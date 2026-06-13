#!/usr/bin/env node
// Backup feature verification — the reverse of install. Self-contained: provisions a sandbox
// schema + temp dirs, installs examples/bundle (DB types only) into it, runs the backup against
// the sandbox schema (getDb()'s INSTALL_SCHEMA redirect — backup itself has no sandbox mode),
// and asserts: dumpYaml round-trips, manifest/file reconstruction, scope + skip rules (D-25/28),
// overwrite-in-place via staged swap (D-26), filters, and a full uninstall → reinstall-from-backup
// round trip. Run from the project root:  node tests/backup.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionSandbox } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { runPlan } from '../scripts/lib/run.mjs';
import { runBackup, dateVersion, resolveBackupName } from '../scripts/lib/backup.mjs';
import { dumpYaml, loadYaml, parseFrontmatter } from '../scripts/lib/parse.mjs';
import { safeName } from '../scripts/lib/fs.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();
const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sb = await provisionSandbox({ ts: stamp, seed: false });
const backupBase = mkdtempSync(join(tmpdir(), 'ai1-backup-'));
console.log(`sandbox ${sb.schema} @ ${sb.baseDir}\n`);

const DB_TYPES = ['skills', 'recipes', 'agents', 'jobs'];   // never touch the service path in tests
const NOW = new Date(2026, 5, 12, 10, 0, 0);                // fixed → version assertable
const outDir = join(backupBase, 'test-backup');
const bctx = (over = {}) => makeCtx({ mode: 'backup', BACKUP_BASE: backupBase, NAME: 'test-backup', ...over });

