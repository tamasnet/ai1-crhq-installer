// core/job.mjs — background_jobs table (PK id varchar). Coarse prereq guard (C12): each required
// skill's install dir must exist before we register the job. script resolves under INSTALL_BASE_DIR.
import { join } from 'path';
import { writeIfChanged } from '../fs.mjs';
import { dumpYaml } from '../parse.mjs';
import { VERDICT } from '../log.mjs';
import { requireFiles } from '../prereq.mjs';

const SCHEDULE_ALIASES = {
  hourly: '0 * * * *', daily: '0 0 * * *',
  'every-15-min': '*/15 * * * *', 'every-30-min': '*/30 * * * *',
};
const resolveSchedule = (s) => SCHEDULE_ALIASES[s] || s;
const mintJobId = () => `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;  // C10

export async function upsertJob(ctx, def) {
  const { db, log, DRY_RUN, BASE } = ctx;
  const { name } = def;

  // C12: required skill install dirs must exist. In dry-run nothing is written, so only enforce
  // genuinely-external deps (bundle-mates being installed this run are assumed present).
  const reqs = def.requires || [];
  requireFiles(ctx, DRY_RUN ? reqs.filter((k) => !ctx.plannedSkills?.has(k)) : reqs);

  const schedule = resolveSchedule(def.schedule);
  const scriptArgs = join(BASE, def.script) + (def.args ? ` ${def.args}` : '');
  const fields = {
    description: def.description || '', schedule, timezone: def.timezone || 'UTC',
    job_type: 'script', script_path: 'node', script_args: scriptArgs,
    timeout_minutes: def.timeout_minutes ?? 30, max_concurrent: def.max_concurrent ?? 1,
    skip_if_running: def.skip_if_running ?? true, enabled: def.enabled ?? true,
  };
  const row = await db('background_jobs').where({ name }).first();
  const compareKeys = ['schedule', 'timezone', 'script_args', 'timeout_minutes', 'max_concurrent', 'skip_if_running', 'enabled'];
  const changed = !row || (row.description || '') !== fields.description || compareKeys.some((k) => row[k] !== fields[k]);

  if (DRY_RUN) {
    log.dry(`${row ? 'update' : 'create'} job ${name} (${schedule})`);
    return res(name, changed ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created');
  }

  const now = new Date();
  if (!row) await db('background_jobs').insert({ id: mintJobId(), name, ...fields, run_count: 0, created_at: now, updated_at: now });
  else if (changed) await db('background_jobs').where({ name }).update({ ...fields, updated_at: now });

  return res(name, changed ? VERDICT.OK : VERDICT.ALREADY, row ? 'updated' : 'created');
}

export async function removeJob(ctx, nameOrDef) {
  const { db, DRY_RUN, log } = ctx;
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await db('background_jobs').where({ name }).first();
  if (!row) return res(name, VERDICT.ALREADY, 'absent');
  if (DRY_RUN) { log.dry(`delete job ${name}`); return res(name, VERDICT.OK, 'removed'); }
  await db('background_jobs').where({ name }).del();
  return res(name, VERDICT.OK, 'removed');
}

// exportJob — backup: reverse upsertJob's mapping. Only `job_type:'script'` + `script_path:'node'`
// rows whose script lives under INSTALL_BASE_DIR can be expressed in the manifest's
// `<skill-key>/scripts/<file>` form — anything else is BACKUP-SKIP, warned, non-fatal (D-28).
// `script_args` was composed as `join(BASE, script)[ + ' ' + args]`, so it splits the same way.
// The DB stores the resolved cron, which round-trips (aliases resolve idempotently). `requires`
// is re-derived from the script's skill segment when that skill is part of the backup.
export async function exportJob(ctx, row, { outRoot, relPath, skillNames }) {
  const { log, BASE } = ctx;
  const skip = (reason) => {
    log.warn(`job ${row.name}: ${reason} — skipped`);
    return { type: 'job', name: row.name, verdict: VERDICT.BACKUP_SKIP, action: 'skipped', detail: reason };
  };
  if (row.job_type !== 'script' || row.script_path !== 'node') {
    return skip(`not a script/node job (job_type=${row.job_type}, script_path=${row.script_path})`);
  }
  const prefix = BASE.endsWith('/') ? BASE : `${BASE}/`;
  const sa = row.script_args || '';
  if (!sa.startsWith(prefix)) return skip(`script outside INSTALL_BASE_DIR (${BASE}): ${sa.split(' ')[0] || '(empty)'}`);

  const rel = sa.slice(prefix.length);
  const sp = rel.indexOf(' ');
  const script = sp === -1 ? rel : rel.slice(0, sp);
  const args = sp === -1 ? '' : rel.slice(sp + 1);
  const skillKey = script.split('/')[0];

  const def = {
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    schedule: row.schedule,
    ...(row.timezone && row.timezone !== 'UTC' ? { timezone: row.timezone } : {}),
    script,
    ...(args ? { args } : {}),
    timeout_minutes: row.timeout_minutes ?? 30,
    max_concurrent: row.max_concurrent ?? 1,
    skip_if_running: row.skip_if_running ?? true,
    enabled: row.enabled ?? true,
    ...(skillNames?.has(skillKey) ? { requires: [skillKey] } : {}),
  };
  writeIfChanged(join(outRoot, relPath), dumpYaml(def), { dryRun: false });
  return { ...res(row.name, VERDICT.BACKUP_OK, 'exported'), entry: { path: relPath } };
}

export async function statusJob(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await ctx.db('background_jobs').where({ name }).first();
  return { type: 'job', name, verdict: row ? VERDICT.ALREADY : VERDICT.ABSENT, present: !!row, enabled: !!row?.enabled, schedule: row?.schedule };
}

function res(name, verdict, action) { return { type: 'job', name, verdict, action }; }
