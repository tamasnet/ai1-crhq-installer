#!/usr/bin/env node
// --list-available verification — the local-package-store discovery view. DB-free: it drives
// the pure functions directly (discoverPackages / collectAvailable / sortAvailable /
// formatAvailableList) and the CLI end-to-end via spawnSync, using the real test fixtures as a
// package store (tests/fixtures/{entry-pkg → skill 'entry-skill', service-pkg → service
// 'ai1-demo-svc'}) plus a throwaway install.json. No sandbox needed.
// Run from the project root:  node tests/list-available.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverPackages, collectAvailable, sortAvailable, formatAvailableList,
} from '../scripts/lib/list-available.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(root, 'tests', 'fixtures');   // entry-pkg + service-pkg, each a real package

const cleanups = [];
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), 'ai1-listavail-')); cleanups.push(d); return d; };

try {
  // ── discoverPackages ─────────────────────────────────────────────────────────
  await test('discoverPackages finds package roots and stops there (no descent into component trees)', () => {
    const found = discoverPackages(fixtures);
    assert.ok(found.some((d) => d.endsWith('/entry-pkg')), 'finds entry-pkg');
    assert.ok(found.some((d) => d.endsWith('/service-pkg')), 'finds service-pkg');
    // entry-pkg has skills/entry-skill/ below it — must NOT be reported (descent stops at the root).
    assert.ok(!found.some((d) => d.includes('entry-skill')), 'does not descend past a package root');
  });

  await test('discoverPackages: absent base → [] ; depth bound respected', () => {
    assert.deepEqual(discoverPackages(join(freshDir(), 'nope')), []);
    // A package one level too deep for maxDepth is not found.
    const base = freshDir();
    mkdirSync(join(base, 'a', 'b'), { recursive: true });
    writeFileSync(join(base, 'a', 'b', 'ai1-package.yaml'), 'name: x\n');
    assert.equal(discoverPackages(base, { maxDepth: 1 }).length, 0, 'b/ is at depth 2 > maxDepth 1');
    assert.equal(discoverPackages(base, { maxDepth: 2 }).length, 1, 'reachable at maxDepth 2');
  });

  // ── collectAvailable (status join against the install log) ─────────────────────
  await test('collectAvailable labels available / installed / missing correctly', () => {
    const installLog = [
      // entry-skill IS declared by entry-pkg → installed
      { type: 'skill', name: 'entry-skill', version: 1, package: 'entry-pkg', package_version: '0.1.0' },
      // ghost-recipe is in the log but no package declares it → missing
      { type: 'recipe', name: 'ghost-recipe', package: 'old-pkg', package_version: '9' },
    ];
    const { rows, scanned } = collectAvailable({
      stores: [{ label: 'packages', base: fixtures }],
      installLog,
    });
    const byName = Object.fromEntries(rows.map((r) => [`${r.type}:${r.name}`, r]));

    assert.equal(byName['skill:entry-skill'].status, 'installed');
    assert.ok(byName['skill:entry-skill'].providers.length >= 1, 'installed row keeps its provider(s)');
    assert.equal(byName['service:ai1-demo-svc'].status, 'available', 'declared, not in log → available');
    assert.equal(byName['project:ai1-demo-project'].status, 'available', 'declared project, not in log → available');
    assert.equal(byName['recipe:ghost-recipe'].status, 'missing', 'in log, no package → missing');
    assert.equal(byName['recipe:ghost-recipe'].providers.length, 0);

    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].present, true);
  });

  await test('collectAvailable dedupes equal store bases (no false duplicates)', () => {
    const { rows } = collectAvailable({
      stores: [{ label: 'packages', base: fixtures }, { label: 'repos', base: fixtures }],
      installLog: [],
    });
    const svc = rows.find((r) => r.name === 'ai1-demo-svc');
    assert.equal(svc.providers.length, 1, 'same base scanned once → single provider');
  });

  // Build a minimal valid skill package at <base>/<pkgName>/ declaring skill <skillName>@<version>.
  const writeSkillPackage = (base, pkgName, skillName, version) => {
    const dir = join(base, pkgName);
    mkdirSync(join(dir, 'skills', skillName), { recursive: true });
    writeFileSync(join(dir, 'ai1-package.yaml'),
      `name: ${pkgName}\nversion: 1\ndescription: x\ncomponents:\n  skills:\n    - path: skills/${skillName}\n      version: ${version}\n`);
    writeFileSync(join(dir, 'skills', skillName, 'SKILL.md'),
      `---\nname: ${skillName}\nversion: ${version}\ndescription: "x"\n---\nbody\n`);
    return dir;
  };

  await test('collectAvailable: same component at different versions → one row PER version', () => {
    const base = freshDir();
    writeSkillPackage(base, 'pkg-a', 'dup-skill', 4);   // v4
    writeSkillPackage(base, 'pkg-b', 'dup-skill', 3);   // v3 (different version → separate row)
    writeSkillPackage(base, 'pkg-c', 'dup-skill', 4);   // v4 again (same version → merges with pkg-a)
    const { rows } = collectAvailable({ stores: [{ label: 'packages', base }], installLog: [] });
    const dup = rows.filter((r) => r.name === 'dup-skill');
    assert.equal(dup.length, 2, 'two distinct versions → two rows');
    assert.deepEqual(dup.map((r) => r.version), [3, 4], 'sorted by version; both versions present');
    const v4 = dup.find((r) => r.version === 4);
    assert.equal(v4.providers.length, 2, 'same-version copies (pkg-a + pkg-c) merge into one row');
    assert.deepEqual(v4.providers.map((p) => p.package).sort(), ['pkg-a', 'pkg-c']);
    assert.ok(dup.every((r) => r.status === 'available'), 'neither version is in the log');
  });

  await test('collectAvailable: install log marks ONLY the installed version; others stay available', () => {
    const base = freshDir();
    writeSkillPackage(base, 'pkg-a', 'multi', 4);
    writeSkillPackage(base, 'pkg-b', 'multi', 3);
    const installLog = [{ type: 'skill', name: 'multi', version: 3, package: 'pkg-b', package_version: '1' }];
    const { rows } = collectAvailable({ stores: [{ label: 'packages', base }], installLog });
    const byVer = Object.fromEntries(rows.filter((r) => r.name === 'multi').map((r) => [r.version, r]));
    assert.equal(byVer[3].status, 'installed', 'the version in the log is installed');
    assert.equal(byVer[4].status, 'available', 'the other available version stays available');
  });

  await test('collectAvailable: installed version absent from all packages → that version is missing', () => {
    const base = freshDir();
    writeSkillPackage(base, 'pkg-a', 'drifted', 4);     // only v4 on disk
    const installLog = [{ type: 'skill', name: 'drifted', version: 2, package: 'old', package_version: '1' }];
    const { rows } = collectAvailable({ stores: [{ label: 'packages', base }], installLog });
    const byVer = Object.fromEntries(rows.filter((r) => r.name === 'drifted').map((r) => [r.version, r]));
    assert.equal(byVer[2].status, 'missing', 'installed v2 is backed by no package → missing');
    assert.equal(byVer[2].providers.length, 0);
    assert.equal(byVer[4].status, 'available', 'v4 on disk is available to (re)install');
  });

  await test('collectAvailable records a warning for an unreadable package manifest, keeps going', () => {
    const base = freshDir();
    mkdirSync(join(base, 'broken-pkg'));
    writeFileSync(join(base, 'broken-pkg', 'ai1-package.yaml'), 'name: broken\n');   // missing required fields
    const { rows, warnings } = collectAvailable({ stores: [{ label: 'packages', base }], installLog: [] });
    assert.equal(rows.length, 0, 'broken package contributes no rows');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /missing required field/i);
  });

  // ── sortAvailable ──────────────────────────────────────────────────────────────
  await test('sortAvailable: by type (canonical install order) then name', () => {
    const rows = [
      { type: 'service', name: 'b' }, { type: 'skill', name: 'z' },
      { type: 'skill', name: 'a' }, { type: 'agent', name: 'm' }, { type: 'recipe', name: 'r' },
    ];
    assert.deepEqual(
      sortAvailable(rows).map((r) => `${r.type}:${r.name}`),
      ['skill:a', 'skill:z', 'recipe:r', 'agent:m', 'service:b'],
    );
  });

  // ── formatAvailableList ──────────────────────────────────────────────────────────
  await test('formatAvailableList: header counts, all columns, em-dash + log fallback for missing', () => {
    const out = formatAvailableList({
      rows: [
        {
          type: 'skill', name: 'foo', version: 2, status: 'available',
          providers: [{ package: 'foo-pkg', package_version: '1', version: 2, location: '~/packages/foo-pkg@1' }],
          log: null,
        },
        {
          type: 'recipe', name: 'ghost', version: null, status: 'missing',
          providers: [], log: { package: 'old-pkg', package_version: '9' },
        },
      ],
      scanned: [{ dir: '~/packages', present: true }, { dir: '~/repos', present: false }],
    });
    assert.match(out, /Available components \(2\): \[available 1, installed 0, missing 1\]/);
    assert.match(out, /scanned: ~\/packages\s+~\/repos \(absent\)/);
    assert.match(out, /STATUS\s+TYPE\s+NAME\s+VERSION\s+PACKAGE\s+LOCATION/);
    assert.match(out, /available\s+skill\s+foo\s+2\s+foo-pkg@1\s+~\/packages\/foo-pkg@1/);
    // missing → package falls back to the install-log entry, location is an em dash
    assert.match(out, /missing\s+recipe\s+ghost\s+—\s+old-pkg@9\s+—/);
  });

  await test('formatAvailableList: duplicate providers surface every location', () => {
    const out = formatAvailableList({
      rows: [{
        type: 'skill', name: 'dup', version: 1, status: 'available',
        providers: [
          { package: 'a', package_version: '1', version: 1, location: '~/packages/a@1' },
          { package: 'b', package_version: '1', version: 1, location: '~/repos/r/platform' },
        ],
        log: null,
      }],
    });
    assert.match(out, /a@1, b@1/, 'both packages listed');
    assert.match(out, /~\/packages\/a@1; ~\/repos\/r\/platform/, 'both locations listed');
  });

  await test('formatAvailableList: empty → notice (with scanned dirs)', () => {
    const out = formatAvailableList({ rows: [], scanned: [{ dir: '~/packages', present: true }] });
    assert.match(out, /^No components available\./);
    assert.match(out, /scanned: ~\/packages/);
  });

  // ── CLI end-to-end (install.mjs --list-available) ────────────────────────────────
  const runCli = (extra, log) => {
    const packagesDir = freshDir();          // PACKAGES_DIR — holds install.json (the log)
    const reposDir = freshDir();             // REPOS_BASE_DIR — empty (no repos cloned)
    if (log) writeFileSync(join(packagesDir, 'install.json'), JSON.stringify(log));
    return spawnSync(process.execPath, [join(root, 'scripts/install.mjs'), '--list-available', ...extra], {
      cwd: tmpdir(), encoding: 'utf8',
      env: { ...process.env, PACKAGE_BASE_DIR: fixtures, REPOS_BASE_DIR: reposDir, PACKAGES_DIR: packagesDir },
    });
  };

  await test('--list-available prints the table (no package needed) → exit 0', () => {
    const r = runCli([], {
      install_version: 2,
      install_changed_at: '2026-06-28T00:00:00.000Z',
      installed_components: [
        { type: 'skill', name: 'entry-skill', version: 1, package: 'entry-pkg', package_version: '0.1.0' },
      ],
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Available components \(/);
    assert.match(r.stdout, /installed\s+skill\s+entry-skill/);
    assert.match(r.stdout, /available\s+service\s+ai1-demo-svc/);
    assert.match(r.stdout, /available\s+project\s+ai1-demo-project/);
  });

  await test('--list-available --json emits the rows array', () => {
    const r = runCli(['--json'], []);
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.some((x) => x.name === 'entry-skill' && x.status === 'available'));
  });

  await test('--list-available is listed in --help', () => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/install.mjs'), 'examples/bundle', '--help'],
      { cwd: root, encoding: 'utf8' });
    assert.match(r.stdout, /--list-available/);
  });
} finally {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
}

done();
