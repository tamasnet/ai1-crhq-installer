// run.mjs — the shared plan dispatcher used by both the CLI runner (install.mjs) and the sandbox
// lifecycle suite, so they exercise identical code paths. Order = skills → recipes → agents →
// jobs → services → projects (D-4); uninstall reverses (C13). Continue-and-report: one failing component is
// recorded but doesn't abort the rest.
import * as skill from './core/skill.mjs';
import * as recipe from './core/recipe.mjs';
import * as agent from './core/agent.mjs';
import * as job from './core/job.mjs';
import * as service from './core/service.mjs';
import { VERDICT } from './log.mjs';
import { makeFilter, hasFilter } from './filter.mjs';

export const ORDER = ['skills', 'recipes', 'agents', 'jobs', 'services', 'projects'];

// The canonical identifier a --include/--exclude filter is tested against — the same value the run
// summary prints. Every component type carries `name` (for agents it maps to agents.key — D-23).
const nameOf = (type, def) => def.name;

const DISPATCH = {
  skills: { upsert: skill.upsertSkill, remove: skill.removeSkill, status: skill.statusSkill },
  recipes: { upsert: recipe.upsertRecipe, remove: recipe.removeRecipe, status: recipe.statusRecipe },
  agents: { upsert: agent.upsertAgent, remove: agent.removeAgent, status: agent.statusAgent },
  jobs: { upsert: job.upsertJob, remove: job.removeJob, status: job.statusJob },
  services: { upsert: service.installService, remove: service.removeService, status: service.statusService },
  projects: { upsert: service.installProject, remove: service.removeProject, status: service.statusProject },
};

export async function runPlan(ctx, plan) {
  const verb = ctx.mode === 'uninstall' ? 'remove' : ctx.mode === 'status' ? 'status' : 'upsert';
  // --type restricts which component TYPES run. Accepts an array (multiple/comma-separated values)
  // or a single string (library callers). Intersect with ORDER so install order is preserved no
  // matter how the values were listed; unknown type names simply select nothing.
  const only = Array.isArray(ctx.TYPE) ? ctx.TYPE : (ctx.TYPE ? [ctx.TYPE] : []);
  const onlySet = only.length ? new Set(only) : null;
  const types = onlySet ? ORDER.filter((t) => onlySet.has(t)) : ORDER;
  const seq = ctx.mode === 'uninstall' ? [...types].reverse() : types;

  // --include/--exclude name filter (compiled once; an invalid pattern throws FilterError → usage
  // exit before any write). `select` drops components whose canonical name fails the filter.
  const filterSpec = { include: ctx.INCLUDE, exclude: ctx.EXCLUDE };
  const match = makeFilter(filterSpec);
  const select = (type, list) => (list || []).filter((def) => match(nameOf(type, def)));

  // What this run will install — lets dry-run preview the planned end state so a component's
  // bundle-mates (a skill it depends on) count as satisfied even though nothing is written yet.
  // The planned sets reflect the POST-filter plan (and the --type type scope), so a skill excluded
  // by --exclude or --type is not treated as a satisfied dependency this run.
  const willRun = (t) => types.includes(t);
  ctx.plannedSkills = new Set(willRun('skills') ? select('skills', plan.skills).map((s) => s.name) : []);
  ctx.plannedRecipes = new Set(willRun('recipes') ? select('recipes', plan.recipes).map((r) => r.name) : []);

  let considered = 0;
  let selected = 0;
  for (const type of seq) {
    const fn = DISPATCH[type]?.[verb];
    if (!fn) continue;
    const list = plan[type] || [];
    considered += list.length;
    const chosen = select(type, list);
    selected += chosen.length;
    for (const def of chosen) {
      try {
        ctx.record(await fn(ctx, def));
      } catch (e) {
        const name = def.name || '?';
        ctx.log.error(`${type}:${name} failed: ${e.message}`);
        ctx.record({ type: type.replace(/s$/, ''), name, verdict: e.name === 'PrereqError' ? VERDICT.PREREQ : VERDICT.FAIL, action: 'error', detail: e.message });
      }
    }
  }

  // Zero-match guard (warn + continue, exit 0): a filter that selects nothing is usually a typo, but
  // "nothing to do" is not a failure. List what was available so the mistake is easy to spot.
  if (hasFilter(filterSpec) && selected === 0 && considered > 0) {
    const avail = seq.flatMap((t) => (DISPATCH[t]?.[verb] ? (plan[t] || []).map((d) => nameOf(t, d)) : []));
    ctx.log.warn(`--include/--exclude matched 0 of ${considered} component(s) — nothing to do. Available: ${avail.join(', ') || '(none)'}`);
  }
  return ctx.results;
}
