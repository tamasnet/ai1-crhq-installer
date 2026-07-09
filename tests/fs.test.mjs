#!/usr/bin/env node
// copyTree — mode preservation, idempotency, streaming copy for large files.
// Run from the project root:  node tests/fs.test.mjs
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyTree, pruneTree, diffTree } from '../scripts/lib/fs.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();

function workDir() {
  return mkdtempSync(join(tmpdir(), 'ai1-fs-'));
}

console.log('copyTree:');

await test('preserves executable mode on copy', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(join(src, 'scripts'), { recursive: true });
  writeFileSync(join(src, 'scripts', 'run.sh'), '#!/bin/sh\necho ok\n');
  chmodSync(join(src, 'scripts', 'run.sh'), 0o755);

  assert.equal(copyTree(src, dest), 1);
  assert.equal(statSync(join(dest, 'scripts', 'run.sh')).mode & 0o777, 0o755);

  rmSync(root, { recursive: true, force: true });
});

await test('idempotent re-run skips byte-identical files', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'note.txt'), 'same');
  chmodSync(join(src, 'note.txt'), 0o644);

  assert.equal(copyTree(src, dest), 1);
  const before = statSync(join(dest, 'note.txt')).mtimeMs;
  assert.equal(copyTree(src, dest), 0);
  assert.equal(statSync(join(dest, 'note.txt')).mtimeMs, before);

  rmSync(root, { recursive: true, force: true });
});

await test('fixes mode and mtime without rewriting byte-identical content', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'tool.sh'), '#!/bin/sh\n');
  chmodSync(join(src, 'tool.sh'), 0o755);

  copyTree(src, dest);
  chmodSync(join(dest, 'tool.sh'), 0o644);
  writeFileSync(join(dest, 'tool.sh'), '#!/bin/sh\n'); // touch mtime on dest only

  assert.equal(copyTree(src, dest), 1);
  const srcStat = statSync(join(src, 'tool.sh'));
  const destStat = statSync(join(dest, 'tool.sh'));
  assert.equal(destStat.mode & 0o777, 0o755);
  assert.equal(Math.floor(destStat.mtimeMs / 1000), Math.floor(srcStat.mtimeMs / 1000));

  rmSync(root, { recursive: true, force: true });
});

await test('preserves source mtime on copy', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'old.txt'), 'v1');
  const past = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(src, 'old.txt'), past, past);

  copyTree(src, dest);
  assert.equal(statSync(join(dest, 'old.txt')).mtimeMs, past.getTime());

  rmSync(root, { recursive: true, force: true });
});

await test('copies large files without loading them fully into JS buffers', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  const big = Buffer.alloc(2 * 1024 * 1024, 0xab);
  writeFileSync(join(src, 'blob.bin'), big);
  chmodSync(join(src, 'blob.bin'), 0o600);

  assert.equal(copyTree(src, dest), 1);
  assert.ok(readFileSync(join(dest, 'blob.bin')).equals(big));
  assert.equal(statSync(join(dest, 'blob.bin')).mode & 0o777, 0o600);

  rmSync(root, { recursive: true, force: true });
});

await test('dry-run reports would-copy and would-chmod', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'a.txt'), 'a');
  chmodSync(join(src, 'a.txt'), 0o600);

  assert.equal(copyTree(src, dest, { dryRun: true }), 1);
  assert.equal(existsSync(dest), false);

  copyTree(src, dest);
  chmodSync(join(dest, 'a.txt'), 0o644);
  assert.equal(copyTree(src, dest, { dryRun: true }), 1);

  rmSync(root, { recursive: true, force: true });
});

console.log('\npruneTree:');

await test('removes dest files absent from src, returning rel paths (dirs with trailing /)', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(join(src, 'keep'), { recursive: true });
  writeFileSync(join(src, 'keep', 'a.txt'), 'a');
  mkdirSync(join(dest, 'keep'), { recursive: true });
  writeFileSync(join(dest, 'keep', 'a.txt'), 'a');
  writeFileSync(join(dest, 'keep', 'b.txt'), 'gone');
  writeFileSync(join(dest, 'stale.txt'), 'gone');
  mkdirSync(join(dest, 'olddir'), { recursive: true });
  writeFileSync(join(dest, 'olddir', 'x'), 'gone');

  assert.deepEqual(pruneTree(dest, src).sort(), ['keep/b.txt', 'olddir/', 'olddir/x', 'stale.txt']);
  assert.ok(existsSync(join(dest, 'keep', 'a.txt')));
  assert.equal(existsSync(join(dest, 'stale.txt')), false);
  assert.equal(existsSync(join(dest, 'olddir')), false);

  rmSync(root, { recursive: true, force: true });
});

