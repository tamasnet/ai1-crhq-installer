// sync.mjs — core sync logic: reconcile a package repo's ai1-package.yaml against the live
// satellite (DB + SKILLS_BASE_DIR) by exporting components back into the package directory.
//
// Direction: satellite (DB + filesystem) → package repo (Git working copy)
// Git-safe: writeIfChanged is used throughout — byte-identical files are never touched.
// Services are out of scope (not DB-resident; their source of truth is the original package).
// Projects are added only with --add-project, then left to git; mirror never auto-adds them.
//
// Two modes (both share every primitive — export*, manifest read/write, version logic):
//
//   mode 'sync' (default): the MANIFEST is the authority. With no --add-* / --remove-* flags, export
//     each component the manifest lists. When any --add-* or --remove-* is present, only those
//     mutations run (Step 2 is skipped — run plain sync afterward to export the rest). --add-project
//     moves the live project into the package and leaves a symlink. Nothing is removed unless
//     --remove-*; package-level version is left untouched; DB additions are normalized to the
//     distributable default (org/locked skills).
//
//   mode 'mirror' (`--mirror`): the LIVE SATELLITE is the authority. Make the
//     package mirror it — within the --type/--include/--exclude scope:
//       • new live components (curated: org/user skills, active recipes, non-system active
//         agents/jobs) not yet in the manifest are added, preserving fidelity (a user skill keeps
//         install_type:user) unless `normalize` is set;
//       • components still present are synced (versions bumped when live > pinned), and skill
//         install_type is reconciled to live;
//       • manifest entries whose component is gone from the satellite are removed — the entry AND
//         its file/dir in the package;
//       • the package-level integer `version` is incremented by 1, but only when the run actually
//         changed package content (a no-op run leaves it alone). A freshly bootstrapped package
//         starts at version 1 and is not bumped on first create;
//       • the run returns an `installLog` delta (components it included vs. removed) so the CLI can
//         reconcile the global install log (${PACKAGES_DIR}/install.json) to the live satellite for
//         exactly the components this mirror carries — installed slots upserted (attributed to this
//         package), removed ones dropped. Plain sync returns an empty delta.
//
// Manifest is updated in place when needed (versions, new/removed entries, package version). The
// package-level `version` is auto-incremented ONLY in mirror mode; plain sync never touches it.

