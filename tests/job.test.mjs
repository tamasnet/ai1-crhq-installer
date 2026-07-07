#!/usr/bin/env node
// background_jobs install verification. Self-contained: provisions a sandbox, runs a
// focused skill+job lifecycle, then exercises upsertJob/removeJob/statusJob with row assertions
// (id minting, script_args resolution, schedule-alias expansion, requires-prereq guard, dry-run).
// Tears down. Run from the project root:  node tests/job.test.mjs
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { provisionSandbox, runLifecycle } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { loadYaml } from '../scripts/lib/parse.mjs';
import { upsertSkill } from '../scripts/lib/core/skill.mjs';
import { upsertJob, removeJob, statusJob, exportJob } from '../scripts/lib/core/job.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sb = await provisionSandbox({ ts: stamp, seed: false });
console.log(`sandbox ${sb.schema} @ ${sb.baseDir}\n`);

const ctx = makeCtx();
const jobRow = (name) => ctx.db('background_jobs').where({ name }).first();
const wipe = async () => { for (const t of ['background_jobs', 'skills']) await ctx.db(t).del(); };

try {
  const { plan } = loadManifest('examples/bundle');
  const skillDef = plan.skills[0];   // ai1-sample-skill
  const jobDef = plan.jobs[0];       // ai1-sample-job: schedule hourly, requires [ai1-sample-skill]
  const skillDir = join(sb.baseDir, skillDef.key);
  const expectedScript = join(sb.baseDir, 'ai1-sample-skill', 'scripts', 'hello.js');

  // ── A. Focused lifecycle FIRST on a pristine schema ────────────
  console.log('job lifecycle (skill + job):');
  await test('full lifecycle → ALL PASS (job present post-install, gone post-uninstall)', async () => {
    const lplan = { skills: [skillDef], recipes: [], agents: [], jobs: [jobDef], services: [] };
    const res = await runLifecycle(makeCtx(), lplan);
    assert.equal(res.passed, true, res.phases.filter((p) => !p.passed).map((p) => `${p.name}: ${p.detail}`).join('; '));
  });

  // Reset DB + disk so the prereq-failure test starts with the skill dir absent.
  await wipe();
  rmSync(skillDir, { recursive: true, force: true });

  console.log('\njob install:');

  await test('prereq: missing required skill dir → PrereqError', async () => {
    await assert.rejects(
      () => upsertJob(ctx, jobDef),
      (e) => e.name === 'PrereqError' && e.missing.includes('ai1-sample-skill'),
    );
    assert.equal(await jobRow(jobDef.name), undefined, 'no row written on prereq failure');
  });

  await upsertSkill(ctx, skillDef);  // create the install dir the job requires

  await test('create: id minted + canon columns + script_args resolved', async () => {
    const r = await upsertJob(ctx, jobDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(r.action, 'created');
    const row = await jobRow(jobDef.name);
    assert.match(row.id, /^job-\d+-[a-z0-9]+$/);
    assert.equal(row.job_type, 'script');
    assert.equal(row.script_path, 'node');
    assert.equal(row.script_args, expectedScript, 'script resolved under SKILLS_BASE_DIR');
    assert.equal(row.schedule, '0 * * * *', 'hourly alias expanded');
    assert.equal(row.timezone, 'UTC');
    assert.equal(row.timeout_minutes, 5);
    assert.equal(row.max_concurrent, 1);
    assert.equal(row.skip_if_running, true);
    assert.equal(row.enabled, true);
    assert.equal(row.run_count, 0);
  });

  await test('idempotent: re-run → ALREADY, id stable', async () => {
    const id = (await jobRow(jobDef.name)).id;
    const r = await upsertJob(ctx, jobDef);
    assert.equal(r.verdict, 'ALREADY-INSTALLED');
    assert.equal((await jobRow(jobDef.name)).id, id);
  });

  await test('update: changed args → OK, id preserved, script_args appends args', async () => {
    const id = (await jobRow(jobDef.name)).id;
    const r = await upsertJob(ctx, { ...jobDef, args: '--limit 5' });
    assert.equal(r.verdict, 'INSTALL-OK');
    const row = await jobRow(jobDef.name);
    assert.equal(row.id, id, 'id not re-minted on update');
    assert.equal(row.script_args, `${expectedScript} --limit 5`);
  });

  await test('schedule aliases + raw cron passthrough', async () => {
    const cases = { 'ai1-daily': ['daily', '0 0 * * *'], 'ai1-q': ['every-15-min', '*/15 * * * *'], 'ai1-raw': ['*/5 * * * *', '*/5 * * * *'] };
    for (const [name, [sched, expected]] of Object.entries(cases)) {
      await upsertJob(ctx, { ...jobDef, name, schedule: sched });
      assert.equal((await jobRow(name)).schedule, expected, `${sched} → ${expected}`);
    }
  });

  await test('dry-run: no row written', async () => {
    const r = await upsertJob(makeCtx({ DRY_RUN: true }), { ...jobDef, name: 'ai1-dry-job' });
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(await jobRow('ai1-dry-job'), undefined);
  });

  await test('status: present/enabled/schedule, and absent', async () => {
    const s = await statusJob(ctx, jobDef.name);
    assert.deepEqual([s.present, s.enabled, s.schedule], [true, true, '0 * * * *']);
    const a = await statusJob(ctx, 'no-such-job');
    assert.equal(a.present, false);
    assert.equal(a.verdict, 'NOT-INSTALLED');
  });

  await test('remove: row gone; idempotent', async () => {
    const r = await removeJob(ctx, jobDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(r.action, 'removed');
    assert.equal(await jobRow(jobDef.name), undefined);
    assert.equal((await removeJob(ctx, jobDef)).verdict, 'ALREADY-INSTALLED', 'absent → ALREADY');
  });

  console.log('\nnew_session jobs:');

  await test('create: new_session row with agent/task/model', async () => {
    const def = {
      name: 'ai1-session-job',
      job_type: 'new_session',
      schedule: '15 0 * * *',
      timezone: 'America/New_York',
      agent: 'operator',
      task: 'Run heartbeat check.',
      model: 'sonnet',
    };
    const r = await upsertJob(ctx, def);
    assert.equal(r.verdict, 'INSTALL-OK');
    const row = await jobRow(def.name);
    assert.equal(row.job_type, 'new_session');
    assert.equal(row.agent, 'operator');
    assert.equal(row.task, 'Run heartbeat check.');
    assert.equal(row.model, 'sonnet');
    assert.equal(row.script_path, null);
    assert.equal(row.script_args, null);
  });

  await test('export: new_session round-trips to YAML', async () => {
    const row = await jobRow('ai1-session-job');
    const outRoot = join(sb.baseDir, 'export');
    mkdirSync(outRoot, { recursive: true });
    const relPath = 'jobs/ai1-session-job.yaml';
    const r = await exportJob(ctx, row, { outRoot, relPath, skillNames: new Set() });
    assert.equal(r.verdict, 'BACKUP-OK');
    const j = loadYaml(readFileSync(join(outRoot, relPath), 'utf8'));
    assert.equal(j.job_type, 'new_session');
    assert.equal(j.agent, 'operator');
    assert.equal(j.task, 'Run heartbeat check.');
  });
} finally {
  await sb.teardown(false);
  await closeDb();
}

done();
