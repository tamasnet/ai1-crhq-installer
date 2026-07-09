// fs.mjs — filesystem helpers. Callers pass absolute paths rooted at ctx.SKILLS_BASE. Every helper
// honors dry-run (zero writes) and is idempotent (skips byte-identical content).
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, rmdirSync,
  lstatSync, readlinkSync, symlinkSync, unlinkSync, renameSync,
  statSync, copyFileSync, chmodSync, utimesSync, openSync, readSync, closeSync,
} from 'fs';
import { join, dirname, resolve } from 'path';

const CMP_CHUNK = 64 * 1024;

export function writeIfChanged(path, content, { dryRun = false } = {}) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  if (dryRun) return true;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

// Recursively copy srcDir → destDir, skipping byte-identical files. Returns the number of files
// written (or that would be written, in dry-run). `skip(relPath)` (path relative to srcDir, using
// '/' separators) excludes matching entries — used by exportSkill to avoid copying the installed
// SKILL.md it is about to regenerate from the DB (which would otherwise flip-flop the file and make
// the export look "changed" on every run). `contentOnly` ignores mode/mtime-only differences —
// used by diff/drift reporting to suppress metadata noise; installs never set it.
export function copyTree(srcDir, destDir, { dryRun = false, skip = null, contentOnly = false } = {}) {
  return copyTreeRel(srcDir, destDir, '', dryRun, skip, contentOnly);
}

function copyTreeRel(srcDir, destDir, rel, dryRun, skip, contentOnly) {
  let changed = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip && skip(r)) continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      changed += copyTreeRel(src, dest, r, dryRun, skip, contentOnly);
    } else if (entry.isFile()) {
      if (copyFileIfChanged(src, dest, { dryRun, contentOnly })) changed++;
    }
  }
  return changed;
}

function modeBits(st) {
  return st.mode & 0o777;
}

function mtimeEqual(srcStat, destStat) {
  // utimes is second-granular on common filesystems; ignore sub-ms and atime (reads bump atime).
  return Math.floor(srcStat.mtimeMs / 1000) === Math.floor(destStat.mtimeMs / 1000);
}

// Mirror source mode + mtime onto dest when either differs.
function syncMetadata(dest, srcStat, { dryRun = false } = {}) {
  const destStat = statSync(dest);
  const srcMode = modeBits(srcStat);
  const needsMode = modeBits(destStat) !== srcMode;
  const needsTime = !mtimeEqual(srcStat, destStat);
  if (!needsMode && !needsTime) return false;
  if (dryRun) return true;
  if (needsMode) chmodSync(dest, srcMode);
  if (needsTime) utimesSync(dest, destStat.atime, srcStat.mtime);
  return true;
}

// Chunked byte compare — avoids loading whole files into memory (OOM on large assets).
function filesByteEqual(src, dest, size) {
  if (size === 0) return true;
  const fdA = openSync(src, 'r');
  const fdB = openSync(dest, 'r');
  const bufA = Buffer.alloc(CMP_CHUNK);
  const bufB = Buffer.alloc(CMP_CHUNK);
  try {
    let remaining = size;
    while (remaining > 0) {
      const n = Math.min(remaining, CMP_CHUNK);
      const ra = readSync(fdA, bufA, 0, n, null);
      const rb = readSync(fdB, bufB, 0, n, null);
      if (ra !== rb || !bufA.subarray(0, ra).equals(bufB.subarray(0, rb))) return false;
      remaining -= ra;
    }
    return true;
  } finally {
    closeSync(fdA);
    closeSync(fdB);
  }
}

