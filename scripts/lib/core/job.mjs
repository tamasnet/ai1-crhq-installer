// core/job.mjs — background_jobs table (PK id varchar). Coarse prereq guard (C12): each required
// skill's install dir must exist before we register the job. script resolves under INSTALL_BASE_DIR.
import { join } from 'path';
import { VERDICT } from '../log.mjs';
import { requireFiles } from '../prereq.mjs';

const SCHEDULE_ALIASES = {
  hourly: '0 * * * *', daily: '0 0 * * *',
  'every-15-min': '*/15 * * * *', 'every-30-min': '*/30 * * * *',
};
const resolveSchedule = (s) => SCHEDULE_ALIASES[s] || s;
const mintJobId = () => `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;  // C10

export async function upsertJob(ctx, def) {
  const { db, log, DRY_RUN, NO_JOB, BASE } = ctx;
  const { name } = def;
  if (NO_JOB) { log.info(`job ${name} skipped (--no-job)`); return res(name, VERDICT.ALREADY, 'skipped'); }

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

export async function statusJob(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await ctx.db('background_jobs').where({ name }).first();
  return { type: 'job', name, verdict: row ? VERDICT.ALREADY : VERDICT.ABSENT, present: !!row, enabled: !!row?.enabled, schedule: row?.schedule };
}

function res(name, verdict, action) { return { type: 'job', name, verdict, action }; }
