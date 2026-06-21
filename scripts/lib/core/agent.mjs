// core/agent.mjs — agents table (PK key) + agent_skills / agent_recipes join sync (C6).
// AgentDef uses the common name/description pattern (D-23): def.name → agents.key,
// def.display_name → agents.name. Minimal insert (other columns ride DB defaults). Only
// existing+active skills attach; recipe names resolve to uuids. Re-run produces zero drift;
// stale links are removed.
import { join } from 'path';
import { existsSync } from 'fs';
import { writeIfChanged, copyTree } from '../fs.mjs';
import { dumpYaml } from '../parse.mjs';
import { VERDICT } from '../log.mjs';
import { recordVersion, removeVersions, currentVersion } from '../version-history.mjs';

// Brain runtime/transient dirs excluded from a sync/backup capture (D-50). An agent component is a
// directory (agents/<key>/, the "brain"); on install the WHOLE tree is copied to AGENT_BRAINS_DIR
// (so the brain owns AGENTS.md + identity.md + …), but on backup the agent has since written runtime
// state into it (activity logs, restore copies) that doesn't belong in a distributable package. The
// default set is overridable via AGENT_BRAIN_EXCLUDE (comma-separated top-level names; set it empty
// to capture everything). Top-level only — matched against each entry's first path segment.
export const DEFAULT_BRAIN_EXCLUDE = ['activity', '_backup', '.scratch', 'memory'];

export function brainExcludeSet(env = process.env.AGENT_BRAIN_EXCLUDE) {
  const list = env != null
    ? env.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_BRAIN_EXCLUDE;
  return new Set(list);
}

