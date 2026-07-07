// core/agent.mjs — agents table (PK key) + agent_skills / agent_recipes join sync (C6).
import { join } from 'path';
import { existsSync } from 'fs';
import { writeIfChanged, copyTree } from '../fs.mjs';
import { dumpYaml } from '../parse.mjs';
import { VERDICT } from '../log.mjs';
import { recordVersion, removeVersions, currentVersion } from '../version-history.mjs';
import { planResult } from './plan-result.mjs';

export const DEFAULT_BRAIN_EXCLUDE = ['activity', '_backup', '.scratch', 'memory'];

export function brainExcludeSet(env = process.env.AGENT_BRAIN_EXCLUDE) {
  const list = env != null
    ? env.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_BRAIN_EXCLUDE;
  return new Set(list);
}

function agentFields(def) {
  const fields = { name: def.display_name, description: def.description || '', mode: def.mode || 'cli', is_active: true };
  if (def.default_model) fields.default_model = def.default_model;
  if (def.agent_type) fields.agent_type = def.agent_type;
  if (def.icon) fields.icon = def.icon;
  if (def.instructions != null) fields.instructions = def.instructions;
  if (def.system_prompt_path != null) fields.system_prompt_path = def.system_prompt_path;
  if (def.provider != null) fields.provider = def.provider;
  if (def.capabilities != null) fields.capabilities = JSON.stringify(def.capabilities);
  return fields;
}

function fieldsSame(row, def, fields) {
  return !!row
    && row.name === fields.name
    && (row.description || '') === fields.description
    && row.mode === fields.mode
    && row.is_active === true
    && (def.default_model == null || row.default_model === def.default_model)
    && (def.agent_type == null || row.agent_type === def.agent_type)
    && (def.icon == null || row.icon === def.icon)
    && (def.instructions == null || (row.instructions || '') === def.instructions)
    && (def.system_prompt_path == null || (row.system_prompt_path || '') === def.system_prompt_path)
    && (def.provider == null || row.provider === def.provider)
    && (def.capabilities == null || JSON.stringify(row.capabilities ?? []) === JSON.stringify(def.capabilities));
}

async function resolveAgentLinks(ctx, def) {
  const { db, log, DRY_RUN } = ctx;
  const key = def.name;
  const desiredSkills = [];
  for (const sn of def.skills || []) {
    const s = await db('skills').where({ name: sn }).first();
    if (s && s.is_active !== false) desiredSkills.push(sn);
    else if (DRY_RUN && ctx.plannedSkills?.has(sn)) desiredSkills.push(sn);
    else log.warn(`agent ${key}: skill '${sn}' not installed/active — attach skipped`);
  }
  const desiredRecipes = [];
  for (const rn of def.recipes || []) {
    const r = await db('recipes').where({ name: rn }).first();
    if (r) desiredRecipes.push(r.id);
    else if (DRY_RUN && ctx.plannedRecipes?.has(rn)) desiredRecipes.push(`planned:${rn}`);
    else log.warn(`agent ${key}: recipe '${rn}' not found — attach skipped`);
  }
  return { desiredSkills, desiredRecipes };
}

function realRecipeIds(desiredRecipes) {
  return desiredRecipes.filter((id) => typeof id !== 'string' || !id.startsWith('planned:'));
}

function linksDrift(curSkills, curRecipes, desiredSkills, desiredRecipes) {
  const realDesired = realRecipeIds(desiredRecipes);
  return desiredSkills.some((s) => !curSkills.includes(s))
    || curSkills.some((s) => !desiredSkills.includes(s))
    || realDesired.some((id) => !curRecipes.includes(id))
    || curRecipes.some((id) => !realDesired.includes(id));
}

