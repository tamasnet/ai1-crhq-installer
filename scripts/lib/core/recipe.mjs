// core/recipe.mjs — recipes table (uuid PK auto, name UNIQUE). description/content are NOT NULL.
import { join } from 'path';
import { writeIfChanged } from '../fs.mjs';
import { dumpYaml } from '../parse.mjs';
import { VERDICT } from '../log.mjs';
import { recordVersion, removeVersions, currentVersion } from '../version-history.mjs';
import { planResult } from './plan-result.mjs';

function recipeFields(def) {
  return { description: def.description || '', content: def.content || '', is_active: true };
}

function recipeFieldDiff(row, fields) {
  return row ? ['description', 'content', 'is_active'].filter((k) => row[k] !== fields[k]) : [];
}

function recipeChanged(row, fields) {
  return !row || recipeFieldDiff(row, fields).length > 0;
}

export async function planRecipe(ctx, def) {
  const { name } = def;
  const row = await ctx.db('recipes').where({ name }).first();
  const fields = recipeFields(def);
  if (!row) return planResult('recipe', name, { verdict: VERDICT.ABSENT, action: 'absent' });
  const dbFields = recipeFieldDiff(row, fields);
  if (!dbFields.length) {
    return planResult('recipe', name, { verdict: VERDICT.ALREADY, action: 'updated' });
  }
  return planResult('recipe', name, { verdict: VERDICT.OK, action: 'updated', dimensions: { db: true, dbFields } });
}

export async function upsertRecipe(ctx, def) {
  const { db, log, DRY_RUN } = ctx;
  const { name } = def;
  const row = await db('recipes').where({ name }).first();
  const fields = recipeFields(def);
  const changed = recipeChanged(row, fields);
  const ver = (id) => ({ fkValue: id, version: def.version, name: def.name, description: def.description, body: def.content });

  if (!row) {
    if (DRY_RUN) {
      log.dry(`create recipe ${name}`);
      await recordVersion(ctx, 'recipe', ver(null));
      return res(name, VERDICT.OK, 'created');
    }
    const now = new Date();
    await db('recipes').insert({ name, ...fields, created_at: now, updated_at: now });
    const id = (await db('recipes').where({ name }).select('id').first())?.id;
    await recordVersion(ctx, 'recipe', ver(id));
    return res(name, VERDICT.OK, 'created');
  }

  const plan = await planRecipe(ctx, def);
  if (DRY_RUN) {
    log.dry(`${changed ? 'update' : 'noop'} recipe ${name}`);
    await recordVersion(ctx, 'recipe', ver(row.id));
    return res(name, plan.verdict, 'updated');
  }

  const now = new Date();
  if (changed) await db('recipes').where({ name }).update({ ...fields, updated_at: now });
  await recordVersion(ctx, 'recipe', ver(row.id));
  return res(name, plan.verdict, 'updated');
}

export async function removeRecipe(ctx, nameOrDef) {
  const { db, DRY_RUN, log } = ctx;
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await db('recipes').where({ name }).first();
  if (!row) return res(name, VERDICT.ALREADY, 'absent');
  if (DRY_RUN) { log.dry(`delete recipe ${name}`); return res(name, VERDICT.OK, 'removed'); }
  await db('recipes').where({ name }).del();
  await removeVersions(ctx, 'recipe', row.id);
  return res(name, VERDICT.OK, 'removed');
}

export async function exportRecipe(ctx, row, { outRoot, relPath }) {
  const version = await currentVersion(ctx.db, 'recipe', row.id);
  const fm = { name: row.name, description: row.description || '', ...(version != null ? { version } : {}) };
  const md = `---\n${dumpYaml(fm)}---\n\n${(row.content || '').replace(/^\n+/, '')}`;
  const changed = writeIfChanged(join(outRoot, relPath), md, { dryRun: !!ctx.DRY_RUN });
  return { ...res(row.name, VERDICT.SYNC_OK, 'exported'), entry: { path: relPath, ...(version != null ? { version } : {}) }, changed };
}

export async function statusRecipe(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await ctx.db('recipes').where({ name }).first();
  return { type: 'recipe', name, verdict: row ? VERDICT.ALREADY : VERDICT.ABSENT, present: !!row, active: !!row?.is_active };
}

function res(name, verdict, action) { return { type: 'recipe', name, verdict, action }; }
