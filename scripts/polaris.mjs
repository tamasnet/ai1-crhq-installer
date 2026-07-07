#!/usr/bin/env node
// ai1-satellite-tools — polaris runner (CLI entry): manage a satellite from its GitHub *Client
// Repository*. That repo pairs a `platform/` Ai1 Package (fed from the shared platform parent via git
// subtree) with a `user/` Ai1 Package (this satellite's own customer/user content). polaris bridges
// the repo and the live satellite — `install.mjs <repo>/platform` and `install.mjs <repo>/user` load
// content in; `sync.mjs --mirror <repo>/user` pushes live user edits back out. Subcommand CLI, like
// remote.mjs; DB-free. The only subcommand is `init` (clone the repo from GitHub).
//
// Usage: polaris.mjs <subcommand> [options]
//   init   clone this satellite's Client Repository into ${REPOS_BASE_DIR}/<repo> (default ~/repos)
//
// init options:
//   --owner=<org>   GitHub owner/org (else AI1_GITHUB_OWNER env, else MyZone-AI)
//   --repo=<name>   repository name (else the satellite's package name, satellitePackageName)
//   --json          machine-readable result output
//   --help          show this help and exit
import { makeLogger } from './lib/log.mjs';
import { UsageError } from './lib/flags.mjs';
import { RemoteError } from './lib/remote.mjs';
import { runInit, PolarisError } from './lib/polaris.mjs';

const USAGE = `ai1-satellite-tools — manage a satellite from its GitHub Client Repository (polaris)

Usage: node scripts/polaris.mjs <subcommand> [options]

Subcommands:
  init   clone this satellite's Client Repository from GitHub into
         \${REPOS_BASE_DIR}/<repo> (default ~/repos). The repo is
         <owner>/<repo> on github.com — owner defaults to MyZone-AI, repo to
         the satellite's package name (satellitePackageName, e.g. ai1-tamas).
         The clone is authenticated with the per-remote GitHub token the hub
         mints (the same token \`remote.mjs github-token\` resolves), so the
         satellite must be registered with the hub first. Refuses to overwrite
         an existing checkout. Clones the remote's default branch.

init options:
  --owner=<org>              GitHub owner/org (else AI1_GITHUB_OWNER env, else MyZone-AI)
  --repo=<name>              repository name (else the satellite's package name)
  --json                     machine-readable result output
  --help                     show this help and exit`;

// Per-subcommand option contract: boolean flags and value flags (--flag=<value>). Mirrors the strict
// validation install/remote use — an unsupported option or a value flag with no value is a usage
// error (exit 2) before any side effect.
const SPEC = {
  init: {
    bool: new Set(['--json']),
    value: new Set(['--owner', '--repo']),
  },
};

const flagName = (token) => {
  const i = token.indexOf('=');
  return i === -1 ? token : token.slice(0, i);
};

// Parse + validate the init argv into a flags object, throwing UsageError on the first violation.
function parseInitArgs(argv) {
  const spec = SPEC.init;
  const flags = { json: false };
  for (const token of argv) {
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token} (see --help)`);
    const name = flagName(token);
    const hasEq = token.includes('=');
    if (spec.bool.has(name)) {
      if (hasEq) throw new UsageError(`option ${name} does not take a value`);
      if (name === '--json') flags.json = true;
    } else if (spec.value.has(name)) {
      const val = hasEq ? token.slice(token.indexOf('=') + 1).trim() : '';
      if (!hasEq || val === '') throw new UsageError(`option ${name} requires a value (use ${name}=<value>)`);
      if (name === '--owner') flags.owner = val;
      else if (name === '--repo') flags.repo = val;
    } else {
      throw new UsageError(`unknown option: ${token} (see --help)`);
    }
  }
  return flags;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv[0] === 'help') {
    console.log(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }

  const [subcommand, ...rest] = argv;
  const log = makeLogger({});

  if (subcommand === 'init') {
    const flags = parseInitArgs(rest);
    // Suppress progress logging on the --json path so stdout is a single parseable object (git's own
    // clone progress goes to stderr regardless).
    const result = await runInit(flags, { log: flags.json ? undefined : log });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      // init's job is to clone — nothing more. Just confirm the checkout; installing the
      // platform/ and user/ packages and mirroring edits back are separate, explicit commands.
      log.ok(`cloned '${result.owner}/${result.repo}' → ${result.dir}`);
    }
    return;
  }

  console.error(`❌ unknown subcommand: ${subcommand} (see --help)`);
  process.exitCode = 2;
}

main().catch((e) => {
  if (e instanceof UsageError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof PolarisError || e instanceof RemoteError) { console.error(`❌ ${e.message}`); process.exitCode = 1; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 1; }
});
