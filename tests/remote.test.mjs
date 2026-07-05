#!/usr/bin/env node
// remote.mjs — the satellite's hub client (register subcommand). DB-free: it talks to the Ai1
// Platform Hub over HTTP and writes ${REMOTE_BASE_DIR}/id.json, so this suite needs no sandbox —
// it stands up a stub HTTP hub mimicking the POST /remote/register contract (201 + token, plus the
// 401/409 error envelopes) and points REMOTE_BASE_DIR at a temp dir. Run from the project root:
//   node tests/remote.test.mjs
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));

// Stub hub in a SEPARATE process: the client runs under spawnSync, which blocks this process's
// event loop, so an in-process HTTP server could never answer the child's request (deadlock). The
// stub replicates the register contract enough to exercise the success + error paths: bootstrap
// 'good-secret' (else 401); remote_id 'taken' is a 409; else 201 + a minted token.
// The GET /remote/config half mirrors apps/api routes/remote.ts enough to exercise the client's
// success / conditional / auth paths: Bearer '<id>.SECRETvalue' is valid; remote_id 'sat-403' is a
// valid token on a not-yet-active remote (403); config is version 5 with an ETag, and an
// If-None-Match of '5' takes a bodyless 304.
// A real package tarball the stub serves on /blob/<obj>: a dir holding an ai1-package.yaml, gzipped.
// get-package downloads this, extracts it to PACKAGE_BASE_DIR/<name>@<version>, and (by default)
// deletes the archive.
const pkgSrc = mkdtempSync(join(tmpdir(), 'remote-pkgsrc-'));
writeFileSync(join(pkgSrc, 'ai1-package.yaml'), 'name: widget\nversion: 3\n');
const tarball = join(mkdtempSync(join(tmpdir(), 'remote-tar-')), 'widget.tar.gz');
const tarRes = spawnSync('tar', ['-czf', tarball, '-C', pkgSrc, '.']);
if (tarRes.status !== 0) throw new Error(`failed to build test tarball: ${tarRes.stderr}`);

