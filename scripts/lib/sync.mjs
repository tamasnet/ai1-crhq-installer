// sync.mjs — core sync logic: read the package's ai1-package.yaml and export each listed
// component from the live satellite (DB + INSTALL_BASE_DIR) back to the package repo directory.
//
// Direction: satellite (DB + filesystem) → package repo (Git working copy)
// Git-safe: writeIfChanged is used throughout — byte-identical files are never touched.
// Services are out of scope (not DB-resident; their source of truth is the original package).
//
// Two operations:
//   runSync — export all components listed in the manifest
//   additions.{skills,recipes,agents,jobs} — add new components to the manifest + export them
//
// Manifest is updated in-place when needed:
//   - versions bumped if the live DB version is higher than what's pinned
//   - new entries appended for each --add-* addition
// The package-level `version` is NOT auto-incremented (that is a semantic decision for the author).

import { existsSync, readFileSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

import {
  parseFrontmatter, safeName, loadYaml, validateManifest,
  exportSkill, exportRecipe, exportAgent, exportJob,
  dumpYaml, writeIfChanged,
} from './index.mjs';

export class SyncError extends Error {
  constructor(msg) { super(msg); this.name = 'SyncError'; }
}

// Component types covered by sync (services are not DB-resident).
export const SYNC_TYPES = ['skills', 'recipes', 'agents', 'jobs'];

// Default relative path within the package for a newly added component.
const DEFAULT_PATH = {
  skills:  (name) => `skills/${safeName(name)}`,
  recipes: (name) => `recipes/${safeName(name)}.md`,
  agents:  (name) => `agents/${safeName(name)}.md`,
  jobs:    (name) => `jobs/${safeName(name)}.yaml`,
};

// Derive the component's canonical DB name from a manifest entry path.
// For skills: try the SKILL.md frontmatter 'name' field; fall back to the directory basename.
// For recipes/agents/jobs: basename of path minus the extension.
// If the component file already exists in the package dir, the frontmatter is authoritative.
function deriveName(packageDir, type, entryPath) {
  if (type === 'skills') {
    const skillMd = join(packageDir, entryPath, 'SKILL.md');
    if (existsSync(skillMd)) {
      try {
        const { meta } = parseFrontmatter(readFileSync(skillMd, 'utf8'));
        if (meta.name) return meta.name;
      } catch { /* fall through to basename */ }
    }
    return basename(entryPath);
  }
  return basename(entryPath, extname(entryPath));
}

// DB row lookup per component type.
async function findRow(db, type, name) {
  switch (type) {
    case 'skills':  return db('skills').where({ name, is_active: true }).first();
    case 'recipes': return db('recipes').where({ name, is_active: true }).first();
    case 'agents':  return db('agents').where({ key: name, is_active: true }).first();
    case 'jobs':    return db('background_jobs').where({ name }).first();
    default:        return null;
  }
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

// Short label for log output.
const label = (type, name) => `${type.replace(/s$/, '')}:${name}`;

// ──────────────────────────────────────────────────────────────────────────────────────────────────

// ctx must have: db, log, DRY_RUN, BASE (needed by exportJob for script-path resolution).
// additions: { skills: string[], recipes: string[], agents: string[], jobs: string[] }
export async function runSync(ctx, { packageDir, additions = {} }) {
  const { db, log } = ctx;
  const dry = !!ctx.DRY_RUN;

  const manifestPath = join(packageDir, 'ai1-package.yaml');
  const manifestExists = existsSync(manifestPath);

  const hasAdditions = SYNC_TYPES.some((t) => (additions[t]?.length ?? 0) > 0);

  if (!manifestExists && !hasAdditions) {
    throw new SyncError(
      `No ai1-package.yaml found in ${packageDir}.\n` +
      `  Use --add-skill=<name> (or --add-recipe, --add-agent, --add-job) to create one.`,
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
    // Bootstrap from the directory name; the author fills in name/description before publishing.
    const pkgName = basename(packageDir);
    manifest = { name: pkgName, version: 1, description: '', components: {} };
    log.warn(`no ai1-package.yaml found — bootstrapping with name '${pkgName}'`);
  }

  manifest.components ??= {};
  let manifestDirty = !manifestExists;   // bootstrapped manifests must always be written
  const results = [];

  // Skill names in the manifest — used by exportJob to populate 'requires:'.
  const skillNamesInManifest = new Set(
    (manifest.components.skills ?? []).map((e) => basename(e.path)),
  );

  // ── Phase 1: Additions (--add-<type>=<name>) ─────────────────────────────────────────────────
  // Additions must exist on the satellite (error, not warn — the intent is explicit).
  for (const type of SYNC_TYPES) {
    for (const name of (additions[type] ?? [])) {
      // Guard: already listed in the manifest.
      const existing = manifest.components[type] ?? [];
      if (existing.some((e) => deriveName(packageDir, type, e.path) === name)) {
        log.warn(`${label(type, name)} already in manifest — skipping addition`);
        continue;
      }

      const row = await findRow(db, type, name);
      if (!row) {
        throw new SyncError(
          `cannot add ${type.replace(/s$/, '')} '${name}': not found on this satellite`,
        );
      }

      const relPath = DEFAULT_PATH[type](name);
      let result;
      try {
        result = await exportComponent(ctx, type, row, { packageDir, relPath, skillNames: skillNamesInManifest });
      } catch (e) {
        throw new SyncError(`failed to export ${label(type, name)}: ${e.message}`);
      }

      if (!dry) {
        manifest.components[type] ??= [];
        if (type === 'skills') {
          // For additions always use the default install_type (org) — don't mirror the live
          // skill_type. exportSkill carries install_type:'user' when the live row is a user skill,
          // but package consumers should receive the locked org default.
          const { install_type: _, ...entry } = result.entry ?? { path: relPath };
          manifest.components[type].push(entry);
          skillNamesInManifest.add(basename(relPath));
        } else {
          manifest.components[type].push(result.entry ?? { path: relPath });
        }
        manifestDirty = true;
      }

      results.push({ type: type.replace(/s$/, ''), name, verdict: 'SYNC-ADDED', action: dry ? 'added (dry-run)' : 'added' });
      if (dry) log.dry(`add ${label(type, name)} to manifest at ${relPath}`);
      else      log.ok(`${label(type, name)} → added to manifest and exported`);
    }
  }

  // ── Phase 2: Sync existing manifest entries ───────────────────────────────────────────────────
  for (const type of SYNC_TYPES) {
    for (const entry of (manifest.components[type] ?? [])) {
      const name = deriveName(packageDir, type, entry.path);
      const row = await findRow(db, type, name);

      if (!row) {
        log.warn(`${label(type, name)} not installed on this satellite — skipped`);
        results.push({ type: type.replace(/s$/, ''), name, verdict: 'SYNC-SKIP', action: 'skipped' });
        continue;
      }

      let result;
      try {
        result = await exportComponent(ctx, type, row, {
          packageDir,
          relPath: entry.path,
          skillNames: skillNamesInManifest,
        });
      } catch (e) {
        log.error(`${label(type, name)}: export failed — ${e.message}`);
        results.push({ type: type.replace(/s$/, ''), name, verdict: 'SYNC-FAIL', action: 'error', detail: e.message });
        continue;
      }

      // Version upgrade: if the live DB version is strictly higher than the manifest pin, update.
      // Skills always have an entry.version (required by the manifest spec); recipes and agents
      // have it only when previously set — we update either way if live > current (or unset).
      const liveVersion = result.entry?.version;
      if (liveVersion != null) {
        if (entry.version == null || liveVersion > entry.version) {
          if (entry.version != null) {
            log.info(`${label(type, name)}: version ${entry.version} → ${liveVersion}`);
          }
          entry.version = liveVersion;
          if (!dry) manifestDirty = true;
        }
      }

      results.push({ type: type.replace(/s$/, ''), name, verdict: 'SYNC-OK', action: 'synced' });
      if (!dry) log.ok(`${label(type, name)} → synced`);
    }
  }

  // ── Phase 3: Write updated manifest if anything changed ───────────────────────────────────────
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
      else if (r.verdict === 'SYNC-SKIP') acc.skipped++;
      else if (r.verdict === 'SYNC-FAIL') acc.failed++;
      return acc;
    },
    { added: 0, synced: 0, skipped: 0, failed: 0 },
  );

  return { results, counts, manifest, manifestPath };
}
