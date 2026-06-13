#!/usr/bin/env node
// CLI option handling — strict validation shared by both entry points (install.mjs + backup.mjs):
// unsupported option → message + exit 2; a value flag with no value → message + exit 2; --help →
// usage + exit 0. All of these short-circuit BEFORE any DB/sandbox work, so this suite needs no
// sandbox. (That a *declared* package-specific install_flag is accepted + forwarded is proven in
// runner.test.mjs via entry-pkg's --foo.) Run from the project root:  node tests/options.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFlags } from '../scripts/lib/flags.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
// install validation fires after the manifest loads, so point it at a real package.
const install = (args) => run('scripts/install.mjs', ['examples/bundle', ...args]);
const backup = (args) => run('scripts/backup.mjs', args);
const out = (r) => `${r.stdout}${r.stderr}`;

// ── install.mjs ──────────────────────────────────────────────────────────────────────────────
console.log('install.mjs options:');

await test('--help prints usage and exits 0', () => {
  const r = install(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: node scripts\/install\.mjs/);
  assert.match(r.stdout, /--type=<types>/);
  assert.match(r.stdout, /--help/);
});

await test('--help short-circuits even with an otherwise-invalid option', () => {
  const r = install(['--help', '--bogus']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage:/);
});

await test('unknown option → message + exit 2', () => {
  const r = install(['--bogus']);
  assert.equal(r.status, 2);
  assert.match(out(r), /unknown option: --bogus/);
});

await test('undeclared package-specific flag is rejected', () => {
  const r = install(['--no-such-pkg-flag']);     // not in examples/bundle install_flags
  assert.equal(r.status, 2);
  assert.match(out(r), /unknown option: --no-such-pkg-flag/);
});

await test('value flag with no value (bare) → message + exit 2', () => {
  const r = install(['--type']);
  assert.equal(r.status, 2);
  assert.match(out(r), /option --type requires a value/);
});

await test('value flag with empty value → message + exit 2', () => {
  const r = install(['--include=']);
  assert.equal(r.status, 2);
  assert.match(out(r), /option --include requires a value/);
});

await test('boolean flag given a value → message + exit 2', () => {
  const r = install(['--dry-run=please']);
  assert.equal(r.status, 2);
  assert.match(out(r), /option --dry-run does not take a value/);
});

// ── install.mjs --list-installed (standalone, read-only; DB-free) ──────────────────────────────
console.log('\ninstall.mjs --list-installed:');

// Run --list-installed from a dir WITHOUT an ai1-package.yaml to prove it needs no package, with
// PACKAGES_DIR pointed at a throwaway install log.
const listInstalled = (logEntries, extra = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai1-listinst-'));
  if (logEntries) writeFileSync(join(dir, 'install.json'), JSON.stringify(logEntries));
  try {
    return spawnSync(process.execPath, [join(root, 'scripts/install.mjs'), '--list-installed', ...extra],
      { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PACKAGES_DIR: dir } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

await test('--list-installed prints a sorted, formatted table (no package needed) → exit 0', () => {
  const r = listInstalled([
    { type: 'service', name: 'svc-b', version: '1.0.0', package: 'pkg', package_version: '1.0.0' },
    { type: 'skill', name: 'zeta', version: '0.2.0', package: 'pkg', package_version: '1.0.0' },
    { type: 'skill', name: 'alpha', version: '0.1.0', package: 'pkg', package_version: '1.0.0' },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Installed components \(3\):/);
  const order = ['alpha', 'zeta', 'svc-b'].map((n) => r.stdout.indexOf(n));
  assert.ok(order[0] < order[1] && order[1] < order[2], `sorted by type then name:\n${r.stdout}`);
});

await test('--list-installed --json emits the sorted array', () => {
  const r = listInstalled([
    { type: 'recipe', name: 'r1', package: 'p', package_version: '1' },
    { type: 'skill', name: 's1', version: '1.0.0', package: 'p', package_version: '1' },
  ], ['--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((c) => c.type), ['skill', 'recipe']);
});

await test('--list-installed on an absent log says so (exit 0)', () => {
  const r = listInstalled(null);     // no install.json written
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No components installed\./);
});

await test('--list-installed is listed in --help', () => {
  assert.match(install(['--help']).stdout, /--list-installed/);
});

// ── backup.mjs ───────────────────────────────────────────────────────────────────────────────
console.log('\nbackup.mjs options:');

await test('--help prints usage and exits 0', () => {
  const r = backup(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: node scripts\/backup\.mjs/);
  assert.match(r.stdout, /read-only export/);
});

await test('unknown option → message + exit 2', () => {
  const r = backup(['--bogus']);
  assert.equal(r.status, 2);
  assert.match(out(r), /unknown option: --bogus/);
});

await test('install-lifecycle flag → "not supported by backup" + exit 2', () => {
  for (const f of ['--sandbox', '--status', '--uninstall']) {
    const r = backup([f]);
    assert.equal(r.status, 2, f);
    assert.match(out(r), /not supported by backup/, f);
  }
});

await test('--dry-run is supported by backup (validation + help)', () => {
  validateFlags(['--dry-run', '--json'], { mode: 'backup' });   // must not throw (D-31)
  assert.throws(() => validateFlags(['--dry-run=x'], { mode: 'backup' }), /does not take a value/);
  const r = backup(['--help']);
  assert.match(r.stdout, /--dry-run\s+preview what would be backed up/);
});

await test('value flag with no value (bare) → message + exit 2', () => {
  const r = backup(['--name']);
  assert.equal(r.status, 2);
  assert.match(out(r), /option --name requires a value/);
});

await test('--type is supported by backup (no usage error from validation)', () => {
  // A bare --type is a value error; a valued --type passes validation (the run then proceeds to
  // the DB, which is out of scope here — we only assert it is NOT rejected as unsupported/unknown).
  const r = backup(['--type']);
  assert.equal(r.status, 2);
  assert.match(out(r), /requires a value/);
  assert.doesNotMatch(out(r), /unknown option|not supported/);
});

done();
