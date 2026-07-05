#!/usr/bin/env node
// CLI option handling — strict validation for both entry points (install.mjs + sync.mjs):
// unsupported option → message + exit 2; a value flag with no value → message + exit 2; --help →
// usage + exit 0; plus sync's mode-consistency checks (--mirror-only flags, --add* vs --mirror).
// All of these short-circuit BEFORE any DB/sandbox work, so this suite needs no sandbox. (That a
// *declared* package-specific install_flag is accepted + forwarded is proven in runner.test.mjs via
// entry-pkg's --foo.) Run from the project root:  node tests/options.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInsideGitRepo } from '../scripts/lib/sync.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
// install validation fires after the manifest loads, so point it at a real package.
const install = (args) => run('scripts/install.mjs', ['examples/bundle', ...args]);
const sync = (args) => run('scripts/sync.mjs', args);
const out = (r) => `${r.stdout}${r.stderr}`;

// ── install.mjs ──────────────────────────────────────────────────────────────────────────────
console.log('install.mjs options:');

await test('--help prints usage and exits 0', () => {
  const r = install(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: node scripts\/install\.mjs/);
  assert.match(r.stdout, /--type=<types>/);
  assert.match(r.stdout, /skill,recipe,agent,job,service,project/);
  assert.match(r.stdout, /--copy-projects/);
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

await test('--type requires singular component type values', () => {
  const r = install(['--type=skills']);
  assert.equal(r.status, 2);
  assert.match(out(r), /expects singular component type values/);
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
const listInstalled = (log, extra = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai1-listinst-'));
  if (log) writeFileSync(join(dir, 'install.json'), JSON.stringify(log));
  try {
    return spawnSync(process.execPath, [join(root, 'scripts/install.mjs'), '--list-installed', ...extra],
      { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PACKAGES_DIR: dir } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

await test('--list-installed prints a sorted, formatted table (no package needed) → exit 0', () => {
  const r = listInstalled({
    install_version: 3,
    install_changed_at: '2026-06-28T00:00:00.000Z',
    installed_components: [
      { type: 'service', name: 'svc-b', version: '1.0.0', package: 'pkg', package_version: '1.0.0' },
      { type: 'skill', name: 'zeta', version: '0.2.0', package: 'pkg', package_version: '1.0.0' },
      { type: 'skill', name: 'alpha', version: '0.1.0', package: 'pkg', package_version: '1.0.0' },
    ],
  });
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

// ── install.mjs --prune-installed (standalone; needs DB for status checks) ─────────────────────
console.log('\ninstall.mjs --prune-installed:');

const pruneInstalled = (log, extra = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai1-prune-'));
  if (log) writeFileSync(join(dir, 'install.json'), JSON.stringify(log));
  try {
    return spawnSync(process.execPath, [join(root, 'scripts/install.mjs'), '--prune-installed', ...extra],
      { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PACKAGES_DIR: dir } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

await test('--prune-installed on empty log reports in sync → exit 0', () => {
  const r = pruneInstalled({
    install_version: 1,
    install_changed_at: '2026-06-28T00:00:00.000Z',
    installed_components: [],
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /in sync/);
});

await test('--prune-installed --dry-run --json previews stale entries without writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai1-prune-json-'));
  const log = {
    install_version: 2,
    install_changed_at: '2026-06-28T00:00:00.000Z',
    installed_components: [
      { type: 'skill', name: 'ai1-definitely-not-installed-xyz', package: 'p', package_version: '1', installed_at: '2026-01-01T00:00:00.000Z' },
    ],
  };
  writeFileSync(join(dir, 'install.json'), JSON.stringify(log));
  try {
    const r = spawnSync(process.execPath, [join(root, 'scripts/install.mjs'), '--prune-installed', '--dry-run', '--json'],
      { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PACKAGES_DIR: dir } });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.summary.pruned, 1);
    assert.equal(body.summary.kept, 0);
    assert.equal(body.dryRun, true);
    assert.equal(JSON.parse(readFileSync(join(dir, 'install.json'), 'utf8')).installed_components.length, 1, 'dry-run left log untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('--prune-installed is listed in --help', () => {
  assert.match(install(['--help']).stdout, /--prune-installed/);
});

// ── sync.mjs ─────────────────────────────────────────────────────────────────────────────────
// All sync option failures short-circuit BEFORE getDb()/runSync, so these need no sandbox.
console.log('\nsync.mjs options:');

await test('--help prints usage and exits 0', () => {
  const r = sync(['--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: sync\.mjs/);
  assert.match(r.stdout, /--mirror/);
});

await test('unknown option → message + exit 2', () => {
  const r = sync(['--bogus']);
  assert.equal(r.status, 2);
  assert.match(out(r), /unknown option: --bogus/);
});

await test('value flag with no value (bare) → message + exit 2', () => {
  const r = sync(['--add-skill']);
  assert.equal(r.status, 2);
  assert.match(out(r), /option --add-skill requires a value/);
});

await test('boolean flag given a value → message + exit 2', () => {
  const r = sync(['--mirror=please']);
  assert.equal(r.status, 2);
  assert.match(out(r), /option --mirror does not take a value/);
});

await test('mirror-only flag without --mirror → message + exit 2', () => {
  for (const f of ['--normalize']) {
    const r = sync([f]);
    assert.equal(r.status, 2, f);
    assert.match(out(r), /requires? --mirror/, f);
  }
});

await test('--add-* combined with --mirror → message + exit 2', () => {
  const r = sync(['--mirror', '--add-project=foo']);
  assert.equal(r.status, 2);
  assert.match(out(r), /cannot be combined with --mirror/);
});

await test('--mirror with an unknown --type → message + exit 2', () => {
  const r = sync(['--mirror', '--type=bogus']);
  assert.equal(r.status, 2);
  assert.match(out(r), /unknown component type/);
});

await test('--mirror rejects plural --type values', () => {
  const r = sync(['--mirror', '--type=skills']);
  assert.equal(r.status, 2);
  assert.match(out(r), /expects singular component type values/);
});

await test('--add-project is listed in sync help', () => {
  assert.match(sync(['--help']).stdout, /--add-project/);
});

// ── sync.mjs git-safety guard (D-49) ────────────────────────────────────────────────────────────
// sync edits the package in place and leans on git to recover a bad run, so a non-git destination is
// refused unless --force. The guard runs before any DB work; the post-guard "No ai1-package.yaml"
// error (a real empty-dir run) is what proves the guard PASSED without reaching a DB query.
console.log('\nsync.mjs git-safety guard:');

const gitTmps = [];
const mkTmp = (init) => {
  const d = mkdtempSync(join(tmpdir(), 'ai1-gitguard-'));
  gitTmps.push(d);
  if (init) spawnSync('git', ['init', '-q', d], { encoding: 'utf8' });
  return d;
};

await test('isInsideGitRepo: false outside a repo, true inside (and for a not-yet-created subdir)', () => {
  const plain = mkTmp(false);
  const repo = mkTmp(true);
  assert.equal(isInsideGitRepo(plain), false, 'a plain temp dir is not a repo');
  assert.equal(isInsideGitRepo(repo), true, 'a git-init dir is a repo');
  assert.equal(isInsideGitRepo(join(repo, 'does', 'not', 'exist')), true, 'a new subdir inside a repo counts (ancestor walk)');
  assert.equal(isInsideGitRepo(join(plain, 'sub')), false, 'a new subdir of a non-repo does not');
});

await test('sync on a non-git destination → error + exit 1 (before any DB work)', () => {
  const r = sync([mkTmp(false)]);
  assert.equal(r.status, 1);
  assert.match(out(r), /not inside a git repository/);
  assert.match(out(r), /--force/);
});

await test('--force proceeds past the guard (then hits the normal no-manifest error, not the git one)', () => {
  const r = sync([mkTmp(false), '--force']);
  assert.equal(r.status, 1);
  assert.doesNotMatch(out(r), /not inside a git repository/, 'git guard bypassed by --force');
  assert.match(out(r), /No ai1-package\.yaml/, 'fell through to the normal empty-dir error');
});

await test('a real git repo is accepted without --force', () => {
  const r = sync([mkTmp(true)]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(out(r), /not inside a git repository/, 'a git repo passes the guard');
  assert.match(out(r), /No ai1-package\.yaml/);
});

await test('--type without --mirror is accepted', () => {
  const d = mkTmp(true);
  writeFileSync(join(d, 'ai1-package.yaml'), 'name: x\nversion: 1\ndescription: x\ncomponents: {}\n');
  const r = sync([d, '--type=skill']);
  assert.doesNotMatch(out(r), /requires? --mirror/);
});

await test('--force is listed in --help', () => {
  assert.match(sync(['--help']).stdout, /--force/);
});

for (const d of gitTmps) rmSync(d, { recursive: true, force: true });

done();
