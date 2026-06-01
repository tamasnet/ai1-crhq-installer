// fs.mjs — filesystem helpers. Callers pass absolute paths rooted at ctx.BASE (C2). Every helper
// honors dry-run (zero writes) and is idempotent (skips byte-identical content, GAP 5).
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';

export function writeIfChanged(path, content, { dryRun = false } = {}) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  if (dryRun) return true;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

// Recursively copy srcDir → destDir, skipping byte-identical files. Returns the number of files
// written (or that would be written, in dry-run).
export function copyTree(srcDir, destDir, { dryRun = false } = {}) {
  let changed = 0;
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      changed += copyTree(src, dest, { dryRun });
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

export function removeTree(path, { dryRun = false } = {}) {
  if (!path || !existsSync(path)) return false;
  if (dryRun) return true;
  rmSync(path, { recursive: true, force: true });
  return true;
}
