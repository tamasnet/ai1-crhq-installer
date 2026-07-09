// protect.mjs — the shared "protect" concept for component files. A protected name is a TOP-LEVEL
// entry of a component's install/live directory that the tooling treats as runtime state, not
// package content: it is never deleted by a --strict install prune and never exported by sync.
// Install COPY is deliberately unaffected — a package that ships a protected name installs it once
// as one-way seed data (warned at install; see listProtectedEntries).
//
// Patterns are simple globs (`*` and `?` only) matched against the top-level path element — never
// nested elements, never the full path. DEFAULT_PROTECT applies to every component; a component's
// manifest entry `protect:` list extends it, and a `!pattern` entry removes that exact pattern from
// the effective set (literal match on the pattern string, resolved after all additions, so order
// never matters). This replaces the former AGENT_BRAIN_EXCLUDE env mechanism.
import { existsSync, readdirSync } from 'fs';

export const DEFAULT_PROTECT = [
  '.*',                    // dotfiles/dirs: .env, .scratch, .cache, …
  '_*',                    // underscore-prefixed: _backup, _private, …
  'activity', 'memory',    // agent-brain runtime dirs
  'data', 'config', 'state', 'uploads', 'backup', 'logs',   // common runtime-state names
  'ecosystem.config.cjs',  // installer-generated PM2 config (kept out of prune drift)
];

// Resolve the effective pattern set: defaults ∪ additions, minus every '!'-negated pattern.
export function effectiveProtect(protect = []) {
  const set = new Set(DEFAULT_PROTECT);
  const negations = [];
  for (const raw of protect ?? []) {
    const p = String(raw).trim();
    if (!p) continue;
    if (p.startsWith('!')) negations.push(p.slice(1));
    else set.add(p);
  }
  for (const n of negations) set.delete(n);
  return [...set];
}

// Glob → anchored regex. Only `*` (any run) and `?` (one char) are special; the rest is literal.
function globRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// Matcher over top-level path elements, in the skip(relPath) shape copyTree/pruneTree take.
// `matched` collects the top-level names actually protected during use, so callers can log
// exactly what was kept/skipped instead of silently dropping it.
export function protectMatcher(protect = []) {
  const regexes = effectiveProtect(protect).map(globRegex);
  const matched = new Set();
  const skip = (rel) => {
    const top = rel.split('/')[0];
    if (!regexes.some((r) => r.test(top))) return false;
    matched.add(top);
    return true;
  };
  return { skip, matched };
}

// Top-level entries of srcDir that match the protect set — i.e. protected names a package SHIPS.
// They install (copy is unaffected) but will never be pruned or synced afterward; callers warn so
// the one-way-seed semantics are deliberate, not accidental.
export function listProtectedEntries(srcDir, protect = []) {
  if (!srcDir || !existsSync(srcDir)) return [];
  const { skip } = protectMatcher(protect);
  return readdirSync(srcDir).filter((name) => skip(name)).sort();
}
