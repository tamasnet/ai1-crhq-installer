// list-available.mjs — a discovery view across the satellite's LOCAL package stores. It
// answers "what can I install, and what's the state of what I already installed?" without touching
// the DB. It scans the two places install-ready packages land on a satellite —
//   • PACKAGE_BASE_DIR (default ~/packages) — where `remote.mjs get-package` extracts downloaded
//     packages as `<name>@<version>/` dirs (resolvePackageBase, lib/remote.mjs)
//   • REPOS_BASE_DIR   (default ~/repos)    — where `polaris.mjs init` clones Client Repositories,
//     each pairing a `platform/` and a `user/` Ai1 Package (resolveReposBase, lib/polaris.mjs)
// — enumerates every component each discovered package declares, then cross-references
// ${PACKAGES_DIR}/install.json (the install log) to label each component AT EACH VERSION (a
// component found at multiple versions across packages is listed once per version):
//   available — declared by a local package at this version, not the version in the install log
//   installed — the version recorded in the install log, still declared by a local package
//   missing   — the version recorded in the install log, found in NO local package (its source is
//               gone, so it can't be repaired/reinstalled from the local stores)
// Read-only and DB-free: it powers `install.mjs --list-available`, the package-store-aware companion
// to `--list-installed`. The pure functions are unit-testable without a live satellite.
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { loadManifest } from './manifest.mjs';
import { readInstallLog, resolvePackagesDir, COMPONENT_TYPES } from './install-log.mjs';
import { resolvePackageBase } from './remote.mjs';
import { resolveReposBase } from './polaris.mjs';

// Render an absolute path with the home dir collapsed to `~`, so locations stay short in the table.
function abbrev(p) {
  const home = homedir();
  return home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;
}

// Walk `baseDir` (up to `maxDepth` levels deep) collecting every directory that holds an
// `ai1-package.yaml`. Descent STOPS at the first manifest found on a branch, so a package's own
// component subtrees (skills/, services/, projects/, …) are never themselves mistaken for packages — and the
// conventional layouts both resolve naturally: `~/packages/<name>@<version>/` (depth 1) and a Client
// Repo's `~/repos/<repo>/{platform,user}/` (depth 2). Hidden dirs (`.git`, the `.<slug>.stage-*`
// temp dirs get-package writes) and `node_modules` are skipped; symlinked dirs are not followed (so
// the walk can't loop). Returns the package directories (absolute); the caller sorts the final rows.
export function discoverPackages(baseDir, { maxDepth = 3 } = {}) {
  const found = [];
  if (!baseDir || !existsSync(baseDir)) return found;
  const walk = (dir, depth) => {
    if (existsSync(join(dir, 'ai1-package.yaml'))) { found.push(dir); return; }   // package root — stop
    if (depth >= maxDepth) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;                                  // skip files + symlinks (no loops)
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      walk(join(dir, e.name), depth + 1);
    }
  };
  walk(baseDir, 0);
  return found;
}

// Load one package's manifest and flatten its declared components to `{ type, name, version }` (type
// in singular form to match the install log). Throws on a bad/unreadable manifest — the caller
// catches and records a per-package warning so one broken package never aborts the whole listing.
function packageComponents(dir) {
  const { meta, plan } = loadManifest(dir);
  const comps = [];
  for (const type of COMPONENT_TYPES) {
    for (const def of plan[`${type}s`] || []) {
      comps.push({ type, name: def.name, version: def.version ?? null });
    }
  }
  return { meta, comps };
}

// Stable display order: by component type (canonical install order), then name, then version
// (numeric where possible; null versions last). The version tiebreak keeps the separate rows for a
// component that exists at multiple versions in a sensible order.
export function sortAvailable(rows) {
  const rank = (t) => { const i = COMPONENT_TYPES.indexOf(t); return i === -1 ? COMPONENT_TYPES.length : i; };
  const vcmp = (a, b) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;                       // null versions sort last within a name
    if (b == null) return -1;
    const na = Number(a); const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return String(a).localeCompare(String(b));
  };
  return [...rows].sort((a, b) =>
    rank(a.type) - rank(b.type)
    || String(a.name).localeCompare(String(b.name))
    || vcmp(a.version, b.version));
}

