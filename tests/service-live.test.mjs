#!/usr/bin/env node
// Live service smoke test — exercises nginx + PM2 apply/remove paths.
// Gated: only runs when AI1_LIVE_SERVICE_TEST=1 (needs sudo, nginx, pm2 on the host).
// Run from the project root:
//   AI1_LIVE_SERVICE_TEST=1 node tests/service-live.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeLogger } from '../scripts/lib/log.mjs';
import { installService, removeService, statusService } from '../scripts/lib/core/service.mjs';
import { resolveServicesBase } from '../scripts/lib/paths.mjs';
import { harness } from './_helpers.mjs';

if (process.env.AI1_LIVE_SERVICE_TEST !== '1') {
  console.log('⏭️  service-live: skipped (set AI1_LIVE_SERVICE_TEST=1 to run live nginx/PM2 smoke test)');
  process.exit(0);
}

const { test, done } = harness();
const NGINX_DIR = '/etc/nginx/projects.d';
const svcName = `ai1-live-smoke-${process.pid}`;
const baseDir = mkdtempSync(join(tmpdir(), 'ai1-live-smoke-'));
const srcDir = join(baseDir, 'src');
const projectDir = join(resolveServicesBase(), svcName);
const vhost = join(NGINX_DIR, `${svcName}.conf`);

const cleanup = () => {
  try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* ignore */ }
};

mkdirSync(srcDir, { recursive: true });
writeFileSync(join(srcDir, 'server.js'), [
  "import { createServer } from 'http';",
  "createServer((_req, res) => { res.end('live-smoke ok'); }).listen(process.env.PORT || 4300, '127.0.0.1');",
].join('\n'));
writeFileSync(join(srcDir, 'service.yaml'), [
  `name: ${svcName}`,
  'version: 1',
  'port: 4398',
  'start: node server.js',
  'app_name: live-smoke',
  'ssl: false',
].join('\n'));

const def = {
  name: svcName,
  version: 1,
  app_port: 4398,
  app_deploy: 'default',
  start: 'node server.js',
  app_name: 'live-smoke',
  ssl: false,
  env: {},
  srcDir,
};

const ctx = () => ({
  log: makeLogger({ dryRun: false }),
  DRY_RUN: false,
  SANDBOX: false,
  results: [],
  record(r) { this.results.push(r); return r; },
});

const pm2Describe = (name) => spawnSync('pm2', ['describe', name], { stdio: 'ignore' }).status === 0;

console.log(`live smoke (${svcName}):`);

try {
  await test('installService: deploys vhost + pm2 process', async () => {
    const r = await installService(ctx(), def);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.match(r.action, /deployed/);
    assert.equal(existsSync(vhost), true, 'nginx vhost should exist');
    assert.equal(existsSync(projectDir), true, 'project dir should exist');
    assert.equal(pm2Describe(svcName), true, 'pm2 process should exist');
    const st = statusService(ctx(), def);
    assert.equal(st.vhostPresent, true);
    assert.equal(st.pm2Present, true);
    assert.equal(st.dirPresent, true);
  });

  await test('removeService: tears down vhost + pm2 + project dir', async () => {
    const r = await removeService(ctx(), def);
    assert.equal(r.verdict, 'INSTALL-OK');
    assert.equal(r.action, 'removed');
    assert.equal(existsSync(vhost), false, 'nginx vhost should be removed');
    assert.equal(existsSync(projectDir), false, 'project dir should be removed');
    assert.equal(pm2Describe(svcName), false, 'pm2 process should be gone');
  });
} finally {
  // Best-effort cleanup if a test failed mid-run.
  if (existsSync(vhost) || existsSync(projectDir) || pm2Describe(svcName)) {
    try { await removeService(ctx(), def); } catch { /* ignore */ }
  }
  cleanup();
}

done();