await test('skip keeps dest-only paths (agent brain live dirs)', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'AGENTS.md'), 'meta');
  mkdirSync(join(dest, 'memory'), { recursive: true });
  writeFileSync(join(dest, 'memory', 'note.md'), 'live');
  writeFileSync(join(dest, 'stale.txt'), 'gone');

  assert.deepEqual(pruneTree(dest, src, { skip: (rel) => rel.split('/')[0] === 'memory' }), ['stale.txt']);
  assert.ok(existsSync(join(dest, 'memory', 'note.md')));
  assert.equal(existsSync(join(dest, 'stale.txt')), false);

  rmSync(root, { recursive: true, force: true });
});

await test('dry-run reports removals without deleting', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'extra.txt'), 'x');

  assert.deepEqual(pruneTree(dest, src, { dryRun: true }), ['extra.txt']);
  assert.ok(existsSync(join(dest, 'extra.txt')));

  rmSync(root, { recursive: true, force: true });
});

await test('pruneTree keeps nested skip paths inside dest-only directories', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  mkdirSync(join(dest, 'vendor', 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dest, 'vendor', 'node_modules', 'pkg', 'index.js'), 'live');
  writeFileSync(join(dest, 'vendor', 'stale.js'), 'gone');

  const skip = (rel) => rel === 'vendor/node_modules' || rel.startsWith('vendor/node_modules/');
  assert.deepEqual(pruneTree(dest, src, { dryRun: true, skip }).sort(), ['vendor/stale.js']);
  pruneTree(dest, src, { dryRun: false, skip });
  assert.ok(existsSync(join(dest, 'vendor', 'node_modules', 'pkg', 'index.js')));
  assert.equal(existsSync(join(dest, 'vendor', 'stale.js')), false);

  rmSync(root, { recursive: true, force: true });
});

console.log('\ndiffTree:');

await test('reports modified, missing (package-only), and extra (live-only) rel paths', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(join(src, 'scripts'), { recursive: true });
  writeFileSync(join(src, 'same.txt'), 'x');
  writeFileSync(join(src, 'scripts', 'edited.js'), 'v2');
  writeFileSync(join(src, 'new.txt'), 'n');
  mkdirSync(join(dest, 'scripts'), { recursive: true });
  writeFileSync(join(dest, 'same.txt'), 'x');
  writeFileSync(join(dest, 'scripts', 'edited.js'), 'v1');
  writeFileSync(join(dest, 'stale.txt'), 'gone');

  const d = diffTree(src, dest);
  assert.deepEqual(d.modified, ['scripts/edited.js']);
  assert.deepEqual(d.missing, ['new.txt']);
  assert.deepEqual(d.extra, ['stale.txt']);
  assert.ok(existsSync(join(dest, 'stale.txt')));   // read-only

  rmSync(root, { recursive: true, force: true });
});

await test('honors copySkip/pruneSkip; metadata-only diffs ignored by default, annotated in meta with strict', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(src, 'SKILL.md'), 'pkg');
  writeFileSync(join(dest, 'SKILL.md'), 'live');
  writeFileSync(join(src, 'run.sh'), '#!/bin/sh');
  writeFileSync(join(dest, 'run.sh'), '#!/bin/sh');
  chmodSync(join(src, 'run.sh'), 0o755);
  chmodSync(join(dest, 'run.sh'), 0o644);
  writeFileSync(join(src, 'a.txt'), 'a');
  writeFileSync(join(dest, 'a.txt'), 'a');
  utimesSync(join(src, 'a.txt'), new Date(1000), new Date(1000));
  utimesSync(join(dest, 'a.txt'), new Date(0), new Date(0));   // mtime-only difference
  mkdirSync(join(dest, 'data'), { recursive: true });
  writeFileSync(join(dest, 'data', 'live.db'), 'state');

  const opts = { copySkip: (rel) => rel === 'SKILL.md', pruneSkip: (rel) => rel.split('/')[0] === 'data' };
  const d = diffTree(src, dest, opts);
  assert.deepEqual(d.modified, []);
  assert.deepEqual(d.meta, []);
  assert.deepEqual(d.missing, []);
  assert.deepEqual(d.extra, []);

  const s = diffTree(src, dest, { ...opts, strict: true });
  assert.deepEqual(s.modified, []);
  assert.deepEqual(s.meta.sort(), ['a.txt (mtime)', 'run.sh (mode 755→644)']);

  rmSync(root, { recursive: true, force: true });
});

console.log('\ncopyTree contentOnly:');

await test('contentOnly ignores mode/mtime-only drift; default counts it', () => {
  const root = workDir();
  const src = join(root, 'src');
  const dest = join(root, 'dest');
  mkdirSync(src, { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(src, 'run.sh'), '#!/bin/sh');
  writeFileSync(join(dest, 'run.sh'), '#!/bin/sh');
  chmodSync(join(src, 'run.sh'), 0o755);
  chmodSync(join(dest, 'run.sh'), 0o644);

  assert.equal(copyTree(src, dest, { dryRun: true }), 1);
  assert.equal(copyTree(src, dest, { dryRun: true, contentOnly: true }), 0);

  rmSync(root, { recursive: true, force: true });
});

done();
