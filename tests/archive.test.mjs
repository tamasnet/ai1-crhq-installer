#!/usr/bin/env node
// Archive extraction hardening — path traversal rejection and safe extract.
//   node tests/archive.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateArchiveMembers, isUnsafeArchiveMember, extractArchive, RemoteError,
} from '../scripts/lib/remote.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();
const cleanups = [];

function track(dir) { cleanups.push(dir); return dir; }

console.log('isUnsafeArchiveMember / validateArchiveMembers:');

await test('rejects .., absolute, and Windows drive paths', () => {
  assert.equal(isUnsafeArchiveMember('../etc/passwd'), true);
  assert.equal(isUnsafeArchiveMember('/etc/passwd'), true);
  assert.equal(isUnsafeArchiveMember('C:/Windows/system.ini'), true);
  assert.equal(isUnsafeArchiveMember('safe/dir/file.txt'), false);
});

await test('validateArchiveMembers throws RemoteError on unsafe member', () => {
  assert.throws(
    () => validateArchiveMembers(['ok.txt', '../escape']),
    (e) => e instanceof RemoteError && /unsafe archive member/.test(e.message),
  );
});

console.log('\nextractArchive:');

await test('safe tar extracts to destination', () => {
  const base = track(mkdtempSync(join(tmpdir(), 'archive-good-')));
  const src = join(base, 'src');
  const dest = join(base, 'dest');
  mkdirSync(src);
  mkdirSync(dest);
  writeFileSync(join(src, 'hello.txt'), 'hi\n');
  const archive = join(base, 'good.tar.gz');
  const pack = spawnSync('tar', ['-czf', archive, '-C', src, '.']);
  assert.equal(pack.status, 0, pack.stderr);

  extractArchive('tar', archive, dest);
  assert.equal(readFileSync(join(dest, 'hello.txt'), 'utf8'), 'hi\n');
});

await test('tar with path traversal is rejected before extract', () => {
  const base = track(mkdtempSync(join(tmpdir(), 'archive-evil-tar-')));
  const content = join(base, 'content');
  const dest = join(base, 'dest');
  mkdirSync(content);
  mkdirSync(dest);
  writeFileSync(join(content, 'ok.txt'), 'pwn\n');
  const archive = join(base, 'evil.tar.gz');
  const pack = spawnSync('tar', [
    '-czf', archive, '--transform', 's,^,../,', '-C', content, 'ok.txt',
  ]);
  assert.equal(pack.status, 0, pack.stderr);

  assert.throws(
    () => extractArchive('tar', archive, dest),
    (e) => e instanceof RemoteError && /unsafe archive member/.test(e.message),
  );
  assert.equal(existsSync(join(dest, 'ok.txt')), false);
});

await test('zip with path traversal is rejected before extract', () => {
  const base = track(mkdtempSync(join(tmpdir(), 'archive-evil-zip-')));
  const dest = join(base, 'dest');
  mkdirSync(dest);
  const archive = join(base, 'evil.zip');
  const pack = spawnSync('python3', ['-c', `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(archive)}, 'w')
z.writestr('../../../tmp/pwned', 'x')
z.close()
`], { encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);

  assert.throws(
    () => extractArchive('zip', archive, dest),
    (e) => e instanceof RemoteError && /unsafe archive member/.test(e.message),
  );
});

for (const d of cleanups) rmSync(d, { recursive: true, force: true });
done();
