#!/usr/bin/env node
// ai1-crhq-installer — generic manifest runner (CLI entry). Thin by design: provision the sandbox
// (if asked) BEFORE building context so the env redirect takes effect, preflight, load + validate
// the manifest, run the plan (or the --sandbox --lifecycle suite), invoke the package install_entry,
// report, tear down. Control flow per api-design §11. Lifecycle hygiene (C8): db destroyed on every
// exit path.
import { resolve } from 'path';
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import {
  createContext, loadManifest, runPlan, preflight, sandbox, closeDb,
  ManifestError, PrereqError, PreflightError, VERDICT,
} from './lib/index.mjs';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;  // C10
const has = (argv, f) => argv.includes(f);

const argv = process.argv.slice(2);
let sb = null;
try {
  if (has(argv, '--sandbox')) {
    sb = await sandbox.provisionSandbox({ ts: stamp() });   // sets INSTALL_SCHEMA / INSTALL_BASE_DIR
  }

  const ctx = await createContext(argv);
  if (sb) ctx.log.info(`sandbox: schema=${sb.schema} baseDir=${sb.baseDir}`);

  await preflight(ctx);   // DB reachable + (write modes) BASE writable — else transport exit 2

  const { meta, plan, packageRoot } = loadManifest(ctx.packageArg);
  ctx.log.info(`package ${meta.name} v${meta.version} — mode=${ctx.mode}${ctx.DRY_RUN ? ' (dry-run)' : ''}`);

  if (sb && ctx.LIFECYCLE) {
    const res = await sandbox.runLifecycle(ctx, plan);
    process.exitCode = res.passed ? 0 : 1;
  } else {
    await runPlan(ctx, plan);
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

function handleFatal(e) {
  if (e instanceof ManifestError) { console.error(`❌ manifest error: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof PreflightError) { console.error(`❌ preflight failed: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof PrereqError) { console.error(`❌ prereq missing: ${e.message}`); process.exitCode = 1; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 2; }
}