try {
  // ── pure helpers ─────────────────────────────────────────────────────────────────────────
  console.log('dumpYaml / naming:');

  await test('dumpYaml round-trips every awkward shape via the real YAML parser', () => {
    const obj = {
      plain: 'simple-value',
      colon: 'has: colon',
      hash: 'has # hash',
      multiline: 'line one\nline two',
      icon: '🧪',
      cron: '0 * * * *',
      versionish: '0.4',
      quoted: 'she said "hi" \\ there',
      num: 5,
      bool: false,
      ambiguous: 'no',
      emptyList: [],
      list: ['a', 'b: c'],
      seqOfMaps: [{ path: 'skills/x', version: '0.1.0' }, { path: 'recipes/y.md' }],
      nested: { sub: { deep: 'v' } },
    };
    assert.deepEqual(loadYaml(dumpYaml(obj)), obj);
  });

  await test('dumpYaml omits undefined; frontmatter blocks re-parse cleanly', () => {
    assert.deepEqual(loadYaml(dumpYaml({ a: 1, b: undefined })), { a: 1 });
    const md = `---\n${dumpYaml({ name: 'x', description: 'a: b # c' })}---\n\nBody --- with dashes.\n`;
    const { meta, body } = parseFrontmatter(md);
    assert.deepEqual(meta, { name: 'x', description: 'a: b # c' });
    assert.match(body, /Body --- with dashes\./);
  });

  await test('safeName sanitizes without dot/dash-leading or empty results', () => {
    assert.equal(safeName('my skill/v2'), 'my-skill-v2');
    assert.equal(safeName('..hidden'), 'hidden');
    assert.equal(safeName('日本語'), 'unnamed');
  });

  await test('resolveBackupName honors SATELLITE_ID', () => {
    const prev = process.env.SATELLITE_ID;
    process.env.SATELLITE_ID = 'sat-x';
    try { assert.equal(resolveBackupName(), 'sat-x-backup'); } finally {
      if (prev === undefined) delete process.env.SATELLITE_ID; else process.env.SATELLITE_ID = prev;
    }
    assert.match(resolveBackupName(), /-backup$/);
  });

  // ── seed: install the example bundle + out-of-scope/unrepresentable rows ─────────────────
  const { plan } = loadManifest('examples/bundle');
  await runPlan(makeCtx({ TYPE: DB_TYPES }), plan);
  const db = makeCtx().db;
  const now = new Date();
  const base = { is_active: true, is_global: false, created_at: now, updated_at: now };
  await db('skills').insert({
    name: 'sys-skill', description: 'platform skill', content: 'sys', skill_type: 'system',
    skill_path: 'db://skills/sys-skill', skill_dir: join(sb.baseDir, 'sys-skill'), ...base,
  });
  await db('skills').insert({
    name: 'inactive-skill', description: 'off', content: 'off', skill_type: 'user',
    skill_path: 'db://skills/inactive-skill', skill_dir: join(sb.baseDir, 'inactive-skill'),
    ...base, is_active: false,
  });
  await db('agents').insert({ key: 'sys-agent', name: 'Sys Agent', is_system: true, is_active: true, created_at: now, updated_at: now });
  await db('background_jobs').insert({
    id: 'job-bk-1', name: 'session-job', job_type: 'new_session', script_path: 'node', script_args: 'x',
    schedule: '0 0 * * *', enabled: true, run_count: 0, created_at: now, updated_at: now,
  });
  await db('background_jobs').insert({
    id: 'job-bk-2', name: 'outside-job', job_type: 'script', script_path: 'node',
    script_args: '/elsewhere/run.js --x', schedule: '0 0 * * *', enabled: true, run_count: 0,
    created_at: now, updated_at: now,
  });

  // ── full backup ──────────────────────────────────────────────────────────────────────────
  console.log('\nbackup:');
  let firstRun;

  await test('writes an installable package with the in-scope inventory; skips recorded', async () => {
    const ctx = bctx();
    firstRun = await runBackup(ctx, { now: NOW });
    assert.equal(firstRun.dir, outDir);
    assert.equal(firstRun.meta.version, dateVersion(NOW));
    assert.equal(dateVersion(NOW), '2026.6.12');

    const { meta, plan: bplan } = loadManifest(outDir);   // self-installable at parse level
    assert.equal(meta.name, 'test-backup');
    assert.deepEqual(bplan.skills.map((s) => s.name), ['ai1-sample-skill']);
    assert.deepEqual(bplan.recipes.map((r) => r.name), ['ai1-sample-recipe']);
    assert.deepEqual(bplan.agents.map((a) => a.name), ['ai1-sample-agent']);
    assert.deepEqual(bplan.jobs.map((j) => j.name), ['ai1-sample-job']);

    // out of scope: system + inactive skills, system agent — absent entirely
    assert.ok(!existsSync(join(outDir, 'skills', 'sys-skill')));
    assert.ok(!existsSync(join(outDir, 'skills', 'inactive-skill')));
    assert.ok(!existsSync(join(outDir, 'agents', 'sys-agent.yaml')));

    // unrepresentable jobs: BACKUP-SKIP recorded, no files, exit severity 0
    const skips = ctx.results.filter((r) => r.verdict === 'BACKUP-SKIP').map((r) => r.name).sort();
    assert.deepEqual(skips, ['outside-job', 'session-job']);
    assert.ok(!existsSync(join(outDir, 'jobs', 'session-job.yaml')));
    assert.ok(ctx.results.every((r) => ['BACKUP-OK', 'BACKUP-SKIP'].includes(r.verdict)));
  });

  await test('skill reconstruction: tree copied, SKILL.md regenerated from the DB row', async () => {
    const md = readFileSync(join(outDir, 'skills', 'ai1-sample-skill', 'SKILL.md'), 'utf8');
    const { meta, body } = parseFrontmatter(md);
    assert.equal(meta.name, 'ai1-sample-skill');
    assert.equal(String(meta.version), '0.1.0', 'version recovered from the on-disk SKILL.md frontmatter');
    assert.match(meta.description, /Sample skill used by the ai1-crhq-installer test bundle/);
    const row = await db('skills').where({ name: 'ai1-sample-skill' }).first();
    assert.equal(body.replace(/^\n+/, ''), row.content.replace(/^\n+/, ''), 'body = DB content (authoritative)');
    assert.ok(existsSync(join(outDir, 'skills', 'ai1-sample-skill', 'scripts', 'hello.js')), 'skill tree copied');
  });

  await test('recipe/agent/job reconstruction matches the rows', async () => {
    const { meta: rfm, body: rbody } = parseFrontmatter(readFileSync(join(outDir, 'recipes', 'ai1-sample-recipe.md'), 'utf8'));
    const rrow = await db('recipes').where({ name: 'ai1-sample-recipe' }).first();
    assert.equal(rfm.name, 'ai1-sample-recipe');
    assert.equal(rfm.description, rrow.description);
    assert.equal(rbody.replace(/^\n+/, ''), rrow.content.replace(/^\n+/, ''));

    const agent = loadYaml(readFileSync(join(outDir, 'agents', 'ai1-sample-agent.yaml'), 'utf8'));
    assert.equal(agent.name, 'ai1-sample-agent');               // agents.key → name (D-23 reversed)
    assert.equal(agent.display_name, 'Ai1 Sample Agent');       // agents.name → display_name
    assert.equal(agent.icon, '🧪');
    assert.deepEqual(agent.skills, ['ai1-sample-skill']);
    assert.deepEqual(agent.recipes, ['ai1-sample-recipe']);

    const job = loadYaml(readFileSync(join(outDir, 'jobs', 'ai1-sample-job.yaml'), 'utf8'));
    assert.equal(job.name, 'ai1-sample-job');
    assert.equal(job.schedule, '0 * * * *', 'DB stores resolved cron; backup keeps it');
    assert.equal(job.script, 'ai1-sample-skill/scripts/hello.js', 'script reverse-resolved relative to BASE');
    assert.equal(job.timeout_minutes, 5);
    assert.deepEqual(job.requires, ['ai1-sample-skill'], 'requires re-derived from the script skill segment');
  });

  await test('overwrite-in-place: re-run replaces the dir (stale files gone), same content', async () => {
    writeFileSync(join(outDir, 'stale-marker.txt'), 'old');
    const before = readFileSync(join(outDir, 'ai1-package.yaml'), 'utf8');
    await runBackup(bctx(), { now: NOW });
    assert.ok(!existsSync(join(outDir, 'stale-marker.txt')), 'previous contents replaced');
    assert.equal(readFileSync(join(outDir, 'ai1-package.yaml'), 'utf8'), before, 'deterministic output');
    assert.ok(!existsSync(`${outDir}.staging-${process.pid}`), 'staging dir swapped away');
  });

  // ── round trip: uninstall → reinstall from the backup → identical rows ───────────────────
  console.log('\nround trip:');

  await test('uninstall everything, install the backup package → state matches', async () => {
    const snap = async () => ({
      skill: await db('skills').where({ name: 'ai1-sample-skill' }).first(),
      recipe: await db('recipes').where({ name: 'ai1-sample-recipe' }).first(),
      agent: await db('agents').where({ key: 'ai1-sample-agent' }).first(),
      job: await db('background_jobs').where({ name: 'ai1-sample-job' }).first(),
      links: {
        skills: (await db('agent_skills').where({ agent_key: 'ai1-sample-agent' }).orderBy('skill_name')).map((r) => r.skill_name),
        recipes: (await db('agent_recipes').where({ agent_key: 'ai1-sample-agent' })).length,
      },
    });
    const before = await snap();

    await runPlan(makeCtx({ mode: 'uninstall', TYPE: DB_TYPES }), plan);
    assert.equal(await db('skills').where({ name: 'ai1-sample-skill' }).first(), undefined);

    const { plan: bplan } = loadManifest(outDir);
    const ictx = makeCtx();
    await runPlan(ictx, bplan);
    assert.ok(ictx.results.every((r) => r.verdict === 'INSTALL-OK'), JSON.stringify(ictx.results));

    const after = await snap();
    const FIELDS = {
      skill: ['name', 'description', 'content', 'skill_type', 'locked', 'skill_path', 'skill_dir', 'is_active'],
      recipe: ['name', 'description', 'content', 'is_active'],
      agent: ['key', 'name', 'description', 'mode', 'default_model', 'icon', 'is_active'],
      job: ['name', 'description', 'schedule', 'timezone', 'job_type', 'script_path', 'script_args',
        'timeout_minutes', 'max_concurrent', 'skip_if_running', 'enabled'],
    };
    for (const [kind, fields] of Object.entries(FIELDS)) {
      for (const f of fields) {
        assert.deepEqual(after[kind]?.[f], before[kind]?.[f], `${kind}.${f} round-trips`);
      }
    }
    assert.deepEqual(after.links, before.links, 'agent links round-trip');
  });

  // ── dry-run (D-31) ───────────────────────────────────────────────────────────────────────
  console.log('\ndry-run:');

  await test('dry-run: full inventory + skip reporting, zero filesystem writes', async () => {
    const dryDir = join(backupBase, 'dry-backup');
    const ctx = bctx({ DRY_RUN: true, NAME: 'dry-backup' });
    const { dir, meta } = await runBackup(ctx, { now: NOW });

    // Same scope + verdicts as a real run (incl. BACKUP-SKIP for unrepresentable jobs)...
    assert.equal(dir, dryDir);
    assert.equal(meta.version, dateVersion(NOW));
    assert.deepEqual(meta.components.skills.map((e) => e.path), ['skills/ai1-sample-skill']);
    assert.deepEqual(Object.keys(meta.components).sort(), ['agents', 'jobs', 'recipes', 'skills']);
    const skips = ctx.results.filter((r) => r.verdict === 'BACKUP-SKIP').map((r) => r.name).sort();
    assert.deepEqual(skips, ['outside-job', 'session-job']);
    assert.ok(ctx.results.every((r) => ['BACKUP-OK', 'BACKUP-SKIP'].includes(r.verdict)));

    // ...but nothing written: no package dir, no staging leftovers.
    assert.ok(!existsSync(dryDir), 'package dir not created');
    assert.ok(!existsSync(`${dryDir}.staging-${process.pid}`), 'no staging dir');
  });

  await test('dry-run: does not touch an existing previous backup', async () => {
    const before = readFileSync(join(outDir, 'ai1-package.yaml'), 'utf8');
    writeFileSync(join(outDir, 'keep-marker.txt'), 'still here');
    await runBackup(bctx({ DRY_RUN: true }), { now: NOW });   // same NAME → same dest as outDir
    assert.equal(readFileSync(join(outDir, 'ai1-package.yaml'), 'utf8'), before, 'manifest untouched');
    assert.ok(existsSync(join(outDir, 'keep-marker.txt')), 'previous backup contents untouched');
    rmSync(join(outDir, 'keep-marker.txt'));
  });

  // ── filters ──────────────────────────────────────────────────────────────────────────────
  console.log('\nfilters:');

  await test('--type=skills limits inventory to skills', async () => {
    const { meta } = await runBackup(bctx({ TYPE: ['skills'] }), { now: NOW });
    assert.deepEqual(Object.keys(meta.components), ['skills']);
    assert.ok(!existsSync(join(outDir, 'recipes')));
  });

  await test('--include narrows by name; zero-match warns but succeeds', async () => {
    const { meta } = await runBackup(bctx({ INCLUDE: 'ai1-sample-recipe' }), { now: NOW });
    assert.deepEqual(Object.keys(meta.components), ['recipes']);
    const ctx = bctx({ INCLUDE: 'no-such-component' });
    const { meta: empty } = await runBackup(ctx, { now: NOW });
    assert.deepEqual(empty.components, {});
    assert.equal(ctx.results.length, 0);
  });
} finally {
  rmSync(backupBase, { recursive: true, force: true });
  await sb.teardown(false);
  await closeDb();
}

done();
