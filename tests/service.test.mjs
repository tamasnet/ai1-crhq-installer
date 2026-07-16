#!/usr/bin/env node
// Service (nginx + PM2) verification — render + build + dry-run + sandbox-skip. Live
// apply/remove is gated in tests/service-live.test.mjs (AI1_LIVE_SERVICE_TEST=1). No DB needed.
//   node tests/service.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest, normalizeBuild, ManifestError, deployIncludesNginx, deployIncludesPm2 } from '../scripts/lib/manifest.mjs';
import { makeLogger } from '../scripts/lib/log.mjs';
import {
  installService, installProject, renderEnv, renderEcosystem, renderNginx, nextFreePort,
} from '../scripts/lib/core/service.mjs';
import { ensureSymlink } from '../scripts/lib/fs.mjs';
import { resolveServicesBase } from '../scripts/lib/paths.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();

// Minimal ctx — services touch no DB, so we avoid opening a connection entirely.
const svcCtx = (over = {}) => ({
  log: makeLogger({ dryRun: !!over.DRY_RUN }),
  DRY_RUN: false, SANDBOX: false, results: [], record(r) { this.results.push(r); return r; }, ...over,
});

const { plan } = loadManifest('tests/fixtures/service-pkg');
const def = plan.services[0];   // ai1-demo-svc, port 4399, secret env, app_name demo + ssl
const projectDir = join(resolveServicesBase(), 'ai1-demo-svc');
const vhost = '/etc/nginx/projects.d/ai1-demo-svc.conf';
const { plan: projectPlan } = loadManifest('tests/fixtures/project-pkg');
const projectDef = projectPlan.projects[0];
const cleanups = [];

console.log('render:');

await test('renderEnv: PORT + NODE_ENV defaults + declared vars', () => {
  const env = renderEnv(def, 4399);
  assert.match(env, /^PORT=4399$/m);
  assert.match(env, /^NODE_ENV=production$/m);
  assert.match(env, /^API_SECRET=super-secret-value$/m);
});

await test('renderEcosystem: name/script/args/cwd/PORT; secrets excluded', () => {
  const eco = renderEcosystem(def, 4399, projectDir);
  assert.match(eco, /"name": "ai1-demo-svc"/);
  assert.match(eco, /"script": "node"/);
  assert.match(eco, /"args": "server\.js"/);
  assert.match(eco, /"PORT": 4399/);
  assert.match(eco, /"autorestart": true/);
  assert.doesNotMatch(eco, /API_SECRET/, 'secrets must NOT land in the PM2 config');
});

await test('renderNginx: 127.0.0.1 proxy, crhq host, TLS, no 0.0.0.0', () => {
  const conf = renderNginx(def, 4399, { SATELLITE_ID: 'myzone-tamas' });
  assert.match(conf, /server_name myzone-tamas-demo\.crhq\.ai;/);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:4399;/);
  assert.match(conf, /ssl_certificate \/etc\/ssl\/crhq\.ai\/fullchain\.pem;/);
  assert.match(conf, /return 301 https:\/\/\$host\$request_uri;/);
  assert.doesNotMatch(conf, /0\.0\.0\.0/, 'never bind 0.0.0.0');
});

await test('renderNginx: ssl:false → plain :80 proxy only', () => {
  const conf = renderNginx({ ...def, app_name: 'demo', ssl: false }, 4399, { SATELLITE_ID: 's' });
  assert.match(conf, /listen 80;/);
  assert.doesNotMatch(conf, /listen 443/);
});

await test('renderNginx: white-label → org + crhq fallback blocks', () => {
  const conf = renderNginx(def, 4399, { SATELLITE_ID: 'acme-demo', IS_WHITELABEL: 'true', ORG_DOMAIN: 'acme.com' });
  assert.match(conf, /server_name demo-demo\.acme\.com;/, 'org-domain primary block');
  assert.match(conf, /server_name acme-demo-demo\.crhq\.ai;/, 'crhq fallback block');
  assert.match(conf, /\/etc\/ssl\/org-cert\/fullchain\.pem/);
});

await test('nextFreePort: skips used, defaults to base', () => {
  assert.equal(nextFreePort([4300, 4301, 4303], 4300), 4302);
  assert.equal(nextFreePort([], 4300), 4300);
});

console.log('\ninstall (no live apply):');

await test('dry-run: built, no live writes', async () => {
  const r = await installService(svcCtx({ DRY_RUN: true }), def);
  assert.equal(r.verdict, 'INSTALL-OK');
  assert.match(r.action, /^built/);
  assert.equal(existsSync(projectDir), false, 'no project dir created');
  assert.equal(existsSync(vhost), false, 'no nginx vhost written');
});

await test('dry-run: skips build commands by default', async () => {
  const marker = join(tmpdir(), `ai1-build-skip-${Date.now()}`);
  const buildDef = { ...def, build: [`touch ${marker}`] };
  const logs = [];
  const log = makeLogger({ dryRun: true });
  const origWarn = log.warn.bind(log);
  log.warn = (m) => { logs.push(m); origWarn(m); };
  await installService({ ...svcCtx({ DRY_RUN: true }), log }, buildDef);
  assert.equal(existsSync(marker), false, 'build command must not run');
  assert.ok(logs.some((m) => /build commands skipped under --dry-run/.test(m)));
  rmSync(marker, { force: true });
});

