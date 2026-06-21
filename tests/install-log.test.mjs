#!/usr/bin/env node
// install-log verification (D-24) — ${PACKAGES_DIR}/install.json bookkeeping. DB-free: drives
// updateInstallLog directly with a real parsed plan (examples/bundle) and synthetic results.
// The log is a FLAT list of component entries, one slot per `type:name`; provenance (package +
// package_version) rides on each entry, so re-install transfers ownership in place.
// Run from the project root:  node tests/install-log.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { updateInstallLog, updateInstallLogForMirror, readInstallLog, installLogPath, resolvePackagesDir, sortInstalled, formatInstalledList } from '../scripts/lib/install-log.mjs';
import { makeLogger, VERDICT } from '../scripts/lib/log.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();

const cleanups = [];
const freshDir = () => { const d = mkdtempSync(join(tmpdir(), 'ai1-install-log-')); cleanups.push(d); return d; };

const packagesDir = freshDir();
const { meta, plan, packageRoot } = loadManifest('examples/bundle');

const makeCtx = (dir, over = {}) => ({
  mode: 'install', DRY_RUN: false, PACKAGES_DIR: dir,
  log: makeLogger({ dryRun: !!over.DRY_RUN }), results: [], ...over,
});
const ok = (type, name) => ({ type, name, verdict: VERDICT.OK, action: 'created' });
const already = (type, name) => ({ type, name, verdict: VERDICT.ALREADY, action: 'updated' });
const allOk = () => [
  ok('skill', plan.skills[0].name), ok('recipe', plan.recipes[0].name), ok('agent', plan.agents[0].name),
  ok('job', plan.jobs[0].name), ok('service', plan.services[0].name),
];
const logged = (dir = packagesDir) => readInstallLog(dir);
const find = (dir, type, name) => logged(dir).find((c) => c.type === type && (name == null || c.name === name));

