// run.mjs — the shared plan dispatcher used by both the CLI runner (install.mjs) and the sandbox
// lifecycle suite, so they exercise identical code paths. Order = skills → recipes → agents →
// jobs → services → projects; uninstall reverses. Continue-and-report: one failing component is
// recorded but doesn't abort the rest.
import * as skill from './core/skill.mjs';
import * as recipe from './core/recipe.mjs';
import * as agent from './core/agent.mjs';
import * as job from './core/job.mjs';
import * as service from './core/service.mjs';
import { VERDICT } from './log.mjs';
import { makeFilter, hasFilter } from './filter.mjs';
import { COLLECTION_TO_CLI_TYPE } from './component-types.mjs';
import { scriptsEnabled } from './flags.mjs';
import { runComponentScript } from './hooks.mjs';

export const ORDER = ['skills', 'recipes', 'agents', 'jobs', 'services', 'projects'];

// The canonical identifier a --include/--exclude filter is tested against — the same value the run
// summary prints. Every component type carries `name` (for agents it maps to agents.key).
const nameOf = (type, def) => def.name;

// Resolve the effective operation for a component given its `handling` mode, the run mode, and the
// --removed/--optional activation flags. Returns the DISPATCH verb to apply ('upsert' | 'remove' |
// 'status') or null to SKIP the component entirely.
//
//   normal   — install→upsert, uninstall→remove, status→status (the default behavior).
//   removed  — tombstone for a component dropped from the package. Inert unless --removed; with
//              --removed it REMOVES the component on BOTH install and uninstall (and reports its live
//              state under --status). Files may be gone, so it is only ever removed, never upserted.
//   optional — not installed unless --optional. uninstall and status are processed normally, with no
//              flag required — exactly like a normal component.
//   strict   — same lifecycle as normal; per-component file pruning is enabled via isInstallStrict().
export function resolveHandling(handling, mode, { removed = false, optional = false } = {}) {
  const h = handling || 'normal';
  if (h === 'removed') {
    if (!removed) return null;                          // inert tombstone — does nothing by default
    return mode === 'status' ? 'status' : 'remove';     // remove on install AND uninstall
  }
  if (h === 'optional') {
    if (mode === 'install' && !optional) return null;   // opt-in install only
    return mode === 'uninstall' ? 'remove' : mode === 'status' ? 'status' : 'upsert';
  }
  // normal and strict share the same install/uninstall/status verbs
  return mode === 'uninstall' ? 'remove' : mode === 'status' ? 'status' : 'upsert';
}

// Action-bound components for this run (filters + handling). Used for INSTALL_COMPONENTS env and hook planning.
export function planActionBoundComponents(ctx, plan) {
  const handlingFlags = { removed: !!ctx.REMOVED, optional: !!ctx.OPTIONAL };
  const match = makeFilter({ include: ctx.INCLUDE, exclude: ctx.EXCLUDE });
  const only = Array.isArray(ctx.TYPE) ? ctx.TYPE : (ctx.TYPE ? [ctx.TYPE] : []);
  const onlySet = only.length ? new Set(only) : null;
  const types = onlySet ? ORDER.filter((t) => onlySet.has(t)) : ORDER;
  const seq = ctx.mode === 'uninstall' ? [...types].reverse() : types;
  const components = [];
  for (const type of seq) {
    for (const def of (plan[type] || []).filter((d) => match(nameOf(type, d)))) {
      const op = resolveHandling(def.handling, ctx.mode, handlingFlags);
      if (!op) continue;
      components.push({ collection: type, type: COLLECTION_TO_CLI_TYPE[type], name: def.name, op });
    }
  }
  return components;
}

// A visible, exit-code-neutral result line for a component skipped by its handling mode, with a hint
// on how to activate it. Recorded so --status/install summaries (and --json) show the entry rather
// than silently dropping it.
function skipResult(type, def) {
  const h = def.handling || 'normal';
  const action = h === 'removed' ? 'tombstone (pass --removed to remove)'
    : h === 'optional' ? 'optional (pass --optional to install)'
      : 'skipped';
  return { type: type.replace(/s$/, ''), name: def.name, verdict: VERDICT.SKIPPED, action };
}

