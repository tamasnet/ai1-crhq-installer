#!/usr/bin/env node
// drift.mjs verification — read-only managed drift + orphan reporting.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { updateInstallLog } from '../scripts/lib/install-log.mjs';
import { provisionSandbox } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { writeFileSync } from 'node:fs';
import { upsertSkill, removeSkill, planSkill } from '../scripts/lib/core/skill.mjs';
import { upsertRecipe } from '../scripts/lib/core/recipe.mjs';
import { upsertAgent } from '../scripts/lib/core/agent.mjs';
import { upsertJob } from '../scripts/lib/core/job.mjs';
import { makeLogger, VERDICT } from '../scripts/lib/log.mjs';
import { indexPackageStores, runDrift, formatDriftReport } from '../scripts/lib/drift.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));
const bundleDir = join(root, 'examples', 'bundle');
const examplesBase = join(root, 'examples');

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sb = await provisionSandbox({ ts: stamp, seed: false });
console.log(`sandbox ${sb.schema} @ ${sb.baseDir}\n`);

const { meta, plan, packageRoot } = loadManifest(bundleDir);
const skillDef = plan.skills[0];
const recipeDef = plan.recipes[0];
const agentDef = plan.agents[0];
const jobDef = plan.jobs[0];

const stores = [{ label: 'examples', base: examplesBase }];
const driftCtx = () => makeCtx({ PACKAGES_DIR: sb.packagesDir, DRY_RUN: true });

const recordInstall = async () => {
  const ctx = makeCtx({ PACKAGES_DIR: sb.packagesDir, mode: 'install' });
  const results = [];
  results.push(await upsertSkill(ctx, skillDef));
  results.push(await upsertRecipe(ctx, recipeDef));
  results.push(await upsertAgent(ctx, agentDef));
  results.push(await upsertJob(ctx, jobDef));
  updateInstallLog(
    { ...ctx, results, log: makeLogger({}) },
    meta,
    { skills: [skillDef], recipes: [recipeDef], agents: [agentDef], jobs: [jobDef] },
    packageRoot,
  );
};

try {
  console.log('indexPackageStores:');
  await test('finds examples/bundle by name@version', () => {
    const { byKey } = indexPackageStores(stores);
    const loc = byKey.get(`${meta.name}@${meta.version}`);
    assert.ok(loc, 'package indexed');
    assert.ok(loc.dir.endsWith('/examples/bundle'));
  });

  console.log('\nmanaged drift:');
  await test('in-sync after install matches package source', async () => {
    await recordInstall();
    const result = await runDrift(driftCtx(), { stores });
    assert.equal(result.summary.drift, 0, formatDriftReport(result));
    assert.equal(result.summary.in_sync, 4);
    assert.equal(result.managed.length, 4);
  });

  await test('modified when live skill content diverges from package', async () => {
    const ctx = driftCtx();
    await ctx.db('skills').where({ name: skillDef.name }).update({
      content: `${skillDef.content}\nLOCAL-EDIT`,
    });
    const result = await runDrift(ctx, { stores });
    const row = result.managed.find((r) => r.type === 'skill' && r.name === skillDef.name);
    assert.equal(row?.state, 'modified');
    assert.equal(row?.package, meta.name);
    assert.ok(row?.source_path);
    assert.ok(row?.package_location);
    assert.equal(result.outOfSync.length, 1);
    assert.equal(result.summary.drift, 1);
  });

  await test('modified when live skill script diverges from package (DB unchanged)', async () => {
    await recordInstall();
    const ctx = makeCtx({ PACKAGES_DIR: sb.packagesDir });
    const skillDir = join(sb.baseDir, skillDef.key);
    writeFileSync(join(skillDir, 'scripts', 'hello.js'), '// local edit\n', 'utf8');
    const result = await runDrift(driftCtx(), { stores });
    const row = result.managed.find((r) => r.type === 'skill' && r.name === skillDef.name);
    assert.equal(row?.state, 'modified');
    assert.match(row?.detail || '', /files/);
    const plan = await planSkill(ctx, skillDef);
    assert.equal(plan.verdict, VERDICT.OK);
    assert.equal(plan.dimensions.files, true);
  });

  await test('plan ALREADY matches upsert ALREADY after install', async () => {
    await recordInstall();
    const ctx = makeCtx({ PACKAGES_DIR: sb.packagesDir, mode: 'install' });
    const plan = await planSkill(ctx, skillDef);
    const r = await upsertSkill(ctx, skillDef);
    assert.equal(plan.verdict, VERDICT.ALREADY);
    assert.equal(r.verdict, VERDICT.ALREADY);
  });

  await test('absent when a logged component is removed from the satellite', async () => {
    await removeSkill(makeCtx({ PACKAGES_DIR: sb.packagesDir }), skillDef.name);
    const result = await runDrift(driftCtx(), { stores });
    const row = result.managed.find((r) => r.type === 'skill');
    assert.equal(row?.state, 'absent');
  });

  await test('source-missing when the package is not in local stores', async () => {
    await recordInstall();
    const result = await runDrift(driftCtx(), { stores: [{ label: 'empty', base: sb.packagesDir }] });
    assert.ok(result.managed.every((r) => r.state === 'source-missing'));
    assert.equal(result.summary.source_missing, 4);
  });

  console.log('\norphans:');
  await test('reports live user skill not in install log', async () => {
    await recordInstall();
    const ctx = driftCtx();
    const now = new Date();
    await ctx.db('skills').insert({
      name: 'orphan-skill',
      description: 'orphan',
      content: 'body',
      skill_path: 'db://skills/orphan-skill',
      skill_dir: join(sb.baseDir, 'orphan-skill'),
      skill_type: 'user',
      is_active: true,
      is_global: false,
      locked: false,
      created_at: now,
      updated_at: now,
    });
    const result = await runDrift(ctx, { stores });
    assert.ok(result.orphans.some((r) => r.name === 'orphan-skill'));
    assert.equal(result.summary.orphans, 1);
  });

  console.log('\nformatDriftReport:');
  await test('human report lists all out-of-sync rows with package details', async () => {
    const text = formatDriftReport({
      summary: { drift: 2, in_sync: 0, modified: 1, absent: 1, source_missing: 0, orphans: 0, managed: 2 },
      outOfSync: [
        {
          type: 'skill', name: 'x', state: 'modified', version: 1,
          package: 'p', package_version: '1', source_path: 'skills/x.md',
          package_location: '/home/agent/packages/p@1', detail: 'updated',
        },
        {
          type: 'recipe', name: 'y', state: 'absent', version: 2,
          package: 'p', package_version: '1', source_path: 'recipes/y.md',
          package_location: '/home/agent/packages/p@1',
        },
      ],
      orphans: [],
      warnings: [],
    });
    assert.match(text, /Out of sync/);
    assert.match(text, /modified/);
    assert.match(text, /absent/);
    assert.match(text, /skills\/x\.md/);
    assert.match(text, /p@1/);
    assert.match(text, /VERSION/);
  });

  console.log('\ndrift.mjs CLI:');
  await test('--help exits 0', () => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/drift.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--package/);
  });
} finally {
  await sb.teardown(false);
  await closeDb();
  done();
}
