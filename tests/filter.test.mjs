#!/usr/bin/env node
// Component selection (--include / --exclude) — unit tests for the matcher semantics plus CLI
// integration proving the runner dispatches only the selected components. The regex rule: a value
// with no regex metacharacters is an exact (anchored) match; otherwise it's a case-sensitive regex.
// Run from the project root:  node tests/filter.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileMatcher, makeFilter, hasFilter, FilterError } from '../scripts/lib/filter.mjs';
import { harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));   // project root (parent of tests/)
// --dry-run keeps the install side-effect-free; --sandbox isolates the schema + satisfies preflight.
const cli = (args) => spawnSync(process.execPath, ['scripts/install.mjs', 'examples/bundle', '--sandbox', '--dry-run', ...args], { cwd: root, encoding: 'utf8' });
// Test selection against the run summary only (pre-summary logs may mention names incidentally).
const summary = (out) => { const i = out.indexOf('── summary ──'); return i >= 0 ? out.slice(i) : out; };
const picked = (out, name) => new RegExp(`\\s${name}\\s`).test(summary(out));

// ── matcher semantics (unit; no DB) ──────────────────────────────────────────────────────────
console.log('matcher (unit):');

await test('literal with no metacharacters → exact, anchored match', () => {
  const m = compileMatcher('ai1-sample-skill');
  assert.equal(m('ai1-sample-skill'), true);
  assert.equal(m('ai1-sample-skill-2'), false);
  assert.equal(m('x-ai1-sample-skill'), false);
});

await test('matching is case-sensitive', () => {
  assert.equal(compileMatcher('foo')('Foo'), false);          // exact path
  assert.equal(compileMatcher('^foo$')('Foo'), false);        // regex path
});

await test('hyphen is literal, not a metacharacter (stays exact)', () => {
  const m = compileMatcher('my-skill');
  assert.equal(m('my-skill'), true);
  assert.equal(m('myXskill'), false);                         // would match if treated as regex
});

await test('a metacharacter switches to (unanchored) regex', () => {
  const m = compileMatcher('^ai1-');
  assert.equal(m('ai1-sample-skill'), true);
  assert.equal(m('zzz-ai1-x'), false);
  const alt = compileMatcher('skill|recipe');
  assert.equal(alt('ai1-sample-recipe'), true);
  assert.equal(alt('ai1-sample-job'), false);
});

await test('makeFilter: include AND not-exclude', () => {
  const f = makeFilter({ include: '^ai1-', exclude: 'job$' });
  assert.equal(f('ai1-sample-skill'), true);
  assert.equal(f('ai1-sample-job'), false);                   // excluded
  assert.equal(f('other-skill'), false);                      // not included
});

await test('no flags → select everything', () => {
  assert.equal(makeFilter({})('anything'), true);
  assert.equal(hasFilter({}), false);
  assert.equal(hasFilter({ include: 'x' }), true);
  assert.equal(hasFilter({ exclude: 'x' }), true);
});

await test('invalid regex → FilterError', () => {
  assert.throws(() => compileMatcher('['), (e) => e instanceof FilterError);
});

// ── CLI selection (examples/bundle, --sandbox --dry-run) ─────────────────────────────────────
console.log('\nCLI selection (examples/bundle):');

await test('--include exact name selects only that component', () => {
  const r = cli(['--include=ai1-sample-skill']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(picked(r.stdout, 'ai1-sample-skill'));
  assert.ok(!picked(r.stdout, 'ai1-sample-recipe'));
  assert.ok(!picked(r.stdout, 'ai1-sample-agent'));
  assert.ok(!picked(r.stdout, 'ai1-sample-job'));
});

await test('--include regex selects the matching subset', () => {
  const r = cli(['--include=^ai1-sample-(skill|recipe)$']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(picked(r.stdout, 'ai1-sample-skill'));
  assert.ok(picked(r.stdout, 'ai1-sample-recipe'));
  assert.ok(!picked(r.stdout, 'ai1-sample-agent'));
  assert.ok(!picked(r.stdout, 'ai1-sample-job'));
});

await test('agents are matched by name', () => {
  const r = cli(['--include=ai1-sample-agent']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(picked(r.stdout, 'ai1-sample-agent'));
  assert.ok(!picked(r.stdout, 'ai1-sample-skill'));
});

await test('--exclude drops the matching component', () => {
  const r = cli(['--exclude=ai1-sample-job']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(picked(r.stdout, 'ai1-sample-skill'));
  assert.ok(picked(r.stdout, 'ai1-sample-agent'));
  assert.ok(!picked(r.stdout, 'ai1-sample-job'));
});

await test('zero match → warn + exit 0', () => {
  const r = cli(['--include=does-not-exist']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /matched 0 of/);
});

await test('invalid regex → usage exit 2', () => {
  const r = cli(['--include=[']);
  assert.equal(r.status, 2);
  assert.match(`${r.stderr}${r.stdout}`, /invalid --include/);
});

// ── CLI --type type selection (multiple values) ──────────────────────────────────────────────
console.log('\nCLI --type (type selection):');

await test('--type with multiple singular types selects exactly those types', () => {
  const r = cli(['--type=skill,job']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(picked(r.stdout, 'ai1-sample-skill'));
  assert.ok(picked(r.stdout, 'ai1-sample-job'));
  assert.ok(!picked(r.stdout, 'ai1-sample-recipe'));
  assert.ok(!picked(r.stdout, 'ai1-sample-agent'));
  assert.ok(!picked(r.stdout, 'ai1-sample-svc'));
});

await test('--type preserves canonical install order regardless of input order', () => {
  const out = summary(cli(['--type=job,skill']).stdout);
  assert.ok(out.indexOf('ai1-sample-skill') < out.indexOf('ai1-sample-job'), 'skill processed before job');
});

await test('--type with an unknown type is a usage error', () => {
  const r = cli(['--type=bogus']);
  assert.equal(r.status, 2);
  assert.match(`${r.stderr}${r.stdout}`, /unknown component type/);
});

done();