// Cross-reference the local package stores with the install log into one row per component identity
// AND version (`type:name@version`) — so a component that exists at multiple versions across packages
// shows as one row PER version (each with its own providers/status), while same-version copies from
// different packages stay one row with multiple providers (the genuine duplicate case). `stores` =
// [{ label, base }] (duplicate/empty bases are ignored). `installLog` = the parsed install log. Returns
// { rows, warnings, scanned }:
//   rows     — sorted; each { type, name, version, status, providers[], log } where providers lists
//              every package that declares the component at THIS version (so duplicate sources are
//              visible) and `log` is the install-log entry when it pins this same version.
//   warnings — packages whose manifest failed to load.
//   scanned  — the store dirs actually inspected (with a present/absent flag), for the header.
export function collectAvailable({ stores = [], installLog = [] } = {}) {
  const byKey = new Map();                       // type:name@version → row
  const warnings = [];
  const scanned = [];
  const keyOf = (type, name, version) => `${type}:${name}@${version == null ? '' : version}`;
  const ensure = (type, name, version) => {
    const k = keyOf(type, name, version);
    if (!byKey.has(k)) byKey.set(k, { type, name, version: version ?? null, providers: [], log: null });
    return byKey.get(k);
  };

  const seenBase = new Set();
  for (const { label, base } of stores) {
    if (!base || seenBase.has(base)) continue;   // dedupe stores so an equal base isn't double-counted
    seenBase.add(base);
    const present = existsSync(base);
    scanned.push({ label, base, dir: abbrev(base), present });
    if (!present) continue;
    for (const dir of discoverPackages(base)) {
      let loaded;
      try { loaded = packageComponents(dir); }
      catch (e) { warnings.push({ dir: abbrev(dir), message: e.message }); continue; }
      for (const c of loaded.comps) {
        const row = ensure(c.type, c.name, c.version);
        row.providers.push({
          package: loaded.meta.name,
          package_version: String(loaded.meta.version),
          version: c.version ?? null,
          location: abbrev(dir),
          store: label,
        });
      }
    }
  }

  // Fold in the install log, matching on the SAME version it pins: attaching to the provider row for
  // (type, name, installed-version) marks that exact version `installed` while other available
  // versions stay `available`. If no package declares that version (or the component at all), the
  // ensure() call creates a provider-less row → `missing` (the installed bits aren't backed locally).
  for (const entry of installLog) {
    if (!entry || !entry.type || entry.name == null) continue;
    ensure(entry.type, entry.name, entry.version ?? null).log = entry;
  }

  const rows = sortAvailable([...byKey.values()].map((r) => ({
    ...r,
    status: r.log ? (r.providers.length ? 'installed' : 'missing') : 'available',
  })));
  return { rows, warnings, scanned };
}

// Render the joined view as an aligned, human-readable table. Columns:
//   STATUS  TYPE  NAME  VERSION  PACKAGE  LOCATION
// PACKAGE/LOCATION list every provider (distinct), so duplicate sources are visible at a glance; a
// `missing` row falls back to the package recorded in the install log with an em-dash location. An
// empty result → a one-line notice (plus the scanned dirs). Store-scan/manifest warnings, if any,
// are appended below the table.
export function formatAvailableList({ rows = [], warnings = [], scanned = [] } = {}) {
  const scannedLine = scanned.length
    ? `  scanned: ${scanned.map((s) => `${s.dir}${s.present ? '' : ' (absent)'}`).join('  ')}`
    : '';
  const warnLines = warnings.map((w) => `  ⚠ ${w.dir}: ${w.message}`);

  if (!rows.length) {
    return ['No components available.', scannedLine, ...warnLines].filter(Boolean).join('\n');
  }

  const cells = rows.map((r) => ({
    status: r.status,
    type: r.type,
    name: String(r.name),
    version: r.version != null ? String(r.version) : '—',
    package: r.providers.length
      ? [...new Set(r.providers.map((p) => `${p.package}@${p.package_version}`))].join(', ')
      : (r.log ? `${r.log.package ?? '?'}@${r.log.package_version ?? '?'}` : '—'),
    location: r.providers.length
      ? [...new Set(r.providers.map((p) => p.location))].join('; ')
      : '—',
  }));
  const head = { status: 'STATUS', type: 'TYPE', name: 'NAME', version: 'VERSION', package: 'PACKAGE', location: 'LOCATION' };
  const width = (k) => Math.max(...[head, ...cells].map((c) => c[k].length));
  const w = {
    status: width('status'), type: width('type'), name: width('name'),
    version: width('version'), package: width('package'),
  };
  const line = (c) => `  ${c.status.padEnd(w.status)}  ${c.type.padEnd(w.type)}  ${c.name.padEnd(w.name)}  ${c.version.padEnd(w.version)}  ${c.package.padEnd(w.package)}  ${c.location}`;

  const counts = rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const summary = `Available components (${rows.length}): `
    + `[available ${counts.available || 0}, installed ${counts.installed || 0}, missing ${counts.missing || 0}]`;

  const out = [summary];
  if (scannedLine) out.push(scannedLine);
  out.push('', line(head), ...cells.map(line));
  if (warnLines.length) out.push('', ...warnLines);
  return out.join('\n');
}

// Resolve the default stores (PACKAGE_BASE_DIR + REPOS_BASE_DIR) and the install log, then build the
// report. Used by the CLI for both the table and the `--json` rows array. An unreadable install log
// degrades gracefully — recorded as a warning and treated as empty — so the available/missing view
// still works (the install cross-reference is just absent).
export function buildAvailableReport() {
  const stores = [
    { label: 'packages', base: resolvePackageBase() },
    { label: 'repos', base: resolveReposBase() },
  ];
  let installLog = [];
  const preWarnings = [];
  try {
    installLog = readInstallLog(resolvePackagesDir());
  } catch (e) {
    preWarnings.push({ dir: abbrev(resolvePackagesDir()), message: `install log unreadable: ${e.message}` });
  }
  const report = collectAvailable({ stores, installLog });
  report.warnings = [...preWarnings, ...report.warnings];
  return report;
}
