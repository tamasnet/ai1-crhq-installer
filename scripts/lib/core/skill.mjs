// core/skill.mjs — skills table (PK name) + assets under INSTALL_BASE_DIR/<key> (C3/C5/C6).
import { join } from 'path';
import { existsSync } from 'fs';
import { copyTree, removeTree } from '../fs.mjs';
import { VERDICT } from '../log.mjs';

export async function upsertSkill(ctx, def) {
  const { db, log, DRY_RUN, RESPECT_LOCKS, BASE } = ctx;
  const name = def.name;
  const skillDir = join(BASE, def.key);
  const skillPath = `db://skills/${name}`;
  const row = await db('skills').where({ name }).first();

  if (row && row.locked) {
    if (RESPECT_LOCKS) {
      log.warn(`skill ${name} is locked; skipped (--respect-locks)`);
      return result(name, VERDICT.LOCKED, 'skipped');
    }
    if (DRY_RUN) log.dry(`unlock locked skill ${name}`);
    else await db('skills').where({ name }).update({ locked: false });  // C5: unlock then update
  }

  const fields = {
    description: def.description, content: def.content, skill_type: 'user',
    skill_path: skillPath, skill_dir: skillDir, is_active: true, is_global: false,
  };
  const rowChanged = !row
    || row.description !== fields.description
    || row.content !== fields.content
    || row.skill_dir !== skillDir
    || row.skill_path !== skillPath
    || row.skill_type !== 'user'
    || row.is_active !== true;

  if (DRY_RUN) {
    log.dry(`${row ? 'update' : 'create'} skill ${name} and copy assets → ${skillDir}`);
    return result(name, rowChanged ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created');
  }

  const now = new Date();
  if (!row) await db('skills').insert({ name, ...fields, created_at: now, updated_at: now });
  else if (rowChanged) await db('skills').where({ name }).update({ ...fields, updated_at: now });

  const files = copyTree(def.srcDir, skillDir, { dryRun: false });
  const verdict = (!rowChanged && files === 0) ? VERDICT.ALREADY : VERDICT.OK;
  return result(name, verdict, row ? 'updated' : 'created', files);
}

export async function removeSkill(ctx, nameOrDef) {
  const { db, log, DRY_RUN, RESPECT_LOCKS, BASE } = ctx;
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await db('skills').where({ name }).first();
  const dir = row?.skill_dir || (typeof nameOrDef === 'object' && nameOrDef.key ? join(BASE, nameOrDef.key) : null);

  if (!row) {
    removeTree(dir, { dryRun: DRY_RUN });
    return result(name, VERDICT.ALREADY, 'absent');
  }
  if (row.locked && RESPECT_LOCKS) {
    log.warn(`skill ${name} is locked; skipped (--respect-locks)`);
    return result(name, VERDICT.LOCKED, 'skipped');
  }
  if (DRY_RUN) {
    log.dry(`delete skill ${name} and remove ${dir}`);
    return result(name, VERDICT.OK, 'removed');
  }
  if (row.locked) await db('skills').where({ name }).update({ locked: false });
  await db('skills').where({ name }).del();
  removeTree(dir, { dryRun: false });
  return result(name, VERDICT.OK, 'removed');
}

export async function statusSkill(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await ctx.db('skills').where({ name }).first();
  return {
    type: 'skill', name, verdict: row ? VERDICT.ALREADY : VERDICT.ABSENT,
    present: !!row, active: !!row?.is_active, filesPresent: row?.skill_dir ? existsSync(row.skill_dir) : false,
  };
}

function result(name, verdict, action, files) {
  return { type: 'skill', name, verdict, action, ...(files != null ? { files } : {}) };
}
