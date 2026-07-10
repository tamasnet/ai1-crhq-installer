#!/usr/bin/env node
// Generic runner (install.mjs) verification: preflight + install_entry hook + flag
// forwarding, driven through the real CLI via spawnSync against tests/fixtures/entry-pkg.
// Run from the project root:  node tests/runner.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { provisionSandbox } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { preflight, PreflightError } from '../scripts/lib/preflight.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));   // project root (parent of tests/)
const cli = (args) => spawnSync(process.execPath, ['scripts/install.mjs', 'tests/fixtures/entry-pkg', '--sandbox', ...args], { cwd: root, encoding: 'utf8' });

// ── preflight unit checks (need a reachable DB → provision a throwaway sandbox) ──────────────
console.log('preflight:');
const sb = await provisionSandbox({ ts: `${Date.now()}${Math.floor(Math.random() * 1000)}`, seed: false });
try {
  await test('passes on reachable DB + writable SKILLS_BASE', async () => {
    await preflight(makeCtx());   // must not throw
  });
  await test('fails on unwritable SKILLS_BASE → PreflightError', async () => {
    await assert.rejects(() => preflight(makeCtx({ SKILLS_BASE: '/ai1-preflight-nope/x' })), (e) => e instanceof PreflightError);
  });
} finally {
  await sb.teardown(false);
  await closeDb();
}

// ── CLI runner: install_entry invocation + flag forwarding ───────────────────────────────────
console.log('\nrunner (install_entry + flags):');

await test('install: components + install_entry run; exit 0; sandbox flag not forwarded', () => {
  const r = cli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed successfully/);
  assert.match(r.stdout, /ENTRY-ARGV:/);
  assert.doesNotMatch(r.stdout, /ENTRY-ARGV:.*--sandbox/, 'internal --sandbox not forwarded');
});

await test('dry-run + package-specific flag forwarded to entry', () => {
  const r = cli(['--dry-run', '--foo']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENTRY-ARGV:(?=.*--dry-run)(?=.*--foo).*/, 'both --dry-run and --foo forwarded');
});

await test('uninstall mode forwarded', () => {
  const r = cli(['--uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Uninstall complete/);
  assert.match(r.stdout, /ENTRY-ARGV:.*--uninstall/);
});

await test('status mode forwarded', () => {
  const r = cli(['--status']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENTRY-ARGV:.*--status/);
});

await test('scoped run skips install_entry by default', () => {
  const r = cli(['--type=skill']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /ENTRY-ARGV:/);
  assert.match(r.stdout, /install_entry skipped \(scoped run/);
});

await test('--with-entry runs install_entry on a scoped run and forwards flags', () => {
  const r = cli(['--type=skill', '--with-entry']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENTRY-ARGV:.*--type=skill/);
  assert.match(r.stdout, /ENTRY-ARGV:.*--with-entry/);
});

done();
