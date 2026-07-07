#!/usr/bin/env node
// Skill + recipe install-path verification. Self-contained: provisions a sandbox
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
import { loadManifest, validateManifest, ManifestError, INSTALLER_VERSION } from '../scripts/lib/manifest.mjs';
import { upsertSkill, removeSkill, statusSkill, planSkill } from '../scripts/lib/core/skill.mjs';
import { upsertRecipe, removeRecipe, statusRecipe, planRecipe } from '../scripts/lib/core/recipe.mjs';
import { currentVersion } from '../scripts/lib/version-history.mjs';
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

  await test('create: default org+locked, row fields correct, assets copied', async () => {
    const r = await upsertSkill(ctx, skillDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(r.action, 'created');
    assert.equal(r.files, 2, 'SKILL.md + scripts/hello.js copied');
    const row = await skillRow();
    assert.equal(row.skill_type, 'org', 'default registration is org');
    assert.equal(row.locked, true, 'org skills install locked');
    assert.equal(row.skill_path, `db://skills/${skillDef.name}`);
    assert.equal(row.skill_dir, skillDir, 'still under SKILLS_BASE_DIR');
    assert.equal(row.is_active, true);
    assert.equal(row.is_global, false);
    assert.ok(row.content.includes('# Ai1 Sample Skill'), 'content = SKILL.md body');
    assert.ok(!row.content.includes('name: ai1-sample-skill'), 'frontmatter stripped from content');
    assert.ok(existsSync(join(skillDir, 'SKILL.md')));
    assert.ok(existsSync(join(skillDir, 'scripts', 'hello.js')));
  });

  await test('version history: skill_versions row at version_num = package version', async () => {
    const rows = await ctx.db('skill_versions').where({ skill_name: skillDef.name });
    assert.equal(rows.length, 1, 'one snapshot recorded');
    assert.equal(rows[0].version_num, skillDef.version, 'version_num matches the integer package version');
    assert.equal(rows[0].version_num, 1);
    assert.ok((rows[0].change_summary || '').length > 0, 'change_summary set');
    assert.ok(rows[0].content.includes('# Ai1 Sample Skill'), 'snapshot carries the body');
  });

  await test('idempotent: re-run → ALREADY-INSTALLED, zero files, stays locked', async () => {
    const r = await upsertSkill(ctx, skillDef);
    assert.equal(r.verdict, 'ALREADY-INSTALLED');
    assert.equal(r.files, 0);
    assert.equal((await planSkill(ctx, skillDef)).verdict, 'ALREADY-INSTALLED');
    assert.equal((await skillRow()).locked, true, 'org skill remains locked across re-install');
    assert.equal((await ctx.db('skill_versions').where({ skill_name: skillDef.name })).length, 1, 're-install merges, no duplicate version row');
  });

  await test('update: changed content → OK, row content updated, stays org+locked', async () => {
    const r = await upsertSkill(ctx, { ...skillDef, content: `${skillDef.content}\nUPDATED-MARKER` });
    assert.equal(r.verdict, 'INSTALL-OK');
    const row = await skillRow();
    assert.ok(row.content.endsWith('UPDATED-MARKER'));
    assert.equal(row.skill_type, 'org');
    assert.equal(row.locked, true, 'unlock-then-update leaves it locked again');
  });

  await test('install_type: user (manifest entry) → user skill, unlocked', async () => {
    const def = { ...skillDef, key: 'ai1-user-skill', name: 'ai1-user-skill', installType: 'user' };
    const r = await upsertSkill(ctx, def);
    assert.equal(r.verdict, 'INSTALL-OK');
    const row = await ctx.db('skills').where({ name: 'ai1-user-skill' }).first();
    assert.equal(row.skill_type, 'user');
    assert.equal(row.locked, false);
  });

  await test('--install-skills-as-user flag → user, unlocked (overrides org default)', async () => {
    const def = { ...skillDef, key: 'ai1-flag-skill', name: 'ai1-flag-skill' };  // no install_type → org by default
    const r = await upsertSkill(makeCtx({ INSTALL_SKILLS_AS_USER: true }), def);
    assert.equal(r.verdict, 'INSTALL-OK');
    const row = await ctx.db('skills').where({ name: 'ai1-flag-skill' }).first();
    assert.equal(row.skill_type, 'user');
    assert.equal(row.locked, false);
  });

  await test('--install-skills-as-user overrides an explicit install_type: org', async () => {
    const def = { ...skillDef, key: 'ai1-flagorg-skill', name: 'ai1-flagorg-skill', installType: 'org' };
    await upsertSkill(makeCtx({ INSTALL_SKILLS_AS_USER: true }), def);
    assert.equal((await ctx.db('skills').where({ name: 'ai1-flagorg-skill' }).first()).skill_type, 'user', 'flag wins');
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

  await test('locked row: auto-unlock then update, restored to org+locked', async () => {
    const r = await upsertSkill(ctx, skillDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    const row = await skillRow();
    assert.equal(row.skill_type, 'org', 'restored to org default');
    assert.equal(row.locked, true, 're-locked after the unlock-then-update');
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
    assert.equal((await ctx.db('skill_versions').where({ skill_name: skillDef.name })).length, 0, 'version history removed with the skill');
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

  await test('version history: recipe_versions row at version_num = package version', async () => {
    const id = (await recipeRow()).id;
    const rows = await ctx.db('recipe_versions').where({ recipe_id: id });
    assert.equal(rows.length, 1, 'one snapshot recorded');
    assert.equal(rows[0].version_num, recipeDef.version, 'version_num matches the integer package version');
    assert.equal(rows[0].version_num, 1);
  });

  await test('idempotent: re-run → ALREADY, uuid stable', async () => {
    const before = (await recipeRow()).id;
    const r = await upsertRecipe(ctx, recipeDef);
    assert.equal(r.verdict, 'ALREADY-INSTALLED');
    assert.equal((await planRecipe(ctx, recipeDef)).verdict, 'ALREADY-INSTALLED');
    assert.equal((await recipeRow()).id, before);
  });

  await test('update: changed content → OK', async () => {
    const r = await upsertRecipe(ctx, { ...recipeDef, content: `${recipeDef.content}\nEXTRA` });
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.ok((await recipeRow()).content.endsWith('EXTRA'));
  });

  await test('status + remove', async () => {
    assert.equal((await statusRecipe(ctx, recipeDef.name)).present, true);
    const id = (await recipeRow()).id;
    const r = await removeRecipe(ctx, recipeDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(await recipeRow(), undefined);
    assert.equal((await statusRecipe(ctx, recipeDef.name)).present, false);
    assert.equal((await ctx.db('recipe_versions').where({ recipe_id: id })).length, 0, 'version history removed with the recipe');
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
    writeFileSync(join(badPkg, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\nversion: 9\ndescription: d\n---\nbody');
    writeFileSync(join(badPkg, 'ai1-package.yaml'),
      'name: bad\nversion: 0.0.1\ndescription: x\ncomponents:\n  skills:\n    - path: skills/foo\n      version: 1\n');
    assert.throws(() => loadManifest(badPkg), (e) => e instanceof ManifestError && /!= manifest pin/.test(e.message));
  });

  await test('non-integer skill version (old semver) → ManifestError', async () => {
    const badPkg = join(sb.baseDir, 'badver');
    mkdirSync(join(badPkg, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(badPkg, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\nversion: 0.1.0\ndescription: d\n---\nbody');
    writeFileSync(join(badPkg, 'ai1-package.yaml'),
      'name: bad\nversion: 0.0.1\ndescription: x\ncomponents:\n  skills:\n    - path: skills/foo\n      version: 0.1.0\n');
    assert.throws(() => loadManifest(badPkg), (e) => e instanceof ManifestError && /positive integer/.test(e.message));
  });

  await test('invalid install_type → ManifestError', async () => {
    const badPkg = join(sb.baseDir, 'badtype');
    mkdirSync(join(badPkg, 'skills', 'foo'), { recursive: true });
    writeFileSync(join(badPkg, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\nversion: 1\ndescription: d\n---\nbody');
    writeFileSync(join(badPkg, 'ai1-package.yaml'),
      'name: bad\nversion: 0.0.1\ndescription: x\ncomponents:\n  skills:\n    - path: skills/foo\n      version: 1\n      install_type: bogus\n');
    assert.throws(() => loadManifest(badPkg), (e) => e instanceof ManifestError && /install_type/.test(e.message));
  });

  await test('installer: plain integer ≤ current → ok; too-new → ManifestError', () => {
    const base = { name: 'p', version: 1, description: 'x', components: {} };
    validateManifest({ ...base, installer: INSTALLER_VERSION });   // requires this version → must not throw
    assert.throws(() => validateManifest({ ...base, installer: INSTALLER_VERSION + 1 }),
      (e) => e instanceof ManifestError && /requires installer version/.test(e.message));
  });

  await test('installer: old semver string → ManifestError (must be a plain integer)', () => {
    assert.throws(() => validateManifest({ name: 'p', version: 1, description: 'x', components: {}, installer: '>=1.0.0' }),
      (e) => e instanceof ManifestError && /positive integer/.test(e.message));
  });

  console.log('\nversion history:');
  await test('bump records each version; downgrade warns but records; current = MAX', async () => {
    const vctx = makeCtx();
    const d = (v) => ({ ...skillDef, key: 'ver-skill', name: 'ver-skill', version: v });
    await upsertSkill(vctx, d(1));
    await upsertSkill(vctx, d(3));                       // forward bump
    let nums = (await vctx.db('skill_versions').where({ skill_name: 'ver-skill' }).orderBy('version_num')).map((r) => r.version_num);
    assert.deepEqual(nums, [1, 3], 'each declared package version recorded as a version_num');
    await upsertSkill(vctx, d(2));                       // downgrade vs current 3 → warn-and-continue
    nums = (await vctx.db('skill_versions').where({ skill_name: 'ver-skill' }).orderBy('version_num')).map((r) => r.version_num);
    assert.deepEqual(nums, [1, 2, 3], 'downgrade still recorded');
    assert.equal(await currentVersion(vctx.db, 'skill', 'ver-skill'), 3, 'current = MAX(version_num), unaffected by the downgrade');
    await removeSkill(vctx, d(2));
    assert.equal((await vctx.db('skill_versions').where({ skill_name: 'ver-skill' })).length, 0, 'remove clears all history');
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
