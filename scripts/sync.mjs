#!/usr/bin/env node
// sync.mjs — satellite → package repo sync.
// The author's "get my changes back" command, and (with --mirror) the satellite backup command.
// Reads the package's ai1-package.yaml and exports each listed component from the live satellite
// (DB + SKILLS_BASE_DIR) to the package repo directory. Git-safe — unchanged files are never
// written, so only genuine diffs appear.
//
// Two modes:
//   (default)  manifest-driven: export the components the manifest lists; --add-* to register more.
//   --mirror   satellite-driven backup: make the package mirror the live satellite within scope —
//              auto-add new components, sync existing, REMOVE manifest entries (and their files)
//              whose component is gone, and bump the integer package version when content changed.
//
// Usage: sync.mjs [<package-dir>] [--add-skill=<n>] [--add-recipe=<n>] [--add-agent=<n>]
//                 [--add-job=<n>] [--add-project=<n>] [--mirror [--normalize] [--type=<t>] [--include=<p>]
//                 [--exclude=<p>]] [--dry-run] [--json] [--help]

import { resolve } from 'node:path';
import {
  getDb, closeDb, makeLogger, resolveSkillsBase, wantsHelp, UsageError, updateInstallLogForMirror,
} from './lib/index.mjs';
import { runSync, SyncError, SYNC_TYPES, isInsideGitRepo } from './lib/sync.mjs';

const USAGE = `\
Usage: sync.mjs [<package-dir>] [options]

Export the live satellite state back to a package repo directory.
Reads <package-dir>/ai1-package.yaml and exports each listed component from the
satellite (DB + SKILLS_BASE_DIR) to the package directory. Unchanged files are
never touched — run before git diff/add/commit.

  --add-skill=<name>    Register a skill in the manifest and export it (repeatable)
  --add-recipe=<name>   Register a recipe in the manifest and export it (repeatable)
  --add-agent=<name>    Register an agent in the manifest and export it (repeatable)
  --add-job=<name>      Register a job in the manifest and export it (repeatable)
  --add-project=<name>  Move /opt/projects/user/<name> into projects/<name>, add it to the manifest,
                        and replace the live directory with a symlink to the package (repeatable).
                        Projects are then managed by git; later sync/mirror runs do not export them.

  --mirror              Backup mode: make the package mirror the live satellite. Auto-adds new
                        components, syncs existing ones, and REMOVES manifest entries (plus their
                        files) whose component no longer exists on the satellite. Bumps the integer
                        package version by 1 when the run changed package content.
  --normalize           With --mirror: ship the distributable default for added skills (org/locked)
                        instead of preserving the live user/org install_type. (Default: preserve.)
  --type=<types>        With --mirror: restrict to DB component types (skills,recipes,agents,jobs;
                        comma-separated and/or repeated). Scopes additions, syncs AND removals.
                        services/projects are accepted for convenience but ignored.
  --include=<pat>       With --mirror: only components whose name matches <pat>
                        (regex; a value with no regex metacharacter is an exact ^pat$ match)
  --exclude=<pat>       With --mirror: skip components whose name matches <pat> (after --include)

  --dry-run             Preview what would be written/removed; no filesystem or manifest changes
  --force               Proceed even if <package-dir> is not inside a git repository (see below)
  --json                Machine-readable output ({ ok, package, counts, results })
  --help                Print this usage and exit

<package-dir> defaults to the current directory.

No ai1-package.yaml? Use --mirror to snapshot the whole satellite, or at least one --add-* flag.

sync edits the package IN PLACE and relies on git to recover a bad run, so it refuses a
<package-dir> that is not inside a git repository. Run 'git init' there (or point at a checkout),
or pass --force to proceed anyway.

Version handling: component versions in the manifest are bumped to match the live DB version if the
live version is higher. The package-level version is auto-incremented only by --mirror, and only
when content actually changed.

Exit codes: 0 = clean  1 = error or export failure  2 = usage error
`;

