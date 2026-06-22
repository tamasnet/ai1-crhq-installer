// install-log.mjs — persistent record of what's installed: ${PACKAGES_DIR}/install.json
// (default ~/packages) — D-24. A FLAT list of installed components, one entry per component
// identity (`type:name`). This mirrors the DB, which allows exactly one row per component name, so
// the log holds exactly one slot per component. Each entry carries the component's own version
// (when it has one) plus provenance: the `package` and `package_version` it was last installed
// from, the `source` manifest file relative to that package root, and the `installed_at` time.
// Because there is one slot per component, re-installing it — from a newer version of the same
// package, or from a different package entirely — TRANSFERS ownership by overwriting that slot;
// duplicate or stale claims cannot exist. A partial upgrade therefore shows up faithfully as mixed
// package_versions across a package's components. Never written in dry-run or status mode;
// uninstalling removes the entry. --sandbox redirects PACKAGES_DIR to a throwaway dir so test runs
// never touch the real log.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { homedir } from 'os';
import { VERDICT } from './log.mjs';

// Canonical component types in install order (singular form, as stored in the log). Exported so the
// availability view (list-available.mjs) shares one source of truth for type ranking.
export const COMPONENT_TYPES = ['skill', 'recipe', 'agent', 'job', 'service', 'project'];

export function resolvePackagesDir() {
  return process.env.PACKAGES_DIR || join(homedir(), 'packages');
}

export function installLogPath(packagesDir = resolvePackagesDir()) {
  return join(packagesDir, 'install.json');
}

// The log is a flat array of component entries ([] if absent).
export function readInstallLog(packagesDir = resolvePackagesDir()) {
  const p = installLogPath(packagesDir);
  if (!existsSync(p)) return [];
  const data = JSON.parse(readFileSync(p, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`install log is not an array: ${p}`);
  return data;
}

// The component's own manifest file, relative to the package root (the log's `source` field).
function sourceOf(type, def, packageRoot) {
  if (type === 'skill') return relative(packageRoot, join(def.srcDir, 'SKILL.md'));
  if (type === 'service' || type === 'project') return relative(packageRoot, def.srcFile || join(def.srcDir, `${type}.yaml`));
  return relative(packageRoot, def.srcFile);
}

// Stable display order: by component type (canonical install order) then name. Returns a new array.
export function sortInstalled(entries) {
  const rank = (t) => { const i = COMPONENT_TYPES.indexOf(t); return i === -1 ? COMPONENT_TYPES.length : i; };
  return [...entries].sort((a, b) => rank(a.type) - rank(b.type) || String(a.name).localeCompare(String(b.name)));
}

// Render the log as an aligned, human-readable table sorted by type then name (--list-installed).
// Empty log → a one-line notice. Columns: TYPE, NAME, VERSION (component's own, '—' if none), and
// FROM (the package@package_version it was installed from).
export function formatInstalledList(entries) {
  if (!entries || !entries.length) return 'No components installed.';
  const rows = sortInstalled(entries).map((r) => ({
    type: r.type,
    name: String(r.name),
    version: r.version != null ? String(r.version) : '—',
    from: `${r.package ?? '?'}@${r.package_version ?? '?'}`,
  }));
  const head = { type: 'TYPE', name: 'NAME', version: 'VERSION', from: 'FROM' };
  const width = (k) => Math.max(...[head, ...rows].map((c) => c[k].length));
  const tw = width('type'); const nw = width('name'); const vw = width('version');
  const line = (c) => `  ${c.type.padEnd(tw)}  ${c.name.padEnd(nw)}  ${c.version.padEnd(vw)}  ${c.from}`;
  return [`Installed components (${rows.length}):`, '', line(head), ...rows.map(line)].join('\n');
}

// Apply a finished run to the log. Only components that were actually processed change: install
// upserts the component's slot — ALREADY keeps its original install date (the bits didn't change),
// while package/package_version/source/version always reflect the current run, so ownership
// transfers in place; uninstall deletes the slot (ALREADY = already absent → still deleted);
// failures leave the log alone. Returns the log path when written, null when skipped (dry-run /
// status / nothing to apply).
export function updateInstallLog(ctx, meta, plan, packageRoot) {
  if (ctx.DRY_RUN || ctx.mode === 'status') return null;

  const defOf = (type, name) => (plan[`${type}s`] || []).find((d) => d.name === name);
  const processed = ctx.results.filter(
    (r) => COMPONENT_TYPES.includes(r.type)
      && (r.verdict === VERDICT.OK || r.verdict === VERDICT.ALREADY),
  );
  if (!processed.length) return null;

  const packagesDir = ctx.PACKAGES_DIR || resolvePackagesDir();
  let entries;
  try {
    entries = readInstallLog(packagesDir);
  } catch (e) {
    ctx.log.warn(`install log unreadable (${e.message}) — starting a fresh one`);
    entries = [];
  }
  const keyOf = (c) => `${c.type}:${c.name}`;
  const byKey = new Map(entries.map((c) => [keyOf(c), c]));
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
      ...(def?.version != null ? { version: def.version } : {}),   // integer component version (D-34)
      package: meta.name,
      package_version: String(meta.version),
      ...(def ? { source: sourceOf(r.type, def, packageRoot) } : {}),
      installed_at: r.verdict === VERDICT.ALREADY && prior?.installed_at ? prior.installed_at : now,
    };
    byKey.set(keyOf(r), entry);
  }

  mkdirSync(packagesDir, { recursive: true });
  const p = installLogPath(packagesDir);
  writeFileSync(p, `${JSON.stringify([...byKey.values()], null, 2)}\n`);
  return p;
}

