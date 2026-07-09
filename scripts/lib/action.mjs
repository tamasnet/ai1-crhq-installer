import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from './context.mjs';
import { preflight } from './preflight.mjs';
import { closeDb } from './db.mjs';
import { runDrift } from './drift.mjs';
import { runDiff } from './diff.mjs';
import { formatCliTypeError, normalizeCliTypeScope } from './component-types.mjs';
import { actionsPath } from './remote.mjs';
import { pullRemoteConfig, pushRemoteInstall, fetchRemotePackage, completeRemoteAction, resolvePackageBase } from './remote.mjs';

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

function requiredString(action, field, actionType = 'install-package') {
  const value = action[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ActionError(`${actionType} action requires string field: ${field}`);
  }
  return value.trim();
}

function requiredPositiveInteger(action, field, actionType = 'install-package') {
  const value = action[field];
  if (Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) >= 1) return Number(value);
  throw new ActionError(`${actionType} action requires positive integer field: ${field}`);
}

function optionalStringField(action, field, actionType) {
  if (action[field] == null) return null;
  if (typeof action[field] !== 'string' || action[field].trim() === '') {
    throw new ActionError(`${actionType} action field ${field} must be a non-empty string when set`);
  }
  return action[field].trim();
}

function optionalBooleanField(action, field, actionType) {
  if (action[field] == null || action[field] === false) return false;
  if (action[field] !== true) {
    throw new ActionError(`${actionType} action field ${field} must be a boolean when set`);
  }
  return true;
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

function diffOptsForAction(action) {
  const actionType = 'diff-package';
  const getPackage = optionalBooleanField(action, 'diff_get_package', actionType);
  const strict = optionalBooleanField(action, 'diff_strict', actionType);
  const copyProjects = optionalBooleanField(action, 'diff_copy_projects', actionType);
  const include = optionalStringField(action, 'diff_include', actionType);
  const exclude = optionalStringField(action, 'diff_exclude', actionType);
  let typeScope = null;
  const rawType = optionalStringField(action, 'diff_type', actionType);
  if (rawType) {
    const { types, invalid } = normalizeCliTypeScope(rawType);
    if (invalid.length) throw new ActionError(formatCliTypeError(invalid, 'diff_type'));
    typeScope = types.length ? types : null;
  }
  return { getPackage, typeScope, filterSpec: { include, exclude }, strict, copyProjects };
}

function localPackageDir(name, version) {
  return join(resolvePackageBase(), `${name}@${version}`);
}

function localPackageAvailable(name, version) {
  return existsSync(join(localPackageDir(name, version), 'ai1-package.yaml'));
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

async function defaultDriftReport(_action, { log } = {}) {
  try {
    const ctx = await createContext([], { mode: 'status' });
    ctx.DRY_RUN = true;
    await preflight(ctx);
    log?.info('running drift report …');
    const data = await runDrift(ctx, {});
    return { type: 'drift-report', data };
  } finally {
    await closeDb();
  }
}

async function resolveDiffPackageDir(plan, { getPackage }, { log } = {}) {
  if (plan.getPackage) {
    const fetched = await getPackage({ name: plan.name, version: plan.version }, { log });
    return { packageDir: fetched.packageDir, source: 'hub' };
  }
  if (localPackageAvailable(plan.name, plan.version)) {
    return { packageDir: localPackageDir(plan.name, plan.version), source: 'local' };
  }
  return { packageDir: null, source: null };
}

async function defaultDiffPackage(action, { log, getPackage } = {}) {
  const plan = planAction(action);
  const resolved = await resolveDiffPackageDir(plan, { getPackage }, { log });
  if (!resolved.packageDir) {
    log?.info(`package '${plan.name}@${plan.version}' is not available locally`);
    return {
      type: 'diff-package',
      data: {
        ok: false,
        message: `package '${plan.name}@${plan.version}' is not available locally (set diff_get_package to true to fetch from hub)`,
        package: { name: plan.name, version: plan.version, dir: null },
      },
    };
  }

  try {
    const ctx = await createContext([], { mode: 'status' });
    ctx.DRY_RUN = true;
    ctx.COPY_PROJECTS = plan.copyProjects;
    await preflight(ctx);
    log?.info(`running diff for ${plan.name}@${plan.version} (${resolved.source}) …`);
    const data = await runDiff(ctx, {
      packageDir: resolved.packageDir,
      typeScope: plan.typeScope,
      filterSpec: plan.filterSpec,
      strict: plan.strict,
    });
    return { type: 'diff-package', data };
  } finally {
    await closeDb();
  }
}

function completionBodyForResult(result) {
  if (result?.data != null && (result.type === 'drift-report' || result.type === 'diff-package')) {
    return { status: 'completed', type: result.type, data: result.data };
  }
  return { status: 'completed' };
}

async function performInstallPackage(action, deps, log) {
  const plan = planAction(action);
  const fetched = await deps.getPackage({ name: plan.name, version: plan.version }, { log });
  const install = await deps.installPackage(fetched.packageDir, plan.installFlags, { log });
  return {
    name: plan.name,
    version: plan.version,
    packageDir: fetched.packageDir,
    installFlags: plan.installFlags,
    install,
  };
}

function planAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new ActionError('action must be an object');
  }
  if (typeof action.type !== 'string' || action.type.trim() === '') {
    throw new ActionError('action is missing required string field: type');
  }

  if (action.type === 'pull-config') {
    return { type: action.type, operation: 'pull-config' };
  }
  if (action.type === 'push-install') {
    return { type: action.type, operation: 'push-install' };
  }
  if (action.type === 'install-package') {
    const name = requiredString(action, 'package_name');
    const version = requiredPositiveInteger(action, 'package_version');
    const installFlags = installFlagsForAction(action);
    return { type: action.type, operation: 'install-package', name, version, installFlags };
  }
  if (action.type === 'diff-package') {
    const name = requiredString(action, 'package_name', 'diff-package');
    const version = requiredPositiveInteger(action, 'package_version', 'diff-package');
    const { getPackage, typeScope, filterSpec, strict, copyProjects } = diffOptsForAction(action);
    return {
      type: action.type,
      operation: 'diff-package',
      name,
      version,
      getPackage,
      typeScope,
      filterSpec,
      strict,
      copyProjects,
    };
  }
  if (action.type === 'drift-report') {
    return { type: action.type, operation: 'drift-report' };
  }

  throw new ActionError(`unsupported action type: ${action.type}`);
}