// sync's own flag set — a spec the satellite-tools mode-based validator doesn't cover.
const FLAG_SPEC = {
  bool:  ['--mirror', '--normalize', '--dry-run', '--force', '--json', '--help'],
  value: ['--add-skill', '--add-recipe', '--add-agent', '--add-job', '--add-project', '--type', '--include', '--exclude'],
};
// Flags that only make sense inside --mirror.
const MIRROR_ONLY = ['--normalize', '--type', '--include', '--exclude'];
const ADD_FLAGS = ['--add-skill', '--add-recipe', '--add-agent', '--add-job', '--add-project'];

const nameOf = (token) => {
  const i = token.indexOf('=');
  return i === -1 ? token : token.slice(0, i);
};

// Validate argv against FLAG_SPEC; throw UsageError on the first violation (--help handled earlier).
function validateFlags(argv) {
  const bool = new Set(FLAG_SPEC.bool);
  const value = new Set(FLAG_SPEC.value);
  for (const token of argv) {
    if (!token.startsWith('--')) continue;   // positional (the package path)
    if (token === '--help') continue;
    const name = nameOf(token);
    const hasEq = token.includes('=');
    if (value.has(name)) {
      const val = hasEq ? token.slice(token.indexOf('=') + 1).trim() : '';
      if (!hasEq || val === '') throw new UsageError(`option ${name} requires a value (use ${name}=<value>)`);
    } else if (bool.has(name)) {
      if (hasEq) throw new UsageError(`option ${name} does not take a value`);
    } else {
      throw new UsageError(`unknown option: ${token} (see --help)`);
    }
  }
}

