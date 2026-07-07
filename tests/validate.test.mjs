#!/usr/bin/env node
// validate.test.mjs — reject-at-load name/DNS/env validation (Phase 1).
// Run from the project root:  node tests/validate.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, ManifestError } from '../scripts/lib/manifest.mjs';
import { assertSafeSegment, assertDnsLabel, assertSafeEnvValue, formatEnvValue } from '../scripts/lib/validate.mjs';
import { renderEnv } from '../scripts/lib/core/service.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();
const tmpDirs = [];

const mkPkg = (yaml, files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai1-validate-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'ai1-package.yaml'), yaml);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
};

const SKILL_MD = (name, v = 1) => `---\nname: ${name}\nversion: ${v}\ndescription: d\n---\nbody`;
const SERVICE_YAML = (name, extra = '') => `name: ${name}\nversion: 1\nstart: node server.js\n${extra}`;

console.log('assertSafeSegment / assertDnsLabel:');

await test('assertSafeSegment rejects ., .., slashes, and illegal chars', () => {
  for (const bad of ['.', '..', '../../../evil', 'foo/bar', 'a b', 'a;injection']) {
    assert.throws(() => assertSafeSegment('test', bad), /invalid test/);
  }
  assert.doesNotThrow(() => assertSafeSegment('test', 'valid-name_1.2'));
});

await test('assertDnsLabel rejects dots, underscores, and injection chars', () => {
  for (const bad of ['demo.evil', 'foo_bar', 'a;rm -rf', 'a b', '../x']) {
    assert.throws(() => assertDnsLabel('app_name', bad), /invalid app_name/);
  }
  assert.doesNotThrow(() => assertDnsLabel('app_name', 'demo-app'));
});

console.log('\nmanifest load (reject-at-load):');

await test('traversing skill name ../../../evil rejected at manifest load', () => {
  const dir = mkPkg(
    'name: p\nversion: 1\ndescription: x\ncomponents:\n  skills:\n    - path: skills/evil\n      version: 1\n',
    { 'skills/evil/SKILL.md': SKILL_MD('../../../evil') },
  );
  assert.throws(() => loadManifest(dir), (e) => e instanceof ManifestError && /invalid skill name/.test(e.message));
});

await test('removed tombstone explicit name ../../../evil rejected at manifest load', () => {
  const dir = mkPkg(
    'name: p\nversion: 1\ndescription: x\ncomponents:\n'
    + '  skills:\n    - path: skills/old\n      handling: removed\n      name: ../../../evil\n',
  );
  assert.throws(() => loadManifest(dir), (e) => e instanceof ManifestError && /invalid skills removed name/.test(e.message));
});

await test('malicious app_name with nginx injection chars rejected at manifest load', () => {
  const dir = mkPkg(
    'name: p\nversion: 1\ndescription: x\ncomponents:\n  services:\n    - path: services/x\n      version: 1\n',
    {
      'services/x/service.yaml': SERVICE_YAML('safe-svc', "app_name: 'demo;injection'\n"),
      'services/x/server.js': 'export {}',
    },
  );
  assert.throws(() => loadManifest(dir), (e) => e instanceof ManifestError && /invalid app_name/.test(e.message));
});

await test('package name with path traversal rejected at manifest load', () => {
  assert.throws(
    () => loadManifest(mkPkg('name: ../escape\nversion: 1\ndescription: x\ncomponents: {}\n')),
    (e) => e instanceof ManifestError && /invalid package name/.test(e.message),
  );
});

console.log('\nrenderEnv (.env hardening):');

await test('renderEnv rejects newline injection in env values', () => {
  const def = { name: 'x', env: { EVIL: 'line1\nINJECTED=1' } };
  assert.throws(() => renderEnv(def, 4300), /env\.EVIL.*newline/);
  assert.throws(() => renderEnv({ name: 'x', env: { EVIL: 'a\rb' } }, 4300), /newline/);
});

await test('formatEnvValue quotes spaces, #, and =', () => {
  assert.equal(formatEnvValue('plain'), 'plain');
  assert.equal(formatEnvValue('has space'), '"has space"');
  assert.equal(formatEnvValue('hash#tag'), '"hash#tag"');
  assert.equal(formatEnvValue('key=value'), '"key=value"');
});

await test('renderEnv quotes special env values', () => {
  const env = renderEnv({ name: 'x', env: { GREETING: 'hello world', NOTE: 'a#comment' } }, 4300);
  assert.match(env, /^GREETING="hello world"$/m);
  assert.match(env, /^NOTE="a#comment"$/m);
});

await test('assertSafeEnvValue is exported for direct checks', () => {
  assert.throws(() => assertSafeEnvValue('KEY', 'x\ny'), /env\.KEY/);
});

for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });

done();
