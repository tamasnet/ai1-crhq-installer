// core/skill.mjs — skills table (PK name) + assets under SKILLS_BASE_DIR/<key>.
import { join } from 'path';
import { existsSync } from 'fs';
import { copyTree, removeTree, writeIfChanged, syncInstallTree, pruneTree } from '../fs.mjs';
import { protectMatcher, listProtectedEntries } from '../protect.mjs';
import { parseFrontmatter, dumpYaml } from '../parse.mjs';
import { VERDICT, logDeletions } from '../log.mjs';
import { recordVersion, removeVersions, currentVersion } from '../version-history.mjs';
import { planResult } from './plan-result.mjs';

async function resolveSkillState(ctx, def) {
  const { db, SKILLS_BASE, INSTALL_SKILLS_AS_USER } = ctx;
  const name = def.name;
  const skillDir = join(SKILLS_BASE, def.key);
  const skillPath = `db://skills/${name}`;
  const asUser = !!INSTALL_SKILLS_AS_USER || def.installType === 'user';
  const skillType = asUser ? 'user' : 'org';
  const locked = !asUser;
  const row = await db('skills').where({ name }).first();
  const fields = {
    description: def.description, content: def.content, skill_type: skillType,
    skill_path: skillPath, skill_dir: skillDir, is_active: true, is_global: false, locked,
  };
  const dbFields = row
    ? ['description', 'content', 'skill_type', 'skill_path', 'skill_dir', 'locked', 'is_active']
      .filter((k) => row[k] !== fields[k])
    : [];
  const rowChanged = !row || dbFields.length > 0;
  let fileChanges = 0;
  let pruned = 0;
  if (def.srcDir && existsSync(def.srcDir)) {
    fileChanges = copyTree(def.srcDir, skillDir, { dryRun: true, skip: (rel) => rel === 'SKILL.md' });
    if (ctx.STRICT && existsSync(skillDir)) {
      pruned = pruneTree(skillDir, def.srcDir, { dryRun: true, skip: protectMatcher(def.protect).skip }).length;
    }
  }
  const ver = { fkValue: name, version: def.version, name: def.name, description: def.description, body: def.content };
  return { name, skillDir, fields, row, rowChanged, dbFields, fileChanges, pruned, ver };
}

export async function planSkill(ctx, def) {
  const { RESPECT_LOCKS } = ctx;
  const { name, row, rowChanged, dbFields, fileChanges, pruned } = await resolveSkillState(ctx, def);
  if (!row) return planResult('skill', name, { verdict: VERDICT.ABSENT, action: 'absent' });
  if (RESPECT_LOCKS && row.locked && (rowChanged || fileChanges > 0 || pruned > 0)) {
    return planResult('skill', name, { verdict: VERDICT.LOCKED, action: 'skipped', detail: 'locked' });
  }
  if (!rowChanged && fileChanges === 0 && pruned === 0) {
    return planResult('skill', name, { verdict: VERDICT.ALREADY, action: 'updated' });
  }
  return planResult('skill', name, {
    verdict: VERDICT.OK,
    action: 'updated',
    dimensions: {
      db: rowChanged, files: fileChanges > 0,
      ...(dbFields.length ? { dbFields } : {}), ...(pruned > 0 ? { pruned } : {}),
    },
  });
}

function installSkillAssets(ctx, def, skillDir) {
  if (!def.srcDir || !existsSync(def.srcDir)) return { files: 0, pruned: [] };
  const shipped = listProtectedEntries(def.srcDir, def.protect);
  if (shipped.length) {
    ctx.log.warn(`skill ${def.name}: package ships protected entries (installed as one-way seed, never pruned/synced): ${shipped.join(', ')}`);
  }
  const protect = protectMatcher(def.protect);
  const { files, pruned } = syncInstallTree(def.srcDir, skillDir, {
    dryRun: !!ctx.DRY_RUN, strict: !!ctx.STRICT, pruneSkip: protect.skip,
  });
  logDeletions(ctx.log, skillDir, pruned, { dryRun: !!ctx.DRY_RUN });
  if (ctx.STRICT && protect.matched.size) {
    ctx.log.info(`skill ${def.name}: protected (kept): ${[...protect.matched].sort().join(', ')}`);
  }
  return { files, pruned };
}

