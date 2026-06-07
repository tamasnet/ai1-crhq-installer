// core/service.mjs — services are nginx + PM2 web apps (NOT DB-resident). D-2b RESOLVED: inline
// templates (deploy-project ships no callable scripts — it's a runbook), so we emit the artifacts
// here and drive pm2/nginx directly, honoring its security rules (127.0.0.1 binding, chmod 640 .env,
// never touch crhq-satellite).
//
// Safety model:
//   • dry-run (D-2a)     → run the build step + render artifacts, SKIP the apply (no nginx/PM2/port).
//   • --sandbox          → services aren't modelled by the sandbox → SKIP entirely (build + apply).
//   • real install       → applyService(): copy source, write .env/ecosystem/vhost, alloc port,
//                          pm2 start+save, nginx reload. This MUTATES THE LIVE VPS.
//
// ⚠️ The live apply/remove paths are implemented per deploy-project conventions but are NOT yet
// exercised — the plan's "one explicit live service smoke test" (Phase 6) validates them. Render +
// build + dry-run + the sandbox skip ARE covered by tests/service.test.mjs.
import { existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { copyTree, removeTree } from '../fs.mjs';
import { VERDICT } from '../log.mjs';

const USER_PROJECTS = '/opt/projects/user';
const NGINX_DIR = '/etc/nginx/projects.d';
const PORT_BASE = 4300;

// ── Pure renderers (fully testable; no I/O) ──────────────────────────────────────────────────

export function renderEnv(def, port) {
  // PORT + NODE_ENV defaults, overridden by the service's declared env. Secrets live ONLY here
  // (chmod 640 by applyService) — never echoed to logs, never duplicated into the PM2 config.
  const merged = { PORT: port, NODE_ENV: 'production', ...(def.env || {}) };
  return `${Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

export function renderEcosystem(def, port, projectDir) {
  const [script, ...rest] = String(def.start || 'node server.js').split(' ');
  const app = {
    name: def.name,
    script,
    args: rest.join(' '),
    cwd: projectDir,
    interpreter: 'none',
    env: { NODE_ENV: 'production', PORT: port },   // secrets stay in .env, not here
    watch: false,
    autorestart: true,
    max_memory_restart: '512M',
  };
  return `module.exports = ${JSON.stringify({ apps: [app] }, null, 2)};\n`;
}

const PROXY = (port, indent = '    ') => [
  `${indent}location / {`,
  `${indent}    proxy_pass http://127.0.0.1:${port};`,
  `${indent}    proxy_http_version 1.1;`,
  `${indent}    proxy_set_header Upgrade $http_upgrade;`,
  `${indent}    proxy_set_header Connection "upgrade";`,
  `${indent}    proxy_set_header Host $host;`,
  `${indent}    proxy_set_header X-Real-IP $remote_addr;`,
  `${indent}    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`,
  `${indent}    proxy_set_header X-Forwarded-Proto $scheme;`,
  `${indent}    proxy_read_timeout 86400;`,
  `${indent}    proxy_send_timeout 86400;`,
  `${indent}    client_max_body_size 50m;`,
  `${indent}}`,
].join('\n');

// Generate the nginx vhost for /etc/nginx/projects.d/<name>.conf following deploy-project's
// conventions. Standard satellite → 80→443 redirect + crhq.ai TLS block; white-label → org domain
// (primary) + crhq.ai (fallback) blocks. ssl:false → plain :80 proxy.
export function renderNginx(def, port, env = process.env) {
  const sub = def.nginx?.subdomain || def.name;
  const ssl = def.nginx?.ssl !== false;
  const satId = env.SATELLITE_ID || 'satellite';
  const crhqHost = `${satId}-${sub}.crhq.ai`;
  const header = `# ${def.name} — managed by ai1-crhq-installer`;

  if (!ssl) {
    return [header, 'server {', '    listen 80;', '    listen [::]:80;',
      `    server_name ${crhqHost};`, '    proxy_hide_header X-Powered-By;', PROXY(port), '}', ''].join('\n');
  }

  const tlsBlock = (serverName, fullchain, privkey) => [
    'server {', '    listen 443 ssl http2;', '    listen [::]:443 ssl http2;',
    `    server_name ${serverName};`, `    ssl_certificate ${fullchain};`,
    `    ssl_certificate_key ${privkey};`, '    ssl_protocols TLSv1.2 TLSv1.3;',
    '    proxy_hide_header X-Powered-By;', PROXY(port), '}'].join('\n');

  if (env.IS_WHITELABEL === 'true' && env.ORG_DOMAIN) {
    const shortName = satId.includes('-') ? satId.slice(satId.indexOf('-') + 1) : satId;
    const orgHost = `${shortName}-${sub}.${env.ORG_DOMAIN}`;
    return [header,
      'server {', '    listen 80;', '    listen [::]:80;',
      `    server_name ${orgHost} ${crhqHost};`, '    return 301 https://$host$request_uri;', '}',
      tlsBlock(orgHost, '/etc/ssl/org-cert/fullchain.pem', '/etc/ssl/org-cert/privkey.pem'),
      tlsBlock(crhqHost, '/etc/ssl/crhq-fallback/fullchain.pem', '/etc/ssl/crhq-fallback/privkey.pem'), ''].join('\n');
  }

  return [header,
    'server {', '    listen 80;', '    listen [::]:80;',
    `    server_name ${crhqHost};`, '    return 301 https://$host$request_uri;', '}',
    tlsBlock(crhqHost, '/etc/ssl/crhq.ai/fullchain.pem', '/etc/ssl/crhq.ai/privkey.pem'), ''].join('\n');
}

export function nextFreePort(usedPorts, base = PORT_BASE) {
  const used = new Set(usedPorts);
  let p = base;
  while (used.has(p)) p += 1;
  return p;
}

// Scan existing vhosts for already-proxied ports (live; used only by applyService).
function scanUsedPorts() {
  if (!existsSync(NGINX_DIR)) return [];
  const ports = [];
  for (const f of readdirSync(NGINX_DIR)) {
    if (!f.endsWith('.conf')) continue;
    for (const m of readFileSync(join(NGINX_DIR, f), 'utf8').matchAll(/proxy_pass\s+http:\/\/127\.0\.0\.1:(\d+)/g)) ports.push(Number(m[1]));
  }
  return ports;
}

function renderArtifacts(def, port, projectDir, env) {
  return { env: renderEnv(def, port), ecosystem: renderEcosystem(def, port, projectDir), nginx: renderNginx(def, port, env) };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────────────────────

export function installService(ctx, def) {
  const { log, DRY_RUN, SANDBOX } = ctx;

  if (SANDBOX) {                                  // services aren't sandbox-modelled (skip cleanly)
    log.warn(`service ${def.name}: skipped under --sandbox (nginx/PM2 not modelled)`);
    return out(def.name, VERDICT.ALREADY, 'sandbox-skipped');
  }

  if (def.build) {                                // D-2a: build runs in dry-run too
    log.info(`service ${def.name}: build (${def.build})`);
    const r = spawnSync(def.build, { cwd: def.srcDir, shell: true, stdio: 'inherit' });
    if (r.status !== 0) return out(def.name, VERDICT.FAIL, 'build-failed');
  }

  const projectDir = join(USER_PROJECTS, def.name);
  const port = def.port || nextFreePort(DRY_RUN ? [] : scanUsedPorts());
  const artifacts = renderArtifacts(def, port, projectDir, process.env);

  if (DRY_RUN) {
    log.dry(`deploy service ${def.name} → ${projectDir} on port ${port} (nginx vhost + PM2 — apply skipped, D-2a)`);
    return out(def.name, VERDICT.OK, `built (port ${port})`);
  }

  applyService(ctx, def, projectDir, port, artifacts);   // ⚠️ live VPS mutation
  return out(def.name, VERDICT.OK, `deployed (port ${port})`);
}

// Live apply — gated to real (non-dry-run, non-sandbox) installs. Faithful to deploy-project;
// pending the explicit live smoke test for verification.
function applyService(ctx, def, projectDir, port, artifacts) {
  if (def.name === 'crhq-satellite') throw new Error('refusing to deploy a service named crhq-satellite');
  mkdirSync(projectDir, { recursive: true });
  copyTree(def.srcDir, projectDir, { dryRun: false });

  const envPath = join(projectDir, '.env');
  writeFileSync(envPath, artifacts.env);
  chmodSync(envPath, 0o640);                                   // Rule 3: lock down secrets
  writeFileSync(join(projectDir, 'ecosystem.config.cjs'), artifacts.ecosystem);
  writeFileSync(join(NGINX_DIR, `${def.name}.conf`), artifacts.nginx);

  sh(ctx, 'pm2', ['start', 'ecosystem.config.cjs'], { cwd: projectDir });
  sh(ctx, 'pm2', ['save'], {});                                // reboot persistence
  sh(ctx, 'sudo', ['nginx', '-t']);
  sh(ctx, 'sudo', ['nginx', '-s', 'reload']);
  ctx.log.ok(`service ${def.name} deployed on 127.0.0.1:${port}`);
}

export function removeService(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const { DRY_RUN, SANDBOX, log } = ctx;
  if (name === 'crhq-satellite') throw new Error('refusing to touch crhq-satellite');
  if (SANDBOX) { log.warn(`service ${name}: skipped under --sandbox`); return out(name, VERDICT.ALREADY, 'sandbox-skipped'); }
  if (DRY_RUN) { log.dry(`remove service ${name} (pm2 delete + rm vhost + nginx reload)`); return out(name, VERDICT.OK, 'removed'); }

  sh(ctx, 'pm2', ['delete', name], { allowFail: true });
  sh(ctx, 'pm2', ['save'], { allowFail: true });
  removeTree(join(NGINX_DIR, `${name}.conf`), { dryRun: false });
  sh(ctx, 'sudo', ['nginx', '-s', 'reload'], { allowFail: true });
  removeTree(join(USER_PROJECTS, name), { dryRun: false });   // remove project dir (incl. .env)
  return out(name, VERDICT.OK, 'removed');
}

export function statusService(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const dirPresent = existsSync(join(USER_PROJECTS, name));
  const vhostPresent = existsSync(join(NGINX_DIR, `${name}.conf`));
  const pm2Present = spawnSync('pm2', ['describe', name], { stdio: 'ignore' }).status === 0;
  return { type: 'service', name, verdict: dirPresent ? VERDICT.ALREADY : VERDICT.ABSENT, dirPresent, vhostPresent, pm2Present };
}

function sh(ctx, cmd, args, { cwd, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
  return r;
}

function out(name, verdict, action) { return { type: 'service', name, verdict, action }; }
