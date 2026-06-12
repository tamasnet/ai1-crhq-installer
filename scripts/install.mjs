#!/usr/bin/env node
// ai1-crhq-installer — generic manifest runner (CLI entry). Thin by design: print --help and exit;
// else load + validate the manifest and validate the CLI options (unsupported option / missing value
// → usage exit 2) BEFORE any side effect; provision the sandbox (if asked) BEFORE building context
// so the env redirect takes effect; preflight; run the plan (or the --sandbox --lifecycle suite);
// invoke the package install_entry; report; tear down. Control flow per api-design §11. Lifecycle
// hygiene (C8): db destroyed on every exit path.
import { resolve } from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import {
  createContext, loadManifest, runPlan, preflight, sandbox, closeDb, updateInstallLog,
  validateFlags, usage, wantsHelp, declaredFlagNames, UsageError,
  ManifestError, PrereqError, PreflightError, FilterError, VERDICT,
} from './lib/index.mjs';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;  // C10
const has = (argv, f) => argv.includes(f);
// The package path is the (last) positional — same rule parseFlags uses. Needed up front so the
// manifest's declared install_flags can be read before flags are validated.
const packageArgOf = (argv) => argv.filter((a) => !a.startsWith('--')).pop() || '.';

const argv = process.argv.slice(2);
if (wantsHelp(argv)) { console.log(usage('install')); process.exit(0); }

let sb = null;
try {
  // Load the manifest first (no DB / sandbox needed) so option validation knows which
  // package-specific flags (install_flags) are permitted, then reject any unsupported option or
  // missing value BEFORE provisioning a sandbox or touching the DB.
  const { meta, plan, packageRoot } = loadManifest(packageArgOf(argv));
  validateFlags(argv, { mode: 'install', declared: declaredFlagNames(meta) });

  if (has(argv, '--sandbox')) {
    sb = await sandbox.provisionSandbox({ ts: stamp() });   // sets INSTALL_SCHEMA / INSTALL_BASE_DIR
  }

  const ctx = await createContext(argv);
  if (sb) ctx.log.info(`sandbox: schema=${sb.schema} baseDir=${sb.baseDir}`);

  await preflight(ctx);   // DB reachable + (write modes) BASE writable — else transport exit 2

  ctx.log.info(`package ${meta.name} v${meta.version} — mode=${ctx.mode}${ctx.DRY_RUN ? ' (dry-run)' : ''}`);

  if (sb && ctx.LIFECYCLE) {
    const res = await sandbox.runLifecycle(ctx, plan);
    process.exitCode = res.passed ? 0 : 1;
  } else {
    await runPlan(ctx, plan);
    recordInstallLog(ctx, meta, plan, packageRoot);  // D-24 — skipped in dry-run/status
    runInstallEntry(ctx, meta, packageRoot, argv);   // A4 / OQ-U2 — runs for install/uninstall/status
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

// Invoke the package's install_entry (if declared) as an isolated `node` subprocess, forwarding the
// mode + standard + package-specific flags so it can honor them (e.g. skip side effects on
// --dry-run). The subprocess inherits INSTALL_SCHEMA / INSTALL_BASE_DIR via env, so it targets the
// same (sandbox) schema + dir. The sandbox-internal flags and the package path are not forwarded.
function runInstallEntry(ctx, meta, packageRoot, rawArgv) {
  if (!meta.install_entry) return;
  const entryPath = resolve(packageRoot, meta.install_entry);
  if (!existsSync(entryPath)) {
    ctx.record({ type: 'entry', name: meta.install_entry, verdict: VERDICT.FAIL, action: 'missing' });
    return;
  }
  const forwarded = rawArgv.filter((a) => a !== ctx.packageArg && !['--sandbox', '--keep', '--lifecycle'].includes(a));
  ctx.log.info(`install_entry → ${meta.install_entry} ${forwarded.join(' ')}`.trim());
  const r = spawnSync(process.execPath, [entryPath, ...forwarded], { cwd: packageRoot, stdio: 'inherit', env: process.env });
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

function handleFatal(e) {
  if (e instanceof UsageError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof ManifestError) { console.error(`❌ manifest error: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof FilterError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof PreflightError) { console.error(`❌ preflight failed: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof PrereqError) { console.error(`❌ prereq missing: ${e.message}`); process.exitCode = 1; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 2; }
}
