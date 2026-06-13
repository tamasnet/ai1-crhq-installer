#!/usr/bin/env node
// Phase 3 verification — agent install + join sync (agent_skills / agent_recipes). Self-contained:
// provisions a sandbox, exercises upsertAgent/removeAgent/statusAgent with row + join assertions,
// then runs a full lifecycle with an agent referencing the sample skill + recipe. Tears down.
// Run from the project root:  node tests/agent.test.mjs
import assert from 'node:assert/strict';
import { provisionSandbox, runLifecycle } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { upsertSkill } from '../scripts/lib/core/skill.mjs';
import { upsertRecipe } from '../scripts/lib/core/recipe.mjs';
import { upsertAgent, removeAgent, statusAgent } from '../scripts/lib/core/agent.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sb = await provisionSandbox({ ts: stamp, seed: false });
console.log(`sandbox ${sb.schema} @ ${sb.baseDir}\n`);

const ctx = makeCtx();
const now = new Date();
const skillsOf = async (key) => (await ctx.db('agent_skills').where({ agent_key: key }).select('skill_name')).map((r) => r.skill_name).sort();
const recipeIdsOf = async (key) => (await ctx.db('agent_recipes').where({ agent_key: key }).select('recipe_id')).map((r) => r.recipe_id);
const agentRow = (key) => ctx.db('agents').where({ key }).first();
const wipe = async () => {
  for (const t of ['agent_skills', 'agent_recipes', 'agents', 'skills', 'recipes']) await ctx.db(t).del();
};

