// protect.mjs — the shared "protect" concept for component files. Protected paths are entries the
// tooling treats as runtime state, not package content: never deleted by a --strict install prune
// and never exported by sync. Install COPY is deliberately unaffected — a package that ships a
// protected path installs it once as one-way seed data (warned at install; see listProtectedEntries).
//
// Pattern tiers (all use simple globs: `*` any chars within a segment, `?` one char, `**` any depth):
//   - no `/` and no `**` → top-level name only (backward compatible)
//   - contains `/`      → anchored path prefix from the component root (+ descendants)
//   - contains `**`      → match at any depth (e.g. `**/node_modules`)
//
// DEFAULT_PROTECT applies to every component; manifest `protect:` extends it; `!pattern` removes that
// exact pattern from the effective set (literal match, resolved after all additions).
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

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

function isTopLevelPattern(pattern) {
  return !pattern.includes('/') && !pattern.includes('**');
}

// Glob → anchored regex for a single path segment.
function segmentGlobRegex(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
}

// Top-level glob (legacy): `*` and `?` only, matched against one name.
function topGlobRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// Path glob without `**`: anchored prefix — matches the path and all descendants.
function pathPrefixRegex(pattern) {
  const segs = pattern.split('/').map(segmentGlobRegex);
  return new RegExp(`^${segs.join('\\/')}(?:\\/.*)?$`);
}

// Path glob with `**`: `**` matches zero or more path segments; still prefix-protects descendants.
function globstarRegex(pattern) {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 3;
      } else {
        re += '.*';
        i += 2;
      }
    } else if (pattern[i] === '*') {
      re += '[^/]*';
      i += 1;
    } else if (pattern[i] === '?') {
      re += '[^/]';
      i += 1;
    } else if (pattern[i] === '/') {
      re += '\\/';
      i += 1;
    } else {
      re += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  re += '(?:\\/.*)?$';
  return new RegExp(re);
}

function compilePattern(pattern) {
  if (isTopLevelPattern(pattern)) {
    return { kind: 'top', re: topGlobRegex(pattern), pattern };
  }
  if (pattern.includes('**')) {
    return { kind: 'path', re: globstarRegex(pattern), pattern };
  }
  return { kind: 'path', re: pathPrefixRegex(pattern), pattern };
}

// Best-effort key for logging which protected root was hit.
function protectionRoot(pattern, rel) {
  if (isTopLevelPattern(pattern)) return rel.split('/')[0];
  const relParts = rel.split('/');
  if (pattern.includes('**')) {
    const patParts = pattern.split('/');
    const starIdx = patParts.indexOf('**');
    if (starIdx >= 0 && starIdx < patParts.length - 1) {
      const tail = patParts.slice(starIdx + 1).join('/');
      const tailParts = tail.split('/');
      for (let i = 0; i <= relParts.length - tailParts.length; i++) {
        const slice = relParts.slice(i, i + tailParts.length).join('/');
        if (pathPrefixRegex(tail).test(slice)) {
          return relParts.slice(0, i + tailParts.length).join('/');
        }
      }
    }
    if (pattern === '**' || pattern.endsWith('/**')) {
      return relParts[0] ?? rel;
    }
  }
  const n = Math.min(pattern.split('/').length, relParts.length);
  return relParts.slice(0, n).join('/');
}

// Matcher in the skip(relPath) shape copyTree/pruneTree take. `matched` collects protected roots
// encountered during use so callers can log what was kept/skipped.
export function protectMatcher(protect = []) {
  const compiled = effectiveProtect(protect).map(compilePattern);
  const matched = new Set();
  const skip = (rel) => {
    for (const { kind, re, pattern } of compiled) {
      if (kind === 'top') {
        const top = rel.split('/')[0];
        if (!re.test(top)) continue;
        matched.add(top);
        return true;
      }
      if (!re.test(rel)) continue;
      matched.add(protectionRoot(pattern, rel));
      return true;
    }
    return false;
  };
  return { skip, matched };
}

// Entries under srcDir that match the protect set — i.e. protected paths a package SHIPS.
export function listProtectedEntries(srcDir, protect = []) {
  if (!srcDir || !existsSync(srcDir)) return [];
  const { skip } = protectMatcher(protect);
  const found = new Set();

  function walk(rel) {
    const full = rel ? join(srcDir, rel) : srcDir;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip(r)) {
        found.add(r);
        continue;
      }
      if (entry.isDirectory()) walk(r);
    }
  }

  walk('');
  return [...found].sort();
}
