// Shared test helpers. makeCtx() builds a minimal context for calling lib/core primitives
// directly (env INSTALL_SCHEMA/INSTALL_BASE_DIR must already be set by provisionSandbox).
// harness() returns a tiny pass/fail runner.
import { getDb } from '../scripts/lib/db.mjs';
import { makeLogger } from '../scripts/lib/log.mjs';

export function makeCtx(over = {}) {
  return {
    db: getDb(), BASE: process.env.INSTALL_BASE_DIR, SCHEMA: process.env.INSTALL_SCHEMA,
    log: makeLogger({ dryRun: !!over.DRY_RUN }),
    DRY_RUN: false, RESPECT_LOCKS: false, INSTALL_SKILLS_AS_USER: false, ONLY: null, mode: 'install',
    results: [], record(r) { this.results.push(r); return r; },
    ...over,
  };
}

export function harness() {
  let passed = 0;
  let failed = 0;
  const test = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
  };
  const done = () => {
    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  };
  return { test, done };
}
