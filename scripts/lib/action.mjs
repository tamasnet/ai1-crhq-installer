import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { actionsPath } from './remote.mjs';
import { pullRemoteConfig, pushRemoteInstall } from './remote.mjs';

export class ActionError extends Error {
  constructor(message) { super(message); this.name = 'ActionError'; }
}

function readActionsFile(dest) {
  if (!existsSync(dest)) {
    return { found: false, record: { actions: [] } };
  }

  let record;
  try { record = JSON.parse(readFileSync(dest, 'utf8')); }
  catch (e) { throw new ActionError(`cannot read actions file ${dest}: ${e.message}`); }

  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ActionError(`actions file ${dest} must contain a JSON object`);
  }
  if (!Array.isArray(record.actions)) {
    throw new ActionError(`actions file ${dest} must contain an actions array`);
  }

  return { found: true, record };
}

function writeActionsFile(dest, record) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, dest);
  return dest;
}

function validateLimit(limit) {
  if (limit == null) return null;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new ActionError('limit must be a non-negative integer');
  }
  return limit;
}

function cleanErrorFields(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return action;
  const { status, error_message, error_at, ...rest } = action;
  return rest;
}

function markFailed(action, e, now) {
  const base = action && typeof action === 'object' && !Array.isArray(action) ? action : {};
  const attempts = Number.isInteger(base.attempts) && base.attempts > 0 ? base.attempts + 1 : 1;
  return {
    ...base,
    attempts,
    status: 'error',
    error_message: e?.message || String(e),
    error_at: now.toISOString(),
  };
}

async function performAction(action, deps, now, log) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new ActionError('action must be an object');
  }
  if (typeof action.type !== 'string' || action.type.trim() === '') {
    throw new ActionError('action is missing required string field: type');
  }

  if (action.type === 'pull-config') {
    return deps.pullConfig({}, { now, log });
  }
  if (action.type === 'push-install') {
    return deps.pushInstall({}, { log });
  }

  throw new ActionError(`unsupported action type: ${action.type}`);
}

export async function runActions({ limit = null } = {}, {
  now = new Date(),
  log,
  pullConfig = pullRemoteConfig,
  pushInstall = pushRemoteInstall,
} = {}) {
  const max = validateLimit(limit);
  const dest = actionsPath();
  const { found, record } = readActionsFile(dest);
  const startingCount = record.actions.length;
  const toProcess = max == null ? startingCount : Math.min(max, startingCount);
  const results = [];

  if (!found || toProcess === 0) {
    return { dest, found, processed: 0, remaining: startingCount, results };
  }

  for (let i = 0; i < toProcess; i++) {
    const action = cleanErrorFields(record.actions[0]);
    const type = action?.type;

    let result;
    try {
      log?.info(`processing action ${i + 1}/${toProcess}: ${type || '(unknown)'}`);
      result = await performAction(action, { pullConfig, pushInstall }, now, log);
    } catch (e) {
      record.actions[0] = markFailed(action, e, now);
      writeActionsFile(dest, record);
      throw new ActionError(`action ${type || '(unknown)'} failed: ${e?.message || String(e)}`);
    }

    record.actions.shift();
    writeActionsFile(dest, record);
    results.push({ type, status: 'ok', result });
    log?.ok(`action ${type} completed`);
  }

  return { dest, found, processed: results.length, remaining: record.actions.length, results };
}
