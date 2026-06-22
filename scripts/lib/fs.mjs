// fs.mjs — filesystem helpers. Callers pass absolute paths rooted at ctx.BASE (C2). Every helper
// honors dry-run (zero writes) and is idempotent (skips byte-identical content, GAP 5).
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync,
  lstatSync, readlinkSync, symlinkSync, unlinkSync, renameSync,
} from 'fs';
import { join, dirname, resolve } from 'path';

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
// the export look "changed" on every run).
export function copyTree(srcDir, destDir, { dryRun = false, skip = null } = {}) {
  return copyTreeRel(srcDir, destDir, '', dryRun, skip);
}

function copyTreeRel(srcDir, destDir, rel, dryRun, skip) {
  let changed = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip && skip(r)) continue;
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      changed += copyTreeRel(src, dest, r, dryRun, skip);
    } else if (entry.isFile()) {
      if (writeBufIfChanged(dest, readFileSync(src), dryRun)) changed++;
    }
  }
  return changed;
}

function writeBufIfChanged(path, buf, dryRun) {
  if (existsSync(path)) {
    try { if (readFileSync(path).equals(buf)) return false; } catch { /* fall through to write */ }
  }
  if (dryRun) return true;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buf);
  return true;
}

// Filesystem-safe file/dir base name for a component name (backup path): keep [A-Za-z0-9._-],
// map every other run of characters to '-'; never empty or dot-leading. Collisions between two
// distinct names that sanitize identically are deduped by the caller.
export function safeName(name) {
  const s = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return s || 'unnamed';
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
