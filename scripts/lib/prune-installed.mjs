// prune-installed.mjs — reconcile install.json against the live satellite. Drops log slots whose
// component is no longer present (the same NOT-INSTALLED verdict --status reports). Bookkeeping
// only — nothing is uninstalled from the satellite.
import { readInstallState, pruneInstallLog, sortInstalled, resolvePackagesDir, installLogPath } from './install-log.mjs';
import { VERDICT } from './log.mjs';
import * as skill from './core/skill.mjs';
import * as recipe from './core/recipe.mjs';
import * as agent from './core/agent.mjs';
import * as job from './core/job.mjs';
import * as service from './core/service.mjs';

const STATUS_FN = {
  skill: (ctx, e) => skill.statusSkill(ctx, e.name),
  recipe: (ctx, e) => recipe.statusRecipe(ctx, e.name),
  agent: (ctx, e) => agent.statusAgent(ctx, e.name),
  job: (ctx, e) => job.statusJob(ctx, e.name),
  service: (ctx, e) => service.statusService(ctx, e.name),
  project: (ctx, e) => service.statusProject(ctx, e.name),
};

function entrySummary(e) {
  return {
    type: e.type,
    name: e.name,
    version: e.version ?? null,
    package: e.package ?? null,
    package_version: e.package_version ?? null,
    installed_at: e.installed_at ?? null,
  };
}

// Check every install-log slot against live satellite state; remove stale ones from install.json.
export async function runPruneInstalled(ctx) {
  const packagesDir = ctx.PACKAGES_DIR || resolvePackagesDir();
  const { installed_components: entries } = readInstallState(packagesDir);
  const pruned = [];
  const kept = [];
  const skipped = [];

  for (const entry of entries) {
    const statusFn = STATUS_FN[entry.type];
    if (!statusFn) {
      if (!ctx.JSON) ctx.log.warn(`install log entry ${entry.type}:${entry.name} has unknown type — kept`);
      skipped.push(entrySummary(entry));
      kept.push(entrySummary(entry));
      continue;
    }
    const st = await statusFn(ctx, entry);
    if (st.verdict === VERDICT.ABSENT) pruned.push(entry);
    else kept.push(entrySummary(entry));
  }

  let written = null;
  if (pruned.length) {
    const { path, removed } = pruneInstallLog(packagesDir, pruned, { dryRun: ctx.DRY_RUN });
    written = path;
    if (!ctx.JSON) {
      for (const p of removed) {
        const label = `${p.type}:${p.name}`;
        if (ctx.DRY_RUN) ctx.log.dry(`remove ${label} from install log (not on satellite)`);
        else ctx.log.ok(`${label} → pruned from install log (not on satellite)`);
      }
    }
  }

  return {
    ok: true,
    dryRun: !!ctx.DRY_RUN,
    packagesDir,
    installLog: installLogPath(packagesDir),
    summary: { total: entries.length, pruned: pruned.length, kept: kept.length, skipped: skipped.length },
    pruned: sortInstalled(pruned).map(entrySummary),
    kept: sortInstalled(kept),
    written,
  };
}

export function formatPruneReport(result) {
  const { summary, pruned, dryRun, written } = result;
  if (!summary.pruned) {
    return `Install log is in sync — ${summary.total} entr${summary.total === 1 ? 'y' : 'ies'}, 0 stale.`;
  }
  const head = dryRun
    ? `Prune preview (dry-run): ${summary.pruned} stale entr${summary.pruned === 1 ? 'y' : 'ies'} would be removed, ${summary.kept} kept.`
    : `Pruned install log: ${summary.pruned} stale entr${summary.pruned === 1 ? 'y' : 'ies'} removed, ${summary.kept} kept.`;
  const rows = pruned.map((r) => ({
    type: r.type,
    name: String(r.name),
    from: `${r.package ?? '?'}@${r.package_version ?? '?'}`,
  }));
  const width = (k) => Math.max(...[{ type: 'TYPE', name: 'NAME', from: 'FROM' }, ...rows].map((c) => c[k].length));
  const tw = width('type'); const nw = width('name');
  const line = (c) => `  ${c.type.padEnd(tw)}  ${c.name.padEnd(nw)}  ${c.from}`;
  const tail = dryRun ? '' : (written ? `\n\nUpdated: ${written}` : '');
  return [head, '', line({ type: 'TYPE', name: 'NAME', from: 'FROM' }), ...rows.map(line), tail].join('\n');
}
