#!/usr/bin/env node
// Archive extraction hardening — path traversal rejection, link rejection, and safe extract.
//   node tests/archive.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateArchiveMembers, isUnsafeArchiveMember, extractArchive, sha256File, RemoteError,
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

console.log('\nsha256File:');

await test('streaming sha256 matches known digest', async () => {
  const base = track(mkdtempSync(join(tmpdir(), 'archive-sha-')));
  const file = join(base, 'payload.bin');
  const content = 'hello package integrity\n';
  writeFileSync(file, content);
  const expected = createHash('sha256').update(content).digest('hex');
  assert.equal(await sha256File(file), expected);
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

await test('tar with symlink member is rejected before extract', () => {
  const base = track(mkdtempSync(join(tmpdir(), 'archive-evil-symlink-')));
  const dest = join(base, 'dest');
  mkdirSync(dest);
  const linkPath = join(base, 'link');
  symlinkSync('/tmp/evil', linkPath);
  const archive = join(base, 'symlink.tar.gz');
  const pack = spawnSync('tar', ['-czf', archive, '-C', base, 'link']);
  assert.equal(pack.status, 0, pack.stderr);

  assert.throws(
    () => extractArchive('tar', archive, dest),
    (e) => e instanceof RemoteError && /symlink\/hardlink member rejected/.test(e.message),
  );
  assert.equal(existsSync(join(dest, 'link')), false);
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

await test('zip with symlink member is rejected before extract when zipinfo is available', () => {
  const zipinfo = spawnSync('zipinfo', ['--version'], { encoding: 'utf8' });
  if (zipinfo.error || zipinfo.status !== 0) return; // zipinfo absent — post-extract walk is the fallback

  const base = track(mkdtempSync(join(tmpdir(), 'archive-evil-zip-symlink-')));
  const dest = join(base, 'dest');
  mkdirSync(dest);
  const archive = join(base, 'symlink.zip');
  const pack = spawnSync('python3', ['-c', `
import zipfile, os
zpath = ${JSON.stringify(archive)}
with zipfile.ZipFile(zpath, 'w') as z:
    info = zipfile.ZipInfo('link')
    info.create_system = 3
    info.external_attr = (0o120777 << 16)
    z.writestr(info, '/tmp/evil')
`], { encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr || pack.stdout);

  assert.throws(
    () => extractArchive('zip', archive, dest),
    (e) => e instanceof RemoteError && /symlink\/hardlink member rejected/.test(e.message),
  );
  assert.equal(existsSync(join(dest, 'link')), false);
});

for (const d of cleanups) rmSync(d, { recursive: true, force: true });
done();