async function performAction(action, deps, now, log) {
  const plan = planAction(action);

  if (plan.type === 'pull-config') {
    return deps.pullConfig({}, { now, log });
  }
  if (plan.type === 'push-install') {
    return deps.pushInstall({}, { log });
  }
  if (plan.type === 'install-package') {
    return performInstallPackage(action, deps, log);
  }
  if (plan.type === 'drift-report') {
    return deps.driftReport(action, { log });
  }
  if (plan.type === 'diff-package') {
    return deps.diffPackage(action, { log });
  }

  throw new ActionError(`unsupported action type: ${plan.type}`);
}

export async function runActions({ limit = null, dryRun = false } = {}, {
  now = new Date(),
  log,
  pullConfig = pullRemoteConfig,
  pushInstall = pushRemoteInstall,
  getPackage = fetchRemotePackage,
  installPackage = defaultInstallPackage,
  driftReport = defaultDriftReport,
  diffPackage = defaultDiffPackage,
  completeAction = completeRemoteAction,
} = {}) {
  const max = validateLimit(limit);
  const dest = actionsPath();
  const { found, record } = readActionsFile(dest);
  const startingCount = record.actions.length;
  const toProcess = max == null ? startingCount : Math.min(max, startingCount);
  const results = [];

  if (!found || toProcess === 0) {
    return { dest, found, dryRun, processed: 0, wouldProcess: 0, remaining: startingCount, results };
  }

  if (dryRun) {
    for (let i = 0; i < toProcess; i++) {
      const action = cleanErrorFields(record.actions[i]);
      const type = action?.type;
      try {
        const plan = planAction(action);
        results.push({ type: plan.type, status: 'dry-run', plan });
        log?.info(`[dry-run] would process action ${i + 1}/${toProcess}: ${plan.type}`);
      } catch (e) {
        throw new ActionError(`action ${type || '(unknown)'} failed dry-run validation: ${e?.message || String(e)}`);
      }
    }
    return { dest, found, dryRun: true, processed: 0, wouldProcess: results.length, remaining: startingCount, results };
  }

  for (let i = 0; i < toProcess; i++) {
    const action = cleanErrorFields(record.actions[0]);
    const type = action?.type;
    const key = typeof action?.key === 'string' && action.key.trim() !== '' ? action.key : null;

    let result;
    try {
      log?.info(`processing action ${i + 1}/${toProcess}: ${type || '(unknown)'}${key ? ` (key=${key})` : ''}`);
      result = await performAction(action, { pullConfig, pushInstall, getPackage, installPackage, driftReport, diffPackage }, now, log);
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
        await completeAction(key, completionBodyForResult(result), { log });
      } catch (ce) {
        log?.warn?.(`could not report action '${key}' completion to hub: ${ce.message}`);
      }
    }
    results.push({ type, status: 'ok', result });
    log?.ok(`action ${type} completed`);
  }

  return { dest, found, dryRun: false, processed: results.length, wouldProcess: results.length, remaining: record.actions.length, results };
}
