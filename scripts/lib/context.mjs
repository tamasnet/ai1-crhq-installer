// context.mjs — the single place flags are parsed and env resolved (D-12). createContext() returns
// a bound context shared by the CLI runner and any package install_entry hook, so both exercise
// identical code paths.
import { join } from 'path';
import { getDb, closeDb } from './db.mjs';
import { makeLogger, SEVERITY } from './log.mjs';
import { resolvePackagesDir } from './install-log.mjs';
import { resolveServicesBase, resolveUserProjectsBase } from './paths.mjs';
import { UsageError } from './flags.mjs';
import { formatCliTypeError, normalizeCliTypeScope } from './component-types.mjs';

// SKILLS_BASE_DIR = the parent dir under which each skill's <key> folder is created (C2/D-19).
export function resolveSkillsBase() {
  return process.env.SKILLS_BASE_DIR
    || (process.env.CRHQ_BASE_DIR && join(process.env.CRHQ_BASE_DIR, 'user-skills'))
    || '/opt/projects/crhq-satellite/user-skills';
}

// AGENT_BRAINS_DIR = the parent dir under which each agent's <key> brain folder is created (D-50) —
// the agent-side analog of SKILLS_BASE_DIR. An agent component is now a directory (agents/<key>/
// with AGENTS.md, like a skill's SKILL.md); install copies that whole tree to join(AGENT_BRAINS_DIR,
// key). Same vendor-neutral / CRHQ_BASE_DIR-relative / default shape as resolveSkillsBase() so the sandbox
// can redirect it to a temp dir. The `documents/agent-brains` literal lives ONLY in the fallback +
// default, never in core logic.
export function resolveBrains() {
  return process.env.AGENT_BRAINS_DIR
    || (process.env.CRHQ_BASE_DIR && join(process.env.CRHQ_BASE_DIR, 'documents/agent-brains'))
    || '/opt/projects/crhq-satellite/documents/agent-brains';
}

export function resolveSchema() {
  return process.env.INSTALL_SCHEMA || process.env.SANDBOX_SCHEMA || null;
}

export function parseFlags(argv) {
  const flags = {
    mode: 'install', DRY_RUN: false, RESPECT_LOCKS: false, INSTALL_SKILLS_AS_USER: false,
    TYPE: null, INCLUDE: null, EXCLUDE: null, SANDBOX: false, KEEP: false, LIFECYCLE: false,
    JSON: false, COPY_PROJECTS: false, packageArg: '.',
  };
  for (const a of argv) {
    if (a === '--uninstall') flags.mode = 'uninstall';
    else if (a === '--status') flags.mode = 'status';
    else if (a === '--dry-run') flags.DRY_RUN = true;
    else if (a === '--respect-locks') flags.RESPECT_LOCKS = true;
    else if (a === '--install-skills-as-user') flags.INSTALL_SKILLS_AS_USER = true;
    else if (a === '--sandbox') flags.SANDBOX = true;
    else if (a === '--keep') flags.KEEP = true;
    else if (a === '--lifecycle') flags.LIFECYCLE = true;
    else if (a === '--json') flags.JSON = true;
    else if (a === '--copy-projects') flags.COPY_PROJECTS = true;
    // --type=<type>[,<type>...] accepts singular CLI values and stores internal collection keys.
    else if (a.startsWith('--type=')) {
      const { types, invalid } = normalizeCliTypeScope(a.slice('--type='.length));
      if (invalid.length) throw new UsageError(formatCliTypeError(invalid));
      if (types.length) flags.TYPE = [...(flags.TYPE || []), ...types];
    }
    else if (a.startsWith('--include=')) flags.INCLUDE = a.slice('--include='.length);
    else if (a.startsWith('--exclude=')) flags.EXCLUDE = a.slice('--exclude='.length);
    else if (a.startsWith('--')) { /* package-specific flag — forwarded to install_entry, ignored here */ }
    else flags.packageArg = a;
  }
  return flags;
}

export async function createContext(argv, opts = {}) {
  const flags = parseFlags(Array.isArray(argv) ? argv : []);
  if (opts.mode) flags.mode = opts.mode;   // CLI entries pick the mode family
  const log = makeLogger({ dryRun: flags.DRY_RUN });
  const ctx = {
    ...flags,
    SKILLS_BASE: resolveSkillsBase(),
    BRAINS: resolveBrains(),
    SERVICES_BASE: resolveServicesBase(),
    USER_PROJECTS_BASE: resolveUserProjectsBase(),
    SCHEMA: resolveSchema(),
    PACKAGES_DIR: resolvePackagesDir(),
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
    console.log(JSON.stringify({ mode, exitCode, ...(ctx.reportExtra || {}), results }, null, 2));
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
