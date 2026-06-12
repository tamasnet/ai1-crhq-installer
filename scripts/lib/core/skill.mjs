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

  // Registration type (D-22). DEFAULT = an org skill, locked. The package-manifest entry's
  // `install_type: user` — or the global --install-skills-as-user flag (which wins) — installs it
  // unlocked as a user skill instead. Assets land in INSTALL_BASE_DIR either way; only the row's
  // skill_type/locked differ.
  const asUser = !!ctx.INSTALL_SKILLS_AS_USER || def.installType === 'user';
  const skillType = asUser ? 'user' : 'org';
  const locked = !asUser;

  const row = await db('skills').where({ name }).first();

  // A locked existing row is skipped under --respect-locks; otherwise we unlock-then-update (C5)
  // below — the live PG trigger forbids UPDATE on a locked row, so the unlock must precede it.
  if (row && row.locked && RESPECT_LOCKS) {
    log.warn(`skill ${name} is locked; skipped (--respect-locks)`);
    return result(name, VERDICT.LOCKED, 'skipped');
  }

  const fields = {
    description: def.description, content: def.content, skill_type: skillType,
    skill_path: skillPath, skill_dir: skillDir, is_active: true, is_global: false, locked,
  };
  const rowChanged = !row
    || row.description !== fields.description
    || row.content !== fields.content
    || row.skill_dir !== skillDir
    || row.skill_path !== skillPath
    || row.skill_type !== skillType
    || row.locked !== locked
    || row.is_active !== true;

  if (DRY_RUN) {
    if (row?.locked && rowChanged) log.dry(`unlock locked skill ${name}`);
    log.dry(`${row ? 'update' : 'create'} skill ${name} as ${skillType}${locked ? ' (locked)' : ''} and copy assets → ${skillDir}`);
    return result(name, rowChanged ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created');
  }

  const now = new Date();
  if (!row) {
    await db('skills').insert({ name, ...fields, created_at: now, updated_at: now });
  } else if (rowChanged) {
    if (row.locked) await db('skills').where({ name }).update({ locked: false });  // C5: unlock so the live trigger permits the update
    await db('skills').where({ name }).update({ ...fields, updated_at: now });
  }

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
