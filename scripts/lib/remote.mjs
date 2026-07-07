// remote.mjs — the Ai1 Platform Hub client used by the `remote.mjs` CLI. The satellite's side of
// the hub contract: it registers the satellite as a *remote*, and (in later subcommands) will poll
// config, report state, and pull management instructions. DB-free and network-only — the hub is
// reached over HTTPS with Node's built-in `fetch` (no runtime deps), and the resulting identity is
// persisted to ${REMOTE_BASE_DIR}/id.json.
//
// Registration (`POST /remote/register`, see ai1-platform-hub apps/api): a satellite presents a
// shared *bootstrap token* plus the `remote_id` it claims and receives a per-remote *token* in
// return — `<remote_id>.<secret>`, surfaced exactly once. That token is the credential for every
// later authenticated call, so it is the one thing id.json must not lose; we therefore refuse to
// overwrite an existing id.json unless --force is given (the hub also 409s a re-register).
import { writeFileSync, renameSync, existsSync, readFileSync, mkdirSync, rmSync, createWriteStream } from 'fs';
import { join, basename } from 'path';
import { homedir, hostname, tmpdir } from 'os';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { spawnSync } from 'child_process';
import { createHash } from 'node:crypto';
import { UsageError } from './flags.mjs';
import { readInstallState } from './install-log.mjs';

// Raised on any registration failure that isn't a usage error (network, hub rejection, bad
// response). The CLI maps it to a non-usage failure exit (1).
export class RemoteError extends Error {
  constructor(message) { super(message); this.name = 'RemoteError'; }
}

// REMOTE_BASE_DIR = the dir holding the satellite's hub identity (id.json) and, later, cached
// config/state. Defaults to ~/remote; for development export REMOTE_BASE_DIR=$(pwd).
export function resolveRemoteBase() {
  return process.env.REMOTE_BASE_DIR || join(homedir(), 'remote');
}

export function idPath(base = resolveRemoteBase()) {
  return join(base, 'id.json');
}

export function configPath(base = resolveRemoteBase()) {
  return join(base, 'config.json');
}

// Sidecar to config.json: poll bookkeeping the satellite doesn't consume but the next poll needs —
// chiefly the config_version that drives the conditional (If-None-Match) request. Kept out of
// config.json so that file stays exactly the opaque payload the hub served.
export function statePath(base = resolveRemoteBase()) {
  return join(base, 'state.json');
}

// Where heartbeat caches the advisory actions the hub returns in its state-report response. Acting
// on them is out of scope here (a later subcommand/consumer does that); remote.mjs only records the
// array, wrapped with the time it was fetched.
export function actionsPath(base = resolveRemoteBase()) {
  return join(base, 'actions.json');
}

// PACKAGE_BASE_DIR = where get-package extracts a downloaded package, into a `<name>@<version>`
// subdir ready for `install.mjs <dir>`. Defaults to ~/packages (the same root install.json lives in).
export function resolvePackageBase() {
  return process.env.PACKAGE_BASE_DIR || join(homedir(), 'packages');
}

// DOWNLOAD_BASE_DIR = where get-package saves the raw archive before extracting it. Defaults to the
// system temp dir; the archive is deleted after a successful extract unless --keep-download is set.
export function resolveDownloadBase() {
  return process.env.DOWNLOAD_BASE_DIR || tmpdir();
}

// remote_id: explicit flag wins, else the SATELLITE_ID convention (D-27/D-37)
// (SATELLITE_ID env, else hostname minus its conventional `crhq-` prefix).
export function resolveRemoteId(flag) {
  return flag || process.env.SATELLITE_ID || hostname().replace(/^crhq-/, '');
}

// First non-empty of the candidates (flag, then the env fallbacks). Used for hub URL and bootstrap
// token, both of which accept a flag and fall back to env.
function firstNonEmpty(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return null;
}

