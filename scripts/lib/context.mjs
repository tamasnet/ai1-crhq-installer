// context.mjs — the single place flags are parsed and env resolved (D-12). createContext() returns
// a bound context shared by the CLI runner and any package install_entry hook, so both exercise
// identical code paths.
import { join } from 'path';
import { getDb, closeDb } from './db.mjs';
import { makeLogger, SEVERITY } from './log.mjs';

// INSTALL_BASE_DIR = the parent dir under which each skill's <key> folder is created (C2/D-19).
export function resolveBase() {
  return process.env.INSTALL_BASE_DIR
    || (process.env.CRHQ_BASE_DIR && join(process.env.CRHQ_BASE_DIR, 'user-skills'))
    || '/opt/projects/crhq-satellite/user-skills';
}

export function resolveSchema() {
  return process.env.INSTALL_SCHEMA || process.env.SANDBOX_SCHEMA || null;
}

export function parseFlags(argv) {
  const flags = {
    mode: 'install', DRY_RUN: false, RESPECT_LOCKS: false,
    ONLY: null, INCLUDE: null, EXCLUDE: null, SANDBOX: false, KEEP: false, LIFECYCLE: false,
    JSON: false, packageArg: '.',
  };
  for (const a of argv) {
    if (a === '--uninstall') flags.mode = 'uninstall';
    else if (a === '--status') flags.mode = 'status';
    else if (a === '--dry-run') flags.DRY_RUN = true;
    else if (a === '--respect-locks') flags.RESPECT_LOCKS = true;
    else if (a === '--sandbox') flags.SANDBOX = true;
    else if (a === '--keep') flags.KEEP = true;
    else if (a === '--lifecycle') flags.LIFECYCLE = true;
    else if (a === '--json') flags.JSON = true;
    // --only=<type>[,<type>...] selects which component types run (repeatable; comma-separated).
    else if (a.startsWith('--only=')) {
      const vals = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
      if (vals.length) flags.ONLY = [...(flags.ONLY || []), ...vals];
    }
    else if (a.startsWith('--include=')) flags.INCLUDE = a.slice('--include='.length);
    else if (a.startsWith('--exclude=')) flags.EXCLUDE = a.slice('--exclude='.length);
    else if (a.startsWith('--')) { /* package-specific flag — forwarded to install_entry, ignored here */ }
    else flags.packageArg = a;
  }
  return flags;
}

export async function createContext(argv) {
  const flags = parseFlags(Array.isArray(argv) ? argv : []);
  const log = makeLogger({ dryRun: flags.DRY_RUN });
  const ctx = {
    ...flags,
    BASE: resolveBase(),
    SCHEMA: resolveSchema(),
    db: getDb(),
    log,
    results: [],
    record(r) {
      if (r) {
        ctx.results.push(r);
        log.info(`${r.type}:${r.name} → ${r.verdict}${r.action ? ` (${r.action})` : ''}`);
      }
      return r;
    },
    report() { return report(ctx); },
    async close() { await closeDb(); },
  };
  return ctx;
}

function report(ctx) {
  const { log, results, mode } = ctx;
  let worst = 0;
  for (const r of results) worst = Math.max(worst, SEVERITY[r.verdict] ?? 1);
  const exitCode = mode === 'status' ? 0 : worst;

  if (ctx.JSON) {
    console.log(JSON.stringify({ mode, exitCode, results }, null, 2));
  } else {
    log.summary(results);
    if (exitCode === 0 && mode === 'install') log.installComplete();
    else if (exitCode === 0 && mode === 'uninstall') log.uninstallComplete();
    else if (mode === 'status') log.info('Status check complete.');
    else log.error(`Completed with ${results.filter((r) => (SEVERITY[r.verdict] ?? 1) > 0).length} failure(s).`);
  }
  process.exitCode = exitCode;
  return exitCode;
}
