#!/usr/bin/env node
// ai1-crhq-installer — generic manifest runner (CLI entry). Thin by design: provision the sandbox
// (if asked) BEFORE building context so the env redirect takes effect, load + validate the
// manifest, run the plan (or the --sandbox --lifecycle assertion suite), report, tear down.
// Control flow per api-design §11. Lifecycle hygiene (C8): db destroyed on every exit path.
import { createContext, loadManifest, runPlan, sandbox, closeDb, ManifestError, PrereqError } from './lib/index.mjs';

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

  const { meta, plan } = loadManifest(ctx.packageArg);
  ctx.log.info(`package ${meta.name} v${meta.version} — mode=${ctx.mode}${ctx.DRY_RUN ? ' (dry-run)' : ''}`);

  if (sb && ctx.LIFECYCLE) {
    const res = await sandbox.runLifecycle(ctx, plan);
    process.exitCode = res.passed ? 0 : 1;
  } else {
    await runPlan(ctx, plan);
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

function handleFatal(e) {
  if (e instanceof ManifestError) { console.error(`❌ manifest error: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof PrereqError) { console.error(`❌ prereq missing: ${e.message}`); process.exitCode = 1; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 2; }
}