// Normalize a hub base URL to an absolute origin with no trailing slash, so endpoint paths can be
// appended cleanly. Remote hubs must use https; cleartext http is allowed only for localhost dev
// stubs (127.0.0.1 / localhost).
export function normalizeHubUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`invalid hub URL: ${raw}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new UsageError(`hub URL must be http(s): ${raw}`);
  }
  const host = u.hostname;
  const isLocalDev = host === 'localhost' || host === '127.0.0.1';
  if (u.protocol === 'http:' && !isLocalDev) {
    throw new UsageError(
      `hub URL must use https (cleartext http is allowed only for localhost): ${raw}`);
  }
  return u.toString().replace(/\/+$/, '');
}

// Resolve all register inputs from parsed flags + env into a validated plan. Throws UsageError on a
// missing required input so the CLI reports it as a usage error before any network call.
export function resolveRegisterInputs(flags) {
  const hub = firstNonEmpty(flags.hub, process.env.AI1_HUB_URL, process.env.HUB_URL);
  if (!hub) {
    throw new UsageError('hub URL required — pass --hub=<url> or set AI1_HUB_URL');
  }
  const bootstrapToken = firstNonEmpty(
    flags.bootstrapToken, process.env.AI1_BOOTSTRAP_TOKEN, process.env.BOOTSTRAP_TOKEN);
  if (!bootstrapToken) {
    throw new UsageError(
      'bootstrap token required — pass --token=<token> or set AI1_BOOTSTRAP_TOKEN');
  }
  const remoteId = resolveRemoteId(flags.remoteId);
  if (!remoteId) {
    throw new UsageError('remote_id required — pass --remote-id=<id> or set SATELLITE_ID');
  }
  const schemaVersion = flags.schemaVersion == null ? 1 : flags.schemaVersion;
  return {
    hubUrl: normalizeHubUrl(hub),
    bootstrapToken,
    remoteId,
    remoteType: flags.remoteType || 'crhq-satellite',
    schemaVersion,
  };
}

// POST the registration to the hub and return the parsed RegisterResponse {remote_id, status,
// token}. Translates transport failures and the hub's error envelope into RemoteError with a
// message keyed to the failure mode (bad bootstrap token, already-registered conflict, etc.).
async function postRegister(inputs) {
  const url = `${inputs.hubUrl}/remote/register`;
  const body = {
    remote_id: inputs.remoteId,
    bootstrap_token: inputs.bootstrapToken,
    remote_type: inputs.remoteType,
    schema_version: inputs.schemaVersion,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new RemoteError(`could not reach hub at ${url}: ${e.message}`);
  }

  // Body may be the success shape or the {error:{code,message}} envelope; tolerate non-JSON.
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON body — handled below */ } }

  if (res.status === 201) {
    if (!data || typeof data.token !== 'string' || typeof data.remote_id !== 'string') {
      throw new RemoteError('hub returned 201 but an unrecognized registration body');
    }
    return data;
  }

  // Non-2xx: surface the hub's machine code + message when present, with a hint for the common
  // failure modes a registering operator hits.
  const code = data?.error?.code;
  const message = data?.error?.message || text || `HTTP ${res.status}`;
  if (res.status === 401) {
    throw new RemoteError(`hub rejected the bootstrap token (401): ${message}`);
  }
  if (res.status === 409) {
    throw new RemoteError(
      `hub says remote '${inputs.remoteId}' cannot register (409): ${message}\n` +
      `  An operator must 'reset' it on the hub before it can re-enroll.`);
  }
  throw new RemoteError(`hub registration failed (${res.status}${code ? ` ${code}` : ''}): ${message}`);
}

// Write id.json atomically (temp + rename) with owner-only perms — it holds the per-remote token.
function writeIdFile(base, record) {
  mkdirSync(base, { recursive: true });
  const dest = idPath(base);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, dest);
  return dest;
}

// register subcommand: resolve inputs, guard against clobbering an existing identity, POST to the
// hub, and persist the result to id.json. `now` is injected by the CLI so the timestamp is
// deterministic in tests. Returns a summary for the caller to print.
export async function registerRemote(flags, { now = new Date(), log } = {}) {
  const inputs = resolveRegisterInputs(flags);
  const base = resolveRemoteBase();
  const dest = idPath(base);

  if (existsSync(dest) && !flags.force) {
    let existingId = null;
    try { existingId = JSON.parse(readFileSync(dest, 'utf8'))?.remote_id; } catch { /* unreadable */ }
    throw new RemoteError(
      `already registered — ${dest} exists${existingId ? ` (remote_id '${existingId}')` : ''}.\n` +
      `  Re-registering would discard the stored token. Pass --force to overwrite.`);
  }

  log?.info(`registering '${inputs.remoteId}' (type=${inputs.remoteType}) with hub ${inputs.hubUrl} …`);
  const result = await postRegister(inputs);

  // id.json stores the durable identity + credential only. The lifecycle `status` is the hub's to
  // own (it changes server-side on approve/reset/revoke), so persisting it here would just go stale;
  // it is surfaced to the operator at registration time but not written.
  const record = {
    remote_id: result.remote_id,
    token: result.token,
    remote_type: inputs.remoteType,
    schema_version: inputs.schemaVersion,
    hub_url: inputs.hubUrl,
    registered_at: now.toISOString(),
  };
  writeIdFile(base, record);

  return { dest, remoteId: record.remote_id, status: result.status, hubUrl: inputs.hubUrl };
}

// Local hub-client files under REMOTE_BASE_DIR (install.json in PACKAGES_DIR is untouched).
function remoteLocalFiles(base) {
  return [
    { key: 'id.json', path: idPath(base) },
    { key: 'config.json', path: configPath(base) },
    { key: 'state.json', path: statePath(base) },
    { key: 'actions.json', path: actionsPath(base) },
  ];
}

// unregister subcommand: local teardown only — remove identity + cached config/state/actions. No hub
// API call; re-enroll via register (hub operator may still need to reset the remote row). Idempotent:
// when id.json is absent, exits success as already unregistered; orphan cache files are still removed.
export function unregisterRemote(flags, { log } = {}) {
  const base = resolveRemoteBase();
  const idDest = idPath(base);
  const alreadyUnregistered = !existsSync(idDest);

  let remoteId = null;
  if (!alreadyUnregistered) {
    try { remoteId = JSON.parse(readFileSync(idDest, 'utf8'))?.remote_id ?? null; } catch { /* unreadable */ }
  }

  const toRemove = remoteLocalFiles(base).filter((f) => existsSync(f.path));
  const removed = toRemove.map((f) => f.key);

  if (toRemove.length === 0) {
    return { remoteId, removed, alreadyUnregistered: true, dryRun: !!flags.dryRun };
  }

  if (flags.dryRun) {
    log?.dry(`remove ${removed.join(', ')} from ${base}`);
    return { remoteId, removed, alreadyUnregistered, dryRun: true };
  }

  for (const f of toRemove) rmSync(f.path, { force: true });
  log?.ok?.(`removed ${removed.join(', ')} from ${base}`);
  return { remoteId, removed, alreadyUnregistered, dryRun: false };
}

// --- pull-config: poll the hub for this remote's configuration ---------------------------------
//
// `GET {hub}/remote/config` (see ai1-platform-hub apps/api routes/remote.ts): a per-remote-token
// authenticated poll. The opaque config payload is the body; its monotonic `config_version` rides in
// the `ETag` header, not the body. We write the raw payload to config.json (what the satellite
// consumes) and the version to a state.json sidecar, so the *next* poll can echo the version in
// `If-None-Match` and take a cheap bodyless `304 Not Modified` when nothing changed — the same
// conditional-poll contract the hub's admin edits bump the version through.

// Read the identity `register` persisted (token + hub_url). Both are required to make an
// authenticated poll; a missing/unusable id.json means the satellite never registered.
function readIdentity(base) {
  const dest = idPath(base);
  if (!existsSync(dest)) {
    throw new RemoteError(`not registered — ${dest} not found. Run 'remote.mjs register' first.`);
  }
  let id;
  try { id = JSON.parse(readFileSync(dest, 'utf8')); }
  catch (e) { throw new RemoteError(`cannot read identity ${dest}: ${e.message}`); }
  if (!id || typeof id.token !== 'string' || typeof id.hub_url !== 'string') {
    throw new RemoteError(`identity ${dest} is missing token/hub_url — re-register with --force.`);
  }
  return id;
}

// Read the state.json sidecar as an object (the local bookkeeping pull-config maintains). Returns an
// empty object when the file is absent or unusable, so callers can spread it unconditionally.
function readState(base) {
  const dest = statePath(base);
  if (!existsSync(dest)) return {};
  try {
    const state = JSON.parse(readFileSync(dest, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch { return {}; }
}

// Recover the last fetched config_version from the sidecar (if any), so the poll can be made
// conditional. Returns null when there is no usable sidecar — the poll is then unconditional.
function readCachedVersion(base) {
  const v = readState(base).config_version;
  return Number.isInteger(v) ? v : null;
}

// Parse the integer config_version out of the hub's ETag (a strong validator like `"7"`). Tolerant
// of quoting/weak markers since we own both ends; null if the header is absent or not an integer.
function parseEtagVersion(etag) {
  if (!etag) return null;
  const n = Number(etag.trim().replace(/^W\//, '').replace(/^"|"$/g, ''));
  return Number.isInteger(n) ? n : null;
}

// Write a JSON file atomically (temp + rename) with owner-only perms — the config payload is opaque
// and admin-controlled, so it may carry secrets and gets the same 0600 treatment as id.json; the
// sidecar rides along at the same perms for consistency.
function writeJsonFile(dest, value) {
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, dest);
  return dest;
}

// Persist a freshly fetched config: the raw opaque payload to config.json, and the poll bookkeeping
// (version + fetch time) to the state.json sidecar. Preserve any heartbeat-maintained keys (such as
// install_version) already present in state.json.
function writeConfig(base, { version, config, fetchedAt }) {
  mkdirSync(base, { recursive: true });
  const dest = writeJsonFile(configPath(base), config);
  writeJsonFile(statePath(base), {
    ...readState(base),
    config_version: version,
    config_fetched_at: fetchedAt,
  });
  return dest;
}

// pull-config subcommand: read the stored identity, conditionally poll the hub, and cache a fresh
// config to config.json (leaving it untouched on a 304). `now` is injected by the CLI so the
// fetched_at stamp is deterministic in tests. Returns a summary for the caller to print.
export async function pullRemoteConfig(_flags, { now = new Date(), log } = {}) {
  const base = resolveRemoteBase();
  const id = readIdentity(base);
  const cachedVersion = readCachedVersion(base);
  const url = `${id.hub_url}/remote/config`;

  log?.info(`polling config for '${id.remote_id}' from ${id.hub_url} …`);

  const headers = { accept: 'application/json', authorization: `Bearer ${id.token}` };
  if (cachedVersion != null) headers['if-none-match'] = `"${cachedVersion}"`;

  let res;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    throw new RemoteError(`could not reach hub at ${url}: ${e.message}`);
  }

  const dest = configPath(base);
  const version = parseEtagVersion(res.headers.get('etag'));

  // Unchanged since the last poll: the hub sends a bodyless 304 and we keep the cached record.
  if (res.status === 304) {
    return { changed: false, dest, remoteId: id.remote_id, configVersion: cachedVersion };
  }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON body — handled below */ } }

  if (res.status === 200) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new RemoteError('hub returned 200 but an unrecognized config body');
    }
    writeConfig(base, { version, config: data, fetchedAt: now.toISOString() });
    return { changed: true, dest, remoteId: id.remote_id, configVersion: version };
  }

  // Non-2xx/3xx: surface the hub's machine code + message, hinting at the common failure modes —
  // 401 (token no longer valid → re-register) and 403 (valid token, remote not yet/no longer active).
  const code = data?.error?.code;
  const message = data?.error?.message || text || `HTTP ${res.status}`;
  if (res.status === 401) {
    throw new RemoteError(
      `hub rejected the remote token (401): ${message}\n` +
      `  Re-register with --force to mint a new token.`);
  }
  if (res.status === 403) {
    throw new RemoteError(`hub will not serve config yet (403): ${message}`);
  }
  throw new RemoteError(`hub config poll failed (${res.status}${code ? ` ${code}` : ''}): ${message}`);
}

// --- heartbeat: report this remote's state to the hub -----------------------------------------
//
// `PUT {hub}/remote/state` (see ai1-platform-hub apps/api routes/remote.ts): a per-remote-token
// authenticated full-replace report. The body is the opaque state object; the hub stamps it with a
// server `reported_at` and echoes that back, along with an `actions` array — advisory instructions
// the hub wants the remote to perform. The report is the local state.json sidecar (the
// config_version / config_fetched_at pull-config maintains) plus the install log's install_version /
// install_changed_at. The payload must not carry server-managed keys (the hub 400s those); none of
//
// remote.mjs's sole responsibility for the actions is to record them: on success it writes the array
// to actions.json (wrapped with `actions_fetched_at`). *Acting* on them is out of scope here — a
// later consumer reads actions.json and performs/clears them.

function installStateSummary() {
  const state = readInstallState();
  return {
    install_version: state.install_version,
    install_changed_at: state.install_changed_at,
  };
}

function refreshHeartbeatState(base) {
  const state = {
    ...readState(base),
    ...installStateSummary(),
  };
  writeJsonFile(statePath(base), state);
  return state;
}

export async function reportRemoteState(_flags, { now = new Date(), log } = {}) {
  const base = resolveRemoteBase();
  const id = readIdentity(base);
  const url = `${id.hub_url}/remote/state`;
  const state = refreshHeartbeatState(base);

  log?.info(`reporting state for '${id.remote_id}' to ${id.hub_url} …`);

  let res;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${id.token}`,
      },
      body: JSON.stringify(state),
    });
  } catch (e) {
    throw new RemoteError(`could not reach hub at ${url}: ${e.message}`);
  }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON body — handled below */ } }

  if (res.status === 200) {
    if (!data || typeof data.remote_id !== 'string' || typeof data.reported_at !== 'string'
        || !Array.isArray(data.actions)) {
      throw new RemoteError('hub returned 200 but an unrecognized state-report body');
    }
    // Record the advisory actions for a later consumer to act on; remote.mjs does not perform them.
    const dest = writeJsonFile(actionsPath(base), {
      actions: data.actions,
      actions_fetched_at: now.toISOString(),
    });
    return { remoteId: data.remote_id, reportedAt: data.reported_at, actions: data.actions, state, dest };
  }

  // Non-2xx: surface the hub's machine code + message, hinting at the common failure modes — 401
  // (token no longer valid → re-register) and 403 (valid token, remote not yet/no longer active).
  const code = data?.error?.code;
  const message = data?.error?.message || text || `HTTP ${res.status}`;
  if (res.status === 401) {
    throw new RemoteError(
      `hub rejected the remote token (401): ${message}\n` +
      `  Re-register with --force to mint a new token.`);
  }
  if (res.status === 403) {
    throw new RemoteError(`hub will not accept state yet (403): ${message}`);
  }
  throw new RemoteError(`hub state report failed (${res.status}${code ? ` ${code}` : ''}): ${message}`);
}