export async function upsertAgent(ctx, def) {
  const { db, log, DRY_RUN } = ctx;
  const key = def.name;

  const row = await db('agents').where({ key }).first();
  const fields = { name: def.display_name, description: def.description || '', mode: def.mode || 'cli', is_active: true };
  if (def.default_model) fields.default_model = def.default_model;
  if (def.icon) fields.icon = def.icon;
  // Content/config fields that now ride in the manifest (D-32) — instructions is the Markdown body;
  // capabilities is jsonb (stringify on the way in). Each is set only when the def carries it, so an
  // omitted field rides the DB default rather than clobbering an existing value.
  if (def.instructions != null) fields.instructions = def.instructions;
  if (def.system_prompt_path != null) fields.system_prompt_path = def.system_prompt_path;
  if (def.provider != null) fields.provider = def.provider;
  if (def.capabilities != null) fields.capabilities = JSON.stringify(def.capabilities);

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
    && (def.icon == null || row.icon === def.icon)
    && (def.instructions == null || (row.instructions || '') === def.instructions)
    && (def.system_prompt_path == null || (row.system_prompt_path || '') === def.system_prompt_path)
    && (def.provider == null || row.provider === def.provider)
    && (def.capabilities == null || JSON.stringify(row.capabilities ?? []) === JSON.stringify(def.capabilities));

  // Version snapshot args (D-34) — optional for agents; recorded only when the package declares one.
  const ver = { fkValue: key, version: def.version, name: def.display_name, description: def.description, body: def.instructions };

  // Brain (D-50): the agent component is a directory whose whole tree copies to AGENT_BRAINS_DIR/<key>
  // (the agent-side analog of a skill's INSTALL_BASE_DIR/<key>). Present only when the def came from a
  // package on disk (a hand-built library def may carry no srcDir → DB-only, no brain write).
  const brainDir = ctx.BRAINS ? join(ctx.BRAINS, key) : null;
  const hasBrain = !!(def.srcDir && brainDir && existsSync(def.srcDir));

  if (DRY_RUN) {
    const brainFiles = hasBrain ? copyTree(def.srcDir, brainDir, { dryRun: true }) : 0;
    log.dry(`${row ? 'update' : 'create'} agent ${key}; sync ${desiredSkills.length} skill(s), ${desiredRecipes.length} recipe(s)`
      + (hasBrain ? `; copy ${brainFiles} brain file(s) → ${brainDir}` : ''));
    await recordVersion(ctx, 'agent', ver);
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

  // Copy the brain tree → AGENT_BRAINS_DIR/<key> (D-50). copyTree is byte-idempotent (a clean re-run
  // writes nothing) and NEVER deletes, so runtime files the agent itself wrote into the brain
  // (activity/, data/) survive a reinstall; only files the package ships are (re)written.
  const brainFiles = hasBrain ? copyTree(def.srcDir, brainDir, { dryRun: false }) : 0;

  await recordVersion(ctx, 'agent', ver);
  const drift = !row || !fieldsSame || addS.length || delS.length || addR.length || delR.length || brainFiles > 0;
  return res(key, drift ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created', { skills: desiredSkills, recipes: desiredRecipes.length });
}

export async function removeAgent(ctx, nameOrDef) {
  const { db, DRY_RUN, log } = ctx;
  const key = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await db('agents').where({ key }).first();
  if (!row) return res(key, VERDICT.ALREADY, 'absent');
  // Uninstall removes the DB row + joins + version history only. The brain folder
  // (AGENT_BRAINS_DIR/<key>) is deliberately PRESERVED (D-50): it can hold agent-authored runtime
  // state (activity/, data/, _backup/) that an uninstall must not destroy. Removing it is a manual op.
  if (DRY_RUN) { log.dry(`delete agent ${key} and its links (brain folder preserved)`); return res(key, VERDICT.OK, 'removed'); }
  await db('agent_skills').where({ agent_key: key }).del();
  await db('agent_recipes').where({ agent_key: key }).del();
  await db('agents').where({ key }).del();
  await removeVersions(ctx, 'agent', key);   // mirror the ON DELETE CASCADE in the FK-less sandbox
  return res(key, VERDICT.OK, 'removed');
}

// exportAgent — backup: write the row back to package form (the reverse of the D-23 mapping:
// agents.key → `name`, agents.name → `display_name`). relPath is now the agent DIRECTORY
// (agents/<key>); AGENTS.md is regenerated from the DB inside it (YAML frontmatter for the
// scalar/list fields + a body carrying `instructions`, D-32) and the rest of the brain folder
// (AGENT_BRAINS_DIR/<key>) is copied alongside it (D-50). The formerly-lossy fields (instructions,
// system_prompt_path, capabilities, non-default provider) round-trip; each is emitted only when it
// carries non-default information so restore stays idempotent. Joins resolve to names; an
// agent_recipes link whose recipe row is gone simply drops out of the join.
export async function exportAgent(ctx, row, { outRoot, relPath }) {
  const { db } = ctx;
  const key = row.key;
  const skills = (await db('agent_skills').where({ agent_key: key }).orderBy('skill_name').select('skill_name'))
    .map((r) => r.skill_name);
  const recipes = (await db('agent_recipes').where({ agent_key: key })
    .join('recipes', 'recipes.id', 'agent_recipes.recipe_id').orderBy('recipes.name').select('recipes.name'))
    .map((r) => r.name);

  const version = await currentVersion(db, 'agent', key);   // live CRHQ number (D-34); emitted only if present
  const fm = {
    name: key,
    display_name: row.name,
    ...(version != null ? { version } : {}),
    ...(row.description ? { description: row.description } : {}),
    mode: row.mode || 'cli',
    ...(row.default_model ? { default_model: row.default_model } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.provider && row.provider !== 'claude' ? { provider: row.provider } : {}),
    ...(row.system_prompt_path ? { system_prompt_path: row.system_prompt_path } : {}),
    ...(row.capabilities && JSON.stringify(row.capabilities) !== '[]' ? { capabilities: row.capabilities } : {}),
    ...(skills.length ? { skills } : {}),
    ...(recipes.length ? { recipes } : {}),
  };
  const destDir = join(outRoot, relPath);   // the agent directory in the package (agents/<key>)

  // Copy the brain tree (AGENT_BRAINS_DIR/<key>) into the package dir, skipping (a) AGENTS.md —
  // regenerated from the DB below, so copying the installed one would clobber it and flip-flop the
  // file every run (the exportSkill/SKILL.md bug, D-41) — and (b) the runtime/transient dirs the
  // operator excludes from a distributable capture (D-50). Missing brain → AGENTS.md alone.
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
  // `changed` = a byte was written (brain file or AGENTS.md) → drives the mirror package-version bump.
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
