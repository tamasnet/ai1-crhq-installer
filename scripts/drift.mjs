#!/usr/bin/env node
// drift.mjs — read-only satellite drift report CLI.
import { createContext, closeDb, preflight, PreflightError } from './lib/index.mjs';
import { UsageError } from './lib/flags.mjs';
import { FilterError } from './lib/filter.mjs';
import { formatCliTypeError, normalizeCliTypeScope } from './lib/component-types.mjs';
import { runDrift, formatDriftReport } from './lib/drift.mjs';

const USAGE = `\
Usage: drift.mjs [options]

Compare the live satellite against install-log components and their source packages.
Reports managed drift (modified / absent / source-missing) and orphans (live but not
in install.json). Read-only — no DB or filesystem writes.

Options:
  --package=<name>   scope managed drift to one package name from the install log
  --type=<types>     restrict to component types (skill,recipe,agent,job,service,project;
                     comma-separated and/or repeated)
  --include=<pat>    only components whose name matches <pat> (exact or regex)
  --exclude=<pat>    skip components whose name matches <pat>
  --strict           also count mode/mtime-only file differences as modified
                     (default compares content only)
  --json             machine-readable output
  --help             show this help and exit`;

const flagName = (token) => {
  const i = token.indexOf('=');
  return i === -1 ? token : token.slice(0, i);
};

function parseArgs(argv) {
  const flags = { json: false, strict: false, package: null, type: [], include: null, exclude: null };
  for (const token of argv) {
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token} (see --help)`);
    const name = flagName(token);
    const hasEq = token.includes('=');
    if (name === '--json' || name === '--strict') {
      if (hasEq) throw new UsageError(`option ${name} does not take a value`);
      if (name === '--json') flags.json = true; else flags.strict = true;
    } else if (name === '--package') {
      const val = hasEq ? token.slice(token.indexOf('=') + 1).trim() : '';
      if (!hasEq || !val) throw new UsageError('option --package requires a value');
      flags.package = val;
    } else if (name === '--type') {
      const raw = hasEq ? token.slice(token.indexOf('=') + 1) : '';
      if (!hasEq || !raw.trim()) throw new UsageError('option --type requires a value');
      const { types, invalid } = normalizeCliTypeScope(raw);
      if (invalid.length) throw new UsageError(formatCliTypeError(invalid));
      flags.type.push(...types);
    } else if (name === '--include') {
      const val = hasEq ? token.slice(token.indexOf('=') + 1) : '';
      if (!hasEq) throw new UsageError('option --include requires a value');
      flags.include = val;
    } else if (name === '--exclude') {
      const val = hasEq ? token.slice(token.indexOf('=') + 1) : '';
      if (!hasEq) throw new UsageError('option --exclude requires a value');
      flags.exclude = val;
    } else {
      throw new UsageError(`unknown option: ${token} (see --help)`);
    }
  }
  return flags;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const flags = parseArgs(argv);
  const ctx = await createContext([], { mode: 'status' });
  ctx.DRY_RUN = true;
  ctx.CONTENT_ONLY = !flags.strict;
  await preflight(ctx);

  const result = await runDrift(ctx, {
    packageFilter: flags.package,
    typeScope: flags.type.length ? flags.type : null,
    filterSpec: { include: flags.include, exclude: flags.exclude },
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDriftReport(result));
  }
  process.exitCode = result.summary.drift > 0 ? 1 : 0;
}

main().catch((e) => {
  if (e instanceof UsageError || e instanceof FilterError) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 2;
  } else if (e instanceof PreflightError) {
    console.error(`❌ preflight failed: ${e.message}`);
    process.exitCode = 2;
  } else {
    console.error(`❌ fatal: ${e.stack || e.message}`);
    process.exitCode = 2;
  }
}).finally(() => closeDb());
