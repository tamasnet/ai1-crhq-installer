// sandbox.mjs — built-in --sandbox (D-17/D-18). Provisions an isolated schema cloned from live
// (CREATE TABLE … LIKE … INCLUDING ALL), seeds live skills so agent-attach + dep checks mirror
// reality (OQ-14), redirects INSTALL_SCHEMA/INSTALL_BASE_DIR, then tears down. --lifecycle runs the
// full install → status → idempotency → uninstall → reinstall assertion suite.
import { mkdirSync, rmSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getAdminDb } from './db.mjs';
import { runPlan } from './run.mjs';
import { VERDICT } from './log.mjs';

export const TABLES = ['skills', 'skill_versions', 'recipes', 'agents', 'agent_skills', 'agent_recipes', 'background_jobs'];

export async function provisionSandbox({ ts, seed = true } = {}) {
  const admin = getAdminDb();
  const schema = `sandbox_${ts}`;
  const baseDir = join(tmpdir(), `ai1-sandbox-${ts}`);
  const packagesDir = join(tmpdir(), `ai1-sandbox-${ts}-packages`);  // install log lands here, not in the real PACKAGES_DIR (D-24)

  await admin.raw('CREATE SCHEMA ??', [schema]);
  for (const t of TABLES) {
    await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, t, t]);  // D-18
  }
  // OQ-14: LIKE omits foreign keys. We deliberately do NOT re-create them — join inserts are
  // guarded (only existing skills/recipes attach) and removeAgent deletes joins explicitly, so
  // intra-schema FKs aren't needed for lifecycle fidelity. We DO seed live skills so agent-attach
  // and prereq checks behave like the real satellite.
  if (seed) {
    await admin.raw(
      'INSERT INTO ??.skills (name, description, skill_path, skill_dir, skill_type, is_active, is_global) '
      + 'SELECT name, description, skill_path, skill_dir, skill_type, is_active, is_global FROM public.skills',
      [schema],
    );
  }

  process.env.INSTALL_SCHEMA = schema;       // redirect BEFORE createContext/getDb (§2/§8)
  process.env.INSTALL_BASE_DIR = baseDir;
  process.env.PACKAGES_DIR = packagesDir;
  mkdirSync(baseDir, { recursive: true });
  mkdirSync(packagesDir, { recursive: true });

  return {
    schema, baseDir, packagesDir,
    async teardown(keep = false) {
      if (keep) return;
      await admin.raw('DROP SCHEMA ?? CASCADE', [schema]);
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(packagesDir, { recursive: true, force: true });
    },
  };
}

// State fingerprint within a schema. agent_recipes are keyed by recipe NAME (not uuid) so a
// reinstall — which mints a fresh recipe uuid — still compares equal to the first install.
export async function snapshotState(schema, baseDir) {
  const db = getAdminDb();
  const skills = (await db(`${schema}.skills`).select('name')).map((r) => r.name).sort();
  const recipes = (await db(`${schema}.recipes`).select('name')).map((r) => r.name).sort();
  const agents = (await db(`${schema}.agents`).select('key')).map((r) => r.key).sort();
  const jobs = (await db(`${schema}.background_jobs`).select('name')).map((r) => r.name).sort();
  const agentSkills = (await db(`${schema}.agent_skills`).select('agent_key', 'skill_name'))
    .map((r) => `${r.agent_key}:${r.skill_name}`).sort();
  const agentRecipes = (await db(`${schema}.agent_recipes as ar`)
    .leftJoin(`${schema}.recipes as r`, 'ar.recipe_id', 'r.id')
    .select('ar.agent_key as ak', 'r.name as rn'))
    .map((r) => `${r.ak}:${r.rn}`).sort();
  const files = existsSync(baseDir) ? readdirSync(baseDir).sort() : [];
  return { skills, recipes, agents, jobs, agentSkills, agentRecipes, files };
}

export function diffState(a, b) {
  const diffs = [];
  for (const k of Object.keys(a)) {
    const setA = new Set(a[k]);
    const setB = new Set(b[k]);
    const added = b[k].filter((x) => !setA.has(x));
    const removed = a[k].filter((x) => !setB.has(x));
    if (added.length) diffs.push(`${k}: +[${added.join(', ')}]`);
    if (removed.length) diffs.push(`${k}: -[${removed.join(', ')}]`);
  }
  return diffs;
}

const okVerdict = (v) => v === VERDICT.OK || v === VERDICT.ALREADY || v === VERDICT.STATUS || v === VERDICT.ABSENT;

// Full lifecycle assertion suite. Assertions are RELATIVE to the post-seed baseline so seeded
// skills don't register as drift.
export async function runLifecycle(ctx, plan) {
  const { SCHEMA: schema, BASE, log } = ctx;
  const phases = [];
  const add = (name, passed, detail = '') => {
    phases.push({ name, passed, detail });
    log.info(`[lifecycle] ${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const run = async (mode) => { ctx.mode = mode; ctx.results = []; await runPlan(ctx, plan); return ctx.results; };
  const failures = (results) => results.filter((r) => !okVerdict(r.verdict));

  const baseline = await snapshotState(schema, BASE);

  const r1 = await run('install');
  const s1 = await snapshotState(schema, BASE);
  const f1 = failures(r1);
  add('fresh-install', f1.length === 0, f1.length ? f1.map((r) => `${r.name}:${r.verdict}`).join(', ') : `${s1.skills.length - baseline.skills.length} skill(s), ${s1.recipes.length} recipe(s), ${s1.agents.length} agent(s), ${s1.jobs.length} job(s) added`);

  const rs = await run('status');
  add('status', failures(rs).length === 0, `${rs.filter((r) => r.verdict === VERDICT.ALREADY).length} present`);

  await run('install');
  const s2 = await snapshotState(schema, BASE);
  const drift = diffState(s1, s2);
  add('idempotency', drift.length === 0, drift.join('; ') || 'zero drift');

  const r3 = await run('uninstall');
  const s3 = await snapshotState(schema, BASE);
  const back = diffState(baseline, s3);
  add('uninstall-clean', failures(r3).length === 0 && back.length === 0, back.join('; ') || 'returned to baseline');

  await run('install');
  const s4 = await snapshotState(schema, BASE);
  const redrift = diffState(s1, s4);
  add('reinstall', redrift.length === 0, redrift.join('; ') || 'reproduced original');

  const passed = phases.every((p) => p.passed);
  log.info(`[lifecycle] ${passed ? '✅ ALL PASS' : '❌ FAILURES PRESENT'}`);
  return { phases, passed };
}
