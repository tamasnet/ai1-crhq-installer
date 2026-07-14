#!/usr/bin/env node
// hooks.test.mjs — manifest hook field validation + install_entry/flags backwards compatibility.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, validateManifest, ManifestError } from '../scripts/lib/manifest.mjs';
import { declaredFlagNames } from '../scripts/lib/flags.mjs';
import { resolvePackageAfter } from '../scripts/lib/hooks.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();
const tmpDirs = [];

const mkPkg = (yaml) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai1-hooks-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'ai1-package.yaml'), yaml);
  return dir;
};


const SKILL = { 'skills/a.md': '---\nname: a\nversion: 1\ndescription: d\n---\n' };

console.log('manifest hooks:');

await test('install_entry resolves as after alias', () => {
  const meta = { after: null, install_entry: 'scripts/x.mjs' };
  assert.equal(resolvePackageAfter(meta), 'scripts/x.mjs');
  meta.after = 'scripts/y.mjs';
  assert.throws(
    () => validateManifest({ name: 'p', version: 1, description: 'x', components: {}, after: 'y', install_entry: 'x' }),
    (e) => e instanceof ManifestError && /disagree/.test(e.message),
  );
});

await test('flags replaces install_flags; both declared is an error', () => {
  assert.throws(
    () => validateManifest({
      name: 'p', version: 1, description: 'x', components: {},
      flags: [{ name: '--a' }], install_flags: [{ name: '--b' }],
    }),
    (e) => e instanceof ManifestError && /both flags and install_flags/.test(e.message),
  );
  const names = declaredFlagNames({ flags: [{ name: '--foo' }] });
  assert.deepEqual(names, ['--foo']);
  assert.deepEqual(declaredFlagNames({ install_flags: [{ name: '--legacy' }] }), ['--legacy']);
});

await test('component before/after paths validated', () => {
  assert.throws(
    () => validateManifest({
      name: 'p', version: 1, description: 'x',
      components: { skills: [{ path: 'skills/a.md', version: 1, before: '' }] },
    }),
    (e) => e instanceof ManifestError && /before/.test(e.message),
  );
});

await test('loadManifest carries component hook paths on defs', () => {
  const yaml = `name: p
version: 1
description: x
components:
  skills:
    - path: skills/a.md
      version: 1
      before: scripts/pre.mjs
      after: scripts/post.mjs
`;
  const dir = mkPkg(yaml);
  for (const [rel, content] of Object.entries(SKILL)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const { plan } = loadManifest(dir);
  assert.equal(plan.skills[0].before, 'scripts/pre.mjs');
  assert.equal(plan.skills[0].after, 'scripts/post.mjs');
});

done();
process.on('exit', () => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });
