// diff.mjs — read-only package → live component diff. Loads a package manifest and compares every
// in-scope component def against its live equivalent (DB fields, links, asset trees), regardless of
// how the live component was installed — no install-log involvement. File detail is status-only
// (no content diffs): modified / package-only / live-only, with protected names set aside.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest, readWebAppConfig } from './manifest.mjs';
import { makeFilter } from './filter.mjs';
import { protectMatcher } from './protect.mjs';
import { diffTree } from './fs.mjs';
import { VERDICT } from './log.mjs';
import { currentVersion } from './version-history.mjs';
import { resolveServicesBase, resolveUserProjectsBase } from './paths.mjs';
import { planSkill } from './core/skill.mjs';
import { planRecipe } from './core/recipe.mjs';
import { planAgent } from './core/agent.mjs';
import { planJob } from './core/job.mjs';
import { planService, planProject } from './core/service.mjs';

export const DIFF_STATES = ['in-sync', 'differs', 'absent', 'tombstone'];

const ORDER = [
  ['skills', 'skill'], ['recipes', 'recipe'], ['agents', 'agent'],
  ['jobs', 'job'], ['services', 'service'], ['projects', 'project'],
];

const PLAN_FN = {
  skill: planSkill,
  recipe: planRecipe,
  agent: planAgent,
  job: (ctx, def) => planJob(ctx, { ...def, requires: def.requires || [] }),
  service: planService,
  project: planProject,
};

function liveDirOf(ctx, type, def) {
  if (type === 'skill') return join(ctx.SKILLS_BASE, def.key);
  if (type === 'agent') return ctx.BRAINS ? join(ctx.BRAINS, def.name) : null;
  if (type === 'service') return join(ctx.SERVICES_BASE || resolveServicesBase(), def.name);
  if (type === 'project') return join(ctx.USER_PROJECTS_BASE || resolveUserProjectsBase(), def.name);
  return null;
}

async function liveVersion(ctx, type, def, liveDir) {
  const { db } = ctx;
  if (type === 'skill') return currentVersion(db, 'skill', def.name);
  if (type === 'agent') return currentVersion(db, 'agent', def.name);
  if (type === 'recipe') {
    const row = await db('recipes').where({ name: def.name }).first();
    return row ? currentVersion(db, 'recipe', row.id) : null;
  }
  if ((type === 'service' || type === 'project') && liveDir && existsSync(liveDir)) {
    try { return readWebAppConfig(liveDir, { kind: type }).version; } catch { return null; }
  }
  return null;
}

// File status vs the live tree, mirroring install/sync skips: skills skip SKILL.md (DB content is
// authoritative), the prune side honors protect. Symlink-mode projects have no copy to compare.
function fileDetail(ctx, type, def, liveDir) {
  if (!def.srcDir || !existsSync(def.srcDir) || !liveDir) return null;
  if (type === 'project' && !ctx.COPY_PROJECTS) return null;
  const protect = protectMatcher(def.protect);
  const copySkip = type === 'skill' ? (rel) => rel === 'SKILL.md' : null;
  const d = diffTree(def.srcDir, liveDir, { copySkip, pruneSkip: protect.skip });
  return { ...d, protected: [...protect.matched].sort() };
}

async function diffComponent(ctx, type, def) {
  const base = { type, name: def.name, package_version: def.version ?? null };
  if (def.handling === 'removed') return { ...base, state: 'tombstone' };

  const plan = await PLAN_FN[type](ctx, def);
  if (plan.verdict === VERDICT.ABSENT) return { ...base, state: 'absent', detail: 'not installed' };

  const liveDir = liveDirOf(ctx, type, def);
  const live_version = await liveVersion(ctx, type, def, liveDir);
  const versionNote = (def.version != null && live_version != null && live_version !== def.version)
    ? `live v${live_version} vs package v${def.version}` : null;
  if (plan.verdict === VERDICT.ALREADY && !versionNote) return { ...base, state: 'in-sync', live_version };

  const dims = plan.dimensions || {};
  const row = { ...base, state: 'differs', live_version };
  if (dims.dbFields?.length) row.db = dims.dbFields;
  else if (dims.db) row.db = ['(changed)'];
  if (dims.linkChanges) row.links = dims.linkChanges;
  if (dims.files || dims.brain || dims.pruned) {
    const files = fileDetail(ctx, type, def, liveDir);
    if (files) row.files = files;
  }
  const notes = [
    versionNote,
    dims.prereq ? plan.detail : null,
    dims.nginx ? 'nginx vhost missing' : null,
    dims.pm2 ? 'pm2 process missing' : null,
    (type === 'project' && !ctx.COPY_PROJECTS && dims.files) ? 'symlink target differs' : null,
  ].filter(Boolean);
  if (notes.length) row.detail = notes.join('; ');
  return row;
}