// Apply a finished `sync --mirror` run to the install log (D-48) so it reflects the live satellite
// for the components THIS mirror package now carries — and ONLY those. A mirror exports live
// components out of the satellite into the package, so each component it included (added/synced/
// unchanged) UPSERTS its slot, attributed to the mirror package: ownership transfers in place under
// the same one-slot-per-`type:name` rule a real install from this package would follow (D-24). Each
// component the mirror REMOVED (gone from the satellite) drops its slot. Components this run did not
// touch — out-of-scope entries, other packages' components — are left exactly as they were. No-op in
// dry-run or when there's nothing to apply; write-if-changed, so a no-op mirror never rewrites the
// file. Bookkeeping only — the CLI treats a throw as a warning, never a failure. Returns the log path
// when it actually wrote, else null.
//
//   applied.installed: [{ type, name, version?, source? }]  — present in the package after the run
//   applied.removed:   [{ type, name }]                       — dropped (gone from the satellite)
//   applied.pkg:       { name, version }                      — the mirror package, for provenance
export function updateInstallLogForMirror(ctx, { installed = [], removed = [], pkg } = {}) {
  if (ctx.DRY_RUN) return null;
  if (!pkg || (!installed.length && !removed.length)) return null;

  const packagesDir = ctx.PACKAGES_DIR || resolvePackagesDir();
  let entries;
  try {
    entries = readInstallLog(packagesDir);
  } catch (e) {
    ctx.log?.warn?.(`install log unreadable (${e.message}) — starting a fresh one`);
    entries = [];
  }

  const keyOf = (c) => `${c.type}:${c.name}`;
  const byKey = new Map(entries.map((c) => [keyOf(c), c]));
  const now = new Date().toISOString();

  for (const c of removed) byKey.delete(keyOf(c));

  for (const c of installed) {
    const prior = byKey.get(keyOf(c));
    byKey.set(keyOf(c), {
      type: c.type,
      name: c.name,
      ...(c.version != null ? { version: c.version } : {}),
      package: pkg.name,
      package_version: String(pkg.version),
      ...(c.source ? { source: c.source } : {}),
      // The component was already live (the mirror captured it) — keep its original install date.
      installed_at: prior?.installed_at ?? now,
    });
  }

  const out = `${JSON.stringify([...byKey.values()], null, 2)}\n`;
  const p = installLogPath(packagesDir);
  let prev = null;
  try { prev = readFileSync(p, 'utf8'); } catch { /* absent → write below */ }
  if (prev === out) return null;            // unchanged → don't rewrite (a no-op mirror stays a no-op)

  mkdirSync(packagesDir, { recursive: true });
  writeFileSync(p, out);
  return p;
}
