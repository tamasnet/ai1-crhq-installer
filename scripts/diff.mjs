#!/usr/bin/env node
// diff.mjs — read-only package → live component diff CLI.
import { createContext, closeDb, preflight, PreflightError, ManifestError } from './lib/index.mjs';
import { UsageError } from './lib/flags.mjs';
import { FilterError } from './lib/filter.mjs';
import { formatCliTypeError, normalizeCliTypeScope } from './lib/component-types.mjs';
import { runDiff, formatDiffReport } from './lib/diff.mjs';

const USAGE = `\
Usage: diff.mjs [<package>] [options]

Compare a package's components against their live equivalents — DB fields, links, and file
trees — regardless of how the live component was installed. File detail is status-only
(~ modified, + package-only, - live-only); protected names are set aside and reported.
Read-only — no DB or filesystem writes.

  <package>  directory containing ai1-package.yaml (or the file itself); default '.'

Options:
  --type=<types>     restrict to component types (skill,recipe,agent,job,service,project;
                     comma-separated and/or repeated)
  --include=<pat>    only components whose name matches <pat> (exact or regex)
  --exclude=<pat>    skip components whose name matches <pat>
  --copy-projects    treat project components as copy-mode deploys (default: symlink)
  --json             machine-readable output
  --help             show this help and exit

Exit codes: 0 no differences, 1 differences found, 2 usage/manifest error.`;

const flagName = (token) => {
  const i = token.indexOf('=');
  return i === -1 ? token : token.slice(0, i);
};

function parseArgs(argv) {
  const flags = { json: false, copyProjects: false, type: [], include: null, exclude: null, packageArg: '.' };
  for (const token of argv) {
    if (!token.startsWith('--')) { flags.packageArg = token; continue; }
    const name = flagName(token);
    const hasEq = token.includes('=');
    if (name === '--json' || name === '--copy-projects') {
      if (hasEq) throw new UsageError(`option ${name} does not take a value`);
      if (name === '--json') flags.json = true; else flags.copyProjects = true;
    } else if (name === '--type') {
      const raw = hasEq ? token.slice(token.indexOf('=') + 1) : '';
      if (!raw.trim()) throw new UsageError('option --type requires a value');
      const { types, invalid } = normalizeCliTypeScope(raw);
      if (invalid.length) throw new UsageError(formatCliTypeError(invalid));
      flags.type.push(...types);
    } else if (name === '--include' || name === '--exclude') {
      if (!hasEq) throw new UsageError(`option ${name} requires a value`);
      flags[name.slice(2)] = token.slice(token.indexOf('=') + 1);
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
  ctx.COPY_PROJECTS = flags.copyProjects;
  await preflight(ctx);

  const result = await runDiff(ctx, {
    packageDir: flags.packageArg,
    typeScope: flags.type.length ? flags.type : null,
    filterSpec: { include: flags.include, exclude: flags.exclude },
  });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDiffReport(result));
  }
  process.exitCode = result.summary.diffs > 0 ? 1 : 0;
}

main().catch((e) => {
  if (e instanceof UsageError || e instanceof FilterError || e instanceof ManifestError) {
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