const DISPATCH = {
  skills: { upsert: skill.upsertSkill, remove: skill.removeSkill, status: skill.statusSkill },
  recipes: { upsert: recipe.upsertRecipe, remove: recipe.removeRecipe, status: recipe.statusRecipe },
  agents: { upsert: agent.upsertAgent, remove: agent.removeAgent, status: agent.statusAgent },
  jobs: { upsert: job.upsertJob, remove: job.removeJob, status: job.statusJob },
  services: { upsert: service.installService, remove: service.removeService, status: service.statusService },
  projects: { upsert: service.installProject, remove: service.removeProject, status: service.statusProject },
};

export async function runPlan(ctx, plan, hookCtx = null) {
  // hookCtx: { meta, packageRoot, rawArgv } — when set, component before/after scripts run.
  const handlingFlags = { removed: !!ctx.REMOVED, optional: !!ctx.OPTIONAL };
  // --type restricts which component TYPES run. The CLI normalizes singular values (`skill`, `job`)
  // into these internal plural collection keys; library callers may pass collection keys directly.
  // Intersect with ORDER so install order is preserved no matter how values were listed.
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
  // The planned sets reflect the POST-filter plan (and the --type type scope), and only count
  // components that will actually be UPSERTED this run, so a skill that is excluded, tombstoned, or
  // an un-activated optional is not treated as a satisfied dependency.
  const willRun = (t) => types.includes(t);
  const plannedUpsert = (type, list) => select(type, list)
    .filter((def) => resolveHandling(def.handling, ctx.mode, handlingFlags) === 'upsert')
    .map((def) => def.name);
  ctx.plannedSkills = new Set(willRun('skills') ? plannedUpsert('skills', plan.skills) : []);
  ctx.plannedRecipes = new Set(willRun('recipes') ? plannedUpsert('recipes', plan.recipes) : []);
  ctx.plannedComponents = planActionBoundComponents(ctx, plan);

  let considered = 0;
  let selected = 0;
  for (const type of seq) {
    const list = plan[type] || [];
    considered += list.length;
    const chosen = select(type, list);
    selected += chosen.length;
    for (const def of chosen) {
      const verb = resolveHandling(def.handling, ctx.mode, handlingFlags);
      if (!verb) { ctx.record(skipResult(type, def)); continue; }
      if (verb === 'upsert' && def.handling === 'strict' && (type === 'recipes' || type === 'jobs')) {
        ctx.log.warn(`${type.replace(/s$/, '')} ${def.name}: handling 'strict' has no effect (no file tree)`);
      }
      const fn = DISPATCH[type]?.[verb];
      if (!fn) continue;

      const component = { type: COLLECTION_TO_CLI_TYPE[type], name: def.name, op: verb };
      const hooks = hookCtx && scriptsEnabled(ctx);
      if (hooks && def.before) {
        const ok = runComponentScript(
          ctx, hookCtx.meta, hookCtx.packageRoot, hookCtx.rawArgv,
          def.before, 'before', component, ctx.plannedComponents,
        );
        if (!ok) continue;
      }

      try {
        const r = await fn(ctx, def);
        if (r) r.op = verb;
        ctx.record(r);
      } catch (e) {
        const name = def.name || '?';
        ctx.log.error(`${type}:${name} failed: ${e.message}`);
        ctx.record({ type: type.replace(/s$/, ''), name, verdict: e.name === 'PrereqError' ? VERDICT.PREREQ : VERDICT.FAIL, action: 'error', detail: e.message });
        continue;
      }

      if (hooks && def.after) {
        runComponentScript(
          ctx, hookCtx.meta, hookCtx.packageRoot, hookCtx.rawArgv,
          def.after, 'after', component, ctx.plannedComponents,
        );
      }
    }
  }

  // Zero-match guard (warn + continue, exit 0): a filter that selects nothing is usually a typo, but
  // "nothing to do" is not a failure. List what was available so the mistake is easy to spot.
  if (hasFilter(filterSpec) && selected === 0 && considered > 0) {
    const avail = seq.flatMap((t) => (plan[t] || []).map((d) => nameOf(t, d)));
    ctx.log.warn(`--include/--exclude matched 0 of ${considered} component(s) — nothing to do. Available: ${avail.join(', ') || '(none)'}`);
  }
  return ctx.results;
}
