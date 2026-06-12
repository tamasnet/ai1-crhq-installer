#!/usr/bin/env node
// install-log verification (D-24) — ${PACKAGES_DIR}/install.json bookkeeping. DB-free: drives
// updateInstallLog directly with a real parsed plan (examples/bundle) and synthetic results.
// Run from the project root:  node tests/install-log.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { updateInstallLog, readInstallLog, installLogPath, resolvePackagesDir } from '../scripts/lib/install-log.mjs';
import { makeLogger, VERDICT } from '../scripts/lib/log.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();

const packagesDir = mkdtempSync(join(tmpdir(), 'ai1-install-log-'));
const { meta, plan, packageRoot } = loadManifest('examples/bundle');
const pkgName = meta.name;

const makeCtx = (over = {}) => ({
  mode: 'install', DRY_RUN: false, PACKAGES_DIR: packagesDir,
  log: makeLogger({ dryRun: !!over.DRY_RUN }), results: [], ...over,
});
const ok = (type, name) => ({ type, name, verdict: VERDICT.OK, action: 'created' });
const already = (type, name) => ({ type, name, verdict: VERDICT.ALREADY, action: 'updated' });
const allOk = () => [
  ok('skill', plan.skills[0].name), ok('recipe', plan.recipes[0].name), ok('agent', plan.agents[0].name),
  ok('job', plan.jobs[0].name), ok('service', plan.services[0].name),
];
const logged = () => readInstallLog(packagesDir);

try {
  await test('install: entry per component with name/version/date/source', () => {
    const p = updateInstallLog(makeCtx({ results: allOk() }), meta, plan, packageRoot);
    assert.equal(p, installLogPath(packagesDir));
    const pkg = logged()[pkgName];
    assert.equal(pkg.version, String(meta.version));
    assert.ok(pkg.installed_at);
    assert.equal(pkg.components.length, 5);
    const skill = pkg.components.find((c) => c.type === 'skill');
    assert.equal(skill.name, plan.skills[0].name);
    assert.equal(skill.version, plan.skills[0].version);
    assert.ok(skill.installed_at);
    assert.equal(skill.source, `skills/${plan.skills[0].key}/SKILL.md`);
    const agent = pkg.components.find((c) => c.type === 'agent');
    assert.equal(agent.source, `agents/${plan.agents[0].name}.yaml`);
    const service = pkg.components.find((c) => c.type === 'service');
    assert.equal(service.source, `services/${plan.services[0].name}/service.yaml`);
    assert.equal(service.version, plan.services[0].version);
  });

  await test('idempotent re-run (ALREADY): component date preserved', () => {
    const before = logged()[pkgName].components.find((c) => c.type === 'skill').installed_at;
    updateInstallLog(makeCtx({ results: [already('skill', plan.skills[0].name)] }), meta, plan, packageRoot);
    const after = logged()[pkgName].components.find((c) => c.type === 'skill').installed_at;
    assert.equal(after, before, 'unchanged component keeps its original install date');
  });

  await test('dry-run: returns null, log untouched', () => {
    const snapshot = readFileSync(installLogPath(packagesDir), 'utf8');
    const p = updateInstallLog(makeCtx({ DRY_RUN: true, results: allOk() }), meta, plan, packageRoot);
    assert.equal(p, null);
    assert.equal(readFileSync(installLogPath(packagesDir), 'utf8'), snapshot);
  });

  await test('status mode: returns null, log untouched', () => {
    const snapshot = readFileSync(installLogPath(packagesDir), 'utf8');
    const p = updateInstallLog(makeCtx({ mode: 'status', results: allOk() }), meta, plan, packageRoot);
    assert.equal(p, null);
    assert.equal(readFileSync(installLogPath(packagesDir), 'utf8'), snapshot);
  });

  await test('failed component: not logged', () => {
    const fail = { type: 'skill', name: 'ghost-skill', verdict: VERDICT.FAIL, action: 'error' };
    updateInstallLog(makeCtx({ results: [fail] }), meta, plan, packageRoot);
    assert.ok(!logged()[pkgName].components.some((c) => c.name === 'ghost-skill'));
  });

  await test('partial uninstall: removes just that component entry', () => {
    updateInstallLog(makeCtx({ mode: 'uninstall', results: [ok('job', plan.jobs[0].name)] }), meta, plan, packageRoot);
    const pkg = logged()[pkgName];
    assert.equal(pkg.components.length, 4);
    assert.ok(!pkg.components.some((c) => c.type === 'job'));
  });

  await test('full uninstall: package entry removed entirely (ALREADY-absent counts)', () => {
    const results = [
      already('skill', plan.skills[0].name), ok('recipe', plan.recipes[0].name), ok('agent', plan.agents[0].name),
      ok('job', plan.jobs[0].name), ok('service', plan.services[0].name),
    ];
    updateInstallLog(makeCtx({ mode: 'uninstall', results }), meta, plan, packageRoot);
    assert.equal(logged()[pkgName], undefined, 'package key deleted with its last component');
  });

  await test('corrupt log: warned and rebuilt, not fatal', () => {
    writeFileSync(installLogPath(packagesDir), '{not json');
    updateInstallLog(makeCtx({ results: [ok('skill', plan.skills[0].name)] }), meta, plan, packageRoot);
    assert.equal(logged()[pkgName].components.length, 1);
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
  rmSync(packagesDir, { recursive: true, force: true });
}

done();