// ctx must have: db, log, SKILLS_BASE, BRAINS (COPY_PROJECTS optional). Read-only.
export async function runDiff(ctx, { packageDir = '.', typeScope = null, filterSpec = {} } = {}) {
  const { meta, plan, packageRoot } = loadManifest(packageDir);
  const match = makeFilter(filterSpec);
  const typeSet = typeScope?.length ? new Set(typeScope) : null;

  // STRICT so plans count live-only files; planned sets mirror install-time link/prereq resolution.
  const planCtx = {
    ...ctx,
    DRY_RUN: true,
    STRICT: true,
    plannedSkills: new Set((plan.skills || []).map((d) => d.name)),
    plannedRecipes: new Set((plan.recipes || []).map((d) => d.name)),
  };

  const results = [];
  for (const [collection, type] of ORDER) {
    if (typeSet && !typeSet.has(collection)) continue;
    for (const def of plan[collection] || []) {
      if (!match(def.name)) continue;
      results.push(await diffComponent(planCtx, type, def));
    }
  }

  const count = (s) => results.filter((r) => r.state === s).length;
  const summary = {
    components: results.length,
    in_sync: count('in-sync'),
    differs: count('differs'),
    absent: count('absent'),
    tombstones: count('tombstone'),
  };
  summary.diffs = summary.differs + summary.absent;

  return {
    ok: true,
    package: { name: meta.name, version: meta.version ?? null, dir: packageRoot },
    summary,
    results,
  };
}

function detailCell(r) {
  const parts = [];
  if (r.db) parts.push(`db: ${r.db.join(', ')}`);
  if (r.links) {
    const l = [
      ...r.links.skills.add.map((s) => `+skill ${s}`),
      ...r.links.skills.del.map((s) => `-skill ${s}`),
      ...(r.links.recipes.add.length ? [`+${r.links.recipes.add.length} recipe(s)`] : []),
      ...(r.links.recipes.del.length ? [`-${r.links.recipes.del.length} recipe(s)`] : []),
    ];
    parts.push(`links: ${l.join(', ')}`);
  }
  if (r.files) {
    const bits = [];
    if (r.files.modified.length) bits.push(`~${r.files.modified.length}`);
    if (r.files.missing.length) bits.push(`+${r.files.missing.length}`);
    if (r.files.extra.length) bits.push(`-${r.files.extra.length}`);
    if (bits.length) parts.push(`files: ${bits.join(' ')}`);
    if (r.files.protected.length) parts.push(`protected: ${r.files.protected.join(', ')}`);
  }
  if (r.detail) parts.push(r.detail);
  return parts.join('; ') || 'file metadata only';
}

export function formatDiffReport(result) {
  const { package: pkg, summary, results } = result;
  const stats = [
    `in-sync ${summary.in_sync}`, `differs ${summary.differs}`, `absent ${summary.absent}`,
    ...(summary.tombstones ? [`tombstones ${summary.tombstones}`] : []),
  ].join(', ');
  const lines = [`Diff ${pkg.name}@${pkg.version ?? '?'} → live: ${stats}`];

  const rows = results.filter((r) => r.state === 'differs' || r.state === 'absent');
  if (!rows.length) {
    lines.push('', `All ${summary.components} component(s) match the live satellite.`);
    return lines.join('\n');
  }

  lines.push('', 'Differences (~ modified, + package-only, - live-only)');
  const cells = rows.map((r) => ({
    state: r.state,
    type: r.type,
    name: String(r.name),
    version: (r.package_version != null || r.live_version != null)
      ? `${r.package_version ?? '—'}→${r.live_version ?? '—'}` : '—',
    detail: r.state === 'absent' ? (r.detail || 'not installed') : detailCell(r),
  }));
  const headRow = { state: 'STATE', type: 'TYPE', name: 'NAME', version: 'VERSION', detail: 'DETAIL' };
  const width = (k) => Math.max(...[headRow, ...cells].map((c) => String(c[k]).length));
  const w = { state: width('state'), type: width('type'), name: width('name'), version: width('version') };
  const line = (c) => `  ${c.state.padEnd(w.state)}  ${c.type.padEnd(w.type)}  ${c.name.padEnd(w.name)}  ${c.version.padEnd(w.version)}  ${c.detail}`;
  lines.push(line(headRow));
  rows.forEach((r, i) => {
    lines.push(line(cells[i]));
    if (r.files) {
      for (const f of r.files.modified) lines.push(`      ~ ${f}`);
      for (const f of r.files.missing) lines.push(`      + ${f}`);
      for (const f of r.files.extra) lines.push(`      - ${f}`);
    }
  });
  return lines.join('\n');
}
