#!/usr/bin/env node
// ai1-satellite-tools — action runner (CLI entry): read ${REMOTE_BASE_DIR}/actions.json and
// perform queued hub advisory actions. The runner updates actions.json after each completed action
// so a later invocation resumes from the first unprocessed action.
import { makeLogger } from './lib/log.mjs';
import { UsageError } from './lib/flags.mjs';
import { ActionError, runActions } from './lib/action.mjs';
import { RemoteError } from './lib/remote.mjs';

const USAGE = `ai1-satellite-tools — process queued hub actions

Usage: node scripts/action.mjs [options]

Reads \${REMOTE_BASE_DIR}/actions.json (default ~/remote/actions.json) and performs queued
advisory actions in order. Supported action types:
  pull-config     run the same logic as remote.mjs pull-config
  push-install    run the same logic as remote.mjs push-install
  install-package run remote.mjs get-package, then install.mjs on the downloaded package

Options:
  --limit=<n>   maximum number of actions to process (default: all; n may be 0)
  --json        machine-readable result output
  --help        show this help and exit`;

const flagName = (token) => {
  const i = token.indexOf('=');
  return i === -1 ? token : token.slice(0, i);
};

function parseArgs(argv) {
  const flags = { json: false, limit: null };
  for (const token of argv) {
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token} (see --help)`);
    const name = flagName(token);
    const hasEq = token.includes('=');
    if (name === '--json') {
      if (hasEq) throw new UsageError('option --json does not take a value');
      flags.json = true;
    } else if (name === '--limit') {
      const val = hasEq ? token.slice(token.indexOf('=') + 1).trim() : '';
      if (!hasEq || val === '') throw new UsageError('option --limit requires a value (use --limit=<n>)');
      if (!/^\d+$/.test(val)) throw new UsageError('option --limit requires a non-negative integer');
      flags.limit = Number(val);
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
  const log = makeLogger({});
  const result = await runActions({ limit: flags.limit }, { now: new Date(), log: flags.json ? undefined : log });

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.processed === 0) {
    const why = result.found ? `${result.remaining} action${result.remaining === 1 ? '' : 's'} pending` : 'actions file not found';
    log.info(`no actions processed (${why})`);
  } else {
    log.ok(`${result.processed} action${result.processed === 1 ? '' : 's'} processed`);
    log.info(`${result.remaining} action${result.remaining === 1 ? '' : 's'} remaining in ${result.dest}`);
  }
}

main().catch((e) => {
  if (e instanceof UsageError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof ActionError || e instanceof RemoteError) { console.error(`❌ ${e.message}`); process.exitCode = 1; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 1; }
});