try {
  await test('install: flat entry per component with version/package/package_version/date/source', () => {
    const p = updateInstallLog(makeCtx(packagesDir, { results: allOk() }), meta, plan, packageRoot);
    assert.equal(p, installLogPath(packagesDir));
    const entries = logged();
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 5);

    const skill = find(packagesDir, 'skill');
    assert.equal(skill.name, plan.skills[0].name);
    assert.equal(skill.version, plan.skills[0].version);
    assert.equal(skill.package, meta.name);
    assert.equal(skill.package_version, String(meta.version));
    assert.equal(skill.source, `skills/${plan.skills[0].key}/SKILL.md`);
    assert.ok(skill.installed_at);

    const agent = find(packagesDir, 'agent');
    assert.equal(agent.source, `agents/${plan.agents[0].name}/AGENTS.md`);
    assert.equal(agent.version, plan.agents[0].version, 'agent carries its (optional) integer version');
    assert.equal(agent.version, 1);
    assert.equal(agent.package, meta.name);

    const service = find(packagesDir, 'service');
    assert.equal(service.source, `services/${plan.services[0].name}/service.yaml`);
    assert.equal(service.version, plan.services[0].version);
    assert.equal(service.package_version, String(meta.version));
  });

  await test('idempotent re-run (ALREADY): component date preserved', () => {
    const before = find(packagesDir, 'skill').installed_at;
    updateInstallLog(makeCtx(packagesDir, { results: [already('skill', plan.skills[0].name)] }), meta, plan, packageRoot);
    assert.equal(find(packagesDir, 'skill').installed_at, before, 'unchanged component keeps its original install date');
  });

  await test('dry-run: returns null, log untouched', () => {
    const snapshot = readFileSync(installLogPath(packagesDir), 'utf8');
    const p = updateInstallLog(makeCtx(packagesDir, { DRY_RUN: true, results: allOk() }), meta, plan, packageRoot);
    assert.equal(p, null);
    assert.equal(readFileSync(installLogPath(packagesDir), 'utf8'), snapshot);
  });

  await test('status mode: returns null, log untouched', () => {
    const snapshot = readFileSync(installLogPath(packagesDir), 'utf8');
    const p = updateInstallLog(makeCtx(packagesDir, { mode: 'status', results: allOk() }), meta, plan, packageRoot);
    assert.equal(p, null);
    assert.equal(readFileSync(installLogPath(packagesDir), 'utf8'), snapshot);
  });

  await test('failed component: not logged', () => {
    const fail = { type: 'skill', name: 'ghost-skill', verdict: VERDICT.FAIL, action: 'error' };
    updateInstallLog(makeCtx(packagesDir, { results: [fail] }), meta, plan, packageRoot);
    assert.ok(!logged().some((c) => c.name === 'ghost-skill'));
  });

  await test('partial uninstall: removes just that component entry', () => {
    updateInstallLog(makeCtx(packagesDir, { mode: 'uninstall', results: [ok('job', plan.jobs[0].name)] }), meta, plan, packageRoot);
    assert.equal(logged().length, 4);
    assert.ok(!logged().some((c) => c.type === 'job'));
  });

  await test('full uninstall: log emptied (ALREADY-absent counts)', () => {
    const results = [
      already('skill', plan.skills[0].name), ok('recipe', plan.recipes[0].name), ok('agent', plan.agents[0].name),
      ok('job', plan.jobs[0].name), ok('service', plan.services[0].name),
    ];
    updateInstallLog(makeCtx(packagesDir, { mode: 'uninstall', results }), meta, plan, packageRoot);
    assert.deepEqual(logged(), [], 'every component removed → empty list');
  });

  await test('corrupt log: warned and rebuilt, not fatal', () => {
    writeFileSync(installLogPath(packagesDir), '{not json');
    updateInstallLog(makeCtx(packagesDir, { results: [ok('skill', plan.skills[0].name)] }), meta, plan, packageRoot);
    assert.equal(logged().length, 1);
  });

  // ── Ownership transfer (the reason for the flat shape) ──────────────────────

  await test('newer package version transfers ownership in place — no duplicate', () => {
    const dir = freshDir();
    updateInstallLog(makeCtx(dir, { results: [ok('skill', plan.skills[0].name)] }), meta, plan, packageRoot);
    const newer = { ...meta, version: 9 };
    updateInstallLog(makeCtx(dir, { results: [ok('skill', plan.skills[0].name)] }), newer, plan, packageRoot);
    const slots = logged(dir).filter((c) => c.type === 'skill' && c.name === plan.skills[0].name);
    assert.equal(slots.length, 1, 'one slot per component — re-install overwrites, never duplicates');
    assert.equal(slots[0].package_version, '9', 'slot reflects the newer package version');
  });

  await test('different package name takes over a component', () => {
    const dir = freshDir();
    updateInstallLog(makeCtx(dir, { results: [ok('skill', plan.skills[0].name)] }), meta, plan, packageRoot);
    const other = { ...meta, name: 'other-pkg', version: 2 };
    updateInstallLog(makeCtx(dir, { results: [ok('skill', plan.skills[0].name)] }), other, plan, packageRoot);
    const slots = logged(dir).filter((c) => c.type === 'skill' && c.name === plan.skills[0].name);
    assert.equal(slots.length, 1, 'the old package no longer claims the component');
    assert.equal(slots[0].package, 'other-pkg');
    assert.equal(slots[0].package_version, '2');
  });

  await test('partial upgrade: mixed package_versions coexist across one package', () => {
    const dir = freshDir();
    updateInstallLog(makeCtx(dir, { results: allOk() }), meta, plan, packageRoot);        // all 5 @ package v1
    const newer = { ...meta, version: 2 };
    updateInstallLog(makeCtx(dir, {                                                        // only skill+recipe bumped
      results: [ok('skill', plan.skills[0].name), ok('recipe', plan.recipes[0].name)],
    }), newer, plan, packageRoot);

    assert.equal(logged(dir).length, 5, 'still exactly one slot per component');
    assert.equal(find(dir, 'skill').package_version, '2');
    assert.equal(find(dir, 'recipe').package_version, '2');
    assert.equal(find(dir, 'agent').package_version, '1', 'untouched component keeps its old package version');
    assert.equal(find(dir, 'job').package_version, '1');
    assert.equal(find(dir, 'service').package_version, '1');
    // all still attributed to the same package name — only the version differs per component
    assert.ok(logged(dir).every((c) => c.package === meta.name));
  });

  // ── --list-installed formatting (sortInstalled / formatInstalledList) ───────

  await test('sortInstalled: by type (canonical install order) then name', () => {
    const entries = [
      { type: 'service', name: 'b' }, { type: 'skill', name: 'z' },
      { type: 'skill', name: 'a' }, { type: 'agent', name: 'm' }, { type: 'recipe', name: 'r' },
    ];
    assert.deepEqual(
      sortInstalled(entries).map((c) => `${c.type}:${c.name}`),
      ['skill:a', 'skill:z', 'recipe:r', 'agent:m', 'service:b'],
    );
  });

  await test('formatInstalledList: header + count + aligned rows; empty → notice', () => {
    assert.match(formatInstalledList([]), /^No components installed\.$/);
    const out = formatInstalledList([
      { type: 'job', name: 'nightly', package: 'bundle', package_version: '0.1.0' },
      { type: 'skill', name: 'my-skill', version: 2, package: 'bundle', package_version: '0.1.0' },
    ]);
    assert.match(out, /Installed components \(2\):/);
    assert.match(out, /TYPE\s+NAME\s+VERSION\s+FROM/);
    assert.match(out, /skill\s+my-skill\s+2\s+bundle@0\.1\.0/, 'integer component version rendered bare');
    assert.match(out, /job\s+nightly\s+—\s+bundle@0\.1\.0/, 'no component version → —');
    assert.ok(out.indexOf('my-skill') < out.indexOf('nightly'), 'skill (type rank 0) before job');
  });

  // ── updateInstallLogForMirror (D-48): sync --mirror reconciles install.json ──────────────────

  await test('mirror: upserts included components (attributed to the mirror pkg), drops removed ones', () => {
    const dir = freshDir();
    // Pre-existing log: a skill from another package + a recipe the mirror will drop.
    writeFileSync(installLogPath(dir), JSON.stringify([
      { type: 'skill', name: 'sk', version: 1, package: 'vendor-pkg', package_version: '7', source: 'skills/sk/SKILL.md', installed_at: '2020-01-01T00:00:00Z' },
      { type: 'recipe', name: 'gone', package: 'vendor-pkg', package_version: '7', installed_at: '2020-01-01T00:00:00Z' },
    ]));
    const ctx = { DRY_RUN: false, PACKAGES_DIR: dir, log: makeLogger({}) };
    const p = updateInstallLogForMirror(ctx, {
      installed: [
        { type: 'skill', name: 'sk', version: 2, source: 'skills/sk/SKILL.md' },   // ownership transfers to mirror
        { type: 'agent', name: 'ag', source: 'agents/ag/AGENTS.md' },               // brand-new slot
      ],
      removed: [{ type: 'recipe', name: 'gone' }],
      pkg: { name: 'ai1-tamas', version: 3 },
    });
    assert.equal(p, installLogPath(dir));
    const log = readInstallLog(dir);
    assert.equal(log.length, 2, 'recipe removed; skill + agent remain');

    const sk = log.find((c) => c.type === 'skill' && c.name === 'sk');
    assert.equal(sk.package, 'ai1-tamas', 'ownership transferred to the mirror package');
    assert.equal(sk.package_version, '3');
    assert.equal(sk.version, 2, 'component version reflects the mirror');
    assert.equal(sk.installed_at, '2020-01-01T00:00:00Z', 'existing install date preserved (already live)');

    const ag = log.find((c) => c.type === 'agent' && c.name === 'ag');
    assert.equal(ag.package, 'ai1-tamas');
    assert.ok(ag.installed_at, 'a fresh slot gets an install date');
    assert.ok(!ag.version, 'no version → omitted');

    assert.ok(!log.some((c) => c.name === 'gone'), 'removed component dropped from the log');
  });

  await test('mirror: leaves untouched components (other packages) alone', () => {
    const dir = freshDir();
    writeFileSync(installLogPath(dir), JSON.stringify([
      { type: 'skill', name: 'other', version: 5, package: 'unrelated', package_version: '9', installed_at: '2021-01-01T00:00:00Z' },
    ]));
    const ctx = { DRY_RUN: false, PACKAGES_DIR: dir, log: makeLogger({}) };
    updateInstallLogForMirror(ctx, {
      installed: [{ type: 'skill', name: 'mine', version: 1, source: 'skills/mine/SKILL.md' }],
      removed: [], pkg: { name: 'ai1-tamas', version: 1 },
    });
    const log = readInstallLog(dir);
    const other = log.find((c) => c.name === 'other');
    assert.equal(other.package, 'unrelated', 'a component this mirror does not carry is untouched');
    assert.equal(other.package_version, '9');
    assert.ok(log.some((c) => c.name === 'mine'), 'the mirrored component is recorded');
  });

  await test('mirror: dry-run writes nothing; no-op run leaves the file byte-identical', () => {
    const dir = freshDir();
    const ctx = (over) => ({ DRY_RUN: false, PACKAGES_DIR: dir, log: makeLogger({}), ...over });
    // dry-run → null, no file
    assert.equal(updateInstallLogForMirror(ctx({ DRY_RUN: true }), {
      installed: [{ type: 'skill', name: 's', version: 1 }], pkg: { name: 'p', version: 1 },
    }), null);
    assert.ok(!existsSync(installLogPath(dir)), 'dry-run wrote nothing');
    // real write
    const p = updateInstallLogForMirror(ctx(), { installed: [{ type: 'skill', name: 's', version: 1 }], pkg: { name: 'p', version: 1 } });
    assert.equal(p, installLogPath(dir));
    const snapshot = readFileSync(installLogPath(dir), 'utf8');
    // identical mirror again → write-if-changed returns null, file untouched
    assert.equal(updateInstallLogForMirror(ctx(), { installed: [{ type: 'skill', name: 's', version: 1 }], pkg: { name: 'p', version: 1 } }), null);
    assert.equal(readFileSync(installLogPath(dir), 'utf8'), snapshot, 'no-op mirror leaves install.json byte-identical');
  });

  await test('mirror: empty delta or missing pkg → null (nothing to do)', () => {
    const dir = freshDir();
    const ctx = { DRY_RUN: false, PACKAGES_DIR: dir, log: makeLogger({}) };
    assert.equal(updateInstallLogForMirror(ctx, { installed: [], removed: [], pkg: { name: 'p', version: 1 } }), null);
    assert.equal(updateInstallLogForMirror(ctx, { installed: [{ type: 'skill', name: 's' }] }), null, 'no pkg → null');
    assert.ok(!existsSync(installLogPath(dir)));
  });

  await test('PACKAGES_DIR env override + ~/packages default', () => {
    const prev = process.env.PACKAGES_DIR;
    process.env.PACKAGES_DIR = join(packagesDir, 'override');
    assert.equal(resolvePackagesDir(), join(packagesDir, 'override'));
    delete process.env.PACKAGES_DIR;
    assert.ok(resolvePackagesDir().endsWith('/packages'), 'defaults to ~/packages');
    if (prev !== undefined) process.env.PACKAGES_DIR = prev;
    assert.ok(!existsSync(join(packagesDir, 'override')), 'resolution alone creates nothing');
  });
} finally {
  for (const d of cleanups) rmSync(d, { recursive: true, force: true });
}

done();
