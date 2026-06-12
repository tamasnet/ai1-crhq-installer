// install-log.mjs — persistent record of what's installed: ${PACKAGES_DIR}/install.json
// (default ~/packages) — D-24. Keyed by package name; each entry carries the package version
// plus per-component {type, name, version?, installed_at, source} where source is the
// component's manifest file relative to the package root. Never written in dry-run or status
// mode; uninstalling removes entries outright (the package key goes when its last component
// does). --sandbox redirects PACKAGES_DIR to a throwaway dir so test runs never touch the
// real log.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { homedir } from 'os';
import { VERDICT } from './log.mjs';

const COMPONENT_TYPES = ['skill', 'recipe', 'agent', 'job', 'service'];

export function resolvePackagesDir() {
  return process.env.PACKAGES_DIR || join(homedir(), 'packages');
}

export function installLogPath(packagesDir = resolvePackagesDir()) {
  return join(packagesDir, 'install.json');
}

export function readInstallLog(packagesDir = resolvePackagesDir()) {
  const p = installLogPath(packagesDir);
  if (!existsSync(p)) return {};
  const data = JSON.parse(readFileSync(p, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`install log is not an object: ${p}`);
  return data;
}

// The component's own manifest file, relative to the package root (the log's `source` field).
function sourceOf(type, def, packageRoot) {
  if (type === 'skill') return relative(packageRoot, join(def.srcDir, 'SKILL.md'));
  if (type === 'service') return relative(packageRoot, join(def.srcDir, 'service.yaml'));
  return relative(packageRoot, def.srcFile);
}

// Apply a finished run to the log. Only components that were actually processed change:
// install upserts an entry per OK/ALREADY result (ALREADY keeps its original date); uninstall
// deletes the entry (ALREADY = already absent → still deleted); failures leave the log alone.
// Returns the log path when written, null when skipped (dry-run / status / nothing to apply).
export function updateInstallLog(ctx, meta, plan, packageRoot) {
  if (ctx.DRY_RUN || ctx.mode === 'status') return null;

  const defOf = (type, name) => (plan[`${type}s`] || []).find((d) => d.name === name);
  const processed = ctx.results.filter(
    (r) => COMPONENT_TYPES.includes(r.type)
      && (r.verdict === VERDICT.OK || r.verdict === VERDICT.ALREADY),
  );
  if (!processed.length) return null;

  const packagesDir = ctx.PACKAGES_DIR || resolvePackagesDir();
  let log;
  try {
    log = readInstallLog(packagesDir);
  } catch (e) {
    ctx.log.warn(`install log unreadable (${e.message}) — starting a fresh one`);
    log = {};
  }
  const pkg = log[meta.name] || { version: String(meta.version), components: [] };
  const keyOf = (c) => `${c.type}:${c.name}`;
  const byKey = new Map(pkg.components.map((c) => [keyOf(c), c]));
  const now = new Date().toISOString();

  for (const r of processed) {
    if (ctx.mode === 'uninstall') {
      byKey.delete(keyOf(r));
      continue;
    }
    const def = defOf(r.type, r.name);
    const prior = byKey.get(keyOf(r));
    const entry = {
      type: r.type,
      name: r.name,
      ...(def?.version ? { version: String(def.version) } : {}),
      installed_at: r.verdict === VERDICT.ALREADY && prior?.installed_at ? prior.installed_at : now,
      ...(def ? { source: sourceOf(r.type, def, packageRoot) } : {}),
    };
    byKey.set(keyOf(r), entry);
  }

  pkg.components = [...byKey.values()];
  if (pkg.components.length) {
    pkg.version = String(meta.version);
    if (ctx.mode === 'install') pkg.installed_at = now;       // last install run that touched the package
    else pkg.installed_at = pkg.installed_at || now;          // partial uninstall keeps the install date
    log[meta.name] = pkg;
  } else {
    delete log[meta.name];   // last component gone → the package entry goes with it
  }

  mkdirSync(packagesDir, { recursive: true });
  const p = installLogPath(packagesDir);
  writeFileSync(p, `${JSON.stringify(log, null, 2)}\n`);
  return p;
}
