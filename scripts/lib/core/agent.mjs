// core/agent.mjs — agents table (PK key) + agent_skills / agent_recipes join sync (C6).
// Minimal insert (other columns ride DB defaults). Only existing+active skills attach; recipe
// names resolve to uuids. Re-run produces zero drift; stale links are removed.
import { VERDICT } from '../log.mjs';

export async function upsertAgent(ctx, def) {
  const { db, log, DRY_RUN } = ctx;
  const key = def.key;

  const row = await db('agents').where({ key }).first();
  const fields = { name: def.name, description: def.description || '', mode: def.mode || 'cli', is_active: true };
  if (def.default_model) fields.default_model = def.default_model;
  if (def.icon) fields.icon = def.icon;

  // Resolve desired links (skills must exist + be active; recipes resolve name → uuid). In dry-run,
  // a bundle-mate not yet written counts as satisfied so the preview reflects the planned state.
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

  const fieldsSame = !!row
    && row.name === fields.name
    && (row.description || '') === fields.description
    && row.mode === fields.mode
    && row.is_active === true
    && (def.default_model == null || row.default_model === def.default_model)
    && (def.icon == null || row.icon === def.icon);

  if (DRY_RUN) {
    log.dry(`${row ? 'update' : 'create'} agent ${key}; sync ${desiredSkills.length} skill(s), ${desiredRecipes.length} recipe(s)`);
    return res(key, VERDICT.OK, row ? 'updated' : 'created', { skills: desiredSkills, recipes: desiredRecipes.length });
  }

  const now = new Date();
  if (!row) await db('agents').insert({ key, ...fields, created_at: now, updated_at: now });
  else if (!fieldsSame) await db('agents').where({ key }).update({ ...fields, updated_at: now });

  // Sync agent_skills.
  const curSkills = (await db('agent_skills').where({ agent_key: key }).select('skill_name')).map((r) => r.skill_name);
  const addS = desiredSkills.filter((s) => !curSkills.includes(s));
  const delS = curSkills.filter((s) => !desiredSkills.includes(s));
  if (addS.length) {
    await db('agent_skills').insert(addS.map((skill_name) => ({ agent_key: key, skill_name })))
      .onConflict(['agent_key', 'skill_name']).ignore();
  }
  if (delS.length) await db('agent_skills').where({ agent_key: key }).whereIn('skill_name', delS).del();

  // Sync agent_recipes.
  const curRecipes = (await db('agent_recipes').where({ agent_key: key }).select('recipe_id')).map((r) => r.recipe_id);
  const addR = desiredRecipes.filter((id) => !curRecipes.includes(id));
  const delR = curRecipes.filter((id) => !desiredRecipes.includes(id));
  if (addR.length) {
    await db('agent_recipes').insert(addR.map((recipe_id) => ({ agent_key: key, recipe_id })))
      .onConflict(['agent_key', 'recipe_id']).ignore();
  }
  if (delR.length) await db('agent_recipes').where({ agent_key: key }).whereIn('recipe_id', delR).del();

  const drift = !row || !fieldsSame || addS.length || delS.length || addR.length || delR.length;
  return res(key, drift ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created', { skills: desiredSkills, recipes: desiredRecipes.length });
}

export async function removeAgent(ctx, keyOrDef) {
  const { db, DRY_RUN, log } = ctx;
  const key = typeof keyOrDef === 'string' ? keyOrDef : keyOrDef.key;
  const row = await db('agents').where({ key }).first();
  if (!row) return res(key, VERDICT.ALREADY, 'absent');
  if (DRY_RUN) { log.dry(`delete agent ${key} and its links`); return res(key, VERDICT.OK, 'removed'); }
  await db('agent_skills').where({ agent_key: key }).del();
  await db('agent_recipes').where({ agent_key: key }).del();
  await db('agents').where({ key }).del();
  return res(key, VERDICT.OK, 'removed');
}

export async function statusAgent(ctx, keyOrDef) {
  const { db } = ctx;
  const key = typeof keyOrDef === 'string' ? keyOrDef : keyOrDef.key;
  const row = await db('agents').where({ key }).first();
  const skills = row ? (await db('agent_skills').where({ agent_key: key }).select('skill_name')).map((r) => r.skill_name) : [];
  const recipes = row ? (await db('agent_recipes').where({ agent_key: key }).select('recipe_id')).map((r) => r.recipe_id) : [];
  return { type: 'agent', name: key, verdict: row ? VERDICT.ALREADY : VERDICT.ABSENT, present: !!row, active: !!row?.is_active, skills, recipes };
}

function res(name, verdict, action, detail) {
  return { type: 'agent', name, verdict, action, ...(detail ? { detail } : {}) };
}