export async function planAgent(ctx, def) {
  const { db, BRAINS } = ctx;
  const key = def.name;
  const row = await db('agents').where({ key }).first();
  if (!row) return planResult('agent', key, { verdict: VERDICT.ABSENT, action: 'absent' });

  const fields = agentFields(def);
  const dbDrift = !fieldsSame(row, def, fields);
  const { desiredSkills, desiredRecipes } = await resolveAgentLinks(ctx, def);
  const curSkills = (await db('agent_skills').where({ agent_key: key }).select('skill_name')).map((r) => r.skill_name);
  const curRecipes = (await db('agent_recipes').where({ agent_key: key }).select('recipe_id')).map((r) => r.recipe_id);
  const linkDrift = linksDrift(curSkills, curRecipes, desiredSkills, desiredRecipes);

  const brainDir = BRAINS ? join(BRAINS, key) : null;
  const hasBrain = !!(def.srcDir && brainDir && existsSync(def.srcDir));
  const brainFiles = hasBrain ? copyTree(def.srcDir, brainDir, { dryRun: true }) : 0;

  if (!dbDrift && !linkDrift && brainFiles === 0) {
    return planResult('agent', key, { verdict: VERDICT.ALREADY, action: 'updated' });
  }
  return planResult('agent', key, {
    verdict: VERDICT.OK,
    action: 'updated',
    dimensions: { db: dbDrift, links: linkDrift, brain: brainFiles > 0 },
  });
}

export async function upsertAgent(ctx, def) {
  const { db, log, DRY_RUN } = ctx;
  const key = def.name;
  const row = await db('agents').where({ key }).first();
  const existed = !!row;
  const fields = agentFields(def);
  const { desiredSkills, desiredRecipes } = await resolveAgentLinks(ctx, def);
  const realDesiredRecipes = realRecipeIds(desiredRecipes);
  const ver = { fkValue: key, version: def.version, name: def.display_name, description: def.description, body: def.instructions };
  const brainDir = ctx.BRAINS ? join(ctx.BRAINS, key) : null;
  const hasBrain = !!(def.srcDir && brainDir && existsSync(def.srcDir));
  const prePlan = existed ? await planAgent(ctx, def) : null;

  if (!row) {
    if (DRY_RUN) {
      log.dry(`create agent ${key}; sync ${desiredSkills.length} skill(s), ${desiredRecipes.length} recipe(s)`
        + (hasBrain ? `; copy brain → ${brainDir}` : ''));
      await recordVersion(ctx, 'agent', ver);
      return res(key, VERDICT.OK, 'created', { skills: desiredSkills, recipes: desiredRecipes.length });
    }
    const now = new Date();
    await db('agents').insert({ key, ...fields, created_at: now, updated_at: now });
  } else {
    if (DRY_RUN) {
      log.dry(`${prePlan.verdict === VERDICT.ALREADY ? 'noop' : 'update'} agent ${key}; sync ${desiredSkills.length} skill(s), ${desiredRecipes.length} recipe(s)`
        + (hasBrain ? `; copy brain → ${brainDir}` : ''));
      await recordVersion(ctx, 'agent', ver);
      return res(key, prePlan.verdict, 'updated', { skills: desiredSkills, recipes: desiredRecipes.length });
    }
    if (prePlan.dimensions.db) await db('agents').where({ key }).update({ ...fields, updated_at: new Date() });
  }

  const curSkills = (await db('agent_skills').where({ agent_key: key }).select('skill_name')).map((r) => r.skill_name);
  const addS = desiredSkills.filter((s) => !curSkills.includes(s));
  const delS = curSkills.filter((s) => !desiredSkills.includes(s));
  if (addS.length) {
    await db('agent_skills').insert(addS.map((skill_name) => ({ agent_key: key, skill_name })))
      .onConflict(['agent_key', 'skill_name']).ignore();
  }
  if (delS.length) await db('agent_skills').where({ agent_key: key }).whereIn('skill_name', delS).del();

  const curRecipes = (await db('agent_recipes').where({ agent_key: key }).select('recipe_id')).map((r) => r.recipe_id);
  const addR = realDesiredRecipes.filter((id) => !curRecipes.includes(id));
  const delR = curRecipes.filter((id) => !realDesiredRecipes.includes(id));
  if (addR.length) {
    await db('agent_recipes').insert(addR.map((recipe_id) => ({ agent_key: key, recipe_id })))
      .onConflict(['agent_key', 'recipe_id']).ignore();
  }
  if (delR.length) await db('agent_recipes').where({ agent_key: key }).whereIn('recipe_id', delR).del();

  if (hasBrain) copyTree(def.srcDir, brainDir, { dryRun: false });
  await recordVersion(ctx, 'agent', ver);
  if (!existed) return res(key, VERDICT.OK, 'created', { skills: desiredSkills, recipes: realDesiredRecipes.length });
  return res(key, prePlan.verdict === VERDICT.ALREADY ? VERDICT.ALREADY : VERDICT.OK, 'updated', { skills: desiredSkills, recipes: realDesiredRecipes.length });
}