// Copy when content differs; chmod when content matches but mode does not. Uses copyFileSync
// (kernel copy) instead of read/write buffers so large files do not allocate full-file buffers.
// Mode and mtime always mirror the source on any write path.
function copyFileIfChanged(src, dest, { dryRun = false, contentOnly = false } = {}) {
  const srcStat = statSync(src);

  if (existsSync(dest)) {
    let destStat;
    try { destStat = statSync(dest); } catch { destStat = null; }
    if (destStat?.isFile() && destStat.size === srcStat.size
        && filesByteEqual(src, dest, srcStat.size)) {
      if (contentOnly) return false;
      if (syncMetadata(dest, srcStat, { dryRun })) return true;
      return false;
    }
  }

  if (dryRun) return true;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  syncMetadata(dest, srcStat);
  return true;
}

// Filesystem-safe file/dir base name for a component name (sync path): keep [A-Za-z0-9._-],
// map every other run of characters to '-'; never empty or dot-leading. Collisions between two
// distinct names that sanitize identically are deduped by the caller.
export function safeName(name) {
  const s = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return s || 'unnamed';
}

// Delete files/dirs in destDir that are absent from srcDir (rsync --delete). skip(relPath) keeps
// matching dest entries even when not in src — callers pass protectMatcher(def.protect).skip so
// protected runtime state survives a --strict install. Returns the removed rel paths (or those
// that would be, in dry-run); a removed directory is a single entry with a trailing '/'.
export function pruneTree(destDir, srcDir, { dryRun = false, skip = null } = {}) {
  if (!existsSync(destDir) || !existsSync(srcDir)) return [];
  return pruneTreeRel(destDir, srcDir, '', dryRun, skip);
}

function pruneTreeRel(destDir, srcDir, rel, dryRun, skip) {
  const removed = [];
  for (const entry of readdirSync(destDir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip?.(r)) continue;
    const destPath = join(destDir, entry.name);
    const srcPath = join(srcDir, entry.name);
    if (!existsSync(srcPath)) {
      if (entry.isDirectory()) {
        removed.push(...pruneAbsentSubtree(destPath, r, dryRun, skip));
        if (!dryRun) {
          try {
            if (readdirSync(destPath).length === 0) {
              rmdirSync(destPath);
              removed.push(`${r}/`);
            }
          } catch { /* race */ }
        } else if (absentDirWouldEmpty(destPath, r, skip, removed)) {
          removed.push(`${r}/`);
        }
      } else {
        removed.push(r);
        if (!dryRun) rmSync(destPath, { force: true });
      }
      continue;
    }
    const srcStat = lstatSync(srcPath);
    if (entry.isDirectory() && srcStat.isDirectory()) {
      removed.push(...pruneTreeRel(destPath, srcPath, r, dryRun, skip));
    }
  }
  return removed;
}

// Remove entries under a dest-only directory, respecting skip on nested paths.
function pruneAbsentSubtree(destDir, rel, dryRun, skip) {
  const removed = [];
  for (const entry of readdirSync(destDir, { withFileTypes: true })) {
    const r = `${rel}/${entry.name}`;
    if (skip?.(r)) continue;
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      removed.push(...pruneAbsentSubtree(destPath, r, dryRun, skip));
      if (!dryRun) {
        try {
          if (readdirSync(destPath).length === 0) {
            rmdirSync(destPath);
            removed.push(`${r}/`);
          }
        } catch { /* race */ }
      } else if (absentDirWouldEmpty(destPath, r, skip, removed)) {
        removed.push(`${r}/`);
      }
    } else {
      removed.push(r);
      if (!dryRun) rmSync(destPath, { force: true });
    }
  }
  return removed;
}

function absentDirWouldEmpty(dir, rel, skip, removed) {
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) return true;
  return entries.every((e) => {
    const r = `${rel}/${e.name}`;
    if (skip?.(r)) return false;
    return removed.includes(r) || removed.includes(`${r}/`);
  });
}

