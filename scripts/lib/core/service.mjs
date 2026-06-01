// core/service.mjs — services are nginx + PM2 web apps (NOT DB-resident), deployed via the
// deploy-project conventions (D-2). PHASE 1 SCOPE: this module implements the build step + the
// dry-run path (D-2a: build runs, apply is skipped) and read-only status. The live deploy/teardown
// (port alloc, PM2, nginx vhost+reload) is intentionally deferred to Phase 6 (D-2b still open) and
// is NOT exercised by the sandbox lifecycle, which models DB + fs only.
import { existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { VERDICT } from '../log.mjs';

export async function installService(ctx, def) {
  const { log, DRY_RUN } = ctx;
  if (def.build) {
    log.info(`service ${def.name}: running build (${def.build})`);
    const r = spawnSync(def.build, { cwd: def.srcDir, shell: true, stdio: 'inherit' });
    if (r.status !== 0) return out(def.name, VERDICT.FAIL, 'build-failed');
  }
  if (DRY_RUN) {
    log.dry(`deploy service ${def.name} (nginx vhost + PM2) — apply skipped (D-2a)`);
    return out(def.name, VERDICT.OK, 'built');
  }
  log.warn(`service ${def.name}: live deploy lands in Phase 6 — not applied`);
  return out(def.name, VERDICT.PARTIAL, 'deferred-phase6');
}

export async function removeService(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  ctx.log.warn(`service ${name}: live teardown lands in Phase 6 — not applied`);
  return out(name, VERDICT.PARTIAL, 'deferred-phase6');
}

export function statusService(ctx, nameOrDef) {
  const name = typeof nameOrDef === 'string' ? nameOrDef : nameOrDef.name;
  const dirPresent = existsSync(join('/opt/projects/user', name));
  const vhostPresent = existsSync(join('/etc/nginx/projects.d', `${name}.conf`));
  return { type: 'service', name, verdict: dirPresent ? VERDICT.ALREADY : VERDICT.ABSENT, dirPresent, vhostPresent, pm2Present: false };
}

function out(name, verdict, action) { return { type: 'service', name, verdict, action }; }