const HUB_SRC = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const TARBALL = ${JSON.stringify(tarball)};
const CONFIG = { poll_interval_seconds: 60, greeting: 'hello' };
const CONFIG_VERSION = 5;
const hub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && req.url === '/remote/register') {
      const b = JSON.parse(body || '{}');
      if (b.bootstrap_token !== 'good-secret') return json(401, { error: { code: 'unauthorized', message: 'Invalid bootstrap token' } });
      if (b.remote_id === 'taken') return json(409, { error: { code: 'conflict', message: \`Remote '\${b.remote_id}' cannot register from status 'active'\` } });
      return json(201, { remote_id: b.remote_id, status: 'registered', token: \`\${b.remote_id}.SECRETvalue\` });
    }
    const bearer = () => {
      const m = (req.headers['authorization'] || '').match(/^Bearer (.+)$/);
      return m ? m[1] : null;
    };
    if (req.method === 'GET' && req.url === '/remote/config') {
      const token = bearer();
      if (!token) return json(401, { error: { code: 'unauthorized', message: 'Missing or malformed remote token' } });
      if (token === 'sat-403.SECRETvalue') return json(403, { error: { code: 'forbidden', message: 'Remote is awaiting operator approval; keep polling' } });
      if (!token.endsWith('.SECRETvalue')) return json(401, { error: { code: 'unauthorized', message: 'Invalid remote token' } });
      const inm = (req.headers['if-none-match'] || '').replace(/^W\\//, '').replace(/^"|"$/g, '');
      res.setHeader('etag', \`"\${CONFIG_VERSION}"\`);
      if (inm === String(CONFIG_VERSION)) { res.writeHead(304); return res.end(); }
      return json(200, CONFIG);
    }
    if (req.method === 'GET' && req.url === '/remote/github-token') {
      const token = bearer();
      if (!token) return json(401, { error: { code: 'unauthorized', message: 'Missing or malformed remote token' } });
      if (token === 'sat-403.SECRETvalue') return json(403, { error: { code: 'forbidden', message: 'Remote is awaiting operator approval; keep polling' } });
      if (!token.endsWith('.SECRETvalue')) return json(401, { error: { code: 'unauthorized', message: 'Invalid remote token' } });
      const remoteId = token.slice(0, token.lastIndexOf('.'));
      if (remoteId === 'no-gh') return json(404, { error: { code: 'not_found', message: 'No GitHub token is available for this remote' } });
      // The raw token IS the body — text/plain, no JSON, no trailing newline.
      res.setHeader('cache-control', 'no-store');
      res.writeHead(200, { 'content-type': 'text/plain; charset=UTF-8' });
      return res.end(\`ghp_\${remoteId}\`);
    }
    if (req.method === 'PUT' && req.url === '/remote/state') {
      const token = bearer();
      if (!token) return json(401, { error: { code: 'unauthorized', message: 'Missing or malformed remote token' } });
      if (token === 'sat-403.SECRETvalue') return json(403, { error: { code: 'forbidden', message: 'Remote is awaiting operator approval; keep polling' } });
      if (!token.endsWith('.SECRETvalue')) return json(401, { error: { code: 'unauthorized', message: 'Invalid remote token' } });
      const b = JSON.parse(body || '{}');
      // Reflect the contract enough to test the client: state must be an object with no reserved keys.
      if (typeof b !== 'object' || b === null || Array.isArray(b) || 'status' in b) return json(400, { error: { code: 'bad_request', message: 'invalid state' } });
      const remoteId = token.slice(0, token.lastIndexOf('.'));
      // The response carries advisory actions (always present, possibly empty). 'no-actions' reports
      // an empty array; everyone else gets a single pull-config action.
      const actions = remoteId === 'no-actions' ? [] : [{ type: 'pull-config', config_version: 9 }];
      return json(200, { remote_id: remoteId, reported_at: '2026-06-14T00:00:00.000Z', actions });
    }
    if (req.method === 'PUT' && req.url === '/remote/install') {
      const token = bearer();
      if (!token) return json(401, { error: { code: 'unauthorized', message: 'Missing or malformed remote token' } });
      if (token === 'sat-403.SECRETvalue') return json(403, { error: { code: 'forbidden', message: 'Remote is awaiting operator approval; keep polling' } });
      if (!token.endsWith('.SECRETvalue')) return json(401, { error: { code: 'unauthorized', message: 'Invalid remote token' } });
      const b = JSON.parse(body || '{}');
      if (typeof b !== 'object' || b === null || Array.isArray(b)
          || !Number.isInteger(b.install_version) || !Array.isArray(b.installed_components)) {
        return json(400, { error: { code: 'bad_request', message: 'invalid install state' } });
      }
      const remoteId = token.slice(0, token.lastIndexOf('.'));
      return json(200, {
        remote_id: remoteId,
        accepted_at: '2026-06-14T00:01:00.000Z',
        install_version: b.install_version,
        component_count: b.installed_components.length,
      });
    }
    // get-package: resolve a signed download URL. format=json → { url, expires_at }; auth mirrors the
    // other routes. 'widget' v3 is the only registered package; anything else is a 404.
    if (req.method === 'GET' && req.url.startsWith('/remote/package')) {
      const token = bearer();
      if (!token) return json(401, { error: { code: 'unauthorized', message: 'Missing or malformed remote token' } });
      if (token === 'sat-403.SECRETvalue') return json(403, { error: { code: 'forbidden', message: 'Remote is awaiting operator approval; keep polling' } });
      if (!token.endsWith('.SECRETvalue')) return json(401, { error: { code: 'unauthorized', message: 'Invalid remote token' } });
      const u = new URL(req.url, \`http://\${req.headers.host}\`);
      const name = u.searchParams.get('name');
      const version = u.searchParams.get('version');
      if (name !== 'widget' || version !== '3') return json(404, { error: { code: 'not_found', message: \`Package '\${name}@\${version}' is not registered\` } });
      res.setHeader('cache-control', 'no-store');
      // The signed URL points back at the stub's own /blob route — the basename carries the .tar.gz ext.
      return json(200, { url: \`http://\${req.headers.host}/blob/widget.tar.gz\`, expires_at: '2026-06-15T12:15:00.000Z' });
    }
    if (req.method === 'GET' && req.url === '/blob/widget.tar.gz') {
      // Stand in for GCS: serve the package archive bytes with no auth (the real signed URL self-auths).
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return res.end(readFileSync(TARBALL));
    }
    return json(404, { error: { code: 'not_found', message: 'no' } });
  });
});
hub.listen(0, () => process.stdout.write('PORT=' + hub.address().port + '\\n'));
`;
const hubFile = join(mkdtempSync(join(tmpdir(), 'remote-hub-')), 'hub.mjs');
writeFileSync(hubFile, HUB_SRC);
const hubProc = spawn(process.execPath, [hubFile], { stdio: ['ignore', 'pipe', 'inherit'] });
const HUB = await new Promise((resolve, reject) => {
  let buf = '';
  hubProc.stdout.on('data', (c) => {
    buf += c;
    const m = buf.match(/PORT=(\d+)/);
    if (m) resolve(`http://127.0.0.1:${m[1]}`);
  });
  hubProc.on('error', reject);
  hubProc.on('exit', (code) => reject(new Error(`stub hub exited early (${code})`)));
});

// Run the register subcommand with an isolated REMOTE_BASE_DIR and a clean env (no ambient
// AI1_HUB_URL / bootstrap / SATELLITE_ID leaking in).
function register(args, { env = {}, base } = {}) {
  const dir = base ?? mkdtempSync(join(tmpdir(), 'remote-'));
  const r = spawnSync(process.execPath, ['scripts/remote.mjs', 'register', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      REMOTE_BASE_DIR: dir,
      ...env,
    },
  });
  return { ...r, dir, out: `${r.stdout}${r.stderr}` };
}
// Run the pull-config subcommand against an isolated REMOTE_BASE_DIR. Like register(), but does not
// default SATELLITE_ID — pull-config reads identity from the dir's id.json, written by a prior register.
function pullConfig(args, { env = {}, base } = {}) {
  const dir = base ?? mkdtempSync(join(tmpdir(), 'remote-'));
  const r = spawnSync(process.execPath, ['scripts/remote.mjs', 'pull-config', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REMOTE_BASE_DIR: dir, ...env },
  });
  return { ...r, dir, out: `${r.stdout}${r.stderr}` };
}
// Run the heartbeat subcommand against an isolated REMOTE_BASE_DIR; like pullConfig(), it reads
// identity from the dir's id.json written by a prior register.
function heartbeat(args, { env = {}, base } = {}) {
  const dir = base ?? mkdtempSync(join(tmpdir(), 'remote-'));
  const packagesDir = env.PACKAGES_DIR || join(dir, 'packages');
  const r = spawnSync(process.execPath, ['scripts/remote.mjs', 'heartbeat', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REMOTE_BASE_DIR: dir, PACKAGES_DIR: packagesDir, ...env },
  });
  return { ...r, dir, out: `${r.stdout}${r.stderr}` };
}
// Run the push-install subcommand against an isolated REMOTE_BASE_DIR. It reads install.json from
// PACKAGES_DIR, defaulting to a path inside the remote temp dir so tests never touch ~/packages.
function pushInstall(args, { env = {}, base } = {}) {
  const dir = base ?? mkdtempSync(join(tmpdir(), 'remote-'));
  const packagesDir = env.PACKAGES_DIR || join(dir, 'packages');
  const r = spawnSync(process.execPath, ['scripts/remote.mjs', 'push-install', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REMOTE_BASE_DIR: dir, PACKAGES_DIR: packagesDir, ...env },
  });
  return { ...r, dir, out: `${r.stdout}${r.stderr}` };
}
// Run the github-token subcommand against an isolated REMOTE_BASE_DIR; reads identity from the dir's
// id.json written by a prior register.
function githubToken(args, { env = {}, base } = {}) {
  const dir = base ?? mkdtempSync(join(tmpdir(), 'remote-'));
  const r = spawnSync(process.execPath, ['scripts/remote.mjs', 'github-token', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REMOTE_BASE_DIR: dir, ...env },
  });
  return { ...r, dir, out: `${r.stdout}${r.stderr}` };
}
// Run the get-package subcommand against an isolated REMOTE_BASE_DIR; reads identity from the dir's
// id.json written by a prior register. Pass PACKAGE_BASE_DIR / DOWNLOAD_BASE_DIR via env.
function getPackage(args, { env = {}, base } = {}) {
  const dir = base ?? mkdtempSync(join(tmpdir(), 'remote-'));
  const r = spawnSync(process.execPath, ['scripts/remote.mjs', 'get-package', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REMOTE_BASE_DIR: dir, ...env },
  });
  return { ...r, dir, out: `${r.stdout}${r.stderr}` };
}
const idFile = (dir) => join(dir, 'id.json');
const configFile = (dir) => join(dir, 'config.json');
const stateFile = (dir) => join(dir, 'state.json');
const actionsFile = (dir) => join(dir, 'actions.json');