export async function removeAgent(ctx, nameOrDef) {
  const { db, DRY_RUN, log } = ctx;
  const key = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await db('agents').where({ key }).first();
  if (!row) return res(key, VERDICT.ALREADY, 'absent');
  if (DRY_RUN) { log.dry(`delete agent ${key} and its links (brain folder preserved)`); return res(key, VERDICT.OK, 'removed'); }
  await db('agent_skills').where({ agent_key: key }).del();
  await db('agent_recipes').where({ agent_key: key }).del();
  await db('agents').where({ key }).del();
  await removeVersions(ctx, 'agent', key);
  return res(key, VERDICT.OK, 'removed');
}

export async function exportAgent(ctx, row, { outRoot, relPath }) {
  const { db } = ctx;
  const key = row.key;
  const skills = (await db('agent_skills').where({ agent_key: key }).orderBy('skill_name').select('skill_name'))
    .map((r) => r.skill_name);
  const recipes = (await db('agent_recipes').where({ agent_key: key })
    .join('recipes', 'recipes.id', 'agent_recipes.recipe_id').orderBy('recipes.name').select('recipes.name'))
    .map((r) => r.name);

  const version = await currentVersion(db, 'agent', key);
  const fm = {
    name: key,
    display_name: row.name,
    ...(version != null ? { version } : {}),
    ...(row.description ? { description: row.description } : {}),
    mode: row.mode || 'cli',
    ...(row.default_model ? { default_model: row.default_model } : {}),
    ...(row.agent_type ? { agent_type: row.agent_type } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.provider && row.provider !== 'claude' ? { provider: row.provider } : {}),
    ...(row.system_prompt_path ? { system_prompt_path: row.system_prompt_path } : {}),
    ...(row.capabilities && JSON.stringify(row.capabilities) !== '[]' ? { capabilities: row.capabilities } : {}),
    ...(skills.length ? { skills } : {}),
    ...(recipes.length ? { recipes } : {}),
  };
  const destDir = join(outRoot, relPath);
  const brainDir = ctx.BRAINS ? join(ctx.BRAINS, key) : null;
  const exclude = brainExcludeSet();
  const files = brainDir && existsSync(brainDir)
    ? copyTree(brainDir, destDir, {
        dryRun: !!ctx.DRY_RUN,
        skip: (rel) => rel === 'AGENTS.md' || exclude.has(rel.split('/')[0]),
      })
    : 0;

  const body = (row.instructions || '').replace(/^\n+/, '');
  const md = `---\n${dumpYaml(fm)}---\n${body ? `\n${body.endsWith('\n') ? body : `${body}\n`}` : ''}`;
  const mdChanged = writeIfChanged(join(destDir, 'AGENTS.md'), md, { dryRun: !!ctx.DRY_RUN });
  return { ...res(key, VERDICT.BACKUP_OK, 'exported', { skills, recipes: recipes.length }), entry: { path: relPath, ...(version != null ? { version } : {}) }, changed: files > 0 || mdChanged };
}

export async function statusAgent(ctx, nameOrDef) {
  const { db } = ctx;
  const key = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await db('agents').where({ key }).first();
  const skills = row ? (await db('agent_skills').where({ agent_key: key }).select('skill_name')).map((r) => r.skill_name) : [];
  const recipes = row ? (await db('agent_recipes').where({ agent_key: key }).select('recipe_id')).map((r) => r.recipe_id) : [];
  return { type: 'agent', name: key, verdict: row ? VERDICT.ALREADY : VERDICT.ABSENT, present: !!row, active: !!row?.is_active, skills, recipes };
}

function res(name, verdict, action, detail) {
  return { type: 'agent', name, verdict, action, ...(detail ? { detail } : {}) };
}