// Parse argv into { positionals, flags }. Boolean flags → true; value flags → array of raw values
// (in argv order) so repeats accumulate. Assumes argv already passed validateFlags().
function parseArgs(argv) {
  const value = new Set(FLAG_SPEC.value);
  const positionals = [];
  const flags = {};
  for (const token of argv) {
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const name = nameOf(token);
    const key = name.slice(2); // strip leading '--'
    if (value.has(name)) {
      const val = token.includes('=') ? token.slice(token.indexOf('=') + 1) : '';
      (flags[key] ||= []).push(val);
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

const argv = process.argv.slice(2);
if (wantsHelp(argv)) { console.log(USAGE); process.exit(0); }

try {
  validateFlags(argv);
  const { positionals, flags } = parseArgs(argv);

  const packageDir = resolve(positionals[0] || '.');
  const dryRun = !!flags['dry-run'];
  const json   = !!flags['json'];
  const mirror = !!flags['mirror'];

  const additions = {
    skills:  flags['add-skill']  ?? [],
    recipes: flags['add-recipe'] ?? [],
    agents:  flags['add-agent']  ?? [],
    jobs:    flags['add-job']    ?? [],
    projects: flags['add-project'] ?? [],
  };

  // Mode-consistency checks (before touching the DB).
  if (!mirror) {
    const offending = MIRROR_ONLY.filter((f) => flags[f.slice(2)] != null);
    if (offending.length) throw new UsageError(`${offending.join(', ')} ${offending.length > 1 ? 'require' : 'requires'} --mirror`);
  } else {
    const usedAdds = ADD_FLAGS.filter((f) => (flags[f.slice(2)]?.length ?? 0) > 0);
    if (usedAdds.length) throw new UsageError(`${usedAdds.join(', ')} cannot be combined with --mirror (mirror auto-discovers all live components)`);
  }

  // --type: comma-separated and/or repeated; validate against the known types.
  let typeScope = null;
  if (flags['type']) {
    typeScope = flags['type'].flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
    const log0 = makeLogger({ dryRun });
    for (const nonDb of ['services', 'projects']) {
      if (typeScope.includes(nonDb)) log0.warn(`${nonDb} are package/git-managed — mirror does not cover them; ignoring`);
    }
    const unknown = typeScope.filter((t) => !['services', 'projects'].includes(t) && !SYNC_TYPES.includes(t));
    if (unknown.length) throw new UsageError(`--type: unknown component type(s): ${unknown.join(', ')} (valid: ${[...SYNC_TYPES, 'services', 'projects'].join(', ')})`);
    typeScope = typeScope.filter((t) => SYNC_TYPES.includes(t));
  }
  // --include/--exclude: a single pattern each (last wins if repeated).
  const lastOf = (key) => (flags[key]?.length ? flags[key][flags[key].length - 1] : undefined);
  const filterSpec = { include: lastOf('include') ?? null, exclude: lastOf('exclude') ?? null };

  // Git-safety guard (D-49): sync edits the package IN PLACE and relies on git to recover a bad run,
  // so refuse a destination that isn't inside a git work tree unless --force. Checked before any DB
  // work; --dry-run is held to the same rule (a preview here is the moment to catch a missing repo).
  if (!flags['force'] && !isInsideGitRepo(packageDir)) {
    throw new SyncError(
      `destination is not inside a git repository: ${packageDir}\n` +
      `  sync edits the package in place and relies on git to recover a bad run.\n` +
      `  Run 'git init' there (or point at an existing checkout), or re-run with --force to proceed anyway.`,
    );
  }

  const db  = getDb();
  const log = makeLogger({ dryRun });
  const ctx = {
    db,
    log,
    DRY_RUN: dryRun,
    SKILLS_BASE: resolveSkillsBase(),   // needed by exportJob for script-path resolution
  };

  const { results, counts, manifest, installLog } = await runSync(ctx, {
    packageDir,
    additions,
    mode: mirror ? 'mirror' : 'sync',
    typeScope,
    filterSpec,
    normalize: !!flags['normalize'],
  });
  const ok = counts.failed === 0;

  // --mirror reconciles the global install log (${PACKAGES_DIR}/install.json) so it reflects the live
  // satellite for the components THIS mirror now carries — installed slots upserted, removed ones
  // dropped (D-48). Bookkeeping only: a write failure warns, it never fails the mirror. Dry-run skips.
  let installLogUpdated = null;
  if (mirror) {
    const nIn = installLog?.installed?.length ?? 0;
    const nOut = installLog?.removed?.length ?? 0;
    if (dryRun) {
      if (nIn || nOut) log.dry(`update install log: ${nIn} installed, ${nOut} removed`);
    } else if (nIn || nOut) {
      try {
        installLogUpdated = updateInstallLogForMirror(ctx, {
          installed: installLog.installed,
          removed: installLog.removed,
          pkg: { name: manifest?.name, version: manifest?.version },
        });
        if (installLogUpdated && !json) log.ok(`install log updated: ${installLogUpdated}`);
      } catch (e) {
        log.warn(`install log not updated: ${e.message}`);
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ ok, mode: mirror ? 'mirror' : 'sync', package: manifest?.name, version: manifest?.version, counts, results, ...(mirror ? { installLog: installLogUpdated } : {}) }, null, 2));
  } else {
    const parts = [
      counts.added     && `${counts.added} added`,
      counts.synced    && `${counts.synced} synced`,
      counts.unchanged && `${counts.unchanged} unchanged`,
      counts.removed   && `${counts.removed} removed`,
      counts.skipped   && `${counts.skipped} skipped`,
      counts.failed    && `${counts.failed} failed`,
    ].filter(Boolean);

    const summary = parts.join(', ') || 'nothing to sync';
    const what = mirror ? 'Mirror' : 'Sync';
    if (ok) {
      console.log(`✅ ${what} complete${dryRun ? ' (dry-run)' : ''}: ${summary}`);
    } else {
      console.log(`❌ ${what} complete with failures: ${summary}`);
    }
  }

  if (!ok) process.exitCode = 1;
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`❌ ${e.message}\n\nRun with --help for usage.`);
    process.exitCode = 2;
  } else if (e instanceof SyncError) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
  } else {
    console.error(`❌ fatal: ${e.stack || e.message}`);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