console.log('remote.mjs register:');

await test('success writes id.json with token + identity (0600 perms), no status field', () => {
  const r = register([`--hub=${HUB}`, '--token=good-secret'], { env: { SATELLITE_ID: 'demo-sat' } });
  assert.equal(r.status, 0, r.out);
  const id = JSON.parse(readFileSync(idFile(r.dir), 'utf8'));
  assert.equal(id.remote_id, 'demo-sat');
  assert.equal(id.token, 'demo-sat.SECRETvalue');
  assert.equal('status' in id, false, 'lifecycle status is the hub\'s to own — not persisted');
  assert.equal(id.hub_url, HUB);
  assert.equal(id.remote_type, 'crhq-satellite');
  assert.equal(id.schema_version, 1);
  assert.match(id.registered_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(statSync(idFile(r.dir)).mode & 0o777, 0o600);
  // The hub-reported status is still surfaced to the operator on stdout.
  assert.match(r.out, /status 'registered'/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('remote_id/type/schema-version overrides are honored + sent', () => {
  const r = register([`--hub=${HUB}`, '--token=good-secret',
    '--remote-id=custom', '--remote-type=edge', '--schema-version=3']);
  assert.equal(r.status, 0, r.out);
  const id = JSON.parse(readFileSync(idFile(r.dir), 'utf8'));
  assert.equal(id.remote_id, 'custom');
  assert.equal(id.remote_type, 'edge');
  assert.equal(id.schema_version, 3);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('hub URL + bootstrap token fall back to env', () => {
  const r = register([], { env: { AI1_HUB_URL: HUB, AI1_BOOTSTRAP_TOKEN: 'good-secret', SATELLITE_ID: 'envsat' } });
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(readFileSync(idFile(r.dir), 'utf8')).remote_id, 'envsat');
  rmSync(r.dir, { recursive: true, force: true });
});

await test('existing id.json → refuse without --force (exit 1, file untouched)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-'));
  writeFileSync(idFile(dir), JSON.stringify({ remote_id: 'old', token: 'old.keep' }));
  const r = register([`--hub=${HUB}`, '--token=good-secret'], { env: { SATELLITE_ID: 'demo-sat' }, base: dir });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /already registered/);
  assert.equal(JSON.parse(readFileSync(idFile(dir), 'utf8')).token, 'old.keep');
  rmSync(dir, { recursive: true, force: true });
});

await test('--force overwrites an existing id.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-'));
  writeFileSync(idFile(dir), JSON.stringify({ remote_id: 'old', token: 'old.keep' }));
  const r = register([`--hub=${HUB}`, '--token=good-secret', '--force'], { env: { SATELLITE_ID: 'demo-sat' }, base: dir });
  assert.equal(r.status, 0, r.out);
  assert.equal(JSON.parse(readFileSync(idFile(dir), 'utf8')).token, 'demo-sat.SECRETvalue');
  rmSync(dir, { recursive: true, force: true });
});

