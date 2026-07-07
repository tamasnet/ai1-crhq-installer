// polaris.mjs — the Polaris client: manage a satellite from its GitHub *Client Repository*.
// The satellite's repo follows the parent–client model (see docs/repo-methodology.md): a
// `platform/` directory (an Ai1 Package fed from the shared platform *parent* repo via git subtree)
// and a `user/` directory (an Ai1 Package holding THIS satellite's own customer/user content). Both
// are installable with `install.mjs`; the `user/` package is the one `sync.mjs --mirror` pushes live
// satellite edits back into. polaris bridges that repository and the live satellite.
//
// This module is the logic behind the `polaris.mjs` CLI. It is **DB-free**: it shells out to `git`
// and reuses the hub client's github-token resolver (lib/remote.mjs). The only subcommand is `init`.
//
// init: clone the satellite's Client Repository from GitHub into ${REPOS_BASE_DIR}/<repo> (default
// ~/repos). The repo is `<owner>/<repo>` on github.com — owner defaults to MyZone-AI (overridable
// via --owner / AI1_GITHUB_OWNER), repo to satellitePackageName() (overridable via --repo). The
// clone is authenticated with the per-remote GitHub token the hub mints — the same token
// `remote.mjs github-token` resolves — injected via git's ENVIRONMENT-based config so the credential
// never lands in argv (`ps`) or in the cloned repo's persisted `.git/config`.
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { UsageError } from './flags.mjs';
import { satellitePackageName } from './identity.mjs';
import { fetchGithubToken } from './remote.mjs';

// Raised on any polaris failure that isn't a usage error (existing checkout, git failure). The CLI
// maps it to a non-usage failure exit (1). Token-resolution failures surface as RemoteError (from
// lib/remote.mjs) instead and are mapped the same way by the CLI.
export class PolarisError extends Error {
  constructor(message) { super(message); this.name = 'PolarisError'; }
}

// The GitHub org that holds the satellite Client Repositories by default. Overridable per-run via
// --owner=<org> or the AI1_GITHUB_OWNER env, so a different cohort/org can be targeted without code
// changes; the constant is the convention for the common case.
export const DEFAULT_GITHUB_OWNER = 'MyZone-AI';
const GITHUB_HOST = 'github.com';

// REPOS_BASE_DIR = the parent dir under which Client Repositories are cloned, one `<repo>/` per
// satellite. Defaults to ~/repos (mirrors the *_BASE_DIR convention used across the toolkit). The
// clone lands at ${REPOS_BASE_DIR}/<repo>.
export function resolveReposBase() {
  return process.env.REPOS_BASE_DIR || join(homedir(), 'repos');
}