// --- push-install: send install.json to the hub -----------------------------------------------
//
// `PUT {hub}/remote/install`: authenticated full-replace report of the satellite's install log.
// The payload is the normalized install state read from `${PACKAGES_DIR}/install.json`; absent logs
// report the empty version-0 state, and legacy flat arrays are normalized by readInstallState().

export async function pushRemoteInstall(_flags, { log } = {}) {
  const base = resolveRemoteBase();
  const id = readIdentity(base);
  const install = readInstallState();
  const url = `${id.hub_url}/remote/install`;

  log?.info(`pushing install state for '${id.remote_id}' to ${id.hub_url} …`);

  let res;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${id.token}`,
      },
      body: JSON.stringify(install),
    });
  } catch (e) {
    throw new RemoteError(`could not reach hub at ${url}: ${e.message}`);
  }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON body — handled below */ } }

  if (res.status === 200 || res.status === 202 || res.status === 204) {
    if (text && (!data || typeof data !== 'object' || Array.isArray(data))) {
      throw new RemoteError(`hub returned ${res.status} but an unrecognized install-report body`);
    }
    const acceptedAt = data?.accepted_at || data?.reported_at || null;
    return {
      remoteId: typeof data?.remote_id === 'string' ? data.remote_id : id.remote_id,
      installVersion: install.install_version,
      installChangedAt: install.install_changed_at,
      componentCount: install.installed_components.length,
      acceptedAt,
    };
  }

  const code = data?.error?.code;
  const message = data?.error?.message || text || `HTTP ${res.status}`;
  if (res.status === 401) {
    throw new RemoteError(
      `hub rejected the remote token (401): ${message}\n` +
      `  Re-register with --force to mint a new token.`);
  }
  if (res.status === 403) {
    throw new RemoteError(`hub will not accept install state yet (403): ${message}`);
  }
  throw new RemoteError(`hub install report failed (${res.status}${code ? ` ${code}` : ''}): ${message}`);
}

// --- github-token: resolve the GitHub token this remote should use ----------------------------
//
// `GET {hub}/remote/github-token` (see ai1-platform-hub apps/api routes/remote.ts): a per-remote-token
// authenticated resolver. The raw token *is* the 200 body (text/plain, no JSON wrapping, no trailing
// newline); the response is `no-store` since it carries a live secret. A `404` is a legitimate answer
// — "no token for this remote right now" — not a transient error. Nothing is persisted locally; the
// caller (e.g. `TOKEN=$(remote.mjs github-token)`) consumes the token directly.

export async function fetchGithubToken(_flags, { log } = {}) {
  const base = resolveRemoteBase();
  const id = readIdentity(base);
  const url = `${id.hub_url}/remote/github-token`;

  log?.info(`resolving github token for '${id.remote_id}' from ${id.hub_url} …`);

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/plain', authorization: `Bearer ${id.token}` },
    });
  } catch (e) {
    throw new RemoteError(`could not reach hub at ${url}: ${e.message}`);
  }

  const text = await res.text();

  if (res.status === 200) {
    // The raw body is the token verbatim — don't reshape it, only guard against an empty 200.
    if (text.trim() === '') {
      throw new RemoteError('hub returned 200 but an empty github token');
    }
    return { token: text };
  }

  // Non-2xx: the body is the JSON error envelope. 404 is the expected "no token available" answer.
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON body — handled below */ } }
  const code = data?.error?.code;
  const message = data?.error?.message || text || `HTTP ${res.status}`;
  if (res.status === 401) {
    throw new RemoteError(
      `hub rejected the remote token (401): ${message}\n` +
      `  Re-register with --force to mint a new token.`);
  }
  if (res.status === 403) {
    throw new RemoteError(`hub will not serve a github token yet (403): ${message}`);
  }
  if (res.status === 404) {
    throw new RemoteError(`no github token available for this remote (404): ${message}`);
  }
  throw new RemoteError(`hub github-token request failed (${res.status}${code ? ` ${code}` : ''}): ${message}`);
}

// --- get-package: resolve, download, and extract a registered package -------------------------
//
// `GET {hub}/remote/package?name=<n>&version=<v>&format=json` (see ai1-platform-hub apps/api
// routes/remote.ts): a per-remote-token authenticated resolver. With `format=json` the hub returns
// `{ url, expires_at }` and may include an optional `digest` — lowercase sha256 hex of the archive
// bytes. When present, get-package verifies the downloaded file before extract. A short-lived,
// pre-signed GCS GET URL carries its own auth in its query string (the default response is a 302
// to that URL; we ask for JSON so we own the download). The hub
// signs *blindly* off the registration, so a returned `url` whose object is missing surfaces as a GCS
// 404 at download time, not here. A `404` from the hub is the legitimate "(name, version) isn't
// registered" answer; 401/403 mirror the other subcommands.
//
// Default behavior: fetch the signed URL, stream the archive to DOWNLOAD_BASE_DIR, extract it into
// PACKAGE_BASE_DIR/<name>@<version> (overwrite-in-place via stage→swap), then delete
// the archive — unless --keep-download is given. The extracted dir is a ready `install.mjs <dir>` input.

// Resolve + validate the get-package inputs (the CLI already validates, but mirror register and keep
// the library defensive so a missing/blank input is a usage error, not a malformed request).
export function resolveGetPackageInputs(flags) {
  const name = firstNonEmpty(flags.name);
  if (!name) throw new UsageError('package name required — pass --name=<name>');
  if (flags.version == null) throw new UsageError('package version required — pass --version=<n>');
  if (!Number.isInteger(flags.version) || flags.version < 1) {
    throw new UsageError('option --version requires a positive integer (>= 1)');
  }
  return { name, version: flags.version };
}

// Map an archive filename to its canonical extension + extractor kind. The hub serves gzipped
// tarballs; a plain .zip is also accepted. Anything else is unsupported (null) — we won't guess.
function archiveKind(name) {
  if (/\.tar\.gz$/i.test(name)) return { ext: '.tar.gz', kind: 'tar' };
  if (/\.tgz$/i.test(name)) return { ext: '.tgz', kind: 'tar' };
  if (/\.zip$/i.test(name)) return { ext: '.zip', kind: 'zip' };
  return null;
}

// Stream the signed URL's bytes to `dest` (owner-only perms — a package may carry secrets). The URL
// is fetched with NO Authorization header: it is cross-host (GCS) and self-authenticating via its
// query string; sending the per-remote token there would leak it.
async function downloadArchive(url, dest) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new RemoteError(`could not download package from the signed URL: ${e.message}`);
  }
  if (res.status !== 200 || !res.body) {
    throw new RemoteError(`signed URL download failed (HTTP ${res.status})`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest, { mode: 0o600 }));
}

// Reject archive member paths that could escape the destination (path traversal, absolute paths,
// Windows drive prefixes). Applied to tar/zip listings before extract.
export function isUnsafeArchiveMember(member) {
  if (!member || member.trim() === '') return true;
  const m = member.replace(/\\/g, '/');
  if (m.startsWith('/') || /^[A-Za-z]:\//.test(m)) return true;
  for (const part of m.split('/')) {
    if (part === '..') return true;
  }
  return false;
}

export function validateArchiveMembers(members) {
  for (const member of members) {
    if (isUnsafeArchiveMember(member)) {
      throw new RemoteError(`unsafe archive member path rejected: ${member}`);
    }
  }
}

function listTarMembers(file) {
  const r = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
  if (r.error) throw new RemoteError(`could not run tar: ${r.error.message}`);
  if (r.status !== 0) {
    throw new RemoteError(`could not list archive members (tar exit ${r.status})`);
  }
  return r.stdout.split('\n').map((l) => l.replace(/\/$/, '')).filter(Boolean);
}

function listZipMembers(file) {
  let r = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' });
  if (!r.error && r.status === 0) return r.stdout.split('\n').filter(Boolean);
  r = spawnSync('unzip', ['-l', file], { encoding: 'utf8' });
  if (r.error) throw new RemoteError(`could not run unzip: ${r.error.message}`);
  if (r.status !== 0) {
    throw new RemoteError(`could not list archive members (unzip exit ${r.status})`);
  }
  const members = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*\d+\s+\d{2,4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
    if (m) members.push(m[1].trim());
  }
  return members;
}

function tarSupportsNoAbsoluteNames() {
  const r = spawnSync('tar', ['--no-absolute-names', '--version'], { encoding: 'utf8', stdio: 'pipe' });
  return !r.error && r.status === 0;
}

function sha256File(path) {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

// Extract `file` into `dest` by shelling out to the platform archiver (tar/unzip), the same
// shell-out approach service.mjs uses for builds. Member paths are listed and validated first;
// GNU tar gets --no-absolute-names when available. Throws RemoteError on unsafe paths, a missing
// tool, or non-zero exit.
export function extractArchive(kind, file, dest) {
  const members = kind === 'tar' ? listTarMembers(file) : listZipMembers(file);
  validateArchiveMembers(members);
  const [cmd, args] = kind === 'tar'
    ? ['tar', [
        ...(tarSupportsNoAbsoluteNames() ? ['--no-absolute-names'] : []),
        '-xzf', file, '-C', dest,
      ]]
    : ['unzip', ['-q', '-o', file, '-d', dest]];
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error) throw new RemoteError(`could not run ${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new RemoteError(`extracting ${basename(file)} failed (${cmd} exit ${r.status})`);
}

// --- complete-action: report a queued action's outcome back to the hub -----------------------
//
// `POST {hub}/remote/actions/{key}` (see ai1-platform-hub apps/api routes/remote.ts): a
// per-remote-token authenticated partial-merge patch on the caller's own action. `status` is the
// only required and interpreted field; everything else is flat verbatim outcome passenger data
// (e.g. `error_message`, `error_at`, `attempts`). Last-writer-wins / idempotent: re-POSTing an
// already-terminal action simply lands the same patch again.
//
// The hub echoes back `{ key, status }` on success (200). A `404` means the `key` doesn't exist
// under *this* remote (unknown or foreign). 401/403 mirror the other subcommands.

export async function completeRemoteAction(key, body, { log } = {}) {
  const base = resolveRemoteBase();
  const id = readIdentity(base);
  const url = `${id.hub_url}/remote/actions/${encodeURIComponent(key)}`;

  log?.info(`completing action '${key}' for '${id.remote_id}' (status=${body.status}) …`);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${id.token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new RemoteError(`could not reach hub at ${url}: ${e.message}`);
  }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON body — handled below */ } }

  if (res.status === 200) {
    if (!data || typeof data.key !== 'string' || typeof data.status !== 'string') {
      throw new RemoteError('hub returned 200 but an unrecognized action-completion body');
    }
    return { key: data.key, status: data.status };
  }

  const code = data?.error?.code;
  const message = data?.error?.message || text || `HTTP ${res.status}`;
  if (res.status === 401) {
    throw new RemoteError(
      `hub rejected the remote token (401): ${message}\n` +
      `  Re-register with --force to mint a new token.`);
  }
  if (res.status === 403) {
    throw new RemoteError(`hub will not accept action completion yet (403): ${message}`);
  }
  if (res.status === 404) {
    throw new RemoteError(`action '${key}' not found on the hub (404): ${message}`);
  }
  throw new RemoteError(`hub action-completion failed (${res.status}${code ? ` ${code}` : ''}): ${message}`);
}