export async function upsertSkill(ctx, def) {
  const { db, log, DRY_RUN } = ctx;
  const { name, skillDir, fields, row, rowChanged, ver } = await resolveSkillState(ctx, def);

  if (!row) {
    if (DRY_RUN) {
      log.dry(`create skill ${name} as ${fields.skill_type}${fields.locked ? ' (locked)' : ''} and copy assets → ${skillDir}`);
      installSkillAssets(ctx, def, skillDir);
      await recordVersion(ctx, 'skill', ver);
      return result(name, VERDICT.OK, 'created');
    }
    const now = new Date();
    await db('skills').insert({ name, ...fields, created_at: now, updated_at: now });
    const { files } = installSkillAssets(ctx, def, skillDir);
    await recordVersion(ctx, 'skill', ver);
    return result(name, VERDICT.OK, 'created', files);
  }

  const plan = await planSkill(ctx, def);

  if (plan.verdict === VERDICT.LOCKED) {
    log.warn(`skill ${name} is locked; skipped (--respect-locks)`);
    return result(name, VERDICT.LOCKED, 'skipped');
  }

  if (DRY_RUN) {
    if (row?.locked && rowChanged) log.dry(`unlock locked skill ${name}`);
    log.dry(`${row ? 'update' : 'create'} skill ${name} as ${fields.skill_type}${fields.locked ? ' (locked)' : ''} and copy assets → ${skillDir}`);
    installSkillAssets(ctx, def, skillDir);
    await recordVersion(ctx, 'skill', ver);
    return result(name, plan.verdict, row ? 'updated' : 'created');
  }

  const now = new Date();
  if (!row) {
    await db('skills').insert({ name, ...fields, created_at: now, updated_at: now });
  } else if (rowChanged) {
    if (row.locked) await db('skills').where({ name }).update({ locked: false });
    await db('skills').where({ name }).update({ ...fields, updated_at: now });
  }

  const { files } = installSkillAssets(ctx, def, skillDir);
  await recordVersion(ctx, 'skill', ver);
  const verdict = (plan.verdict === VERDICT.ALREADY && files === 0) ? VERDICT.ALREADY : VERDICT.OK;
  return result(name, verdict, row ? 'updated' : 'created', files);
}

export async function removeSkill(ctx, nameOrDef) {
  const { db, log, DRY_RUN, RESPECT_LOCKS, SKILLS_BASE } = ctx;
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await db('skills').where({ name }).first();
  const dir = row?.skill_dir || (typeof nameOrDef === 'object' && nameOrDef.key ? join(SKILLS_BASE, nameOrDef.key) : null);

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
  await removeVersions(ctx, 'skill', name);
  removeTree(dir, { dryRun: false });
  return result(name, VERDICT.OK, 'removed');
}

export async function exportSkill(ctx, row, { outRoot, relPath, protect }) {
  const { db, log } = ctx;
  const destDir = join(outRoot, relPath);
  const matcher = protectMatcher(protect);
  const files = row.skill_dir && existsSync(row.skill_dir)
    ? copyTree(row.skill_dir, destDir, { dryRun: !!ctx.DRY_RUN, skip: (rel) => rel === 'SKILL.md' || matcher.skip(rel) })
    : 0;
  if (matcher.matched.size) log.info(`skill ${row.name}: protected (not exported): ${[...matcher.matched].sort().join(', ')}`);

  let version = await currentVersion(db, 'skill', row.name);
  if (version == null) {
    version = 1;
    log.warn(`skill ${row.name}: no version history in skill_versions — pinned 1`);
  }
  const parsed = tryFrontmatter(row.content || '');
  const body = (parsed.meta.name || parsed.meta.version || parsed.meta.description) ? parsed.body : (row.content || '');
  const meta = { name: row.name, version, description: row.description || '' };
  const md = `---\n${dumpYaml(meta)}---\n\n${body.replace(/^\n+/, '')}`;
  const mdChanged = writeIfChanged(join(destDir, 'SKILL.md'), md, { dryRun: !!ctx.DRY_RUN });

  const entry = { path: relPath, version, ...(row.skill_type === 'user' ? { install_type: 'user' } : {}) };
  return { ...result(row.name, VERDICT.SYNC_OK, 'exported', files + (mdChanged ? 1 : 0)), entry, changed: files > 0 || mdChanged };
}

function tryFrontmatter(text) {
  try { return parseFrontmatter(text); } catch { return { meta: {}, body: text }; }
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
