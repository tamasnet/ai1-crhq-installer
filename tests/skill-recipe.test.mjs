#!/usr/bin/env node
// Phase 2 verification — skill + recipe install paths. Self-contained: provisions a sandbox
// schema + temp dir, exercises the primitives directly with row-level assertions, and tears down.
// Run from the project root:  node tests/skill-recipe.test.mjs
//
// Note: CREATE TABLE … LIKE does not copy triggers, so the live skills lock TRIGGER is absent in
// the sandbox. These tests therefore validate the installer's lock LOGIC (does upsertSkill honor
// row.locked + --respect-locks, and unlock-then-update by default), not the DB trigger itself.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { provisionSandbox, runLifecycle } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { loadManifest, ManifestError } from '../scripts/lib/manifest.mjs';
import { upsertSkill, removeSkill, statusSkill } from '../scripts/lib/core/skill.mjs';
import { upsertRecipe, removeRecipe, statusRecipe } from '../scripts/lib/core/recipe.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sb = await provisionSandbox({ ts: stamp, seed: false });
console.log(`sandbox ${sb.schema} @ ${sb.baseDir}\n`);

try {
  const { plan } = loadManifest('examples/bundle');
  const skillDef = plan.skills[0];    // ai1-sample-skill
  const recipeDef = plan.recipes[0];  // ai1-sample-recipe
  const ctx = makeCtx();
  const skillDir = join(sb.baseDir, skillDef.key);
  const skillRow = () => ctx.db('skills').where({ name: skillDef.name }).first();

  console.log('skills:');

  await test('create: verdict OK, row fields correct, assets copied', async () => {
    const r = await upsertSkill(ctx, skillDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(r.action, 'created');
    assert.equal(r.files, 2, 'SKILL.md + scripts/hello.js copied');
    const row = await skillRow();
    assert.equal(row.skill_type, 'user');
    assert.equal(row.skill_path, `db://skills/${skillDef.name}`);
    assert.equal(row.skill_dir, skillDir);
    assert.equal(row.is_active, true);
    assert.equal(row.is_global, false);
    assert.ok(row.content.includes('# Ai1 Sample Skill'), 'content = SKILL.md body');
    assert.ok(!row.content.includes('name: ai1-sample-skill'), 'frontmatter stripped from content');
    assert.ok(existsSync(join(skillDir, 'SKILL.md')));
    assert.ok(existsSync(join(skillDir, 'scripts', 'hello.js')));
  });

  await test('idempotent: re-run → ALREADY-INSTALLED, zero files re-copied', async () => {
    const r = await upsertSkill(ctx, skillDef);
    assert.equal(r.verdict, 'ALREADY-INSTALLED');
    assert.equal(r.files, 0);
  });

  await test('update: changed content → OK, row content updated', async () => {
    const r = await upsertSkill(ctx, { ...skillDef, content: `${skillDef.content}\nUPDATED-MARKER` });
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.ok((await skillRow()).content.endsWith('UPDATED-MARKER'));
  });

  await test('lock + --respect-locks: skipped, row untouched', async () => {
    await ctx.db('skills').where({ name: skillDef.name }).update({ locked: true, content: 'LOCKED-OLD', skill_type: 'system' });
    const r = await upsertSkill(makeCtx({ RESPECT_LOCKS: true }), skillDef);
    assert.equal(r.verdict, 'LOCKED-ROW');
    assert.equal(r.action, 'skipped');
    const row = await skillRow();
    assert.equal(row.content, 'LOCKED-OLD', 'locked row not modified');
    assert.equal(row.locked, true, 'still locked');
  });

  await test('lock default: auto-unlock then update', async () => {
    const r = await upsertSkill(ctx, skillDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    const row = await skillRow();
    assert.equal(row.locked, false, 'unlocked');
    assert.equal(row.skill_type, 'user', 'restored to user');
    assert.ok(row.content.includes('# Ai1 Sample Skill'));
  });

  await test('dry-run: zero writes (no row, no dir) for a new skill', async () => {
    const dryDef = { ...skillDef, key: 'ai1-dry-skill', name: 'ai1-dry-skill' };
    const r = await upsertSkill(makeCtx({ DRY_RUN: true }), dryDef);
    assert.equal(r.verdict, 'INSTALL-OK');           // "would create"
    assert.equal(await ctx.db('skills').where({ name: 'ai1-dry-skill' }).first(), undefined, 'no row written');
    assert.equal(existsSync(join(sb.baseDir, 'ai1-dry-skill')), false, 'no dir written');
  });

  await test('status: present/active/filesPresent, and absent', async () => {
    const s = await statusSkill(ctx, skillDef.name);
    assert.deepEqual([s.present, s.active, s.filesPresent], [true, true, true]);
    const a = await statusSkill(ctx, 'no-such-skill');
    assert.equal(a.present, false);
    assert.equal(a.verdict, 'NOT-INSTALLED');
  });

  await test('remove: row + dir gone', async () => {
    const r = await removeSkill(ctx, skillDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(r.action, 'removed');
    assert.equal(await skillRow(), undefined);
    assert.equal(existsSync(skillDir), false);
  });

  console.log('\nrecipes:');
  const recipeRow = () => ctx.db('recipes').where({ name: recipeDef.name }).first();

  await test('create: OK, content = body, NOT-NULL fields set', async () => {
    const r = await upsertRecipe(ctx, recipeDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    const row = await recipeRow();
    assert.ok(row.id, 'uuid auto-generated');
    assert.ok(row.content.includes('# Ai1 Sample Recipe'));
    assert.equal(row.is_active, true);
    assert.ok(row.description.length > 0);
  });

  await test('idempotent: re-run → ALREADY, uuid stable', async () => {
    const before = (await recipeRow()).id;
    const r = await upsertRecipe(ctx, recipeDef);
    assert.equal(r.verdict, 'ALREADY-INSTALLED');
    assert.equal((await recipeRow()).id, before);
  });

  await test('update: changed content → OK', async () => {
    const r = await upsertRecipe(ctx, { ...recipeDef, content: `${recipeDef.content}\nEXTRA` });
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.ok((await recipeRow()).content.endsWith('EXTRA'));
  });

  await test('status + remove', async () => {
    assert.equal((await statusRecipe(ctx, recipeDef.name)).present, true);
    const r = await removeRecipe(ctx, recipeDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(await recipeRow(), undefined);
    assert.equal((await statusRecipe(ctx, recipeDef.name)).present, false);
  });

  console.log('\nnegatives:');

  await test('missing SKILL.md → ManifestError', async () => {
    const badPkg = join(sb.baseDir, 'badpkg');
    mkdirSync(join(badPkg, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(badPkg, 'ai1-package.yaml'),
      'name: bad\nversion: 0.0.1\ndescription: x\ncomponents:\n  skills:\n    - path: skills/foo\n      version: 0.0.1\n');
    assert.throws(() => loadManifest(badPkg), (e) => e instanceof ManifestError && /SKILL\.md/.test(e.message));
  });

  await test('skill version pin mismatch → ManifestError', async () => {
    const badPkg = join(sb.baseDir, 'badpin');
    mkdirSync(join(badPkg, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(badPkg, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\nversion: 9.9.9\ndescription: d\n---\nbody');
    writeFileSync(join(badPkg, 'ai1-package.yaml'),
      'name: bad\nversion: 0.0.1\ndescription: x\ncomponents:\n  skills:\n    - path: skills/foo\n      version: 0.0.1\n');
    assert.throws(() => loadManifest(badPkg), (e) => e instanceof ManifestError && /version/.test(e.message));
  });

  console.log('\nskills+recipes-only lifecycle:');
  await test('full lifecycle (skills + recipes) → ALL PASS', async () => {
    const lctx = makeCtx();
    const plan2 = { skills: [skillDef], recipes: [recipeDef], agents: [], jobs: [], services: [] };
    const res = await runLifecycle(lctx, plan2);
    assert.equal(res.passed, true, res.phases.filter((p) => !p.passed).map((p) => `${p.name}: ${p.detail}`).join('; '));
  });
} finally {
  await sb.teardown(false);
  await closeDb();
}

done();
