// backup.mjs — the reverse of install (D-25..D-28): read the satellite's CRHQ-resident
// components (skills, recipes, agents, jobs) from the DB and write them back out as an
// INSTALLABLE package in the ai1-package.yaml manifest format under
// ${BACKUP_BASE_DIR}/<package-name>/. Restore = `install.mjs <that dir>`.
//
// Always live and non-destructive: it only reads the DB (via the same getDb() chokepoint, so
// INSTALL_SCHEMA still applies — which is how tests point it at a sandbox schema) and only
// writes under BACKUP_BASE. No sandbox, no locks. --dry-run (D-31) runs the full discovery /
// scope / export pipeline — including the skip rules and warnings — with ZERO filesystem writes
// (the export primitives thread ctx.DRY_RUN into the fs helpers); the generated manifest is
// validated in memory and the previous backup is left untouched. Services are out of scope in
// v1 (not DB-resident; their source of truth is the original package).
//
// Overwrite-in-place (D-26): each run replaces ${BACKUP_BASE}/<name>/ — but the package is
// built in a staging dir and swapped in only after the generated manifest passes the same
// loadManifest() an install would run, so a failed backup never clobbers the previous good one.
import { mkdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import { loadManifest, validateManifest } from './manifest.mjs';
import { dumpYaml } from './parse.mjs';
import { writeIfChanged, safeName } from './fs.mjs';
import { VERDICT } from './log.mjs';
import { makeFilter, hasFilter } from './filter.mjs';
import { exportSkill } from './core/skill.mjs';
import { exportRecipe } from './core/recipe.mjs';
import { exportAgent } from './core/agent.mjs';
import { exportJob } from './core/job.mjs';

// Backup covers the DB-resident types only (manifest order, services excluded — D-25).
export const BACKUP_TYPES = ['skills', 'recipes', 'agents', 'jobs'];

// Default package name: <satellite-id>-backup (D-27). SATELLITE_ID env when set; else the host
// name minus its conventional `crhq-` prefix.
export function resolveBackupName() {
  const sat = process.env.SATELLITE_ID || hostname().replace(/^crhq-/, '');
  return `${sat}-backup`;
}

// Date-based package version (D-27), minted at the CLI entry and threaded in so lib/ stays
// deterministic for tests.
export function dateVersion(now) {
  return `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
}

// Scope (D-25): org/user skills (platform `system` skills are restored by the platform, not a
// package), all active recipes, non-system active agents, non-system jobs. Inactive rows are
// out of scope — the manifest can't express is_active:false, and restoring one would silently
// re-activate it. Ordered by name so output (and diffs of it) are deterministic.
async function discover(db) {
  return {
    skills: await db('skills').whereIn('skill_type', ['org', 'user']).where({ is_active: true }).orderBy('name'),
    recipes: await db('recipes').where({ is_active: true }).orderBy('name'),
    agents: await db('agents').where({ is_active: true })
      .where((q) => q.where({ is_system: false }).orWhereNull('is_system')).orderBy('key'),
    jobs: await db('background_jobs')
      .where((q) => q.where({ is_system: false }).orWhereNull('is_system')).orderBy('name'),
  };
}

export async function runBackup(ctx, { now = new Date() } = {}) {
  const { db, log } = ctx;
  const dry = !!ctx.DRY_RUN;
  const pkgName = ctx.NAME || resolveBackupName();
  const destDir = join(ctx.BACKUP_BASE, pkgName);
  const staging = `${destDir}.staging-${process.pid}`;

  const found = await discover(db);

  // --type (type scope; `services` never applies) + --include/--exclude (name filter) — the
  // same semantics as runPlan, tested against the same canonical name per type.
  const only = Array.isArray(ctx.TYPE) ? ctx.TYPE : (ctx.TYPE ? [ctx.TYPE] : []);
  const onlySet = only.length ? new Set(only) : null;
  if (onlySet?.has('services')) log.warn('services are not DB-resident — backup does not cover them; ignoring');
  const types = onlySet ? BACKUP_TYPES.filter((t) => onlySet.has(t)) : BACKUP_TYPES;
  const filterSpec = { include: ctx.INCLUDE, exclude: ctx.EXCLUDE };
  const match = makeFilter(filterSpec);
  const nameOf = { skills: (r) => r.name, recipes: (r) => r.name, agents: (r) => r.key, jobs: (r) => r.name };

  const scoped = {};
  let considered = 0;
  let selected = 0;
  for (const t of BACKUP_TYPES) {
    const inType = types.includes(t) ? found[t] : [];
    considered += inType.length;
    scoped[t] = inType.filter((r) => match(nameOf[t](r)));
    selected += scoped[t].length;
  }
  log.info(`scope: ${types.map((t) => `${scoped[t].length} ${t}`).join(', ')} (org/user, active; system components excluded)`);
  if (hasFilter(filterSpec) && selected === 0 && considered > 0) {
    const avail = types.flatMap((t) => found[t].map(nameOf[t]));
    log.warn(`--include/--exclude matched 0 of ${considered} component(s) — nothing to do. Available: ${avail.join(', ') || '(none)'}`);
  }

  if (!dry) {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
  }

  try {
    // Component file paths: sanitized name, deduped on (rare) sanitization collisions.
    const used = new Set();
    const pathFor = (dir, base, ext) => {
      let p = `${dir}/${base}${ext}`;
      for (let i = 2; used.has(p); i++) p = `${dir}/${base}-${i}${ext}`;
      used.add(p);
      return p;
    };
    const skillNames = new Set(scoped.skills.map((r) => r.name));
    const EXPORT = {
      skills: (row) => exportSkill(ctx, row, { outRoot: staging, relPath: pathFor('skills', safeName(row.name), '') }),
      recipes: (row) => exportRecipe(ctx, row, { outRoot: staging, relPath: pathFor('recipes', safeName(row.name), '.md') }),
      agents: (row) => exportAgent(ctx, row, { outRoot: staging, relPath: pathFor('agents', safeName(row.key), '.yaml') }),
      jobs: (row) => exportJob(ctx, row, { outRoot: staging, relPath: pathFor('jobs', safeName(row.name), '.yaml'), skillNames }),
    };

    // Continue-and-report, like runPlan: one failing component records BACKUP-FAIL (→ exit 1)
    // but doesn't abort the rest of the backup.
    const components = {};
    for (const t of types) {
      for (const row of scoped[t]) {
        const name = nameOf[t](row);
        try {
          const r = await EXPORT[t](row);
          ctx.record(r);
          if (r.entry) (components[t] ||= []).push(r.entry);
        } catch (e) {
          log.error(`${t}:${name} failed: ${e.message}`);
          ctx.record({ type: t.replace(/s$/, ''), name, verdict: VERDICT.BACKUP_FAIL, action: 'error', detail: e.message });
        }
      }
    }

    const meta = {
      name: pkgName,
      version: dateVersion(now),
      description: `CRHQ satellite backup (${types.join(', ')}) generated by ai1-crhq-installer backup.`,
      components,
    };
    writeIfChanged(join(staging, 'ai1-package.yaml'), dumpYaml(meta), { dryRun: dry });

    if (dry) {
      // Nothing was staged, so the full loadManifest() self-check can't run — validate the
      // generated manifest in memory instead (same shape/required-field/pin rules, minus the
      // component-file reads). The previous backup (if any) is left untouched.
      validateManifest(meta);
      log.dry(`write backup package: ${destDir}`);
    } else {
      // Self-check: the backup must itself be installable — parse + validate the staged package
      // exactly the way install.mjs would. Throws ManifestError on any defect, before the swap.
      loadManifest(staging);

      // Swap (D-26): replace the previous backup only once the staged package is complete + valid.
      rmSync(destDir, { recursive: true, force: true });
      renameSync(staging, destDir);
      log.ok(`backup package: ${destDir}`);
    }
    ctx.reportExtra = { package: { name: pkgName, version: meta.version, dir: destDir, ...(dry ? { dryRun: true } : {}) } };
    return { dir: destDir, meta, results: ctx.results };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });   // never leave a half-built staging dir
    throw e;
  }
}