try {
  const { plan } = loadManifest('examples/bundle');
  const skillDef = plan.skills[0];     // ai1-sample-skill
  const recipeDef = plan.recipes[0];   // ai1-sample-recipe
  const agentDef = plan.agents[0];     // ai1-sample-agent → skills:[sample], recipes:[sample]

  // ── A. Focused lifecycle FIRST on a clean schema (Phase 3 acceptance test) ──────────────
  console.log('agent lifecycle (skill + recipe + agent):');
  await test('full lifecycle → ALL PASS (agent has skill + recipe; clean uninstall)', async () => {
    const lplan = { skills: [skillDef], recipes: [recipeDef], agents: [agentDef], jobs: [], services: [] };
    const res = await runLifecycle(makeCtx(), lplan);
    assert.equal(res.passed, true, res.phases.filter((p) => !p.passed).map((p) => `${p.name}: ${p.detail}`).join('; '));
  });

  // ── B. Granular join-sync tests on a wiped schema with controlled fixtures ───────────────
  await wipe();
  await upsertSkill(ctx, skillDef);                                  // ai1-sample-skill (active)
  await upsertRecipe(ctx, recipeDef);                               // ai1-sample-recipe
  const seedSkill = (name, active) => ctx.db('skills').insert({ name, skill_path: `db://skills/${name}`, skill_type: 'user', is_active: active, content: '', created_at: now, updated_at: now });
  await seedSkill('ai1-second-skill', true);
  await seedSkill('ai1-inactive-skill', false);
  await ctx.db('recipes').insert({ name: 'ai1-second-recipe', description: '', content: '', is_active: true, created_at: now, updated_at: now });
  const secondRecipeId = (await ctx.db('recipes').where({ name: 'ai1-second-recipe' }).first()).id;
  const sampleRecipeId = (await ctx.db('recipes').where({ name: recipeDef.name }).first()).id;

  console.log('\nagent join sync:');

  await test('create: minimal row + DB defaults, links resolved', async () => {
    const r = await upsertAgent(ctx, agentDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(r.action, 'created');
    const row = await agentRow(agentDef.name);
    assert.equal(row.name, agentDef.display_name);
    assert.equal(row.mode, 'cli');
    assert.equal(row.is_active, true);
    assert.equal(row.provider, 'claude', 'provider rides DB default');
    assert.equal(row.icon, '🧪', 'icon from def');
    assert.equal(row.default_model, 'sonnet');
    assert.ok(agentDef.instructions && agentDef.instructions.length, 'def carries instructions from the .md body');
    assert.equal(row.instructions, agentDef.instructions, 'instructions persisted from the Markdown body');
    assert.deepEqual(await skillsOf(agentDef.name), ['ai1-sample-skill']);
    assert.deepEqual(await recipeIdsOf(agentDef.name), [sampleRecipeId], 'recipe name resolved to uuid');
  });

  await test('full field set: instructions + capabilities + provider + system_prompt_path persist; idempotent', async () => {
    const full = {
      ...agentDef, name: 'ai1-full-agent', skills: [], recipes: [],
      instructions: 'Persona body line one.\nLine two.\n',
      capabilities: ['search', 'write'], provider: 'openai', system_prompt_path: '/prompts/full.txt',
    };
    const r = await upsertAgent(ctx, full);
    assert.equal(r.verdict, 'INSTALL-OK');
    const row = await agentRow('ai1-full-agent');
    assert.equal(row.instructions, full.instructions, 'instructions persisted verbatim');
    assert.deepEqual(row.capabilities, ['search', 'write'], 'capabilities jsonb round-trips as an array');
    assert.equal(row.provider, 'openai', 'non-default provider persisted');
    assert.equal(row.system_prompt_path, '/prompts/full.txt');
    assert.equal((await upsertAgent(ctx, full)).verdict, 'ALREADY-INSTALLED', 're-run → no drift');
    assert.equal((await upsertAgent(ctx, { ...full, instructions: 'Changed.\n' })).verdict, 'INSTALL-OK', 'instructions change → drift');
    await removeAgent(ctx, full);
  });

  await test('idempotent: re-run → ALREADY, no link drift', async () => {
    const r = await upsertAgent(ctx, agentDef);
    assert.equal(r.verdict, 'ALREADY-INSTALLED');
    assert.deepEqual(await skillsOf(agentDef.name), ['ai1-sample-skill']);
    assert.deepEqual(await recipeIdsOf(agentDef.name), [sampleRecipeId]);
  });

  await test('attach filters: missing + inactive skills skipped', async () => {
    const r = await upsertAgent(ctx, { ...agentDef, skills: ['ai1-sample-skill', 'ai1-inactive-skill', 'ghost-skill'] });
    assert.equal(r.verdict, 'ALREADY-INSTALLED', 'desired set unchanged after filtering');
    assert.deepEqual(await skillsOf(agentDef.name), ['ai1-sample-skill']);
  });

  await test('skill sync: add new + remove stale', async () => {
    const r = await upsertAgent(ctx, { ...agentDef, skills: ['ai1-second-skill'] });
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.deepEqual(await skillsOf(agentDef.name), ['ai1-second-skill'], 'sample removed, second added');
  });

  await test('recipe sync: add second, then drop back to one', async () => {
    await upsertAgent(ctx, { ...agentDef, recipes: ['ai1-sample-recipe', 'ai1-second-recipe'] });
    assert.deepEqual((await recipeIdsOf(agentDef.name)).sort(), [sampleRecipeId, secondRecipeId].sort());
    await upsertAgent(ctx, { ...agentDef, recipes: ['ai1-second-recipe'] });
    assert.deepEqual(await recipeIdsOf(agentDef.name), [secondRecipeId], 'stale recipe link removed');
  });

  await test('field update: changed display_name → row updated', async () => {
    const r = await upsertAgent(ctx, { ...agentDef, display_name: 'Renamed Agent' });
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal((await agentRow(agentDef.name)).name, 'Renamed Agent');
  });

  await test('dry-run: resolves links but writes nothing', async () => {
    const r = await upsertAgent(makeCtx({ DRY_RUN: true }), { ...agentDef, name: 'ai1-dry-agent' });
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(await agentRow('ai1-dry-agent'), undefined, 'no agent row');
    assert.deepEqual(await skillsOf('ai1-dry-agent'), [], 'no skill links');
  });

  await test('status: present, active, skills[] + recipes[]', async () => {
    // Set a known state first (each upsert re-syncs the full skills + recipes sets).
    await upsertAgent(ctx, { ...agentDef, skills: ['ai1-second-skill'], recipes: ['ai1-second-recipe'] });
    const s = await statusAgent(ctx, agentDef.name);
    assert.equal(s.present, true);
    assert.equal(s.active, true);
    assert.deepEqual(s.skills, ['ai1-second-skill']);
    assert.deepEqual(s.recipes, [secondRecipeId]);
    const a = await statusAgent(ctx, 'no-such-agent');
    assert.equal(a.present, false);
    assert.equal(a.verdict, 'NOT-INSTALLED');
  });

  await test('remove: agent row + all join links deleted; idempotent', async () => {
    const r = await removeAgent(ctx, agentDef);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(r.action, 'removed');
    assert.equal(await agentRow(agentDef.name), undefined);
    assert.deepEqual(await skillsOf(agentDef.name), []);
    assert.deepEqual(await recipeIdsOf(agentDef.name), []);
    assert.equal((await removeAgent(ctx, agentDef)).verdict, 'ALREADY-INSTALLED', 'absent → ALREADY');
  });
} finally {
  await sb.teardown(false);
  await closeDb();
}

done();
