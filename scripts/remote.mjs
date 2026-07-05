#!/usr/bin/env node
// ai1-satellite-tools — remote runner (CLI entry): the satellite's client for the Ai1 Platform Hub.
// Registers a satellite as a *remote*, and (in later subcommands) will receive/send config and
// state, take management instructions, and download packages for installation. Network-only and
// DB-free; the resulting identity is written to ${REMOTE_BASE_DIR}/id.json (default ~/remote).
//
// Usage: remote.mjs <subcommand> [options]
//   register     self-enroll this satellite with the hub and store the per-remote key
//   pull-config   poll the hub for this remote's config and cache it to config.json
//   heartbeat    report state (state.json) and cache returned actions[]
//   push-install send install.json to the hub
//   github-token print the GitHub token this remote should use (raw token to stdout)
//   get-package  download + extract a registered package into PACKAGE_BASE_DIR/<name>@<version>
//
// register options:
//   --hub=<url>                hub base URL (else AI1_HUB_URL / HUB_URL)
//   --token=<tok>              shared enrollment secret (else AI1_BOOTSTRAP_TOKEN / BOOTSTRAP_TOKEN)
//   --remote-id=<id>           identity to claim (else SATELLITE_ID, else normalized hostname)
//   --remote-type=<type>       remote type reported at enrollment (default satellite type)
//   --schema-version=<n>       schema version reported at enrollment (default 1)
//   --force                    overwrite an existing id.json (discards the stored token)
//   --json                     machine-readable result output
//   --help                     show this help and exit
//
// pull-config / heartbeat / push-install options:
//   --json                     machine-readable result output
//   --help                     show this help and exit
import { makeLogger } from './lib/log.mjs';
import { UsageError } from './lib/flags.mjs';
import { registerRemote, pullRemoteConfig, reportRemoteState, pushRemoteInstall, fetchGithubToken, fetchRemotePackage, RemoteError } from './lib/remote.mjs';

const USAGE = `ai1-satellite-tools — register a satellite with the Ai1 Platform Hub

Usage: node scripts/remote.mjs <subcommand> [options]

Subcommands:
  register     self-enroll this satellite with the hub and store the per-remote key in
               \${REMOTE_BASE_DIR}/id.json (default ~/remote)
  pull-config   poll the hub for this remote's config and write the raw payload to
               \${REMOTE_BASE_DIR}/config.json (+ a state.json sidecar with the version;
               conditional — a 304 leaves both files as-is)
  heartbeat    report this remote's state (state.json contents) to
               the hub; echo the server reported_at and cache the returned advisory
               actions[] to \${REMOTE_BASE_DIR}/actions.json
  push-install send the normalized \${PACKAGES_DIR}/install.json state to the hub via
               PUT /remote/install
  github-token resolve the GitHub token this remote should use and print just the raw
               token to stdout (suitable for \`TOKEN=\$(… github-token)\`)
  get-package  resolve a signed download URL for a registered package, download the
               archive to \${DOWNLOAD_BASE_DIR} (default system temp) and extract it to
               \${PACKAGE_BASE_DIR}/<name>@<version> (default ~/packages); the archive is
               deleted after a successful extract unless --keep-download is given

register options:
  --hub=<url>                hub base URL (else AI1_HUB_URL / HUB_URL env)
  --token=<tok>              shared enrollment secret (else AI1_BOOTSTRAP_TOKEN / BOOTSTRAP_TOKEN)
  --remote-id=<id>           identity to claim (else SATELLITE_ID env, else normalized hostname)
  --remote-type=<type>       remote type reported at enrollment (default satellite type)
  --schema-version=<n>       schema version reported at enrollment (default 1)
  --force                    overwrite an existing id.json (discards the stored token)
  --json                     machine-readable result output
  --help                     show this help and exit

pull-config / heartbeat / push-install options:
  --json                     machine-readable result output
  --help                     show this help and exit

github-token options:
  --help                     show this help and exit

get-package options:
  --name=<name>              registered package name (required)
  --version=<n>              registered package version, a positive integer (required)
  --keep-download            keep the downloaded archive instead of deleting it after extract
  --json                     machine-readable result output
  --help                     show this help and exit`;

// Per-subcommand option contract: boolean flags and value flags (--flag=<value>). Mirrors the
// strict validation install/backup use (flags.mjs): an unsupported option or a value flag with no
// value is a usage error (exit 2) before any side effect.
const SPEC = {
  register: {
    bool: new Set(['--force', '--json']),
    value: new Set(['--hub', '--token', '--remote-id', '--remote-type', '--schema-version']),
  },
  'pull-config': {
    bool: new Set(['--json']),
    value: new Set([]),
  },
  heartbeat: {
    bool: new Set(['--json']),
    value: new Set([]),
  },
  'push-install': {
    bool: new Set(['--json']),
    value: new Set([]),
  },
  'github-token': {
    bool: new Set([]),
    value: new Set([]),
  },
  'get-package': {
    bool: new Set(['--keep-download', '--json']),
    value: new Set(['--name', '--version']),
  },
};

const flagName = (token) => {
  const i = token.indexOf('=');
  return i === -1 ? token : token.slice(0, i);
};

