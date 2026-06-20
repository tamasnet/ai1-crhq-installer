#!/usr/bin/env node
// sync.mjs — satellite → package repo sync.
// The author's "get my changes back" command, and (with --mirror) the satellite backup command.
// Reads the package's ai1-package.yaml and exports each listed component from the live satellite
// (DB + INSTALL_BASE_DIR) to the package repo directory. Git-safe — unchanged files are never
// written, so only genuine diffs appear.
//
// Two modes:
//   (default)  manifest-driven: export the components the manifest lists; --add-* to register more.
//   --mirror   satellite-driven backup: make the package mirror the live satellite within scope —
//              auto-add new components, sync existing, REMOVE manifest entries (and their files)
//              whose component is gone, and bump the integer package version when content changed.
//
// Usage: sync.mjs [<package-dir>] [--add-skill=<n>] [--add-recipe=<n>] [--add-agent=<n>]
//                 [--add-job=<n>] [--mirror [--normalize] [--type=<t>] [--include=<p>]
//                 [--exclude=<p>]] [--dry-run] [--json] [--help]

import { resolve } from 'node:path';
import {
  getDb, closeDb, makeLogger, resolveBase, wantsHelp, UsageError,
} from './lib/index.mjs';
import { runSync, SyncError, SYNC_TYPES } from './lib/sync.mjs';

const USAGE = `\
Usage: sync.mjs [<package-dir>] [options]

Export the live satellite state back to a package repo directory.
Reads <package-dir>/ai1-package.yaml and exports each listed component from the
satellite (DB + INSTALL_BASE_DIR) to the package directory. Unchanged files are
never touched — run before git diff/add/commit.

  --add-skill=<name>    Register a skill in the manifest and export it (repeatable)
  --add-recipe=<name>   Register a recipe in the manifest and export it (repeatable)
  --add-agent=<name>    Register an agent in the manifest and export it (repeatable)
  --add-job=<name>      Register a job in the manifest and export it (repeatable)

  --mirror              Backup mode: make the package mirror the live satellite. Auto-adds new
                        components, syncs existing ones, and REMOVES manifest entries (plus their
                        files) whose component no longer exists on the satellite. Bumps the integer
                        package version by 1 when the run changed package content.
  --normalize           With --mirror: ship the distributable default for added skills (org/locked)
                        instead of preserving the live user/org install_type. (Default: preserve.)
  --type=<types>        With --mirror: restrict to component types (skills,recipes,agents,jobs;
                        comma-separated and/or repeated). Scopes additions, syncs AND removals.
  --include=<pat>       With --mirror: only components whose name matches <pat>
                        (regex; a value with no regex metacharacter is an exact ^pat$ match)
  --exclude=<pat>       With --mirror: skip components whose name matches <pat> (after --include)

  --dry-run             Preview what would be written/removed; no filesystem or manifest changes
  --json                Machine-readable output ({ ok, package, counts, results })
  --help                Print this usage and exit

<package-dir> defaults to the current directory.

No ai1-package.yaml? Use --mirror to snapshot the whole satellite, or at least one --add-* flag.

Version handling: component versions in the manifest are bumped to match the live DB version if the
live version is higher. The package-level version is auto-incremented only by --mirror, and only
when content actually changed.

Exit codes: 0 = clean  1 = error or export failure  2 = usage error
`;

// sync's own flag set — a spec the satellite-tools mode-based validator doesn't cover.
const FLAG_SPEC = {
  bool:  ['--mirror', '--normalize', '--dry-run', '--json', '--help'],
  value: ['--add-skill', '--add-recipe', '--add-agent', '--add-job', '--type', '--include', '--exclude'],
};
// Flags that only make sense inside --mirror.
const MIRROR_ONLY = ['--normalize', '--type', '--include', '--exclude'];
const ADD_FLAGS = ['--add-skill', '--add-recipe', '--add-agent', '--add-job'];

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
    if (typeScope.includes('services')) log0.warn('services are not DB-resident — mirror does not cover them; ignoring');
    const unknown = typeScope.filter((t) => t !== 'services' && !SYNC_TYPES.includes(t));
    if (unknown.length) throw new UsageError(`--type: unknown component type(s): ${unknown.join(', ')} (valid: ${SYNC_TYPES.join(', ')})`);
    typeScope = typeScope.filter((t) => SYNC_TYPES.includes(t));
  }
  // --include/--exclude: a single pattern each (last wins if repeated).
  const lastOf = (key) => (flags[key]?.length ? flags[key][flags[key].length - 1] : undefined);
  const filterSpec = { include: lastOf('include') ?? null, exclude: lastOf('exclude') ?? null };

  const db  = getDb();
  const log = makeLogger({ dryRun });
  const ctx = {
    db,
    log,
    DRY_RUN: dryRun,
    BASE: resolveBase(),   // needed by exportJob for script-path resolution
  };

  const { results, counts, manifest } = await runSync(ctx, {
    packageDir,
    additions,
    mode: mirror ? 'mirror' : 'sync',
    typeScope,
    filterSpec,
    normalize: !!flags['normalize'],
  });
  const ok = counts.failed === 0;

  if (json) {
    console.log(JSON.stringify({ ok, mode: mirror ? 'mirror' : 'sync', package: manifest?.name, version: manifest?.version, counts, results }, null, 2));
  } else {
    const parts = [
      counts.added   && `${counts.added} added`,
      counts.synced  && `${counts.synced} synced`,
      counts.removed && `${counts.removed} removed`,
      counts.skipped && `${counts.skipped} skipped`,
      counts.failed  && `${counts.failed} failed`,
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