// Compare srcDir (package) against destDir (live) without writing. Returns rel-path lists:
// modified (bytes differ), missing (in src, not live), extra (live-only, via pruneTree dry-run —
// dirs with trailing '/'), meta (strict only: annotated mode/mtime-only differences, e.g.
// 'run.sh (mode 644→755)' package→live, or 'a.txt (mtime)'). copySkip/pruneSkip mirror install.
export function diffTree(srcDir, destDir, { copySkip = null, pruneSkip = null, strict = false } = {}) {
  const out = { modified: [], missing: [], extra: [], meta: [] };
  if (!srcDir || !existsSync(srcDir)) return out;
  diffTreeRel(srcDir, destDir, '', copySkip, strict, out);
  if (existsSync(destDir)) out.extra = pruneTree(destDir, srcDir, { dryRun: true, skip: pruneSkip });
  return out;
}

function diffTreeRel(srcDir, destDir, rel, skip, strict, out) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip && skip(r)) continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) { diffTreeRel(src, dest, r, skip, strict, out); continue; }
    if (!entry.isFile()) continue;
    let destStat = null;
    try { destStat = statSync(dest); } catch { /* missing */ }
    if (!destStat?.isFile()) { out.missing.push(r); continue; }
    const srcStat = statSync(src);
    if (srcStat.size !== destStat.size || !filesByteEqual(src, dest, srcStat.size)) {
      out.modified.push(r);
    } else if (strict && modeBits(srcStat) !== modeBits(destStat)) {
      out.meta.push(`${r} (mode ${modeBits(srcStat).toString(8)}→${modeBits(destStat).toString(8)})`);
    } else if (strict && !mtimeEqual(srcStat, destStat)) {
      out.meta.push(`${r} (mtime)`);
    }
  }
}

// Copy package assets then optionally prune extras so dest matches src (--strict install).
// `pruned` is the list of removed rel paths (empty when not strict).
export function syncInstallTree(srcDir, destDir, { dryRun = false, strict = false, copySkip = null, pruneSkip = null, contentOnly = false } = {}) {
  if (!srcDir || !existsSync(srcDir)) return { files: 0, pruned: [] };
  const files = copyTree(srcDir, destDir, { dryRun, skip: copySkip, contentOnly });
  const pruned = strict && existsSync(destDir)
    ? pruneTree(destDir, srcDir, { dryRun, skip: pruneSkip })
    : [];
  return { files, pruned };
}

export function removeTree(path, { dryRun = false } = {}) {
  if (!path || !pathExistsOrLink(path)) return false;
  if (dryRun) return true;
  rmSync(path, { recursive: true, force: true });
  return true;
}

function lstatMaybe(path) {
  try { return lstatSync(path); } catch { return null; }
}

export function pathExistsOrLink(path) {
  return !!lstatMaybe(path);
}

export function ensureSymlink(linkPath, targetPath, { dryRun = false, replaceNonSymlink = false } = {}) {
  const st = lstatMaybe(linkPath);
  const absTarget = resolve(targetPath);
  if (st?.isSymbolicLink()) {
    const cur = readlinkSync(linkPath);
    const curAbs = resolve(dirname(linkPath), cur);
    if (curAbs === absTarget) return false;
    if (dryRun) return true;
    unlinkSync(linkPath);
    symlinkSync(absTarget, linkPath, 'dir');
    return true;
  }
  if (st) {
    if (!replaceNonSymlink) throw new Error(`${linkPath} exists and is not a symlink`);
    if (dryRun) return true;
    rmSync(linkPath, { recursive: true, force: true });
  }
  if (dryRun) return true;
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(absTarget, linkPath, 'dir');
  return true;
}

export function moveTree(srcDir, destDir, { dryRun = false } = {}) {
  if (!pathExistsOrLink(srcDir)) throw new Error(`source does not exist: ${srcDir}`);
  if (pathExistsOrLink(destDir)) throw new Error(`destination already exists: ${destDir}`);
  if (dryRun) return true;
  mkdirSync(dirname(destDir), { recursive: true });
  try {
    renameSync(srcDir, destDir);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    copyTree(srcDir, destDir, { dryRun: false });
    removeTree(srcDir, { dryRun: false });
  }
  return true;
}
