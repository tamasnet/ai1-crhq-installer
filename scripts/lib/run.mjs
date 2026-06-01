// run.mjs — the shared plan dispatcher used by both the CLI runner (install.mjs) and the sandbox
// lifecycle suite, so they exercise identical code paths. Order = skills → recipes → agents →
// jobs → services (D-4); uninstall reverses (C13). Continue-and-report: one failing component is
// recorded but doesn't abort the rest.
import * as skill from './core/skill.mjs';
import * as recipe from './core/recipe.mjs';
import * as agent from './core/agent.mjs';
import * as job from './core/job.mjs';
import * as service from './core/service.mjs';
import { VERDICT } from './log.mjs';

export const ORDER = ['skills', 'recipes', 'agents', 'jobs', 'services'];

const DISPATCH = {
  skills: { upsert: skill.upsertSkill, remove: skill.removeSkill, status: skill.statusSkill },
  recipes: { upsert: recipe.upsertRecipe, remove: recipe.removeRecipe, status: recipe.statusRecipe },
  agents: { upsert: agent.upsertAgent, remove: agent.removeAgent, status: agent.statusAgent },
  jobs: { upsert: job.upsertJob, remove: job.removeJob, status: job.statusJob },
  services: { upsert: service.installService, remove: service.removeService, status: service.statusService },
};

export async function runPlan(ctx, plan) {
  const verb = ctx.mode === 'uninstall' ? 'remove' : ctx.mode === 'status' ? 'status' : 'upsert';
  const types = ctx.ONLY ? [ctx.ONLY] : ORDER;
  const seq = ctx.mode === 'uninstall' ? [...types].reverse() : types;

  // What this run will install — lets dry-run preview the planned end state so a component's
  // bundle-mates (a skill it depends on) count as satisfied even though nothing is written yet.
  const willRun = (t) => (ctx.ONLY ? ctx.ONLY === t : true)
    && !(t === 'agents' && ctx.NO_AGENT) && !(t === 'jobs' && ctx.NO_JOB);
  ctx.plannedSkills = new Set(willRun('skills') ? (plan.skills || []).map((s) => s.name) : []);
  ctx.plannedRecipes = new Set(willRun('recipes') ? (plan.recipes || []).map((r) => r.name) : []);

  for (const type of seq) {
    if (type === 'agents' && ctx.NO_AGENT) continue;
    if (type === 'jobs' && ctx.NO_JOB) continue;
    const fn = DISPATCH[type]?.[verb];
    if (!fn) continue;
    for (const def of plan[type] || []) {
      try {
        ctx.record(await fn(ctx, def));
      } catch (e) {
        const name = def.name || def.key || '?';
        ctx.log.error(`${type}:${name} failed: ${e.message}`);
        ctx.record({ type: type.replace(/s$/, ''), name, verdict: e.name === 'PrereqError' ? VERDICT.PREREQ : VERDICT.FAIL, action: 'error', detail: e.message });
      }
    }
  }
  return ctx.results;
}
