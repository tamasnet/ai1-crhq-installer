#!/usr/bin/env node
// ai1-satellite-tools — generic manifest runner (CLI entry). Thin by design: print --help and exit;
// else load + validate the manifest and validate the CLI options (unsupported option / missing value
// → usage exit 2) BEFORE any side effect; provision the sandbox (if asked) BEFORE building context
// so the env redirect takes effect; preflight; run the plan (or the --sandbox --lifecycle suite);
// invoke the package install_entry; report; tear down. Lifecycle hygiene: the db is destroyed on
// every exit path.
import { resolve } from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import {
  createContext, loadManifest, runPlan, preflight, sandbox, closeDb, updateInstallLog,
  readInstallLog, sortInstalled, formatInstalledList, buildAvailableReport, formatAvailableList,
  validateFlags, usage, wantsHelp, declaredFlagNames, UsageError,
  ManifestError, PrereqError, PreflightError, FilterError, VERDICT,
  validateInstallScope,
  runPruneInstalled, formatPruneReport,
} from './lib/index.mjs';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;  // unique sandbox suffix
const has = (argv, f) => argv.includes(f);
// The package path is the (last) positional — same rule parseFlags uses. Needed up front so the
// manifest's declared install_flags can be read before flags are validated.
const packageArgOf = (argv) => argv.filter((a) => !a.startsWith('--')).pop() || '.';

const argv = process.argv.slice(2);
if (wantsHelp(argv)) { console.log(usage('install')); process.exit(0); }
// --list-installed is a standalone, read-only report of ${PACKAGES_DIR}/install.json — no manifest,
// DB, or sandbox. Like --help, it short-circuits before any of that work.
if (has(argv, '--list-installed')) { listInstalled(argv); }
// --list-available is the same kind of standalone read-only report, one level wider: it scans the
// local package stores and joins them against the install log. Also no manifest, DB, or sandbox.
if (has(argv, '--list-available')) { listAvailable(argv); }
// --prune-installed reconciles install.json against live satellite state — drops stale slots only.
if (has(argv, '--prune-installed')) { await pruneInstalled(argv); }

let sb = null;
try {
  // Load the manifest first (no DB / sandbox needed) so option validation knows which
  // package-specific flags (install_flags) are permitted, then reject any unsupported option or
  // missing value BEFORE provisioning a sandbox or touching the DB.
  const { meta, plan, packageRoot } = loadManifest(packageArgOf(argv));
  validateFlags(argv, { mode: 'install', declared: declaredFlagNames(meta) });

  if (has(argv, '--sandbox')) {
    sb = await sandbox.provisionSandbox({ ts: stamp() });   // sets INSTALL_SCHEMA / SKILLS_BASE_DIR
  }

  const ctx = await createContext(argv);
  validateInstallScope(ctx);
  ctx.PACKAGE = { name: meta.name, version: meta.version };   // provenance for version-history change summaries
  if (sb) ctx.log.info(`sandbox: schema=${sb.schema} baseDir=${sb.baseDir}`);

  await preflight(ctx);   // DB reachable + (write modes) SKILLS_BASE writable — else transport exit 2

  ctx.log.info(`package ${meta.name} v${meta.version} — mode=${ctx.mode}${ctx.DRY_RUN ? ' (dry-run)' : ''}`);

  if (sb && ctx.LIFECYCLE) {
    const res = await sandbox.runLifecycle(ctx, plan);
    process.exitCode = res.passed ? 0 : 1;
  } else {
    await runPlan(ctx, plan);
    recordInstallLog(ctx, meta, plan, packageRoot);  // skipped in dry-run/status
    runInstallEntry(ctx, meta, packageRoot, argv);   // runs for install/uninstall/status
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

// Invoke the package's install_entry (if declared) as an isolated subprocess, forwarding the
// mode + standard + package-specific flags so it can honor them (e.g. skip side effects on
// --dry-run). The subprocess inherits INSTALL_SCHEMA / SKILLS_BASE_DIR via env, so it targets the
// same (sandbox) schema + dir. The sandbox-internal flags and the package path are not forwarded.
// .mjs/.js entries run under node; other paths run directly (shebang + executable bit).
function runInstallEntry(ctx, meta, packageRoot, rawArgv) {
  if (!meta.install_entry) return;
  const entryPath = resolve(packageRoot, meta.install_entry);
  if (!existsSync(entryPath)) {
    ctx.record({ type: 'entry', name: meta.install_entry, verdict: VERDICT.FAIL, action: 'missing' });
    return;
  }
  const forwarded = rawArgv.filter((a) => a !== ctx.packageArg && !['--sandbox', '--keep', '--lifecycle'].includes(a));
  ctx.log.info(`install_entry → ${meta.install_entry} ${forwarded.join(' ')}`.trim());
  const isNode = /\.mjs$|\.js$/.test(entryPath);
  const r = spawnSync(
    isNode ? process.execPath : entryPath,
    isNode ? [entryPath, ...forwarded] : forwarded,
    { cwd: packageRoot, stdio: 'inherit', env: process.env },
  );
  ctx.record({
    type: 'entry', name: meta.install_entry,
    verdict: r.status === 0 ? VERDICT.OK : VERDICT.FAIL,
    action: r.status === 0 ? 'ran' : `exit ${r.status}`,
  });
}

// Update ${PACKAGES_DIR}/install.json with this run's outcome. Bookkeeping only — a failure
// here is warned, not fatal: the DB is the source of truth and the install itself succeeded.
function recordInstallLog(ctx, meta, plan, packageRoot) {
  try {
    const p = updateInstallLog(ctx, meta, plan, packageRoot);
    if (p) ctx.log.info(`install log updated: ${p}`);
  } catch (e) {
    ctx.log.warn(`install log not updated: ${e.message}`);
  }
}

// Print ${PACKAGES_DIR}/install.json — a table sorted by type then name, or the raw sorted array
// under --json. Read-only; exits 0 on success, 2 if the log is unreadable. Never returns.
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

// Scan the local package stores (PACKAGE_BASE_DIR + REPOS_BASE_DIR), cross-reference the install
// log, and print the availability table — or the raw rows array under --json. Read-only; like
// --list-installed it short-circuits before manifest/DB/sandbox. Exits 0; never returns.
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

// Reconcile install.json with live satellite state — prune slots whose component is absent.
// Read-only with --dry-run; needs DB (status checks) but no manifest or package.
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
  else if (e instanceof PrereqError) { console.error(`❌ prereq missing: ${e.message}`); process.exitCode = 1; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 2; }
}
