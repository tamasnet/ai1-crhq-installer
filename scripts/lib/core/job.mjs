// core/job.mjs — background_jobs table (PK id varchar). Coarse prereq guard: each required
// skill's install dir must exist before we register the job. script resolves under SKILLS_BASE_DIR.
import { join } from 'path';
import { writeIfChanged } from '../fs.mjs';
import { dumpYaml } from '../parse.mjs';
import { VERDICT } from '../log.mjs';
import { requireFiles } from '../prereq.mjs';
import { planResult } from './plan-result.mjs';

const SCHEDULE_ALIASES = {
  hourly: '0 * * * *', daily: '0 0 * * *',
  'every-15-min': '*/15 * * * *', 'every-30-min': '*/30 * * * *',
};
const resolveSchedule = (s) => SCHEDULE_ALIASES[s] || s;
const mintJobId = () => `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const COMMON_DEFAULTS = {
  timeout_minutes: 30,
  max_concurrent: 1,
  skip_if_running: true,
  enabled: true,
};

function resolveJobType(def) {
  if (def.job_type) return def.job_type;
  if (def.script) return 'script';
  return null;
}

function commonFields(def, schedule) {
  return {
    description: def.description || '',
    schedule,
    timezone: def.timezone || 'UTC',
    timeout_minutes: def.timeout_minutes ?? COMMON_DEFAULTS.timeout_minutes,
    max_concurrent: def.max_concurrent ?? COMMON_DEFAULTS.max_concurrent,
    skip_if_running: def.skip_if_running ?? COMMON_DEFAULTS.skip_if_running,
    enabled: def.enabled ?? COMMON_DEFAULTS.enabled,
  };
}

function fieldsForDef(ctx, def) {
  const schedule = resolveSchedule(def.schedule);
  const jobType = resolveJobType(def);
  const base = commonFields(def, schedule);

  if (jobType === 'script') {
    const scriptArgs = join(ctx.SKILLS_BASE, def.script) + (def.args ? ` ${def.args}` : '');
    return {
      ...base,
      job_type: 'script',
      script_path: 'node',
      script_args: scriptArgs,
      agent: null,
      task: null,
      recipe_id: null,
      project_id: null,
      target_session_id: null,
      message: null,
      model: null,
      max_runs_before_rotate: null,
    };
  }
  if (jobType === 'new_session') {
    return {
      ...base,
      job_type: 'new_session',
      agent: def.agent || null,
      task: def.task || null,
      recipe_id: def.recipe_id || null,
      project_id: def.project_id || null,
      model: def.model || null,
      script_path: null,
      script_args: null,
      target_session_id: null,
      message: null,
      max_runs_before_rotate: null,
    };
  }
  if (jobType === 'message_session') {
    return {
      ...base,
      job_type: 'message_session',
      target_session_id: def.target_session_id,
      message: def.message,
      max_runs_before_rotate: def.max_runs_before_rotate ?? null,
      model: def.model || null,
      agent: null,
      task: null,
      recipe_id: null,
      project_id: null,
      script_path: null,
      script_args: null,
    };
  }
  throw new Error(`unsupported job type: ${jobType}`);
}

const COMPARE_KEYS = {
  script: ['schedule', 'timezone', 'script_args', 'timeout_minutes', 'max_concurrent', 'skip_if_running', 'enabled'],
  new_session: ['schedule', 'timezone', 'agent', 'task', 'recipe_id', 'project_id', 'model', 'timeout_minutes', 'max_concurrent', 'skip_if_running', 'enabled'],
  message_session: ['schedule', 'timezone', 'target_session_id', 'message', 'max_runs_before_rotate', 'model', 'timeout_minutes', 'max_concurrent', 'skip_if_running', 'enabled'],
};

function rowFieldDiff(row, fields) {
  const diffs = [];
  if (row.job_type !== fields.job_type) diffs.push('job_type');
  if ((row.description || '') !== fields.description) diffs.push('description');
  for (const k of COMPARE_KEYS[fields.job_type] || []) if (row[k] !== fields[k]) diffs.push(k);
  return diffs;
}

function rowChanged(row, fields) {
  return rowFieldDiff(row, fields).length > 0;
}

function checkPrereqs(ctx, def) {
  const reqs = def.requires || [];
  const external = reqs.filter((k) => !ctx.plannedSkills?.has(k));
  try {
    requireFiles(ctx, external);
    return null;
  } catch (e) {
    if (e.name === 'PrereqError') return 'missing prerequisite';
    throw e;
  }
}

export async function planJob(ctx, def) {
  const { name } = def;
  const prereq = checkPrereqs(ctx, def);
  if (prereq) {
    return planResult('job', name, { verdict: VERDICT.OK, action: 'updated', detail: prereq, dimensions: { prereq: true } });
  }
  const fields = fieldsForDef(ctx, def);
  const row = await ctx.db('background_jobs').where({ name }).first();
  if (!row) return planResult('job', name, { verdict: VERDICT.ABSENT, action: 'absent' });
  const dbFields = rowFieldDiff(row, fields);
  if (!dbFields.length) return planResult('job', name, { verdict: VERDICT.ALREADY, action: 'updated' });
  return planResult('job', name, { verdict: VERDICT.OK, action: 'updated', dimensions: { db: true, dbFields } });
}

export async function upsertJob(ctx, def) {
  const { db, log, DRY_RUN } = ctx;
  const { name } = def;

  const reqs = def.requires || [];
  requireFiles(ctx, DRY_RUN ? reqs.filter((k) => !ctx.plannedSkills?.has(k)) : reqs);

  const fields = fieldsForDef(ctx, def);
  const row = await db('background_jobs').where({ name }).first();

  if (!row) {
    if (DRY_RUN) {
      log.dry(`create job ${name} (${fields.schedule})`);
      return res(name, VERDICT.OK, 'created');
    }
    const now = new Date();
    await db('background_jobs').insert({ id: mintJobId(), name, ...fields, run_count: 0, created_at: now, updated_at: now });
    return res(name, VERDICT.OK, 'created');
  }

  const plan = await planJob(ctx, def);
  if (DRY_RUN) {
    log.dry(`${plan.verdict === VERDICT.ALREADY ? 'noop' : 'update'} job ${name} (${fields.schedule})`);
    return res(name, plan.verdict, 'updated');
  }

  const changed = rowChanged(row, fields);
  const now = new Date();
  if (changed) await db('background_jobs').where({ name }).update({ ...fields, updated_at: now });
  return res(name, plan.verdict, 'updated');
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

function exportCommonJobFields(row) {
  return {
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    schedule: row.schedule,
    ...(row.timezone && row.timezone !== 'UTC' ? { timezone: row.timezone } : {}),
    timeout_minutes: row.timeout_minutes ?? COMMON_DEFAULTS.timeout_minutes,
    max_concurrent: row.max_concurrent ?? COMMON_DEFAULTS.max_concurrent,
    skip_if_running: row.skip_if_running ?? COMMON_DEFAULTS.skip_if_running,
    enabled: row.enabled ?? COMMON_DEFAULTS.enabled,
  };
}

function exportScriptJob(ctx, row, { outRoot, relPath, skillNames }) {
  const { log, SKILLS_BASE } = ctx;
  const skip = (reason) => {
    log.warn(`job ${row.name}: ${reason} — skipped`);
    return { type: 'job', name: row.name, verdict: VERDICT.SYNC_SKIP, action: 'skipped', detail: reason };
  };
  if (row.job_type !== 'script' || row.script_path !== 'node') {
    return skip(`not a script/node job (job_type=${row.job_type}, script_path=${row.script_path})`);
  }
  const prefix = SKILLS_BASE.endsWith('/') ? SKILLS_BASE : `${SKILLS_BASE}/`;
  const sa = row.script_args || '';
  if (!sa.startsWith(prefix)) return skip(`script outside SKILLS_BASE_DIR (${SKILLS_BASE}): ${sa.split(' ')[0] || '(empty)'}`);

  const rel = sa.slice(prefix.length);
  const sp = rel.indexOf(' ');
  const script = sp === -1 ? rel : rel.slice(0, sp);
  const args = sp === -1 ? '' : rel.slice(sp + 1);
  const skillKey = script.split('/')[0];

  const def = {
    ...exportCommonJobFields(row),
    script,
    ...(args ? { args } : {}),
    ...(skillNames?.has(skillKey) ? { requires: [skillKey] } : {}),
  };
  const changed = writeIfChanged(join(outRoot, relPath), dumpYaml(def), { dryRun: !!ctx.DRY_RUN });
  return { ...res(row.name, VERDICT.SYNC_OK, 'exported'), entry: { path: relPath }, changed };
}

function exportNewSessionJob(ctx, row, { outRoot, relPath }) {
  const { log } = ctx;
  if (!row.agent || (!row.task && !row.recipe_id)) {
    log.warn(`job ${row.name}: new_session missing agent or task/recipe_id — skipped`);
    return { type: 'job', name: row.name, verdict: VERDICT.SYNC_SKIP, action: 'skipped', detail: 'incomplete new_session job' };
  }
  const def = {
    ...exportCommonJobFields(row),
    job_type: 'new_session',
    agent: row.agent,
    ...(row.task ? { task: row.task } : {}),
    ...(row.recipe_id ? { recipe_id: row.recipe_id } : {}),
    ...(row.project_id ? { project_id: row.project_id } : {}),
    ...(row.model ? { model: row.model } : {}),
  };
  const changed = writeIfChanged(join(outRoot, relPath), dumpYaml(def), { dryRun: !!ctx.DRY_RUN });
  return { ...res(row.name, VERDICT.SYNC_OK, 'exported'), entry: { path: relPath }, changed };
}

function exportMessageSessionJob(ctx, row, { outRoot, relPath }) {
  const { log } = ctx;
  if (!row.target_session_id || !row.message) {
    log.warn(`job ${row.name}: message_session missing target_session_id or message — skipped`);
    return { type: 'job', name: row.name, verdict: VERDICT.SYNC_SKIP, action: 'skipped', detail: 'incomplete message_session job' };
  }
  const def = {
    ...exportCommonJobFields(row),
    job_type: 'message_session',
    target_session_id: row.target_session_id,
    message: row.message,
    ...(row.max_runs_before_rotate != null ? { max_runs_before_rotate: row.max_runs_before_rotate } : {}),
    ...(row.model ? { model: row.model } : {}),
  };
  const changed = writeIfChanged(join(outRoot, relPath), dumpYaml(def), { dryRun: !!ctx.DRY_RUN });
  return { ...res(row.name, VERDICT.SYNC_OK, 'exported'), entry: { path: relPath }, changed };
}

export async function exportJob(ctx, row, opts) {
  if (row.job_type === 'new_session') return exportNewSessionJob(ctx, row, opts);
  if (row.job_type === 'message_session') return exportMessageSessionJob(ctx, row, opts);
  return exportScriptJob(ctx, row, opts);
}

export async function statusJob(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const row = await ctx.db('background_jobs').where({ name }).first();
  return { type: 'job', name, verdict: row ? VERDICT.ALREADY : VERDICT.ABSENT, present: !!row, enabled: !!row?.enabled, schedule: row?.schedule };
}

function res(name, verdict, action) { return { type: 'job', name, verdict, action }; }