await test('401 bad bootstrap token → exit 1, no id.json written', () => {
  const r = register([`--hub=${HUB}`, '--token=wrong'], { env: { SATELLITE_ID: 'demo-sat' } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /bootstrap token \(401\)/);
  assert.equal(existsSync(idFile(r.dir)), false);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('409 conflict → exit 1 with reset hint', () => {
  const r = register([`--hub=${HUB}`, '--token=good-secret', '--remote-id=taken']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /cannot register \(409\)/);
  assert.match(r.out, /reset/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('unreachable hub → exit 1 (could not reach)', () => {
  const r = register(['--hub=http://127.0.0.1:1', '--token=good-secret', '--remote-id=x']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /could not reach hub/);
  rmSync(r.dir, { recursive: true, force: true });
});

console.log('remote.mjs pull-config:');

// Register into `dir` (so id.json exists), returning the dir for a subsequent pull-config call.
function registered(remoteId = 'cfg-sat') {
  const dir = mkdtempSync(join(tmpdir(), 'remote-'));
  const r = register([`--hub=${HUB}`, '--token=good-secret', `--remote-id=${remoteId}`], { base: dir });
  assert.equal(r.status, 0, r.out);
  return dir;
}

await test('caches the raw payload to config.json + version to state.json sidecar', () => {
  const dir = registered();
  const r = pullConfig([], { base: dir });
  assert.equal(r.status, 0, r.out);
  // config.json is exactly the opaque payload the hub served — no wrapping record.
  const cfg = JSON.parse(readFileSync(configFile(dir), 'utf8'));
  assert.deepEqual(cfg, { poll_interval_seconds: 60, greeting: 'hello' });
  assert.equal(statSync(configFile(dir)).mode & 0o777, 0o600);
  // The version + fetch time live in the state.json sidecar — just those two keys.
  const state = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  assert.deepEqual(Object.keys(state).sort(), ['config_fetched_at', 'config_version']);
  assert.equal(state.config_version, 5);
  assert.match(state.config_fetched_at, /^\d{4}-\d\d-\d\dT/);
  assert.match(r.out, /updated to version 5/);
  rmSync(dir, { recursive: true, force: true });
});

await test('second poll is conditional → 304, config.json left untouched', () => {
  const dir = registered();
  assert.equal(pullConfig([], { base: dir }).status, 0);
  const before = readFileSync(configFile(dir), 'utf8');
  const r2 = pullConfig([], { base: dir });
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /unchanged \(version 5\)/);
  assert.equal(readFileSync(configFile(dir), 'utf8'), before);
  rmSync(dir, { recursive: true, force: true });
});

await test('--json prints a machine-readable result', () => {
  const dir = registered();
  const r = pullConfig(['--json'], { base: dir });
  assert.equal(r.status, 0, r.out);
  const out = JSON.parse(r.stdout);
  assert.equal(out.changed, true);
  assert.equal(out.configVersion, 5);
  assert.equal(out.remoteId, 'cfg-sat');
  rmSync(dir, { recursive: true, force: true });
});

await test('not registered (no id.json) → exit 1', () => {
  const r = pullConfig([]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not registered/);
  assert.equal(existsSync(configFile(r.dir)), false);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('403 not-yet-active → exit 1, no config.json written', () => {
  const dir = registered('sat-403');
  const r = pullConfig([], { base: dir });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /will not serve config yet \(403\)/);
  assert.equal(existsSync(configFile(dir)), false);
  rmSync(dir, { recursive: true, force: true });
});

await test('pull-config unknown option → exit 2', () => {
  const r = pullConfig(['--nope']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /unknown option: --nope/);
  rmSync(r.dir, { recursive: true, force: true });
});

console.log('remote.mjs heartbeat:');

await test('reports install metadata and echoes the server reported_at', () => {
  const dir = registered('beat-sat');
  const r = heartbeat([], { base: dir });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /state reported for 'beat-sat'/);
  assert.match(r.out, /2026-06-14T00:00:00\.000Z/);
  const state = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  assert.equal(state.install_version, 0);
  assert.equal(state.install_changed_at, null);
  rmSync(dir, { recursive: true, force: true });
});

await test('--json includes the reported_at and state sent', () => {
  const dir = registered('beat-sat');
  const r = heartbeat(['--json'], { base: dir });
  assert.equal(r.status, 0, r.out);
  const out = JSON.parse(r.stdout);
  assert.equal(out.remoteId, 'beat-sat');
  assert.equal(out.reportedAt, '2026-06-14T00:00:00.000Z');
  assert.equal(out.state.install_version, 0);
  assert.equal(out.state.install_changed_at, null);
  assert.equal('local_time' in out.state, false);
  rmSync(dir, { recursive: true, force: true });
});

await test('heartbeat persists and reports install_version/install_changed_at from install.json', () => {
  const dir = registered('beat-sat');
  const packagesDir = mkdtempSync(join(tmpdir(), 'remote-packages-'));
  writeFileSync(join(packagesDir, 'install.json'), JSON.stringify({
    install_version: 7,
    install_changed_at: '2026-06-28T15:00:00.000Z',
    installed_components: [],
  }));

  const r = heartbeat(['--json'], { base: dir, env: { PACKAGES_DIR: packagesDir } });
  assert.equal(r.status, 0, r.out);
  const sent = JSON.parse(r.stdout).state;
  assert.equal(sent.install_version, 7);
  assert.equal(sent.install_changed_at, '2026-06-28T15:00:00.000Z');

  const persisted = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  assert.equal(persisted.install_version, 7);
  assert.equal(persisted.install_changed_at, '2026-06-28T15:00:00.000Z');

  rmSync(packagesDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

await test('writes the returned actions to actions.json wrapped with actions_fetched_at', () => {
  const dir = registered('beat-sat');
  const r = heartbeat([], { base: dir });
  assert.equal(r.status, 0, r.out);
  const wrapped = JSON.parse(readFileSync(actionsFile(dir), 'utf8'));
  assert.deepEqual(Object.keys(wrapped).sort(), ['actions', 'actions_fetched_at']);
  assert.deepEqual(wrapped.actions, [{ type: 'pull-config', config_version: 9 }]);
  assert.match(wrapped.actions_fetched_at, /^\d{4}-\d\d-\d\dT/);
  assert.match(r.out, /1 action written to/);
  assert.equal(statSync(actionsFile(dir)).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true, force: true });
});

await test('an empty actions array is still written (always present)', () => {
  const dir = registered('no-actions');
  const r = heartbeat([], { base: dir });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions, []);
  assert.match(r.out, /0 actions written to/);
  rmSync(dir, { recursive: true, force: true });
});

await test('reports state.json contents + install metadata', () => {
  const dir = registered('beat-sat');
  assert.equal(pullConfig([], { base: dir }).status, 0); // writes state.json (config_version + config_fetched_at)
  const before = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  assert.equal('install_version' in before, false);

  const r = heartbeat(['--json'], { base: dir });
  assert.equal(r.status, 0, r.out);
  const sent = JSON.parse(r.stdout).state;
  assert.equal(sent.config_version, 5);
  assert.match(sent.config_fetched_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(sent.install_version, 0);
  assert.equal(sent.install_changed_at, null);
  assert.equal('local_time' in sent, false);
  const after = JSON.parse(readFileSync(stateFile(dir), 'utf8'));
  assert.equal(after.config_version, 5);
  assert.match(after.config_fetched_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(after.install_version, 0);
  assert.equal(after.install_changed_at, null);
  rmSync(dir, { recursive: true, force: true });
});

await test('not registered (no id.json) → exit 1', () => {
  const r = heartbeat([]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not registered/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('403 not-yet-active → exit 1', () => {
  const dir = registered('sat-403');
  const r = heartbeat([], { base: dir });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /will not accept state yet \(403\)/);
  rmSync(dir, { recursive: true, force: true });
});

await test('heartbeat unknown option → exit 2', () => {
  const r = heartbeat(['--nope']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /unknown option: --nope/);
  rmSync(r.dir, { recursive: true, force: true });
});

console.log('remote.mjs push-install:');

await test('push-install sends install.json and reports summary', () => {
  const dir = registered('install-sat');
  const packagesDir = mkdtempSync(join(tmpdir(), 'remote-packages-'));
  writeFileSync(join(packagesDir, 'install.json'), JSON.stringify({
    install_version: 11,
    install_changed_at: '2026-06-28T16:00:00.000Z',
    installed_components: [
      { type: 'skill', name: 'demo-skill', package: 'demo', package_version: '1', installed_at: '2026-06-28T15:59:00.000Z' },
    ],
  }));

  const r = pushInstall(['--json'], { base: dir, env: { PACKAGES_DIR: packagesDir } });
  assert.equal(r.status, 0, r.out);
  const out = JSON.parse(r.stdout);
  assert.equal(out.remoteId, 'install-sat');
  assert.equal(out.installVersion, 11);
  assert.equal(out.installChangedAt, '2026-06-28T16:00:00.000Z');
  assert.equal(out.componentCount, 1);
  assert.equal(out.acceptedAt, '2026-06-14T00:01:00.000Z');

  rmSync(packagesDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

await test('push-install with absent install.json sends empty version-0 state', () => {
  const dir = registered('install-sat');
  const r = pushInstall([], { base: dir });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /install state v0 pushed for 'install-sat'/);
  assert.match(r.out, /0 components reported/);
  rmSync(dir, { recursive: true, force: true });
});

await test('push-install not registered (no id.json) → exit 1', () => {
  const r = pushInstall([]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not registered/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('push-install 403 not-yet-active → exit 1', () => {
  const dir = registered('sat-403');
  const r = pushInstall([], { base: dir });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /will not accept install state yet \(403\)/);
  rmSync(dir, { recursive: true, force: true });
});

await test('push-install unknown option → exit 2', () => {
  const r = pushInstall(['--nope']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /unknown option: --nope/);
  rmSync(r.dir, { recursive: true, force: true });
});

console.log('remote.mjs github-token:');

await test('prints just the raw token to stdout (no prefix, no extra output)', () => {
  const dir = registered('gh-sat');
  const r = githubToken([], { base: dir });
  assert.equal(r.status, 0, r.out);
  // stdout is the token byte-for-byte — no trailing newline, no [ai1] log prefix.
  assert.equal(r.stdout, 'ghp_gh-sat');
  assert.equal(r.stdout.includes('[ai1]'), false);
  rmSync(dir, { recursive: true, force: true });
});

await test('404 (no token available) → exit 1', () => {
  const dir = registered('no-gh');
  const r = githubToken([], { base: dir });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /no github token available for this remote \(404\)/);
  assert.equal(r.stdout, '');
  rmSync(dir, { recursive: true, force: true });
});

await test('not registered (no id.json) → exit 1', () => {
  const r = githubToken([]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not registered/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('403 not-yet-active → exit 1', () => {
  const dir = registered('sat-403');
  const r = githubToken([], { base: dir });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /will not serve a github token yet \(403\)/);
  rmSync(dir, { recursive: true, force: true });
});

await test('github-token unknown option → exit 2', () => {
  const r = githubToken(['--json']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /unknown option: --json/);
  rmSync(r.dir, { recursive: true, force: true });
});

console.log('remote.mjs get-package:');

// A registered dir plus fresh PACKAGE_BASE_DIR / DOWNLOAD_BASE_DIR temp dirs, and a cleanup helper.
function pkgEnv(remoteId = 'pkg-sat') {
  const dir = registered(remoteId);
  const pkgBase = mkdtempSync(join(tmpdir(), 'remote-pkgs-'));
  const dlBase = mkdtempSync(join(tmpdir(), 'remote-dl-'));
  const env = { PACKAGE_BASE_DIR: pkgBase, DOWNLOAD_BASE_DIR: dlBase };
  const cleanup = () => [dir, pkgBase, dlBase].forEach((d) => rmSync(d, { recursive: true, force: true }));
  return { dir, pkgBase, dlBase, env, cleanup };
}

await test('downloads + extracts to PACKAGE_BASE_DIR/<name>@<version>, deletes the archive', () => {
  const { dir, pkgBase, dlBase, env, cleanup } = pkgEnv();
  const r = getPackage(['--name=widget', '--version=3'], { base: dir, env });
  assert.equal(r.status, 0, r.out);
  // The package was extracted into PACKAGE_BASE_DIR/widget@3 with its contents intact.
  const extracted = join(pkgBase, 'widget@3', 'ai1-package.yaml');
  assert.equal(existsSync(extracted), true, r.out);
  assert.match(readFileSync(extracted, 'utf8'), /name: widget/);
  // The archive was removed after a successful extract (default), leaving no stage dirs behind.
  assert.equal(existsSync(join(dlBase, 'widget@3.tar.gz')), false);
  assert.deepEqual(readdirSync(pkgBase), ['widget@3']);
  assert.match(r.out, /ready at/);
  cleanup();
});

await test('--keep-download leaves the archive in DOWNLOAD_BASE_DIR', () => {
  const { dir, dlBase, env, cleanup } = pkgEnv();
  const r = getPackage(['--name=widget', '--version=3', '--keep-download'], { base: dir, env });
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(join(dlBase, 'widget@3.tar.gz')), true, r.out);
  cleanup();
});

await test('--json prints a machine-readable result without the signed URL', () => {
  const { dir, pkgBase, env, cleanup } = pkgEnv();
  const r = getPackage(['--name=widget', '--version=3', '--json'], { base: dir, env });
  assert.equal(r.status, 0, r.out);
  const out = JSON.parse(r.stdout);
  assert.equal(out.name, 'widget');
  assert.equal(out.version, 3);
  assert.equal(out.packageDir, join(pkgBase, 'widget@3'));
  assert.equal(out.keptDownload, false);
  assert.equal(out.download, null);
  // The signed URL is a bearer credential — it must not be echoed back to stdout.
  assert.equal('url' in out, false);
  cleanup();
});

await test('404 unregistered package → exit 1, nothing extracted', () => {
  const { dir, pkgBase, env, cleanup } = pkgEnv();
  const r = getPackage(['--name=widget', '--version=99'], { base: dir, env });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /is not registered \(404\)/);
  assert.equal(existsSync(join(pkgBase, 'widget@99')), false);
  cleanup();
});

await test('not registered (no id.json) → exit 1', () => {
  const r = getPackage(['--name=widget', '--version=3']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not registered/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('403 not-yet-active → exit 1', () => {
  const { dir, env, cleanup } = pkgEnv('sat-403');
  const r = getPackage(['--name=widget', '--version=3'], { base: dir, env });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /will not serve packages yet \(403\)/);
  cleanup();
});

await test('missing --name → exit 2', () => {
  const { dir, env, cleanup } = pkgEnv();
  const r = getPackage(['--version=3'], { base: dir, env });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /package name required/);
  cleanup();
});

await test('missing --version → exit 2', () => {
  const { dir, env, cleanup } = pkgEnv();
  const r = getPackage(['--name=widget'], { base: dir, env });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /package version required/);
  cleanup();
});

await test('--version=abc → exit 2', () => {
  const { dir, env, cleanup } = pkgEnv();
  const r = getPackage(['--name=widget', '--version=abc'], { base: dir, env });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /--version requires a positive integer/);
  cleanup();
});

await test('get-package unknown option → exit 2', () => {
  const { dir, env, cleanup } = pkgEnv();
  const r = getPackage(['--name=widget', '--version=3', '--nope'], { base: dir, env });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /unknown option: --nope/);
  cleanup();
});

console.log('remote.mjs option validation:');

await test('missing hub → usage error (exit 2)', () => {
  const r = register(['--token=good-secret'], { env: { SATELLITE_ID: 'demo-sat' } });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /hub URL required/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('missing bootstrap token → usage error (exit 2)', () => {
  const r = register([`--hub=${HUB}`], { env: { SATELLITE_ID: 'demo-sat' } });
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /bootstrap token required/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('unknown option → exit 2', () => {
  const r = register([`--hub=${HUB}`, '--token=good-secret', '--nope']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /unknown option: --nope/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('value flag with no value → exit 2', () => {
  const r = register(['--hub', '--token=good-secret']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /option --hub requires a value/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('--schema-version=abc → exit 2', () => {
  const r = register([`--hub=${HUB}`, '--token=good-secret', '--schema-version=abc']);
  assert.equal(r.status, 2, r.out);
  assert.match(r.out, /--schema-version requires an integer/);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('unknown subcommand → exit 2', () => {
  const r = spawnSync(process.execPath, ['scripts/remote.mjs', 'frobnicate'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(`${r.stdout}${r.stderr}`, /unknown subcommand/);
});

await test('--help → exit 0 with usage', () => {
  const r = spawnSync(process.execPath, ['scripts/remote.mjs', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: node scripts\/remote\.mjs/);
});

hubProc.kill();
rmSync(join(hubFile, '..'), { recursive: true, force: true });
rmSync(pkgSrc, { recursive: true, force: true });
rmSync(join(tarball, '..'), { recursive: true, force: true });
done();
