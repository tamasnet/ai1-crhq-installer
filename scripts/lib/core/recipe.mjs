// core/recipe.mjs — recipes table (uuid PK auto, name UNIQUE). description/content are NOT NULL.
import { join } from 'path';
import { writeIfChanged } from '../fs.mjs';
import { dumpYaml } from '../parse.mjs';
import { VERDICT } from '../log.mjs';

export async function upsertRecipe(ctx, def) {
  const { db, log, DRY_RUN } = ctx;
  const { name } = def;
  const row = await db('recipes').where({ name }).first();
  const fields = { description: def.description || '', content: def.content || '', is_active: true };
  const changed = !row || row.description !== fields.description || row.content !== fields.content || row.is_active !== true;

  if (DRY_RUN) {
    log.dry(`${row ? 'update' : 'create'} recipe ${name}`);
    return res(name, changed ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created');
  }

  const now = new Date();
  if (!row) await db('recipes').insert({ name, ...fields, created_at: now, updated_at: now });  // id uuid auto
  else if (changed) await db('recipes').where({ name }).update({ ...fields, updated_at: now });

  return res(name, changed ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created');
}

export async function removeRecipe(ctx, nameOrDef) {
  const { db, DRY_RUN, log } = ctx;
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await db('recipes').where({ name }).first();
  if (!row) return res(name, VERDICT.ALREADY, 'absent');
  if (DRY_RUN) { log.dry(`delete recipe ${name}`); return res(name, VERDICT.OK, 'removed'); }
  await db('recipes').where({ name }).del();
  return res(name, VERDICT.OK, 'removed');
}

// exportRecipe — backup: write the row back to package form (frontmatter + body .md). The DB
// has no recipe version column, so no version pin is emitted (it's optional for recipes).
export async function exportRecipe(ctx, row, { outRoot, relPath }) {
  const fm = { name: row.name, description: row.description || '' };
  const md = `---\n${dumpYaml(fm)}---\n\n${(row.content || '').replace(/^\n+/, '')}`;
  writeIfChanged(join(outRoot, relPath), md, { dryRun: !!ctx.DRY_RUN });
  return { ...res(row.name, VERDICT.BACKUP_OK, 'exported'), entry: { path: relPath } };
}

export async function statusRecipe(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await ctx.db('recipes').where({ name }).first();
  return { type: 'recipe', name, verdict: row ? VERDICT.ALREADY : VERDICT.ABSENT, present: !!row, active: !!row?.is_active };
}

function res(name, verdict, action) { return { type: 'recipe', name, verdict, action }; }