export async function fetchRemotePackage(flags, { log } = {}) {
  const inputs = resolveGetPackageInputs(flags);
  const base = resolveRemoteBase();
  const id = readIdentity(base);

  // 1. Resolve the signed URL from the hub (format=json so we drive the download ourselves).
  const query = new URLSearchParams({ name: inputs.name, version: String(inputs.version), format: 'json' });
  const url = `${id.hub_url}/remote/package?${query}`;
  log?.info(`resolving package '${inputs.name}@${inputs.version}' for '${id.remote_id}' from ${id.hub_url} …`);

  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${id.token}` } });
  } catch (e) {
    throw new RemoteError(`could not reach hub at ${url}: ${e.message}`);
  }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { /* non-JSON body — handled below */ } }

  if (res.status !== 200) {
    // Non-2xx: surface the hub's machine code + message. 401 (token invalid → re-register), 403
    // (valid token, remote not active), 404 (no such (name, version) — a legitimate answer).
    const code = data?.error?.code;
    const message = data?.error?.message || text || `HTTP ${res.status}`;
    if (res.status === 401) {
      throw new RemoteError(
        `hub rejected the remote token (401): ${message}\n` +
        `  Re-register with --force to mint a new token.`);
    }
    if (res.status === 403) {
      throw new RemoteError(`hub will not serve packages yet (403): ${message}`);
    }
    if (res.status === 404) {
      throw new RemoteError(`package '${inputs.name}@${inputs.version}' is not registered (404): ${message}`);
    }
    throw new RemoteError(`hub package request failed (${res.status}${code ? ` ${code}` : ''}): ${message}`);
  }
  if (!data || typeof data.url !== 'string') {
    throw new RemoteError('hub returned 200 but an unrecognized package body');
  }
  const signedUrl = data.url;
  const expiresAt = typeof data.expires_at === 'string' ? data.expires_at : null;
  const expectedDigest = typeof data.digest === 'string' && /^[a-f0-9]{64}$/i.test(data.digest.trim())
    ? data.digest.trim().toLowerCase()
    : null;

  // 2. Decide the archive format from the object name baked into the signed URL's path.
  const objectName = basename(new URL(signedUrl).pathname);
  const archive = archiveKind(objectName);
  if (!archive) {
    throw new RemoteError(`unsupported package archive '${objectName}' (expected .tar.gz, .tgz, or .zip)`);
  }

  // 3. Download the archive to DOWNLOAD_BASE_DIR.
  const downloadBase = resolveDownloadBase();
  mkdirSync(downloadBase, { recursive: true });
  const downloadPath = join(downloadBase, `${inputs.name}@${inputs.version}${archive.ext}`);
  log?.info(`downloading archive → ${downloadPath} …`);
  await downloadArchive(signedUrl, downloadPath);

  if (expectedDigest) {
    const actual = sha256File(downloadPath);
    if (actual !== expectedDigest) {
      throw new RemoteError(
        `package digest mismatch — expected sha256 ${expectedDigest}, got ${actual}`);
    }
    log?.info('package digest verified (sha256)');
  } else {
    log?.info('hub did not provide a package digest — skipping integrity check');
  }

  // 4. Extract into PACKAGE_BASE_DIR/<name>@<version>, overwrite-in-place via stage→swap so a failed
  //    extract never leaves a half-written package where install.mjs would pick it up.
  const packageBase = resolvePackageBase();
  mkdirSync(packageBase, { recursive: true });
  const slug = `${inputs.name}@${inputs.version}`;
  const finalDir = join(packageBase, slug);
  const stageDir = join(packageBase, `.${slug}.stage-${process.pid}`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  try {
    extractArchive(archive.kind, downloadPath, stageDir);
  } catch (e) {
    // Leave the download in place on failure (for inspection/retry); just clear the partial stage.
    rmSync(stageDir, { recursive: true, force: true });
    throw e;
  }
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(stageDir, finalDir);
  log?.ok(`extracted '${slug}' → ${finalDir}`);

  // 5. Delete the download unless --keep-download.
  if (flags.keepDownload) {
    log?.info(`keeping archive at ${downloadPath}`);
  } else {
    rmSync(downloadPath, { force: true });
  }

  return {
    name: inputs.name,
    version: inputs.version,
    packageDir: finalDir,
    download: flags.keepDownload ? downloadPath : null,
    keptDownload: Boolean(flags.keepDownload),
    expiresAt,
  };
}
