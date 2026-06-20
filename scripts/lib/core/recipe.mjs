// core/recipe.mjs — recipes table (uuid PK auto, name UNIQUE). description/content are NOT NULL.
import { join } from 'path';
import { writeIfChanged } from '../fs.mjs';
import { dumpYaml } from '../parse.mjs';
import { VERDICT } from '../log.mjs';
import { recordVersion, removeVersions, currentVersion } from '../version-history.mjs';

export async function upsertRecipe(ctx, def) {
  const { db, log, DRY_RUN } = ctx;
  const { name } = def;
  const row = await db('recipes').where({ name }).first();
  const fields = { description: def.description || '', content: def.content || '', is_active: true };
  const changed = !row || row.description !== fields.description || row.content !== fields.content || row.is_active !== true;
  // Version snapshot args (D-34) — optional for recipes; recorded only when the package declares one.
  // recipe_versions is keyed by the row uuid, resolved after the upsert.
  const ver = (id) => ({ fkValue: id, version: def.version, name: def.name, description: def.description, body: def.content });

  if (DRY_RUN) {
    log.dry(`${row ? 'update' : 'create'} recipe ${name}`);
    await recordVersion(ctx, 'recipe', ver(row?.id ?? null));
    return res(name, changed ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created');
  }

  const now = new Date();
  if (!row) await db('recipes').insert({ name, ...fields, created_at: now, updated_at: now });  // id uuid auto
  else if (changed) await db('recipes').where({ name }).update({ ...fields, updated_at: now });

  const id = row?.id ?? (await db('recipes').where({ name }).select('id').first())?.id;
  await recordVersion(ctx, 'recipe', ver(id));
  return res(name, changed ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created');
}

export async function removeRecipe(ctx, nameOrDef) {
  const { db, DRY_RUN, log } = ctx;
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await db('recipes').where({ name }).first();
  if (!row) return res(name, VERDICT.ALREADY, 'absent');
  if (DRY_RUN) { log.dry(`delete recipe ${name}`); return res(name, VERDICT.OK, 'removed'); }
  await db('recipes').where({ name }).del();
  await removeVersions(ctx, 'recipe', row.id);   // mirror the ON DELETE CASCADE in the FK-less sandbox
  return res(name, VERDICT.OK, 'removed');
}

// exportRecipe — backup: write the row back to package form (frontmatter + body .md). The integer
// version is the live CRHQ number = MAX(recipe_versions.version_num) (D-34), emitted only when the
// recipe has version history (it's optional for recipes).
export async function exportRecipe(ctx, row, { outRoot, relPath }) {
  const version = await currentVersion(ctx.db, 'recipe', row.id);
  const fm = { name: row.name, description: row.description || '', ...(version != null ? { version } : {}) };
  const md = `---\n${dumpYaml(fm)}---\n\n${(row.content || '').replace(/^\n+/, '')}`;
  const changed = writeIfChanged(join(outRoot, relPath), md, { dryRun: !!ctx.DRY_RUN });
  return { ...res(row.name, VERDICT.BACKUP_OK, 'exported'), entry: { path: relPath, ...(version != null ? { version } : {}) }, changed };
}

export async function statusRecipe(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await ctx.db('recipes').where({ name }).first();
  return { type: 'recipe', name, verdict: row ? VERDICT.ALREADY : VERDICT.ABSENT, present: !!row, active: !!row?.is_active };
}

function res(name, verdict, action) { return { type: 'recipe', name, verdict, action }; }