import { existsSync, readFileSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { join, basename, extname, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Import siblings directly (not the index barrel) so sync.mjs can itself be re-exported from index
// without an import cycle.
import { parseFrontmatter, loadYaml, dumpYaml } from './parse.mjs';
import { safeName, writeIfChanged, removeTree, moveTree, ensureSymlink, pathExistsOrLink } from './fs.mjs';
import { validateManifest, readWebAppConfig } from './manifest.mjs';
import { assertSafeSegment } from './validate.mjs';
import { makeFilter, hasFilter } from './filter.mjs';
import { VERDICT } from './log.mjs';
import { exportSkill } from './core/skill.mjs';
import { exportRecipe } from './core/recipe.mjs';
import { exportAgent } from './core/agent.mjs';
import { exportJob } from './core/job.mjs';
import { satellitePackageName } from './identity.mjs';
import { resolveUserProjectsBase } from './paths.mjs';

export class SyncError extends Error {
  constructor(msg) { super(msg); this.name = 'SyncError'; }
}

function validateProjectSegment(name) {
  try {
    assertSafeSegment('project name', name);
  } catch (e) {
    throw new SyncError(e.message);
  }
}

// True iff `dir` is inside a git working tree. sync edits the package IN PLACE — git is the
// recovery net for a bad run — so the CLI refuses a non-git destination unless --force. For a
// not-yet-created bootstrap dir (`<repo>/user` that mirror will create) the check walks up to the
// nearest existing ancestor, so a new subdir inside a repo still counts as git-safe. Shells out to
// `git rev-parse --is-inside-work-tree` (the same git dependency polaris already relies on); a git
// error, missing git, or a "false" result → not a repo.
export function isInsideGitRepo(dir) {
  let probe = dir;
  while (probe && !existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;                 // reached the filesystem root
    probe = parent;
  }
  if (!probe || !existsSync(probe)) return false;
  const r = spawnSync('git', ['-C', probe, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'true';
}

// Component types covered by sync/mirror DB export (services/projects are not DB-resident).
export const SYNC_TYPES = ['skills', 'recipes', 'agents', 'jobs'];

// Default relative path within the package for a newly added component. Skills, agents, and projects
// are directories (SKILL.md / AGENTS.md / project.yaml inside); recipes and jobs are single files.
const DEFAULT_PATH = {
  skills:  (name) => `skills/${safeName(name)}`,
  recipes: (name) => `recipes/${safeName(name)}.md`,
  agents:  (name) => `agents/${safeName(name)}`,
  jobs:    (name) => `jobs/${safeName(name)}.yaml`,
  projects:(name) => `projects/${safeName(name)}`,
};

// Canonical DB identifier for a discovered row, per type.
const ROW_NAME = { skills: (r) => r.name, recipes: (r) => r.name, agents: (r) => r.key, jobs: (r) => r.name };

// Derive the component's canonical DB name from a manifest entry path.
// For directory components: try their metadata file's canonical name; fall back to the directory
// basename. For recipes/jobs: basename of path minus the extension.
// If the component file already exists in the package dir, the frontmatter is authoritative.
function deriveName(packageDir, type, entryPath) {
  if (type === 'skills' || type === 'agents') {
    const mdName = type === 'skills' ? 'SKILL.md' : 'AGENTS.md';
    const mdPath = join(packageDir, entryPath, mdName);
    if (existsSync(mdPath)) {
      try {
        const { meta } = parseFrontmatter(readFileSync(mdPath, 'utf8'));
        if (meta.name) return meta.name;
      } catch { /* fall through to basename */ }
    }
    return basename(entryPath);
  }
  if (type === 'projects') {
    const srcDir = join(packageDir, entryPath);
    try {
      if (existsSync(srcDir)) return readWebAppConfig(srcDir, { kind: 'project', pathLabel: entryPath }).config.name;
    } catch { /* fall through to basename */ }
    return basename(entryPath);
  }
  return basename(entryPath, extname(entryPath));
}

// DB row lookup per component type — the satellite's notion of "this component is live". Skills,
// recipes and agents must be active; jobs have no is_active column. This is the liveness test that
// mirror uses for REMOVAL (an entry with no matching row is gone → removed).
async function findRow(db, type, name) {
  switch (type) {
    case 'skills':  return db('skills').where({ name, is_active: true }).first();
    case 'recipes': return db('recipes').where({ name, is_active: true }).first();
    case 'agents':  return db('agents').where({ key: name, is_active: true }).first();
    case 'jobs':    return db('background_jobs').where({ name }).first();
    default:        return null;
  }
}

// The curated live inventory mirror auto-adds FROM: active `user` skills only (NOT `org`/`store`/
// `system` — those come from their own source packages, not a satellite backup), active recipes,
// non-system active agents, non-system jobs. Inactive/system rows are intentionally excluded — the
// manifest can't express them and restoring one would misrepresent the satellite. (Removal is
// deliberately more conservative — see findRow — so an org/store/system or already-listed component
// in the manifest is synced or skipped, never silently purged just because it isn't auto-added.)
// Curated live inventory (same set mirror auto-adds). Exported for drift/orphan reporting.
export async function discoverLiveComponents(db) {
  return {
    skills: await db('skills').where({ skill_type: 'user', is_active: true }).orderBy('name'),
    recipes: await db('recipes').where({ is_active: true }).orderBy('name'),
    agents: await db('agents').where({ is_active: true })
      .where((q) => q.where({ is_system: false }).orWhereNull('is_system')).orderBy('key'),
    jobs: await db('background_jobs')
      .where((q) => q.where({ is_system: false }).orWhereNull('is_system')).orderBy('name'),
  };
}

// Dispatch to the appropriate export function.
async function exportComponent(ctx, type, row, { packageDir, relPath, skillNames }) {
  switch (type) {
    case 'skills':  return exportSkill(ctx, row, { outRoot: packageDir, relPath });
    case 'recipes': return exportRecipe(ctx, row, { outRoot: packageDir, relPath });
    case 'agents':  return exportAgent(ctx, row, { outRoot: packageDir, relPath });
    case 'jobs':    return exportJob(ctx, row, { outRoot: packageDir, relPath, skillNames });
    default:        throw new SyncError(`Unknown component type: ${type}`);
  }
}

// A minimal but valid project.yaml for a live project that doesn't ship one. Required fields only
// (name/version/start); port and nginx fall back to runtime defaults (auto-allocated port,
// app_name = name, ssl on). The author edits it afterward — git owns the project once it's added.
function defaultProjectConfig(name) {
  return dumpYaml({ name, version: 1, start: 'node server.js' });
}

function addProjectToPackage(ctx, name, { packageDir, relPath }) {
  const dry = !!ctx.DRY_RUN;
  const liveBase = ctx.USER_PROJECTS_BASE || resolveUserProjectsBase();
  const liveDir = join(liveBase, name);
  const destDir = join(packageDir, relPath);

  if (!pathExistsOrLink(liveDir)) throw new SyncError(`cannot add project '${name}': ${liveDir} does not exist`);
  if (pathExistsOrLink(destDir)) throw new SyncError(`cannot add project '${name}': package path already exists: ${relPath}`);
  if (existsSync(join(liveDir, '.git'))) {
    throw new SyncError(
      `cannot add project '${name}': ${liveDir} is a git repository\n` +
      `  Remove .git to convert it to a plain directory first; the package repo owns version control after --add-project.`,
    );
  }

  // project.yaml is optional. When present it's the source of truth for the name + version pin;
  // when absent a valid default is generated in the package after the move (version 1).
  const hasConfig = existsSync(join(liveDir, 'project.yaml'));
  let version = 1;
  if (hasConfig) {
    const { config, version: pinned } = readWebAppConfig(liveDir, { kind: 'project', pathLabel: liveDir });
    if (config.name !== name) throw new SyncError(`cannot add project '${name}': project config name is '${config.name}'`);
    version = pinned;
  }

  if (!dry) {
    moveTree(liveDir, destDir, { dryRun: false });
    try {
      if (!hasConfig) writeIfChanged(join(destDir, 'project.yaml'), defaultProjectConfig(name), { dryRun: false });
      ensureSymlink(liveDir, destDir, { dryRun: false });
    } catch (e) {
      // Best-effort rollback: keep the live project usable if replacing it with a symlink failed.
      try { moveTree(destDir, liveDir, { dryRun: false }); } catch { /* ignore rollback failure */ }
      throw e;
    }
  }

  return { entry: { path: relPath, version }, changed: true, generatedConfig: !hasConfig };
}

// Reverse --add-project: drop the manifest entry and its package files. When the live project path
// is still a symlink into the package, restore it as a real directory under USER_PROJECTS_BASE.
function removeProjectFromPackage(ctx, name, { packageDir, entryPath }) {
  const dry = !!ctx.DRY_RUN;
  const liveBase = ctx.USER_PROJECTS_BASE || resolveUserProjectsBase();
  const liveDir = join(liveBase, name);
  const destDir = join(packageDir, entryPath);
  let changed = false;

  try {
    const st = lstatSync(liveDir);
    if (st.isSymbolicLink()) {
      const target = resolve(dirname(liveDir), readlinkSync(liveDir));
      if (target === resolve(destDir)) {
        if (!dry) {
          unlinkSync(liveDir);
          if (pathExistsOrLink(destDir)) moveTree(destDir, liveDir, { dryRun: false });
        }
        return true;
      }
      ctx.log.warn(`project '${name}': live path is a symlink but not to this package — removing package files only`);
    } else {
      ctx.log.warn(`project '${name}': live path exists and is not a symlink — removing package files only`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (removeTree(destDir, { dryRun: dry })) changed = true;
  return changed;
}

// Short label for log output.
const label = (type, name) => `${type.replace(/s$/, '')}:${name}`;
const singular = (type) => type.replace(/s$/, '');

// The component's manifest file relative to the package root — the install log's `source` field
// (mirrors install-log.mjs's sourceOf). Skills/agents carry a SKILL.md/AGENTS.md under their dir;
// the rest are a single file.
const sourceOf = (type, path) => (
  type === 'skills' ? `${path}/SKILL.md`
    : type === 'agents' ? `${path}/AGENTS.md`
      : type === 'projects' ? `${path}/project.yaml`
        : path
);

// ──────────────────────────────────────────────────────────────────────────────────────────────────

// ctx must have: db, log, DRY_RUN, SKILLS_BASE (needed by exportJob for script-path resolution).
// opts:
//   packageDir  — the package repo dir holding ai1-package.yaml
//   additions   — { skills, recipes, agents, jobs: string[] } explicit --add-* names (sync mode)
//   removals    — { skills, recipes, agents, jobs, projects: string[] } explicit --remove-* names
//   mode        — 'sync' (default) | 'mirror'
//   typeScope   — array of DB component types to restrict to; null = all types, [] = none
//   filterSpec  — { include, exclude } name filters (combined with --type when both are set)
//   normalize   — (mirror) strip live fidelity (skills → org/locked) like a sync addition
export async function runSync(ctx, { packageDir, additions = {}, removals = {}, mode = 'sync', typeScope = null, filterSpec = {}, normalize = false } = {}) {
  const { db, log } = ctx;
  const dry = !!ctx.DRY_RUN;
  const isMirror = mode === 'mirror';
  const preserveFidelity = isMirror && !normalize;

  // Scope: --type / --include / --exclude apply in both plain sync (Step 2) and mirror (all steps).
  const scoped = Array.isArray(typeScope) || hasFilter(filterSpec);
  const typeSet = Array.isArray(typeScope) ? new Set(typeScope) : null;
  const nameMatch = makeFilter(filterSpec);
  const typeInScope = (t) => !typeSet || typeSet.has(t);
  const inScope = (t, name) => typeInScope(t) && nameMatch(name);

  const manifestPath = join(packageDir, 'ai1-package.yaml');
  const manifestExists = existsSync(manifestPath);

  const explicitAdds = [...SYNC_TYPES, 'projects'].some((t) => (additions[t]?.length ?? 0) > 0);
  const explicitRemoves = [...SYNC_TYPES, 'projects'].some((t) => (removals[t]?.length ?? 0) > 0);
  for (const name of [...(additions.projects ?? []), ...(removals.projects ?? [])]) {
    validateProjectSegment(name);
  }
  // Plain sync with --add-* / --remove-* performs only those mutations; skip Step 2.
  const mutationOnly = !isMirror && (explicitAdds || explicitRemoves);

  if (!manifestExists && !isMirror && !explicitAdds) {
    throw new SyncError(
      `No ai1-package.yaml found in ${packageDir}.\n` +
      `  Use --add-skill=<name> (or --add-recipe, --add-agent, --add-job, --add-project) to create one,\n` +
      `  or --mirror to snapshot the whole satellite into this directory.`,
    );
  }

  // Load or bootstrap the manifest as a plain YAML object.
  let manifest;
  if (manifestExists) {
    const raw = readFileSync(manifestPath, 'utf8');
    manifest = loadYaml(raw);
    try {
      validateManifest(manifest);
    } catch (e) {
      throw new SyncError(`ai1-package.yaml is invalid: ${e.message}`);
    }
  } else {
    // Bootstrap. A --mirror snapshot is the satellite's OWN package, so it is named by the shared
    // satellitePackageName() heuristic (satellite id → drop `myzone-` → ensure `ai1-`). A plain-sync
    // --add bootstrap uses the directory name — the author is creating a specific named package repo.
    const pkgName = isMirror ? satellitePackageName() : basename(packageDir);
    manifest = { name: pkgName, version: 1, description: '', components: {} };
    log.warn(`no ai1-package.yaml found — bootstrapping with name '${pkgName}'`);
  }

  manifest.components ??= {};
  let manifestDirty = !manifestExists;   // bootstrapped manifests must always be written
  let contentChanged = false;            // any byte actually written/removed → drives the mirror version bump
  const results = [];
  // Mirror-only: the delta the CLI applies to the global install log. `logInstalled` = the
  // components this run faithfully exported into the package (so install.json marks them installed,
  // attributed to this mirror package); `logRemoved` = ones gone from the satellite (slot dropped).
  // Populated only in mirror mode; skips/failures (not faithfully captured) are excluded.
  const logInstalled = [];
  const logRemoved = [];

  // Skill names known to the package — used by exportJob to populate 'requires:'.
  const skillNamesInManifest = new Set(
    (manifest.components.skills ?? []).map((e) => basename(e.path)),
  );

  // Build the addition queue: explicit --add-* plus, in mirror mode, every curated live component in
  // scope that the manifest doesn't already list.
  const addQueue = {};
  for (const t of SYNC_TYPES) addQueue[t] = [...(additions[t] ?? [])];
  addQueue.projects = [...(additions.projects ?? [])];

  if (isMirror) {
    const live = await discoverLiveComponents(db);
    for (const t of SYNC_TYPES) {
      if (!typeInScope(t)) continue;
      const present = new Set((manifest.components[t] ?? []).map((e) => deriveName(packageDir, t, e.path)));
      for (const row of (live[t] ?? [])) {
        const nm = ROW_NAME[t](row);
        if (!nameMatch(nm) || present.has(nm)) continue;
        addQueue[t].push(nm);
      }
    }
  }

  // (type:name) handled as an addition — Step 2 must not re-export/re-count them.
  const handled = new Set();

  // ── Step 0: explicit removals (--remove-* in plain sync) ─────────────────────────────────────
  if (!isMirror) {
    for (const type of [...SYNC_TYPES, 'projects']) {
      for (const name of (removals[type] ?? [])) {
        const list = manifest.components[type] ?? [];
        const idx = list.findIndex((e) => deriveName(packageDir, type, e.path) === name);
        if (idx < 0) {
          log.warn(`${label(type, name)} not in manifest — skipping removal`);
          results.push({ type: singular(type), name, verdict: 'SYNC-SKIP', action: 'not in manifest' });
          continue;
        }
        const entry = list[idx];
        let changed = false;
        if (type === 'projects') {
          changed = removeProjectFromPackage(ctx, name, { packageDir, entryPath: entry.path });
        } else if (removeTree(join(packageDir, entry.path), { dryRun: dry })) {
          changed = true;
        }
        list.splice(idx, 1);
        if (list.length) manifest.components[type] = list;
        else { delete manifest.components[type]; }
        manifestDirty = true;
        if (changed) contentChanged = true;
        results.push({ type: singular(type), name, verdict: 'SYNC-REMOVED', action: dry ? 'removed (dry-run)' : 'removed' });
        if (dry) log.dry(`remove ${label(type, name)} from manifest (${entry.path})`);
        else      log.ok(`${label(type, name)} → removed from package`);
      }
    }
    // Rebuild skill names after removals (jobs' requires: field depends on this).
    skillNamesInManifest.clear();
    for (const e of (manifest.components.skills ?? [])) skillNamesInManifest.add(basename(e.path));
  }

  // ── Step 1: additions ────────────────────────────────────────────────────────────────────────
  for (const name of addQueue.projects) {
    const type = 'projects';
    const existing = manifest.components.projects ?? [];
    if (existing.some((e) => deriveName(packageDir, type, e.path) === name)) {
      log.warn(`${label(type, name)} already in manifest — skipping addition`);
      continue;
    }

    const relPath = DEFAULT_PATH.projects(name);
    let result;
    try {
      result = addProjectToPackage(ctx, name, { packageDir, relPath });
    } catch (e) {
      throw e instanceof SyncError ? e : new SyncError(`failed to add ${label(type, name)}: ${e.message}`);
    }

    if (!dry) {
      manifest.components.projects ??= [];
      manifest.components.projects.push(result.entry);
      manifestDirty = true;
    }

    contentChanged = true;
    const genNote = result.generatedConfig ? ' (generated default project.yaml)' : '';
    results.push({ type: 'project', name, verdict: 'SYNC-ADDED', action: dry ? 'added (dry-run)' : 'added' });
    if (dry) log.dry(`move ${label(type, name)} from live project dir into package at ${relPath} and replace with symlink${result.generatedConfig ? '; generate a default project.yaml' : ''}`);
    else      log.ok(`${label(type, name)} → moved into package and symlinked${genNote}`);
  }

  for (const type of SYNC_TYPES) {
    for (const name of addQueue[type]) {
      const existing = manifest.components[type] ?? [];
      if (existing.some((e) => deriveName(packageDir, type, e.path) === name)) {
        if (!isMirror) log.warn(`${label(type, name)} already in manifest — skipping addition`);
        continue;
      }

      const row = await findRow(db, type, name);
      if (!row) {
        // Explicit --add of something not installed is a hard error; a mirror auto-add that vanished
        // between discovery and export (a race) is just skipped.
        if (isMirror) { log.warn(`${label(type, name)} vanished before export — skipped`); continue; }
        throw new SyncError(`cannot add ${singular(type)} '${name}': not found on this satellite`);
      }

      let result;
      try {
        result = await exportComponent(ctx, type, row, { packageDir, relPath: DEFAULT_PATH[type](name), skillNames: skillNamesInManifest });
      } catch (e) {
        if (isMirror) {
          log.error(`${label(type, name)}: export failed — ${e.message}`);
          results.push({ type: singular(type), name, verdict: 'SYNC-FAIL', action: 'error', detail: e.message });
          continue;
        }
        throw new SyncError(`failed to export ${label(type, name)}: ${e.message}`);
      }

      // Unrepresentable in the manifest (e.g. a non-node / out-of-base job) — not added.
      if (result?.verdict === VERDICT.BACKUP_SKIP) {
        log.warn(`${label(type, name)}: ${result.detail || 'not representable in a package'} — not added`);
        results.push({ type: singular(type), name, verdict: 'SYNC-SKIP', action: 'skipped', ...(result.detail ? { detail: result.detail } : {}) });
        continue;
      }

      const relPath = result.entry?.path ?? DEFAULT_PATH[type](name);
      if (!dry) {
        manifest.components[type] ??= [];
        let entry = result.entry ?? { path: relPath };
        // Skills: a sync addition (or --normalize) ships the locked org default, so drop the live
        // install_type marker; a mirror addition preserves it for a faithful restore.
        if (type === 'skills' && !preserveFidelity) {
          const { install_type: _omit, ...rest } = entry;
          entry = rest;
        }
        manifest.components[type].push(entry);
        if (type === 'skills') skillNamesInManifest.add(basename(relPath));
        manifestDirty = true;
      }

      handled.add(`${type}:${name}`);
      contentChanged = true;
      if (isMirror) logInstalled.push({ type: singular(type), name, version: result.entry?.version ?? null, source: sourceOf(type, relPath) });
      results.push({ type: singular(type), name, verdict: 'SYNC-ADDED', action: dry ? 'added (dry-run)' : 'added' });
      if (dry) log.dry(`add ${label(type, name)} to manifest at ${relPath}`);
      else      log.ok(`${label(type, name)} → added to manifest and exported`);
    }
  }

  // ── Step 2: sync existing manifest entries (mirror also removes the dead ones) ────────────────
  if (!mutationOnly) for (const type of SYNC_TYPES) {
    const list = manifest.components[type] ?? [];
    const kept = [];
    for (const entry of list) {
      // A 'removed' tombstone is a distribution marker (its component is intentionally absent live),
      // not exportable state — preserve it untouched so a mirror/sync never silently prunes it.
      if (entry.handling === 'removed') { kept.push(entry); continue; }

      const name = deriveName(packageDir, type, entry.path);

      if (handled.has(`${type}:${name}`)) { kept.push(entry); continue; }   // already exported in Step 1
      if (scoped && !inScope(type, name)) { kept.push(entry); continue; } // out of scope → untouched

      const row = await findRow(db, type, name);

      if (!row) {
        if (isMirror) {
          // Gone from the satellite → drop the entry and delete its file/dir from the package.
          if (removeTree(join(packageDir, entry.path), { dryRun: dry })) contentChanged = true;
          manifestDirty = true;
          contentChanged = true;
          logRemoved.push({ type: singular(type), name });
          results.push({ type: singular(type), name, verdict: 'SYNC-REMOVED', action: dry ? 'removed (dry-run)' : 'removed' });
          if (dry) log.dry(`remove ${label(type, name)} from package (${entry.path})`);
          else      log.ok(`${label(type, name)} → removed from package (gone from satellite)`);
          continue;   // not kept
        }
        log.warn(`${label(type, name)} not installed on this satellite — skipped`);
        results.push({ type: singular(type), name, verdict: 'SYNC-SKIP', action: 'skipped' });
        kept.push(entry);
        continue;
      }

      let result;
      try {
        result = await exportComponent(ctx, type, row, { packageDir, relPath: entry.path, skillNames: skillNamesInManifest });
      } catch (e) {
        log.error(`${label(type, name)}: export failed — ${e.message}`);
        results.push({ type: singular(type), name, verdict: 'SYNC-FAIL', action: 'error', detail: e.message });
        kept.push(entry);
        continue;
      }

      // Unrepresentable now (e.g. a job whose script moved outside SKILLS_BASE_DIR) — keep the
      // manifest entry as-is, surface a skip, don't claim a clean sync.
      if (result?.verdict === VERDICT.BACKUP_SKIP) {
        log.warn(`${label(type, name)}: ${result.detail || 'not representable in a package'} — skipped`);
        results.push({ type: singular(type), name, verdict: 'SYNC-SKIP', action: 'skipped', ...(result.detail ? { detail: result.detail } : {}) });
        kept.push(entry);
        continue;
      }

      // Did this run actually change anything for this component? Either a byte was written to the
      // package (result.changed) or a manifest-only field (version pin / skill install_type) moved.
      let entryChanged = !!result?.changed;

      // Version upgrade: if the live DB version is strictly higher than the manifest pin, update.
      // Skills always carry a version; recipes/agents only when set — update if live > current/unset.
      const liveVersion = result.entry?.version;
      if (liveVersion != null && (entry.version == null || liveVersion > entry.version)) {
        if (entry.version != null) log.info(`${label(type, name)}: version ${entry.version} → ${liveVersion}`);
        entry.version = liveVersion;
        manifestDirty = true;
        entryChanged = true;
      }

      // Mirror fidelity: reconcile a skill entry's install_type to the live row (present iff a user
      // skill, absent for org). Plain sync leaves install_type to the author.
      if (isMirror && type === 'skills') {
        const want = preserveFidelity ? result.entry?.install_type : undefined;   // 'user' | undefined
        if (want !== entry.install_type) {
          if (want == null) delete entry.install_type; else entry.install_type = want;
          manifestDirty = true;
          entryChanged = true;
        }
      }

      // Report `synced` only when something actually changed; an unchanged component is `unchanged`
      // (silent per-line, so repeated runs are quiet — the summary still tallies it).
      if (entryChanged) {
        contentChanged = true;
        results.push({ type: singular(type), name, verdict: 'SYNC-OK', action: 'synced' });
        if (dry) log.dry(`sync ${label(type, name)}`);
        else      log.ok(`${label(type, name)} → synced`);
      } else {
        results.push({ type: singular(type), name, verdict: 'SYNC-UNCHANGED', action: 'unchanged' });
      }
      // Faithfully present in the mirror package → record it as installed (attributed to this package).
      if (isMirror) logInstalled.push({ type: singular(type), name, version: entry.version ?? null, source: sourceOf(type, entry.path) });
      kept.push(entry);
    }

    // Mirror rebuilds each type list (dropping removed entries) and prunes empties so the manifest
    // never carries a dangling `type: []`. Plain sync mutates entries in place and leaves the shape.
    if (isMirror) {
      if (kept.length) manifest.components[type] = kept;
      else if (manifest.components[type] != null) { delete manifest.components[type]; manifestDirty = true; }
    }
  }

  // ── Step 3: mirror package-version bump (only when content actually changed) ──────────────────
  if (isMirror && manifestExists && contentChanged) {
    const cur = manifest.version;
    const next = Number.isInteger(cur) ? cur + 1 : 1;   // non-integer/legacy date label → reset to 1
    if (next !== cur) {
      if (dry) {
        log.dry(`bump package version ${cur ?? '(unset)'} → ${next}`);
      } else {
        manifest.version = next;
        manifestDirty = true;
        log.info(`package version ${cur ?? '(unset)'} → ${next}`);
      }
    }
  }

  // ── Step 4: write the updated manifest if anything changed ────────────────────────────────────
  if (manifestDirty) {
    if (dry) {
      log.dry(`write ai1-package.yaml → ${manifestPath}`);
    } else {
      writeIfChanged(manifestPath, dumpYaml(manifest), { dryRun: false });
      log.ok(`ai1-package.yaml updated`);
    }
  }

  const counts = results.reduce(
    (acc, r) => {
      if (r.verdict === 'SYNC-ADDED') acc.added++;
      else if (r.verdict === 'SYNC-OK') acc.synced++;
      else if (r.verdict === 'SYNC-UNCHANGED') acc.unchanged++;
      else if (r.verdict === 'SYNC-REMOVED') acc.removed++;
      else if (r.verdict === 'SYNC-SKIP') acc.skipped++;
      else if (r.verdict === 'SYNC-FAIL') acc.failed++;
      return acc;
    },
    { added: 0, synced: 0, unchanged: 0, removed: 0, skipped: 0, failed: 0 },
  );

  // Mirror's effect on the global install log, for the CLI to apply. Empty in plain sync.
  const installLog = { installed: logInstalled, removed: logRemoved };

  return { results, counts, manifest, manifestPath, installLog };
}
