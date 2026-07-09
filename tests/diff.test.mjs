#!/usr/bin/env node
// diff.mjs — package → live component diff: absent/in-sync/differs states, db/link/file detail.
// Run from the project root:  node tests/diff.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync, chmodSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { provisionSandbox } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { upsertSkill } from '../scripts/lib/core/skill.mjs';
import { upsertRecipe } from '../scripts/lib/core/recipe.mjs';
import { upsertAgent } from '../scripts/lib/core/agent.mjs';
import { upsertJob } from '../scripts/lib/core/job.mjs';
import { runDiff, formatDiffReport } from '../scripts/lib/diff.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));
const DB_TYPES = ['skills', 'recipes', 'agents', 'jobs'];

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sb = await provisionSandbox({ ts: stamp, seed: false });
console.log(`sandbox ${sb.schema} @ ${sb.baseDir}\n`);

try {
  const { plan } = loadManifest('examples/bundle');
  const skillDef = plan.skills[0];
  const skillDir = join(sb.baseDir, skillDef.key);
  const diffOpts = { packageDir: 'examples/bundle', typeScope: DB_TYPES };
  const byName = (r, name) => r.results.find((x) => x.name === name);

  await test('all components absent before install', async () => {
    const r = await runDiff(makeCtx(), diffOpts);
    assert.equal(r.summary.components, 4);
    assert.equal(r.summary.absent, 4);
    assert.equal(r.summary.diffs, 4);
  });

  await test('all components in sync after install', async () => {
    const ctx = makeCtx();
    await upsertSkill(ctx, skillDef);
    await upsertRecipe(ctx, plan.recipes[0]);
    await upsertAgent(ctx, plan.agents[0]);
    await upsertJob(ctx, plan.jobs[0]);
    const r = await runDiff(makeCtx(), diffOpts);
    assert.equal(r.summary.in_sync, 4, JSON.stringify(r.results));
    assert.equal(r.summary.diffs, 0);
  });

  await test('live file edits → differs with modified/extra lists; protected set aside', async () => {
    appendFileSync(join(skillDir, 'scripts', 'hello.js'), '\n// live edit\n');
    writeFileSync(join(skillDir, 'junk.txt'), 'stray');
    mkdirSync(join(skillDir, 'data'), { recursive: true });
    writeFileSync(join(skillDir, 'data', 'live.db'), 'state');
    const r = await runDiff(makeCtx(), diffOpts);
    const row = byName(r, skillDef.name);
    assert.equal(row.state, 'differs');
    assert.deepEqual(row.files.modified, ['scripts/hello.js']);
    assert.deepEqual(row.files.extra, ['junk.txt']);
    assert.deepEqual(row.files.protected, ['data']);
  });

  await test('live DB edit → differs with named field', async () => {
    const ctx = makeCtx();
    await ctx.db('recipes').where({ name: plan.recipes[0].name }).update({ description: 'edited live' });
    const r = await runDiff(makeCtx(), diffOpts);
    const row = byName(r, plan.recipes[0].name);
    assert.equal(row.state, 'differs');
    assert.deepEqual(row.db, ['description']);
  });

  await test('removed agent link → differs with linkChanges', async () => {
    const ctx = makeCtx();
    await ctx.db('agent_skills').where({ agent_key: plan.agents[0].name }).del();
    const r = await runDiff(makeCtx(), diffOpts);
    const row = byName(r, plan.agents[0].name);
    assert.equal(row.state, 'differs');
    assert.ok(row.links.skills.add.includes(skillDef.name));
  });

  await test('formatDiffReport lists per-file marks', async () => {
    const r = await runDiff(makeCtx(), diffOpts);
    const text = formatDiffReport(r);
    assert.match(text, /~ scripts\/hello\.js/);
    assert.match(text, /- junk\.txt/);
    assert.match(text, /protected: data/);
  });

  console.log('\nCLI:');

  const cli = (args) => spawnSync(process.execPath, ['scripts/diff.mjs', ...args], { cwd: root, encoding: 'utf8' });

  await test('--help prints usage; unknown option → exit 2', () => {
    const h = cli(['--help']);
    assert.equal(h.status, 0);
    assert.match(h.stdout, /Usage: diff\.mjs/);
    const bad = cli(['--nope']);
    assert.equal(bad.status, 2);
    assert.match(`${bad.stdout}${bad.stderr}`, /unknown option/);
  });

  await test('CLI --json reports the drifted skill, exit 1', () => {
    const r = cli(['examples/bundle', '--type=skill', '--json']);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.summary.differs, 1);
    assert.equal(body.results[0].files.modified[0], 'scripts/hello.js');
  });

  await test('CLI exits 0 when scope has no differences', async () => {
    const ctx = makeCtx();
    // restore skill assets so only db/recipe + agent drift remain
    rmSync(join(skillDir, 'junk.txt'));
    await upsertSkill({ ...ctx, STRICT: true }, skillDef);
    const r = cli(['examples/bundle', '--type=skill', '--json']);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).summary.in_sync, 1);
  });

  console.log('\n--strict metadata sensitivity:');

  await test('mode-only change: in-sync by default, annotated meta with strict', async () => {
    chmodSync(join(skillDir, 'scripts', 'hello.js'), 0o700);
    const scope = { packageDir: 'examples/bundle', typeScope: ['skills'] };
    const dflt = await runDiff(makeCtx(), scope);
    assert.equal(dflt.summary.in_sync, 1, JSON.stringify(dflt.results));
    const strict = await runDiff(makeCtx(), { ...scope, strict: true });
    const row = strict.results[0];
    assert.equal(row.state, 'differs');
    assert.match(row.files.meta[0], /^scripts\/hello\.js \(mode \d+→700\)$/);
    assert.match(formatDiffReport(strict), /~ scripts\/hello\.js \(mode \d+→700\)/);
  });

  await test('mtime-only change: in-sync by default, "(mtime)" with strict', async () => {
    const pkgMode = statSync(join(skillDef.srcDir, 'scripts', 'hello.js')).mode & 0o777;
    chmodSync(join(skillDir, 'scripts', 'hello.js'), pkgMode);   // restore mode to package's
    utimesSync(join(skillDir, 'scripts', 'hello.js'), new Date(0), new Date(0));
    const scope = { packageDir: 'examples/bundle', typeScope: ['skills'] };
    const dflt = await runDiff(makeCtx(), scope);
    assert.equal(dflt.summary.in_sync, 1, JSON.stringify(dflt.results));
    const strict = await runDiff(makeCtx(), { ...scope, strict: true });
    assert.deepEqual(strict.results[0].files.meta, ['scripts/hello.js (mtime)']);
  });
} finally {
  await sb.teardown(false);
  await closeDb();
}

done();
