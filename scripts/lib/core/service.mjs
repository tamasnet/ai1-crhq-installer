// core/service.mjs — services/projects are nginx + PM2 web apps (NOT DB-resident). Deployment
// follows the conventions of the CRHQ `deploy-project` skill: templates are inline — we emit the
// artifacts here and drive pm2/nginx directly — and its security rules are honored (127.0.0.1
// binding, chmod 640 .env, never touch crhq-satellite).
//
// Safety model:
//   • dry-run            → render artifacts, SKIP build + apply (no nginx/PM2/port) unless --run-build.
//   • --sandbox          → web apps aren't modelled by the sandbox → SKIP entirely (build + apply).
//   • real install       → applyWebApp(): copy/symlink source, write .env/ecosystem/vhost,
//                          alloc port, pm2 start+save, nginx reload. This MUTATES THE LIVE VPS.
//
// ⚠️ The live apply/remove paths mutate nginx + PM2 on the VPS. Run tests/service-live.test.mjs
// with AI1_LIVE_SERVICE_TEST=1 on a machine with sudo/nginx/pm2 to exercise them end-to-end. Render +
// build + dry-run + symlink helpers + the sandbox skip ARE covered by tests/service.test.mjs.
import { existsSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, lstatSync, readlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { spawnSync } from 'child_process';
import { copyTree, removeTree, ensureSymlink, syncInstallTree, pruneTree } from '../fs.mjs';
import { protectMatcher, listProtectedEntries } from '../protect.mjs';
import { isInstallStrict } from '../strict.mjs';
import { assertSafeEnvValue, formatEnvValue } from '../validate.mjs';
import { VERDICT, logDeletions } from '../log.mjs';
import { resolveServicesBase, resolveUserProjectsBase } from '../paths.mjs';
import { planResult } from './plan-result.mjs';

const NGINX_DIR = '/etc/nginx/projects.d';
const PORT_BASE = 4300;

// ── Pure renderers (fully testable; no I/O) ──────────────────────────────────────────────────

export function renderEnv(def, port) {
  // PORT + NODE_ENV defaults, overridden by the service's declared env. Secrets live ONLY here
  // (chmod 640 by applyWebApp) — never echoed to logs, never duplicated into the PM2 config.
  const merged = { PORT: port, NODE_ENV: 'production', ...(def.env || {}) };
  for (const [k, v] of Object.entries(merged)) assertSafeEnvValue(k, v);
  return `${Object.entries(merged).map(([k, v]) => `${k}=${formatEnvValue(v)}`).join('\n')}\n`;
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

// Generate the nginx vhost for /etc/nginx/projects.d/<name>.conf, following the CRHQ
// deploy-project skill's conventions. Standard satellite → 80→443 redirect + crhq.ai TLS block; white-label → org domain
// (primary) + crhq.ai (fallback) blocks. ssl:false → plain :80 proxy.
export function renderNginx(def, port, env = process.env) {
  const sub = def.app_name || def.name;
  const ssl = def.ssl !== false;
  const satId = env.SATELLITE_ID || 'satellite';
  const crhqHost = `${satId}-${sub}.crhq.ai`;
  const header = `# ${def.name} — managed by ai1-satellite-tools`;

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

async function planWebApp(ctx, def, { type, baseDir, contentMode }) {
  const name = def.name;
  const st = statusWebApp(ctx, def, { type, baseDir });
  if (st.verdict === VERDICT.ABSENT) return planResult(type, name, { verdict: VERDICT.ABSENT, action: 'absent' });

  const deployDir = join(baseDir, name);
  let fileDrift = false;
  if (type === 'project' && contentMode === 'symlink') {
    try {
      const stLink = lstatSync(deployDir);
      if (stLink.isSymbolicLink()) {
        const target = resolve(dirname(deployDir), readlinkSync(deployDir));
        fileDrift = target !== resolve(def.srcDir);
      } else if (existsSync(deployDir)) {
        fileDrift = true;
      }
    } catch { /* ENOENT → absent handled above */ }
  } else if (def.srcDir && existsSync(def.srcDir)) {
    fileDrift = copyTree(def.srcDir, deployDir, { dryRun: true, contentOnly: !!ctx.CONTENT_ONLY }) > 0;
    if (isInstallStrict(ctx, def) && existsSync(deployDir)) {
      fileDrift = fileDrift || pruneTree(deployDir, def.srcDir, { dryRun: true, skip: protectMatcher(def.protect).skip }).length > 0;
    }
  }

  const nginxDrift = !st.vhostPresent;
  const pm2Drift = !st.pm2Present;
  if (!fileDrift && !nginxDrift && !pm2Drift) {
    return planResult(type, name, { verdict: VERDICT.ALREADY, action: 'updated' });
  }
  return planResult(type, name, {
    verdict: VERDICT.OK,
    action: 'updated',
    dimensions: { files: fileDrift, nginx: nginxDrift, pm2: pm2Drift },
  });
}

export function planService(ctx, def) {
  return planWebApp(ctx, def, {
    type: 'service',
    baseDir: ctx.SERVICES_BASE || resolveServicesBase(),
    contentMode: 'copy',
  });
}

export function planProject(ctx, def) {
  return planWebApp(ctx, def, {
    type: 'project',
    baseDir: ctx.USER_PROJECTS_BASE || resolveUserProjectsBase(),
    contentMode: ctx.COPY_PROJECTS ? 'copy' : 'symlink',
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────────────────────

export function installService(ctx, def) {
  return installWebApp(ctx, def, {
    type: 'service',
    baseDir: ctx.SERVICES_BASE || resolveServicesBase(),
    contentMode: 'copy',
  });
}

export function installProject(ctx, def) {
  return installWebApp(ctx, def, {
    type: 'project',
    baseDir: ctx.USER_PROJECTS_BASE || resolveUserProjectsBase(),
    contentMode: ctx.COPY_PROJECTS ? 'copy' : 'symlink',
  });
}

async function installWebApp(ctx, def, { type, baseDir, contentMode }) {
  const { log, DRY_RUN, SANDBOX, RUN_BUILD } = ctx;

  if (SANDBOX) {                                  // nginx/PM2 aren't sandbox-modelled (skip cleanly)
    log.warn(`${type} ${def.name}: skipped under --sandbox (nginx/PM2 not modelled)`);
    return out(type, def.name, VERDICT.ALREADY, 'sandbox-skipped');
  }

  const buildCmds = def.build || [];
  const runBuilds = !DRY_RUN || RUN_BUILD;
  if (DRY_RUN && buildCmds.length && !RUN_BUILD) {
    log.warn(`${type} ${def.name}: build commands skipped under --dry-run (pass --run-build to execute them)`);
  } else if (DRY_RUN && buildCmds.length && RUN_BUILD) {
    log.warn(`${type} ${def.name}: running build commands under --dry-run (--run-build)`);
  }

  // def.build is a normalized list of shell commands (manifest.normalizeBuild); run them in order,
  // fail fast on the first non-zero exit when builds are enabled.
  //
  // Build commands must NOT inherit NODE_ENV=production: npm's `omit` config defaults to ['dev']
  // when NODE_ENV=production, so `npm install`/`npm ci` would silently skip devDependencies and the
  // build's own tooling (vite, webpack, tsc, babel…) goes missing. Strip it for the build env only —
  // the deployed app still gets NODE_ENV=production via renderEnv()/renderEcosystem().
  if (runBuilds) {
    const buildEnv = { ...process.env };
    delete buildEnv.NODE_ENV;
    for (const cmd of buildCmds) {
      log.info(`${type} ${def.name}: build (${cmd})`);
      const r = spawnSync(cmd, { cwd: def.srcDir, shell: true, stdio: 'inherit', env: buildEnv });
      if (r.status !== 0) return out(type, def.name, VERDICT.FAIL, 'build-failed');
    }
  }

  // Copy-mode deploys: surface protected names the package ships (after builds, so build output in
  // srcDir counts). They install as one-way seed data — never pruned by --strict afterward.
  if (contentMode === 'copy' && def.srcDir && existsSync(def.srcDir)) {
    const shipped = listProtectedEntries(def.srcDir, def.protect);
    if (shipped.length) {
      log.warn(`${type} ${def.name}: package ships protected entries (installed as one-way seed, never pruned): ${shipped.join(', ')}`);
    }
  }

  const projectDir = join(baseDir, def.name);
  const port = def.port || nextFreePort(DRY_RUN ? [] : scanUsedPorts());
  const artifacts = renderArtifacts(def, port, projectDir, process.env);
  const plan = await planWebApp(ctx, def, { type, baseDir, contentMode });

  if (DRY_RUN) {
    const content = type === 'project'
      ? (contentMode === 'copy' ? 'copy project files' : `symlink to ${def.srcDir}`)
      : 'copy service files';
    log.dry(`deploy ${type} ${def.name} → ${projectDir} on port ${port} (${content}; nginx vhost + PM2 — apply skipped)`);
    if (isInstallStrict(ctx, def) && contentMode === 'copy' && def.srcDir && existsSync(def.srcDir) && existsSync(projectDir)) {
      const stale = pruneTree(projectDir, def.srcDir, { dryRun: true, skip: protectMatcher(def.protect).skip });
      logDeletions(log, projectDir, stale, { dryRun: true });
    }
    const verdict = plan.verdict === VERDICT.ALREADY ? VERDICT.ALREADY : VERDICT.OK;
    const action = plan.verdict === VERDICT.ALREADY ? 'unchanged' : `built (port ${port})`;
    return out(type, def.name, verdict, action);
  }

  if (plan.verdict === VERDICT.ALREADY) {
    return out(type, def.name, VERDICT.ALREADY, 'unchanged');
  }

  applyWebApp(ctx, def, projectDir, port, artifacts, { type, contentMode });
  return out(type, def.name, VERDICT.OK, `deployed (port ${port})`);
}

// Live apply — gated to real (non-dry-run, non-sandbox) installs; follows the deploy-project
// skill's deployment steps. Verified by tests/service-live.test.mjs when AI1_LIVE_SERVICE_TEST=1.
function applyWebApp(ctx, def, projectDir, port, artifacts, { type, contentMode }) {
  if (def.name === 'crhq-satellite') throw new Error(`refusing to deploy a ${type} named crhq-satellite`);
  if (contentMode === 'symlink') {
    ensureSymlink(projectDir, def.srcDir);
  } else {
    if (isSymlink(projectDir)) removeTree(projectDir, { dryRun: false });
    mkdirSync(projectDir, { recursive: true });
    const protect = protectMatcher(def.protect);
    const { pruned } = syncInstallTree(def.srcDir, projectDir, {
      dryRun: false, strict: isInstallStrict(ctx, def), pruneSkip: protect.skip,
    });
    logDeletions(ctx.log, projectDir, pruned, { dryRun: false });
    if (isInstallStrict(ctx, def) && protect.matched.size) {
      ctx.log.info(`${type} ${def.name}: protected (kept): ${[...protect.matched].sort().join(', ')}`);
    }
  }

  const envPath = join(projectDir, '.env');
  writeFileSync(envPath, artifacts.env);
  chmodSync(envPath, 0o640);                                   // Rule 3: lock down secrets
  writeFileSync(join(projectDir, 'ecosystem.config.cjs'), artifacts.ecosystem);
  writeFileSync(join(NGINX_DIR, `${def.name}.conf`), artifacts.nginx);

  sh(ctx, 'pm2', ['start', 'ecosystem.config.cjs'], { cwd: projectDir });
  sh(ctx, 'pm2', ['save'], {});                                // reboot persistence
  sh(ctx, 'sudo', ['nginx', '-t']);
  sh(ctx, 'sudo', ['nginx', '-s', 'reload']);
  ctx.log.ok(`${type} ${def.name} deployed on 127.0.0.1:${port}`);
}

export function removeService(ctx, nameOrDef) {
  return removeWebApp(ctx, nameOrDef, {
    type: 'service',
    baseDir: ctx.SERVICES_BASE || resolveServicesBase(),
  });
}

export function removeProject(ctx, nameOrDef) {
  return removeWebApp(ctx, nameOrDef, {
    type: 'project',
    baseDir: ctx.USER_PROJECTS_BASE || resolveUserProjectsBase(),
  });
}

function removeWebApp(ctx, nameOrDef, { type, baseDir }) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const { DRY_RUN, SANDBOX, log } = ctx;
  if (name === 'crhq-satellite') throw new Error('refusing to touch crhq-satellite');
  if (SANDBOX) { log.warn(`${type} ${name}: skipped under --sandbox`); return out(type, name, VERDICT.ALREADY, 'sandbox-skipped'); }
  if (DRY_RUN) { log.dry(`remove ${type} ${name} (pm2 delete + rm vhost + nginx reload)`); return out(type, name, VERDICT.OK, 'removed'); }

  sh(ctx, 'pm2', ['delete', name], { allowFail: true });
  sh(ctx, 'pm2', ['save'], { allowFail: true });
  removeTree(join(NGINX_DIR, `${name}.conf`), { dryRun: false });
  sh(ctx, 'sudo', ['nginx', '-s', 'reload'], { allowFail: true });
  removeTree(join(baseDir, name), { dryRun: false });   // remove deployed dir/symlink (incl. .env)
  return out(type, name, VERDICT.OK, 'removed');
}

export function statusService(ctx, nameOrDef) {
  return statusWebApp(ctx, nameOrDef, {
    type: 'service',
    baseDir: ctx.SERVICES_BASE || resolveServicesBase(),
  });
}

export function statusProject(ctx, nameOrDef) {
  return statusWebApp(ctx, nameOrDef, {
    type: 'project',
    baseDir: ctx.USER_PROJECTS_BASE || resolveUserProjectsBase(),
  });
}

function statusWebApp(ctx, nameOrDef, { type, baseDir }) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const dirPresent = existsSync(join(baseDir, name));
  const vhostPresent = existsSync(join(NGINX_DIR, `${name}.conf`));
  const pm2Present = spawnSync('pm2', ['describe', name], { stdio: 'ignore' }).status === 0;
  return { type, name, verdict: dirPresent ? VERDICT.ALREADY : VERDICT.ABSENT, dirPresent, vhostPresent, pm2Present };
}

function sh(ctx, cmd, args, { cwd, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.status})`);
  return r;
}

function isSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function out(type, name, verdict, action) { return { type, name, verdict, action }; }
