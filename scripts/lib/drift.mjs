// drift.mjs — read-only satellite drift report. Compares install-log components against their
// source packages (DB rows, asset trees, joins, deployed web apps) and lists live orphans the
// mirror would auto-add but that are not attributed in install.json.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { discoverPackages } from './list-available.mjs';
import { loadManifest } from './manifest.mjs';
import { readInstallState, sortInstalled } from './install-log.mjs';
import { resolvePackageBase } from './remote.mjs';
import { resolveReposBase } from './polaris.mjs';
import { discoverLiveComponents } from './sync.mjs';
import { makeFilter } from './filter.mjs';
import { VERDICT } from './log.mjs';
import { currentVersion } from './version-history.mjs';
import { resolveServicesBase, resolveUserProjectsBase } from './paths.mjs';
import { planSkill } from './core/skill.mjs';
import { planRecipe } from './core/recipe.mjs';
import { planAgent } from './core/agent.mjs';
import { planJob } from './core/job.mjs';
import { planService, planProject } from './core/service.mjs';

export const DRIFT_STATES = ['in-sync', 'modified', 'absent', 'source-missing', 'orphan'];

const COLLECTION_OF = {
  skill: 'skills', recipe: 'recipes', agent: 'agents', job: 'jobs', service: 'services', project: 'projects',
};

const ROW_NAME = {
  skills: (r) => r.name, recipes: (r) => r.name, agents: (r) => r.key, jobs: (r) => r.name,
};

const PLAN_FN = {
  skill: (ctx, def) => planSkill(ctx, def),
  recipe: (ctx, def) => planRecipe(ctx, def),
  agent: (ctx, def) => planAgent(ctx, def),
  job: (ctx, def) => planJob(ctx, { ...def, requires: def.requires || [] }),
  service: (ctx, def) => planService(ctx, def),
  project: (ctx, def) => planProject(ctx, def),
};

function pkgKey(name, version) {
  return `${name}@${version == null ? '' : version}`;
}

export function indexPackageStores(stores = []) {
  const byKey = new Map();
  const warnings = [];
  const seenBase = new Set();
  for (const { label, base } of stores) {
    if (!base || seenBase.has(base)) continue;
    seenBase.add(base);
    if (!existsSync(base)) continue;
    for (const dir of discoverPackages(base)) {
      try {
        const { meta } = loadManifest(dir);
        byKey.set(pkgKey(meta.name, String(meta.version)), { dir, meta, store: label });
      } catch (e) {
        warnings.push({ dir, message: e.message });
      }
    }
  }
  return { byKey, warnings };
}

function findComponentDef(packageDir, entry) {
  const collection = COLLECTION_OF[entry.type];
  if (!collection) return null;
  const { plan } = loadManifest(packageDir);
  return (plan[collection] || []).find((d) => d.name === entry.name) || null;
}

async function liveVersion(ctx, type, def) {
  const db = ctx.db;
  if (type === 'skill') return currentVersion(db, 'skill', def.name);
  if (type === 'recipe') {
    const row = await db('recipes').where({ name: def.name }).first();
    return row ? currentVersion(db, 'recipe', row.id) : null;
  }
  if (type === 'agent') return currentVersion(db, 'agent', def.name);
  return def.version ?? null;
}

function planToDrift(plan, { liveVer, versionNote } = {}) {
  if (plan.verdict === VERDICT.ABSENT) return { state: 'absent' };
  if (plan.verdict === VERDICT.LOCKED) return { state: 'modified', detail: 'locked', live_version: liveVer };
  if (plan.verdict === VERDICT.ALREADY) {
    if (versionNote) return { state: 'modified', detail: versionNote, live_version: liveVer };
    return { state: 'in-sync', live_version: liveVer };
  }
  const detail = [plan.detail, versionNote].filter(Boolean).join('; ') || plan.action || 'would change';
  return { state: 'modified', detail, live_version: liveVer };
}

async function diffComponent(ctx, entry, def) {
  const type = entry.type;
  const planCtx = {
    ...ctx,
    plannedSkills: new Set(def.requires || []),
    plannedRecipes: new Set(),
  };
  const plan = await PLAN_FN[type](planCtx, def);
  const liveVer = await liveVersion(ctx, type, def);
  const versionNote = (entry.version != null && liveVer != null && liveVer !== entry.version)
    ? `live v${liveVer} vs log v${entry.version}`
    : null;
  return planToDrift(plan, { liveVer, versionNote });
}

async function diffManagedEntry(ctx, entry, packageIndex) {
  const base = {
    type: entry.type,
    name: entry.name,
    version: entry.version ?? null,
    package: entry.package ?? null,
    package_version: entry.package_version ?? null,
    source_path: entry.source ?? null,
  };
  const loc = packageIndex.byKey.get(pkgKey(entry.package, entry.package_version));
  if (!loc) return { ...base, state: 'source-missing', detail: 'package not in local stores' };

  let def;
  try {
    def = findComponentDef(loc.dir, entry);
  } catch (e) {
    return { ...base, state: 'source-missing', package_location: loc.dir, detail: e.message };
  }
  if (!def) {
    return {
      ...base,
      state: 'source-missing',
      package_location: loc.dir,
      detail: 'component not in package manifest',
    };
  }
  if (def.handling === 'removed') return { ...base, state: 'in-sync', package_location: loc.dir, detail: 'tombstone' };

  const diff = await diffComponent(ctx, entry, def);
  return { ...base, ...diff, package_location: loc.dir };
}

