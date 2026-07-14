#!/usr/bin/env node
// ai1-satellite-tools — generic manifest runner (CLI entry). Thin by design: print --help and exit;
// else load + validate the manifest and validate the CLI options (unsupported option / missing value
// → usage exit 2) BEFORE any side effect; provision the sandbox (if asked) BEFORE building context
// so the env redirect takes effect; preflight; package before script; run the plan (or the
// --sandbox --lifecycle suite); record install log; package after script; report; tear down.
import { existsSync } from 'fs';
import {
  createContext, loadManifest, runPlan, planActionBoundComponents, preflight, sandbox, closeDb,
  updateInstallLog, readInstallLog, sortInstalled, formatInstalledList, buildAvailableReport,
  formatAvailableList, validateFlags, usage, wantsHelp, declaredFlagNames, UsageError, parseFlags,
  ManifestError, PrereqError, PreflightError, FilterError,
  validateInstallScope, validateInstallSource, runPruneInstalled, formatPruneReport,
} from './lib/index.mjs';
import {
  HookAbortError, resolvePackageAfter, warnDeprecatedPackageFields,
  runPackageScript, shouldRunPackageBefore, actualComponentsFromResults,
} from './lib/hooks.mjs';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const has = (argv, f) => argv.includes(f);
const packageArgOf = (argv) => argv.filter((a) => !a.startsWith('--')).pop() || '.';

const argv = process.argv.slice(2);
if (wantsHelp(argv)) { console.log(usage('install')); process.exit(0); }
if (has(argv, '--list-installed')) { listInstalled(argv); }
if (has(argv, '--list-available')) { listAvailable(argv); }
if (has(argv, '--prune-installed')) { await pruneInstalled(argv); }

let sb = null;
try {
  const { meta, plan, packageRoot } = loadManifest(packageArgOf(argv));
  validateFlags(argv, { mode: 'install', declared: declaredFlagNames(meta) });
  validateInstallSource(packageRoot, parseFlags(argv));

  if (has(argv, '--sandbox')) {
    sb = await sandbox.provisionSandbox({ ts: stamp() });
  }

  const ctx = await createContext(argv);
  validateInstallScope(ctx);
  ctx.PACKAGE = { name: meta.name, version: meta.version };
  ctx.packageRoot = packageRoot;
  ctx.packageArg = ctx.packageArg || packageArgOf(argv);
  if (sb) ctx.log.info(`sandbox: schema=${sb.schema} baseDir=${sb.baseDir}`);

  await preflight(ctx);

  ctx.log.info(`package ${meta.name} v${meta.version} — mode=${ctx.mode}${ctx.DRY_RUN ? ' (dry-run)' : ''}`);
  warnDeprecatedPackageFields(ctx, meta);

  const hookCtx = { meta, packageRoot, rawArgv: argv };
  const planned = planActionBoundComponents(ctx, plan);

  if (sb && ctx.LIFECYCLE) {
    const res = await sandbox.runLifecycle(ctx, plan);
    process.exitCode = res.passed ? 0 : 1;
  } else {
    if (shouldRunPackageBefore(ctx, meta)) {
      runPackageScript(ctx, meta, packageRoot, argv, 'before', planned, { abortOnFail: true });
    }
    await runPlan(ctx, plan, hookCtx);
    recordInstallLog(ctx, meta, plan, packageRoot);
    if (resolvePackageAfter(meta)) {
      const actual = actualComponentsFromResults(ctx.results);
      runPackageScript(ctx, meta, packageRoot, argv, 'after', actual);
    }
    ctx.report();
  }
} catch (e) {
  handleFatal(e);
} finally {
  if (sb) {
    if (has(argv, '--keep')) console.log(`[ai1] --keep: sandbox retained — schema=${sb.schema} baseDir=${sb.baseDir}`);
    else await sb.teardown(false);
  }
  await closeDb();
}

function recordInstallLog(ctx, meta, plan, packageRoot) {
  try {
    const p = updateInstallLog(ctx, meta, plan, packageRoot);
    if (p) ctx.log.info(`install log updated: ${p}`);
  } catch (e) {
    ctx.log.warn(`install log not updated: ${e.message}`);
  }
}

function listInstalled(rawArgv) {
  try {
    const entries = readInstallLog();
    console.log(has(rawArgv, '--json') ? JSON.stringify(sortInstalled(entries), null, 2) : formatInstalledList(entries));
    process.exit(0);
  } catch (e) {
    console.error(`❌ install log unreadable: ${e.message}`);
    process.exit(2);
  }
}

function listAvailable(rawArgv) {
  try {
    const report = buildAvailableReport();
    console.log(has(rawArgv, '--json') ? JSON.stringify(report.rows, null, 2) : formatAvailableList(report));
    process.exit(0);
  } catch (e) {
    console.error(`❌ could not list available components: ${e.message}`);
    process.exit(2);
  }
}

async function pruneInstalled(rawArgv) {
  try {
    validateFlags(rawArgv, { mode: 'install' });
    const ctx = await createContext(rawArgv);
    await preflight(ctx);
    const result = await runPruneInstalled(ctx);
    console.log(has(rawArgv, '--json') ? JSON.stringify(result, null, 2) : formatPruneReport(result));
    process.exit(0);
  } catch (e) {
    handleFatal(e);
    process.exit(process.exitCode ?? 2);
  } finally {
    await closeDb();
  }
}

function handleFatal(e) {
  if (e instanceof UsageError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof ManifestError) { console.error(`❌ manifest error: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof FilterError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof PreflightError) { console.error(`❌ preflight failed: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof HookAbortError) { console.error(`❌ ${e.message}`); process.exitCode = 1; }
  else if (e instanceof PrereqError) { console.error(`❌ prereq missing: ${e.message}`); process.exitCode = 1; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 2; }
}
