import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionsPath } from './remote.mjs';
import { pullRemoteConfig, pushRemoteInstall, fetchRemotePackage, completeRemoteAction } from './remote.mjs';

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

function requiredString(action, field) {
  const value = action[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ActionError(`install-package action requires string field: ${field}`);
  }
  return value.trim();
}

function requiredPositiveInteger(action, field) {
  const value = action[field];
  if (Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 1) return Number(value);
  throw new ActionError(`install-package action requires positive integer field: ${field}`);
}

function optionalStringFlag(action, field, flag) {
  if (action[field] == null) return null;
  if (typeof action[field] !== 'string' || action[field].trim() === '') {
    throw new ActionError(`install-package action field ${field} must be a non-empty string when set`);
  }
  return `${flag}=${action[field].trim()}`;
}

function optionalBooleanFlag(action, field, flag) {
  if (action[field] == null || action[field] === false) return null;
  if (action[field] !== true) {
    throw new ActionError(`install-package action field ${field} must be a boolean when set`);
  }
  return flag;
}

function installFlagsForAction(action) {
  return [
    optionalStringFlag(action, 'install_type', '--type'),
    optionalStringFlag(action, 'install_include', '--include'),
    optionalStringFlag(action, 'install_exclude', '--exclude'),
    optionalBooleanFlag(action, 'install_optional', '--optional'),
  ].filter(Boolean);
}

function defaultInstallPackage(packageDir, args = [], { log } = {}) {
  const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const installScript = join(scriptsDir, 'install.mjs');
  const argv = [installScript, packageDir, ...args];

  log?.info(`installing downloaded package → ${packageDir}${args.length ? ` (${args.join(' ')})` : ''}`);
  const r = spawnSync(process.execPath, argv, {
    cwd: dirname(scriptsDir),
    encoding: 'utf8',
    env: process.env,
    stdio: log ? 'inherit' : 'pipe',
  });
  if (r.error) throw new ActionError(`could not run install.mjs: ${r.error.message}`);
  if (r.status !== 0) {
    throw new ActionError(`install.mjs failed for ${packageDir} (exit ${r.status})`);
  }
  return { packageDir, flags: args, exitCode: r.status };
}

async function performInstallPackage(action, deps, log) {
  const name = requiredString(action, 'package_name');
  const version = requiredPositiveInteger(action, 'package_version');
  const installFlags = installFlagsForAction(action);
  const fetched = await deps.getPackage({ name, version }, { log });
  const install = await deps.installPackage(fetched.packageDir, installFlags, { log });
  return {
    name,
    version,
    packageDir: fetched.packageDir,
    installFlags,
    install,
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
  if (action.type === 'install-package') {
    return performInstallPackage(action, deps, log);
  }

  throw new ActionError(`unsupported action type: ${action.type}`);
}

export async function runActions({ limit = null } = {}, {
  now = new Date(),
  log,
  pullConfig = pullRemoteConfig,
  pushInstall = pushRemoteInstall,
  getPackage = fetchRemotePackage,
  installPackage = defaultInstallPackage,
  completeAction = completeRemoteAction,
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
    const key = typeof action?.key === 'string' && action.key.trim() !== '' ? action.key : null;

    let result;
    try {
      log?.info(`processing action ${i + 1}/${toProcess}: ${type || '(unknown)'}${key ? ` (key=${key})` : ''}`);
      result = await performAction(action, { pullConfig, pushInstall, getPackage, installPackage }, now, log);
    } catch (e) {
      const failed = markFailed(action, e, now);
      record.actions[0] = failed;
      writeActionsFile(dest, record);
      // Notify the hub of the failure for queued actions (best-effort: don't mask the original error).
      if (key) {
        try {
          await completeAction(key, {
            status: 'failed',
            error_message: failed.error_message,
            error_at: failed.error_at,
            attempts: failed.attempts,
          }, { log });
        } catch (ce) {
          log?.warn?.(`could not report action '${key}' failure to hub: ${ce.message}`);
        }
      }
      throw new ActionError(`action ${type || '(unknown)'} failed: ${e?.message || String(e)}`);
    }

    record.actions.shift();
    writeActionsFile(dest, record);
    // Notify the hub of completion for queued actions (best-effort: don't mask the main result).
    if (key) {
      try {
        await completeAction(key, { status: 'completed' }, { log });
      } catch (ce) {
        log?.warn?.(`could not report action '${key}' completion to hub: ${ce.message}`);
      }
    }
    results.push({ type, status: 'ok', result });
    log?.ok(`action ${type} completed`);
  }

  return { dest, found, processed: results.length, remaining: record.actions.length, results };
}
