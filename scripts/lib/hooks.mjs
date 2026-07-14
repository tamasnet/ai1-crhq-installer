// hooks.mjs — package/component before/after script hooks: env, planning, subprocess runner.
import { resolve } from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { VERDICT } from './log.mjs';
import { isScopedRun, shouldRunPackageScripts, scriptsEnabled } from './flags.mjs';

export class HookAbortError extends Error {
  constructor(message) { super(message); this.name = 'HookAbortError'; }
}

export function resolvePackageAfter(meta) {
  return meta?.after ?? meta?.install_entry ?? null;
}

export function resolvePackageFlags(meta) {
  return meta?.flags ?? meta?.install_flags ?? null;
}

export function warnDeprecatedPackageFields(ctx, meta) {
  if (meta?.install_entry && !meta?.after) {
    ctx.log.warn('install_entry is deprecated; use after in the manifest');
  }
  if (meta?.install_flags && !meta?.flags) {
    ctx.log.warn('install_flags is deprecated; use flags in the manifest');
  }
}

export function actualComponentsFromResults(results) {
  const out = [];
  for (const r of results || []) {
    if (!r || r.verdict === VERDICT.SKIPPED) continue;
    if (r.type === 'package-script' || r.type === 'component-script' || r.type === 'entry') continue;
    if (!r.type || !r.name || !r.op) continue;
    out.push({ type: r.type, name: r.name, op: r.op });
  }
  return out;
}

export function formatComponentsEnv(components) {
  return (components || []).map((c) => `${c.type}:${c.name}`).join(' ');
}

function buildHookEnv(ctx, meta, components, component = null) {
  const env = { ...process.env };
  env.INSTALL_MODE = ctx.mode;
  env.INSTALL_PACKAGE = `${meta.name}@${meta.version}`;
  env.INSTALL_DRY_RUN = ctx.DRY_RUN ? '1' : '0';
  env.INSTALL_COMPONENTS = formatComponentsEnv(components);
  if (component) {
    env.INSTALL_COMPONENT = `${component.type}:${component.name}`;
    env.INSTALL_COMPONENT_OP = component.op;
  } else {
    delete env.INSTALL_COMPONENT;
    delete env.INSTALL_COMPONENT_OP;
  }
  return env;
}

function forwardedArgv(rawArgv, packageArg) {
  return rawArgv.filter((a) => a !== packageArg && !['--sandbox', '--keep', '--lifecycle'].includes(a));
}

function spawnScript(packageRoot, scriptPath, rawArgv, packageArg, env) {
  const entryPath = resolve(packageRoot, scriptPath);
  if (!existsSync(entryPath)) return { ok: false, status: null, missing: true, entryPath };
  const forwarded = forwardedArgv(rawArgv, packageArg);
  const isNode = /\.mjs$|\.js$/.test(entryPath);
  const r = spawnSync(
    isNode ? process.execPath : entryPath,
    isNode ? [entryPath, ...forwarded] : forwarded,
    { cwd: packageRoot, stdio: 'inherit', env },
  );
  return { ok: r.status === 0, status: r.status, missing: false, entryPath, forwarded };
}

export function runPackageScript(ctx, meta, packageRoot, rawArgv, phase, components, { abortOnFail = false } = {}) {
  const scriptPath = phase === 'before' ? meta.before : resolvePackageAfter(meta);
  if (!scriptPath) return true;
  if (!scriptsEnabled(ctx)) return true;
  if (!shouldRunPackageScripts(ctx)) {
    ctx.log.info(`package ${phase} skipped (scoped run; pass --with-package-scripts to run)`);
    ctx.record({
      type: 'package-script', name: scriptPath, verdict: VERDICT.SKIPPED,
      action: `scoped (pass --with-package-scripts)`, detail: phase,
    });
    return true;
  }
  const env = buildHookEnv(ctx, meta, components);
  ctx.log.info(`package ${phase} → ${scriptPath}`);
  const r = spawnScript(packageRoot, scriptPath, rawArgv, ctx.packageArg, env);
  if (r.missing) {
    ctx.record({ type: 'package-script', name: scriptPath, verdict: VERDICT.FAIL, action: 'missing', detail: phase });
    if (abortOnFail) throw new HookAbortError(`package ${phase} script missing: ${scriptPath}`);
    return false;
  }
  ctx.record({
    type: 'package-script', name: scriptPath,
    verdict: r.ok ? VERDICT.OK : VERDICT.FAIL,
    action: r.ok ? phase : `${phase} exit ${r.status}`, detail: phase,
  });
  if (abortOnFail && !r.ok) throw new HookAbortError(`package ${phase} script failed: ${scriptPath}`);
  return r.ok;
}

export function runComponentScript(ctx, meta, packageRoot, rawArgv, scriptPath, phase, component, components) {
  if (!scriptPath || !scriptsEnabled(ctx)) return true;
  const env = buildHookEnv(ctx, meta, components, component);
  ctx.log.info(`component ${phase} → ${component.type}:${component.name} (${scriptPath})`);
  const r = spawnScript(packageRoot, scriptPath, rawArgv, ctx.packageArg, env);
  if (r.missing) {
    ctx.record({
      type: 'component-script', name: `${component.type}:${component.name}`, verdict: VERDICT.FAIL,
      action: `${phase} missing`, detail: phase,
    });
    return false;
  }
  ctx.record({
    type: 'component-script', name: `${component.type}:${component.name}`,
    verdict: r.ok ? VERDICT.OK : VERDICT.FAIL,
    action: r.ok ? phase : `${phase} exit ${r.status}`, detail: phase,
  });
  return r.ok;
}

export function shouldRunPackageBefore(ctx, meta) {
  return ctx.mode === 'install' && !!meta?.before;
}

export { shouldRunPackageScripts, scriptsEnabled };