// Parse + validate a subcommand's argv into a flags object, throwing UsageError on the first
// violation. Returns camelCased flags consumed by lib/remote.mjs.
function parseRegisterArgs(argv) {
  const spec = SPEC.register;
  const flags = { force: false, json: false };
  for (const token of argv) {
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token} (see --help)`);
    const name = flagName(token);
    const hasEq = token.includes('=');
    if (spec.bool.has(name)) {
      if (hasEq) throw new UsageError(`option ${name} does not take a value`);
      if (name === '--force') flags.force = true;
      else if (name === '--json') flags.json = true;
    } else if (spec.value.has(name)) {
      const val = hasEq ? token.slice(token.indexOf('=') + 1).trim() : '';
      if (!hasEq || val === '') throw new UsageError(`option ${name} requires a value (use ${name}=<value>)`);
      if (name === '--hub') flags.hub = val;
      else if (name === '--token') flags.bootstrapToken = val;
      else if (name === '--remote-id') flags.remoteId = val;
      else if (name === '--remote-type') flags.remoteType = val;
      else if (name === '--schema-version') {
        const n = Number(val);
        if (!Number.isInteger(n)) throw new UsageError('option --schema-version requires an integer');
        flags.schemaVersion = n;
      }
    } else {
      throw new UsageError(`unknown option: ${token} (see --help)`);
    }
  }
  return flags;
}

// Parse + validate the argv of a boolean-flag-only subcommand (pull-config, heartbeat,
// push-install). Only --json; same strict contract as register — an unsupported option or a value on
// a boolean flag is a usage error (exit 2).
function parseBoolOnlyArgs(subcommand, argv) {
  const spec = SPEC[subcommand];
  const flags = { json: false };
  for (const token of argv) {
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token} (see --help)`);
    const name = flagName(token);
    const hasEq = token.includes('=');
    if (spec.bool.has(name)) {
      if (hasEq) throw new UsageError(`option ${name} does not take a value`);
      if (name === '--json') flags.json = true;
    } else {
      throw new UsageError(`unknown option: ${token} (see --help)`);
    }
  }
  return flags;
}

// Parse + validate the get-package argv. Same strict contract as the others: --name (required) and
// --version (required, positive integer) are value flags; --keep-download/--json are booleans.
function parseGetPackageArgs(argv) {
  const spec = SPEC['get-package'];
  const flags = { keepDownload: false, json: false };
  for (const token of argv) {
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token} (see --help)`);
    const name = flagName(token);
    const hasEq = token.includes('=');
    if (spec.bool.has(name)) {
      if (hasEq) throw new UsageError(`option ${name} does not take a value`);
      if (name === '--keep-download') flags.keepDownload = true;
      else if (name === '--json') flags.json = true;
    } else if (spec.value.has(name)) {
      const val = hasEq ? token.slice(token.indexOf('=') + 1).trim() : '';
      if (!hasEq || val === '') throw new UsageError(`option ${name} requires a value (use ${name}=<value>)`);
      if (name === '--name') flags.name = val;
      else if (name === '--version') {
        if (!/^\d+$/.test(val) || Number(val) < 1) {
          throw new UsageError('option --version requires a positive integer (>= 1)');
        }
        flags.version = Number(val);
      }
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

  if (subcommand === 'register') {
    const flags = parseRegisterArgs(rest);
    // Suppress the progress line on the --json path so stdout is a single parseable object.
    const result = await registerRemote(flags, { now: new Date(), log: flags.json ? undefined : log });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      log.ok(`registered '${result.remoteId}' — status '${result.status}'`);
      log.info(`identity written to ${result.dest}`);
      if (result.status === 'registered') {
        log.info('awaiting operator approval on the hub before authenticated calls are served.');
      }
    }
    return;
  }

  if (subcommand === 'pull-config') {
    const flags = parseBoolOnlyArgs(subcommand, rest);
    const result = await pullRemoteConfig(flags, { now: new Date(), log: flags.json ? undefined : log });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.changed) {
      log.ok(`config updated to version ${result.configVersion} → ${result.dest}`);
    } else {
      log.info(`config unchanged (version ${result.configVersion}); ${result.dest} left as-is`);
    }
    return;
  }

  if (subcommand === 'heartbeat') {
    const flags = parseBoolOnlyArgs(subcommand, rest);
    const result = await reportRemoteState(flags, { now: new Date(), log: flags.json ? undefined : log });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      log.ok(`state reported for '${result.remoteId}' — recorded at ${result.reportedAt}`);
      const n = result.actions.length;
      log.info(`${n} action${n === 1 ? '' : 's'} written to ${result.dest}`);
    }
    return;
  }

  if (subcommand === 'push-install') {
    const flags = parseBoolOnlyArgs(subcommand, rest);
    const result = await pushRemoteInstall(flags, { log: flags.json ? undefined : log });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      log.ok(`install state v${result.installVersion} pushed for '${result.remoteId}'`);
      log.info(`${result.componentCount} component${result.componentCount === 1 ? '' : 's'} reported`);
    }
    return;
  }

  if (subcommand === 'github-token') {
    parseBoolOnlyArgs(subcommand, rest);
    // No progress logging and no trailing newline — stdout must be the token byte-for-byte, since it
    // may be used verbatim in an auth header or URL where a stray newline would corrupt it.
    const result = await fetchGithubToken({}, {});
    process.stdout.write(result.token);
    return;
  }

  if (subcommand === 'get-package') {
    const flags = parseGetPackageArgs(rest);
    const result = await fetchRemotePackage(flags, { log: flags.json ? undefined : log });

    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      log.ok(`package '${result.name}@${result.version}' ready at ${result.packageDir}`);
      log.info(`install it with: node scripts/install.mjs ${result.packageDir}`);
      if (result.keptDownload) log.info(`archive kept at ${result.download}`);
    }
    return;
  }

  console.error(`❌ unknown subcommand: ${subcommand} (see --help)`);
  process.exitCode = 2;
}

main().catch((e) => {
  if (e instanceof UsageError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof RemoteError) { console.error(`❌ ${e.message}`); process.exitCode = 1; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 1; }
});
