#!/usr/bin/env node
// protect.mjs — protected-names semantics: defaults, '!' negation, top-level glob matching,
// listProtectedEntries, and manifest validation of the protect field. Pure/DB-free.
// Run from the project root:  node tests/protect.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_PROTECT, effectiveProtect, protectMatcher, listProtectedEntries } from '../scripts/lib/protect.mjs';
import { validateManifest, ManifestError } from '../scripts/lib/manifest.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();

console.log('effectiveProtect:');

await test('defaults include the runtime-state set', () => {
  const set = new Set(effectiveProtect());
  for (const p of ['.*', '_*', 'activity', 'memory', 'data', 'config', 'state', 'uploads', 'backup', 'logs', 'ecosystem.config.cjs']) {
    assert.ok(set.has(p), `missing default: ${p}`);
  }
  assert.equal(effectiveProtect().length, DEFAULT_PROTECT.length);
});

await test('component list extends the defaults', () => {
  const set = new Set(effectiveProtect(['sessions', 'seed-*']));
  assert.ok(set.has('sessions'));
  assert.ok(set.has('seed-*'));
  assert.ok(set.has('memory'));   // defaults retained
});

await test("'!pattern' removes a default; unknown negation is a no-op; order never matters", () => {
  assert.ok(!new Set(effectiveProtect(['!config'])).has('config'));
  assert.equal(effectiveProtect(['!no-such-entry']).length, DEFAULT_PROTECT.length);
  // Negations resolve after all additions regardless of position.
  assert.ok(!new Set(effectiveProtect(['!config', 'config'])).has('config'));
  assert.ok(!new Set(effectiveProtect(['config', '!config'])).has('config'));
});

console.log('\nprotectMatcher:');

await test('protects default names at the top level (dotfiles, underscore, literals, glob)', () => {
  const { skip } = protectMatcher();
  assert.ok(skip('.env'));
  assert.ok(skip('_backup'));
  assert.ok(skip('memory'));
  assert.ok(skip('memory/session-1/notes.md'));   // nested path under a protected top-level dir
  assert.ok(skip('ecosystem.config.cjs'));
  assert.ok(!skip('index.js'));
  assert.ok(!skip('SKILL.md'));
  assert.ok(!skip('ecosystem_config.cjs'));       // '.' in the pattern is literal, not regex-any
});

await test('patterns without / match TOP-LEVEL elements only by default', () => {
  const { skip } = protectMatcher();
  assert.ok(!skip('scripts/data/lookup.json'));   // top-level element is 'scripts'
  assert.ok(!skip('src/.env'));                   // top-level element is 'src'
});

await test('path-prefix patterns protect nested paths and descendants', () => {
  const { skip } = protectMatcher(['scripts/node_modules']);
  assert.ok(skip('scripts/node_modules'));
  assert.ok(skip('scripts/node_modules/lodash/index.js'));
  assert.ok(!skip('scripts/data/lookup.json'));
  assert.ok(!skip('vendor/node_modules'));        // not under scripts/
});

await test('** patterns protect at any depth', () => {
  const { skip } = protectMatcher(['**/node_modules']);
  assert.ok(skip('node_modules'));
  assert.ok(skip('node_modules/pkg/index.js'));
  assert.ok(skip('scripts/node_modules'));
  assert.ok(skip('scripts/node_modules/lodash/index.js'));
  assert.ok(skip('a/b/node_modules/x'));
  assert.ok(!skip('scripts/vendor'));             // no node_modules segment
});

await test('path globs do not cross / within a segment', () => {
  const { skip } = protectMatcher(['scripts/*.cache']);
  assert.ok(skip('scripts/foo.cache'));
  assert.ok(skip('scripts/foo.cache/nested'));
  assert.ok(!skip('scripts/foo/bar.cache'));
});

await test('component globs work and matched collects protected roots', () => {
  const m = protectMatcher(['seed-*', 'db?', 'scripts/node_modules']);
  assert.ok(m.skip('seed-data'));
  assert.ok(m.skip('db1'));
  assert.ok(!m.skip('db12'));                     // '?' is exactly one character
  m.skip('memory/a.md');
  m.skip('scripts/node_modules/pkg/index.js');
  assert.deepEqual([...m.matched].sort(), ['db1', 'memory', 'scripts/node_modules', 'seed-data']);
});

console.log('\nlistProtectedEntries:');

await test('lists top-level and nested src entries matching the protect set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai1-protect-'));
  writeFileSync(join(dir, '.env'), 'X=1');
  writeFileSync(join(dir, 'index.js'), '//');
  mkdirSync(join(dir, 'data'));
  mkdirSync(join(dir, 'scripts', 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'node_modules', 'pkg', 'index.js'), '//');
  assert.deepEqual(listProtectedEntries(dir), ['.env', 'data']);
  assert.deepEqual(listProtectedEntries(dir, ['!data']), ['.env']);
  assert.deepEqual(listProtectedEntries(dir, ['scripts/node_modules']), ['.env', 'data', 'scripts/node_modules']);
  assert.deepEqual(listProtectedEntries(dir, ['**/node_modules']), ['.env', 'data', 'scripts/node_modules']);
  assert.deepEqual(listProtectedEntries(join(dir, 'absent')), []);
  rmSync(dir, { recursive: true, force: true });
});

console.log('\nmanifest protect validation:');

const manifest = (protect) => ({
  name: 'p', version: 1, description: 'd',
  components: { skills: [{ path: 'skills/s.md', version: 1, ...(protect !== undefined ? { protect } : {}) }] },
});

await test('valid protect list is accepted; invalid shapes are rejected', () => {
  validateManifest(manifest(undefined));
  validateManifest(manifest(['sessions', '!config', 'scripts/node_modules', '**/node_modules']));
  assert.throws(() => validateManifest(manifest('sessions')), ManifestError);
  assert.throws(() => validateManifest(manifest([42])), ManifestError);
  assert.throws(() => validateManifest(manifest([' '])), ManifestError);
});

done();