await test('dry-run --run-build: executes build commands', async () => {
  const marker = join(tmpdir(), `ai1-build-run-${Date.now()}`);
  const buildDef = { ...def, build: [`touch ${marker}`] };
  const logs = [];
  const log = makeLogger({ dryRun: true });
  const origWarn = log.warn.bind(log);
  log.warn = (m) => { logs.push(m); origWarn(m); };
  await installService({ ...svcCtx({ DRY_RUN: true, RUN_BUILD: true }), log }, buildDef);
  assert.equal(existsSync(marker), true, 'build command should run');
  assert.ok(logs.some((m) => /--run-build/.test(m)));
  rmSync(marker, { force: true });
});

await test('--sandbox: skipped cleanly (services not modelled)', async () => {
  const r = await installService(svcCtx({ SANDBOX: true }), def);
  assert.equal(r.verdict, 'ALREADY-INSTALLED');
  assert.equal(r.action, 'sandbox-skipped');
  assert.equal(existsSync(projectDir), false);
});

await test('secret hygiene: env secret never logged', async () => {
  const orig = console.log;
  let buf = '';
  console.log = (...a) => { buf += `${a.join(' ')}\n`; };
  try { await installService(svcCtx({ DRY_RUN: true }), def); } finally { console.log = orig; }
  assert.doesNotMatch(buf, /super-secret-value/, 'secret must not appear in logs');
});

console.log('\napp_port / app_deploy:');

await test('loadManifest: deprecated port maps to app_port', () => {
  assert.equal(def.app_port, 4399);
  assert.equal(def.app_deploy, 'default');
  assert.equal(def.portDeprecated, true);
});

await test('deployIncludesNginx/Pm2 helpers', () => {
  assert.equal(deployIncludesNginx('default'), true);
  assert.equal(deployIncludesPm2('default'), true);
  assert.equal(deployIncludesNginx('nginx'), true);
  assert.equal(deployIncludesPm2('nginx'), false);
  assert.equal(deployIncludesNginx('pm2'), false);
  assert.equal(deployIncludesPm2('pm2'), true);
  assert.equal(deployIncludesNginx('none'), false);
  assert.equal(deployIncludesPm2('none'), false);
});

await test('dry-run app_deploy=none: files only, no pm2/nginx in message', async () => {
  const logs = [];
  const log = makeLogger({ dryRun: true });
  const origDry = log.dry.bind(log);
  log.dry = (m) => { logs.push(m); origDry(m); };
  const r = await installService({ ...svcCtx({ DRY_RUN: true }), log }, { ...def, app_deploy: 'none', portDeprecated: false });
  assert.equal(r.verdict, 'INSTALL-OK');
  assert.ok(logs.some((m) => /app_deploy=none/.test(m)));
});

await test('install warns when deprecated port is used', async () => {
  const logs = [];
  const log = makeLogger({ dryRun: true });
  const origWarn = log.warn.bind(log);
  log.warn = (m) => { logs.push(m); origWarn(m); };
  await installService({ ...svcCtx({ DRY_RUN: true }), log }, def);
  assert.ok(logs.some((m) => /'port' is deprecated/.test(m)));
});

console.log('\nprojects (no live apply):');

await test('project dry-run: deploys under /opt/projects/user and defaults to symlink mode', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ai1-project-base-'));
  cleanups.push(base);
  const r = await installProject(svcCtx({ DRY_RUN: true, USER_PROJECTS_BASE: base }), projectDef);
  assert.equal(r.type, 'project');
  assert.equal(r.verdict, 'INSTALL-OK');
  assert.equal(existsSync(join(base, projectDef.name)), false, 'dry-run creates no project symlink');
});

await test('ensureSymlink: creates and updates the live project link', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai1-project-link-'));
  cleanups.push(base);
  const a = join(base, 'a');
  const b = join(base, 'b');
  const link = join(base, 'live');
  mkdirSync(a); mkdirSync(b);

  assert.equal(ensureSymlink(link, a), true);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readlinkSync(link), a);

  assert.equal(ensureSymlink(link, a), false, 'same target is unchanged');
  assert.equal(ensureSymlink(link, b), true, 'different target updates the symlink');
  assert.equal(readlinkSync(link), b);
});

console.log('\nbuild field normalization:');

await test('normalizeBuild: a single string becomes a one-element list', () => {
  assert.deepEqual(normalizeBuild('svc build', 'npm run build'), ['npm run build']);
});

await test('normalizeBuild: a list is kept in order', () => {
  assert.deepEqual(
    normalizeBuild('svc build', ['npm ci', 'npm run build', 'npm run bundle']),
    ['npm ci', 'npm run build', 'npm run bundle'],
  );
});

await test('normalizeBuild: empty/whitespace entries are dropped; nothing left → undefined', () => {
  assert.deepEqual(normalizeBuild('svc build', ['npm ci', '   ', '']), ['npm ci']);
  assert.equal(normalizeBuild('svc build', '   '), undefined);
  assert.equal(normalizeBuild('svc build', []), undefined);
  assert.equal(normalizeBuild('svc build', undefined), undefined);
  assert.equal(normalizeBuild('svc build', null), undefined);
});

await test('normalizeBuild: a non-string entry is a manifest error', () => {
  assert.throws(() => normalizeBuild('svc build', ['npm ci', 42]), (e) => e instanceof ManifestError && /string or a list/.test(e.message));
  assert.throws(() => normalizeBuild('svc build', { cmd: 'x' }), (e) => e instanceof ManifestError);
});

for (const d of cleanups) rmSync(d, { recursive: true, force: true });

done();
