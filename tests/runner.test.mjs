#!/usr/bin/env node
// Generic runner (install.mjs) verification: preflight + hook scripts + flag forwarding.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { provisionSandbox } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { preflight, PreflightError } from '../scripts/lib/preflight.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = (args) => spawnSync(process.execPath, ['scripts/install.mjs', 'tests/fixtures/entry-pkg', '--sandbox', ...args], { cwd: root, encoding: 'utf8' });

console.log('preflight:');
const sb = await provisionSandbox({ ts: `${Date.now()}${Math.floor(Math.random() * 1000)}`, seed: false });
try {
  await test('passes on reachable DB + writable SKILLS_BASE', async () => {
    await preflight(makeCtx());
  });
  await test('fails on unwritable SKILLS_BASE → PreflightError', async () => {
    await assert.rejects(() => preflight(makeCtx({ SKILLS_BASE: '/ai1-preflight-nope/x' })), (e) => e instanceof PreflightError);
  });
} finally {
  await sb.teardown(false);
  await closeDb();
}

console.log('\nrunner (hooks + flags):');

await test('install: components + package after + component hooks; exit 0', () => {
  const r = cli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /installed successfully/);
  assert.match(r.stdout, /ENTRY-ARGV:/);
  assert.match(r.stdout, /COMP-BEFORE: skill:entry-skill/);
  assert.match(r.stdout, /COMP-AFTER: skill:entry-skill op=upsert/);
  assert.doesNotMatch(r.stdout, /ENTRY-ARGV:.*--sandbox/);
});

await test('dry-run + package-specific flag forwarded to hooks', () => {
  const r = cli(['--dry-run', '--foo']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENTRY-ARGV:(?=.*--dry-run)(?=.*--foo)/);
});

await test('uninstall mode forwarded to package after', () => {
  const r = cli(['--uninstall']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Uninstall complete/);
  assert.match(r.stdout, /ENTRY-ARGV:.*--uninstall/);
});

await test('scoped run skips package after by default; component hooks still run', () => {
  const r = cli(['--type=skill']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /ENTRY-ARGV:/);
  assert.match(r.stdout, /package after skipped \(scoped run/);
  assert.match(r.stdout, /COMP-BEFORE: skill:entry-skill/);
});

await test('--with-package-scripts runs package after on scoped run', () => {
  const r = cli(['--type=skill', '--with-package-scripts']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENTRY-ARGV:.*--type=skill/);
  assert.match(r.stdout, /ENTRY-ARGV:.*--with-package-scripts/);
});

await test('--with-entry is an alias for --with-package-scripts', () => {
  const r = cli(['--type=skill', '--with-entry']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ENTRY-ARGV:/);
});

await test('--no-scripts skips package and component hooks', () => {
  const r = cli(['--no-scripts']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /ENTRY-ARGV:/);
  assert.doesNotMatch(r.stdout, /COMP-BEFORE:/);
  assert.doesNotMatch(r.stdout, /COMP-AFTER:/);
});

done();