function listFilesystemOrphans(baseDir, type, logged) {
  const orphans = [];
  if (!baseDir || !existsSync(baseDir)) return orphans;
  for (const ent of readdirSync(baseDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const key = `${type}:${ent.name}`;
    if (!logged.has(key)) orphans.push({ type, name: ent.name, state: 'orphan' });
  }
  return orphans;
}

export async function runDrift(ctx, {
  packageFilter = null,
  typeScope = null,
  filterSpec = {},
  stores = null,
} = {}) {
  const packagesDir = ctx.PACKAGES_DIR;
  const { installed_components: logEntries } = readInstallState(packagesDir);
  const packageIndex = indexPackageStores(stores || [
    { label: 'packages', base: resolvePackageBase() },
    { label: 'repos', base: resolveReposBase() },
  ]);

  const match = makeFilter(filterSpec);
  const typeSet = typeScope?.length ? new Set(typeScope) : null;
  const inScope = (type, name) => {
    if (typeSet && !typeSet.has(COLLECTION_OF[type])) return false;
    return match(name);
  };

  const managed = [];
  for (const entry of logEntries) {
    if (!entry?.type || entry.name == null) continue;
    if (packageFilter && entry.package !== packageFilter) continue;
    if (!inScope(entry.type, String(entry.name))) continue;
    managed.push(await diffManagedEntry(ctx, entry, packageIndex));
  }

  const logged = new Set(logEntries.map((e) => `${e.type}:${e.name}`));
  const orphans = [];

  const live = await discoverLiveComponents(ctx.db);
  for (const [collection, rows] of Object.entries(live)) {
    const type = collection.replace(/s$/, '');
    for (const row of rows) {
      const name = ROW_NAME[collection](row);
      if (!inScope(type, name)) continue;
      if (!logged.has(`${type}:${name}`)) orphans.push({ type, name, state: 'orphan' });
    }
  }

  if (!typeSet || typeSet.has('services')) {
    for (const o of listFilesystemOrphans(ctx.SERVICES_BASE, 'service', logged)) {
      if (inScope('service', o.name)) orphans.push(o);
    }
  }
  if (!typeSet || typeSet.has('projects')) {
    for (const o of listFilesystemOrphans(ctx.USER_PROJECTS_BASE, 'project', logged)) {
      if (inScope('project', o.name)) orphans.push(o);
    }
  }

  const summary = {
    managed: managed.length,
    orphans: orphans.length,
    in_sync: managed.filter((r) => r.state === 'in-sync').length,
    modified: managed.filter((r) => r.state === 'modified').length,
    absent: managed.filter((r) => r.state === 'absent').length,
    source_missing: managed.filter((r) => r.state === 'source-missing').length,
  };
  summary.drift = summary.modified + summary.absent + summary.source_missing + summary.orphans;

  const outOfSync = sortInstalled([
    ...managed.filter((r) => r.state !== 'in-sync'),
    ...orphans,
  ]);

  return {
    ok: true,
    packagesDir,
    packageFilter,
    summary,
    managed: sortInstalled(managed),
    orphans: sortInstalled(orphans),
    outOfSync,
    warnings: packageIndex.warnings,
  };
}

function abbrevPath(p) {
  if (!p) return '—';
  const home = homedir();
  if (home && (p === home || p.startsWith(`${home}/`))) return `~${p.slice(home.length)}`;
  return p;
}

function driftRowCells(r) {
  const pkg = r.package ? `${r.package}@${r.package_version ?? '?'}` : '—';
  const version = r.version != null ? String(r.version) : '—';
  const source = r.source_path || '—';
  const location = abbrevPath(r.package_location);
  let detail = r.detail || '';
  if (!detail && r.live_version != null) detail = `live v${r.live_version}`;
  if (r.state === 'orphan') detail = detail || 'not in install log';
  return {
    state: r.state,
    type: r.type,
    name: String(r.name),
    version,
    package: pkg,
    source,
    location,
    detail,
  };
}

export function formatDriftReport(result) {
  const { summary, outOfSync, warnings, packageFilter } = result;
  const rows = outOfSync ?? [
    ...(result.managed || []).filter((r) => r.state !== 'in-sync'),
    ...(result.orphans || []),
  ];
  const head = packageFilter
    ? `Drift report (package ${packageFilter}): ${summary.drift} issue(s) — `
    : `Drift report: ${summary.drift} issue(s) — `;
  const stats = [
    `in-sync ${summary.in_sync}`,
    `modified ${summary.modified}`,
    `absent ${summary.absent}`,
    `source-missing ${summary.source_missing}`,
    `orphans ${summary.orphans}`,
  ].join(', ');

  const lines = [head + stats];

  if (!rows.length) {
    lines.push('', `All ${summary.managed} managed component(s) are in sync; no orphans.`);
  } else {
    lines.push('', 'Out of sync');
    const cells = rows.map(driftRowCells);
    const headRow = {
      state: 'STATE', type: 'TYPE', name: 'NAME', version: 'VERSION',
      package: 'PACKAGE', source: 'SOURCE', location: 'LOCATION', detail: 'DETAIL',
    };
    const width = (k) => Math.max(...[headRow, ...cells].map((c) => String(c[k]).length));
    const w = {
      state: width('state'), type: width('type'), name: width('name'), version: width('version'),
      package: width('package'), source: width('source'), location: width('location'),
    };
    const line = (c) => `  ${c.state.padEnd(w.state)}  ${c.type.padEnd(w.type)}  ${c.name.padEnd(w.name)}  ${c.version.padEnd(w.version)}  ${c.package.padEnd(w.package)}  ${c.source.padEnd(w.source)}  ${c.location.padEnd(w.location)}  ${c.detail}`;
    lines.push(line(headRow), ...cells.map(line));
  }

  if (warnings?.length) {
    lines.push('', ...warnings.map((w) => `  ⚠ ${w.dir}: ${w.message}`));
  }
  return lines.join('\n');
}