// First non-empty, trimmed candidate (flag, then env fallbacks); null when none is usable.
function firstNonEmpty(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

// GitHub owner: explicit --owner wins, else AI1_GITHUB_OWNER env, else the MyZone-AI default.
export function resolveOwner(flag) {
  return firstNonEmpty(flag, process.env.AI1_GITHUB_OWNER) || DEFAULT_GITHUB_OWNER;
}

// Repository name: explicit --repo wins, else the satellite's own package name (satellitePackageName,
// e.g. `myzone-tamas` → `ai1-tamas`), which is the convention a Client Repository is named for.
export function resolveRepo(flag) {
  return firstNonEmpty(flag) || satellitePackageName();
}

// A GitHub owner/repo segment: letters, digits, '.', '_' and '-'. Bare '.'/'..' are rejected so the
// value can never escape REPOS_BASE_DIR or steer the remote URL off github.com/<owner>/<repo>.
function assertSafeSegment(label, val) {
  if (val === '.' || val === '..' || !/^[A-Za-z0-9._-]+$/.test(val)) {
    throw new UsageError(
      `invalid ${label} '${val}' — only letters, digits, '.', '_' and '-' are allowed`);
  }
}

// Resolve + validate every init input from parsed flags + env into a plan: the GitHub owner/repo,
// the REPOS_BASE_DIR, the destination checkout dir, and the clean (tokenless) remote URL. Throws
// UsageError on a malformed owner/repo so the CLI reports it before any network/git side effect.
export function resolveInitInputs(flags = {}) {
  const owner = resolveOwner(flags.owner);
  const repo = resolveRepo(flags.repo);
  assertSafeSegment('owner', owner);
  assertSafeSegment('repo', repo);
  const reposBase = resolveReposBase();
  const dest = join(reposBase, repo);
  const remoteUrl = `https://${GITHUB_HOST}/${owner}/${repo}.git`;
  return { owner, repo, reposBase, dest, remoteUrl };
}

// Default git runner — shells out to the real `git` binary, streaming its progress straight through
// (git writes clone progress to stderr, so stdout stays clean for the CLI's --json path). Tests
// inject their own `runGit` to capture argv/env without invoking git.
function defaultRunGit(args, { env } = {}) {
  return spawnSync('git', args, { stdio: 'inherit', env });
}

// Clone `remoteUrl` into `dest`, authenticating with `token` via git's ENVIRONMENT-based config
// (GIT_CONFIG_COUNT/KEY/VALUE, git >= 2.31) rather than the URL or argv. The credential is supplied
// as a scoped `http.https://github.com/.extraheader` Basic header (`x-access-token:<token>`); because
// it's command-scoped env config it is NOT written to the cloned repo's `.git/config`, so `origin`
// is left as the clean, tokenless URL — and it never appears in `ps`/argv. GIT_TERMINAL_PROMPT=0
// makes a bad/missing token fail fast instead of hanging on an interactive prompt. The token is a
// credential — neither it nor the derived header is ever logged.
export function gitClone({ remoteUrl, token, dest }, { runGit = defaultRunGit, log } = {}) {
  if (!token || typeof token !== 'string') {
    throw new PolarisError('cannot clone — no GitHub token resolved');
  }
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${GITHUB_HOST}/.extraheader`,
    GIT_CONFIG_VALUE_0: header,
  };
  log?.info(`cloning ${remoteUrl} → ${dest} …`);
  const r = runGit(['clone', remoteUrl, dest], { env });
  if (r.error) throw new PolarisError(`could not run git: ${r.error.message}`);
  if (r.status !== 0) {
    throw new PolarisError(
      `git clone failed (exit ${r.status}) for ${remoteUrl} — ` +
      `check the repo exists and the GitHub token grants it access`);
  }
}

// init subcommand: resolve inputs, refuse to clobber an existing checkout, resolve the per-remote
// GitHub token (the same call `remote.mjs github-token` makes), and clone the Client Repository.
// `getToken`/`runGit` are injected by tests; the defaults reuse the hub client + the real git binary.
// Returns a summary for the caller to print (the URL is the clean tokenless one — safe to echo).
export async function runInit(flags = {}, { log, getToken = fetchGithubToken, runGit } = {}) {
  const inputs = resolveInitInputs(flags);
  mkdirSync(inputs.reposBase, { recursive: true });

  // Always refuse if the destination already exists (no --force): a re-clone would discard local
  // edits to the user/ package not yet synced/committed. Checked BEFORE the token call so an existing
  // checkout fails fast without a network round-trip.
  if (existsSync(inputs.dest)) {
    throw new PolarisError(
      `destination already exists — ${inputs.dest}.\n` +
      `  polaris init never overwrites an existing checkout; remove it manually to re-clone.`);
  }

  // Resolve the GitHub token exactly as `remote.mjs github-token` does (per-remote token minted by
  // the hub, read via the registered identity). A missing identity / 404 surfaces as a RemoteError,
  // which the CLI maps to a clear failure — the satellite must be registered with the hub first.
  const { token } = await getToken({}, { log });

  gitClone({ remoteUrl: inputs.remoteUrl, token, dest: inputs.dest }, { runGit, log });

  return { owner: inputs.owner, repo: inputs.repo, dir: inputs.dest, url: inputs.remoteUrl };
}
