#!/usr/bin/env node
// handling.test.mjs — the per-component `handling` field (normal | removed | optional).
//   • resolveHandling: the verb-resolution matrix (handling × mode × --removed/--optional).
//   • manifest: validation of the field, version exemption for tombstones, name derivation.
//   • end-to-end: runPlan + install-log behavior in a sandbox — an optional entry is skipped unless
//     --optional; a 'removed' tombstone is inert unless --removed, and with --removed it deletes the
//     component (and its install-log slot) on an INSTALL run.
// Run from the project root:  node tests/handling.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionSandbox } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { loadManifest, validateManifest, ManifestError } from '../scripts/lib/manifest.mjs';
import { runPlan, resolveHandling } from '../scripts/lib/run.mjs';
import { runSync } from '../scripts/lib/sync.mjs';
import { updateInstallLog, readInstallLog } from '../scripts/lib/install-log.mjs';
import { loadYaml } from '../scripts/lib/parse.mjs';
import { readFileSync } from 'node:fs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();

// ── resolveHandling matrix (pure; no DB) ───────────────────────────────────────────────────────
console.log('resolveHandling:');

const NONE = { removed: false, optional: false };

await test('normal: install→upsert, uninstall→remove, status→status (flags irrelevant)', () => {
  for (const flags of [NONE, { removed: true, optional: true }]) {
    assert.equal(resolveHandling('normal', 'install', flags), 'upsert');
    assert.equal(resolveHandling('normal', 'uninstall', flags), 'remove');
    assert.equal(resolveHandling('normal', 'status', flags), 'status');
  }
  // omitted handling defaults to normal
  assert.equal(resolveHandling(undefined, 'install', NONE), 'upsert');
});

await test('removed: inert by default; --removed removes on BOTH install and uninstall', () => {
  assert.equal(resolveHandling('removed', 'install', NONE), null);
  assert.equal(resolveHandling('removed', 'uninstall', NONE), null);
  assert.equal(resolveHandling('removed', 'status', NONE), null);
  assert.equal(resolveHandling('removed', 'install', { removed: true }), 'remove');
  assert.equal(resolveHandling('removed', 'uninstall', { removed: true }), 'remove');
  assert.equal(resolveHandling('removed', 'status', { removed: true }), 'status');
});

await test('optional: install gated by --optional; uninstall/status always normal', () => {
  assert.equal(resolveHandling('optional', 'install', NONE), null);
  assert.equal(resolveHandling('optional', 'install', { optional: true }), 'upsert');
  // uninstall + status never require the flag
  assert.equal(resolveHandling('optional', 'uninstall', NONE), 'remove');
  assert.equal(resolveHandling('optional', 'status', NONE), 'status');
});

// ── manifest validation + buildPlan ────────────────────────────────────────────────────────────
console.log('\nmanifest:');

const mkPkg = (yaml, files = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai1-handling-'));
  writeFileSync(join(dir, 'ai1-package.yaml'), yaml);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
};
const SKILL_MD = (name, v = 1) => `---\nname: ${name}\nversion: ${v}\ndescription: d\n---\nbody`;
const tmpDirs = [];
const pkg = (yaml, files) => { const d = mkPkg(yaml, files); tmpDirs.push(d); return d; };

await test('invalid handling value → ManifestError', () => {
  assert.throws(() => validateManifest({
    name: 'p', version: 1, description: 'x',
    components: { skills: [{ path: 'skills/a', version: 1, handling: 'bogus' }] },
  }), (e) => e instanceof ManifestError && /handling must be one of/.test(e.message));
});

await test('handling values normal/removed/optional all validate', () => {
  for (const h of ['normal', 'optional']) {
    validateManifest({ name: 'p', version: 1, description: 'x', components: { skills: [{ path: 'skills/a', version: 1, handling: h }] } });
  }
  // removed needs no version pin (next test); validate with one present is also fine
  validateManifest({ name: 'p', version: 1, description: 'x', components: { skills: [{ path: 'skills/a', handling: 'removed' }] } });
});

await test('removed tombstone is exempt from the skill version-pin requirement', () => {
  // A real skill with no version → error; the same entry marked removed → ok.
  assert.throws(() => validateManifest({ name: 'p', version: 1, description: 'x', components: { skills: [{ path: 'skills/a' }] } }),
    (e) => e instanceof ManifestError && /requires a version pin/.test(e.message));
  validateManifest({ name: 'p', version: 1, description: 'x', components: { skills: [{ path: 'skills/a', handling: 'removed' }] } });
});

await test('removed tombstone loads WITHOUT reading files (no SKILL.md needed) and derives its name', () => {
  // No skills/old/SKILL.md on disk, no version — would normally fail to load; as a tombstone it loads.
  const dir = pkg('name: p\nversion: 1\ndescription: x\ncomponents:\n  skills:\n    - path: skills/old\n      handling: removed\n');
  const { plan } = loadManifest(dir);
  assert.equal(plan.skills.length, 1);
  assert.equal(plan.skills[0].name, 'old', 'name derived from path basename');
  assert.equal(plan.skills[0].key, 'old');
  assert.equal(plan.skills[0].handling, 'removed');
});

await test('removed tombstone honors an explicit name; file-type name strips extension', () => {
  const dir = pkg('name: p\nversion: 1\ndescription: x\ncomponents:\n'
    + '  skills:\n    - path: skills/dir-x\n      handling: removed\n      name: real-skill-name\n'
    + '  recipes:\n    - path: recipes/gone.md\n      handling: removed\n');
  const { plan } = loadManifest(dir);
  assert.equal(plan.skills[0].name, 'real-skill-name', 'explicit name wins over basename');
  assert.equal(plan.recipes[0].name, 'gone', 'recipe (file type) name strips .md');
});

await test('normal/optional entries still load their files and carry handling', () => {
  const dir = pkg(
    'name: p\nversion: 1\ndescription: x\ncomponents:\n'
    + '  skills:\n    - path: skills/keep\n      version: 1\n'
    + '    - path: skills/opt\n      version: 1\n      handling: optional\n',
    { 'skills/keep/SKILL.md': SKILL_MD('keep'), 'skills/opt/SKILL.md': SKILL_MD('opt') },
  );
  const { plan } = loadManifest(dir);
  assert.equal(plan.skills[0].handling, 'normal', 'omitted handling defaults to normal');
  assert.equal(plan.skills[1].handling, 'optional');
  assert.ok(plan.skills[0].content.includes('body'), 'real skill body loaded');
});

// ── end-to-end: runPlan + install log in a sandbox ─────────────────────────────────────────────
console.log('\nend-to-end (sandbox):');

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sb = await provisionSandbox({ ts: stamp, seed: false });
try {
  // Package with a normal skill (keep), a normal skill (doomed), and an optional skill (opt).
  const pkgA = pkg(
    'name: ph\nversion: 1\ndescription: x\ncomponents:\n'
    + '  skills:\n    - path: skills/keep\n      version: 1\n'
    + '    - path: skills/doomed\n      version: 1\n'
    + '    - path: skills/opt\n      version: 1\n      handling: optional\n',
    {
      'skills/keep/SKILL.md': SKILL_MD('keep'),
      'skills/doomed/SKILL.md': SKILL_MD('doomed'),
      'skills/opt/SKILL.md': SKILL_MD('opt'),
    },
  );
  const A = loadManifest(pkgA);
  const skillRow = (name) => makeCtx().db('skills').where({ name }).first();

  await test('install without --optional: keep+doomed installed, opt SKIPPED (and not in log)', async () => {
    const ctx = makeCtx();
    await runPlan(ctx, A.plan);
    const verdicts = Object.fromEntries(ctx.results.map((r) => [r.name, r.verdict]));
    assert.equal(verdicts.keep, 'INSTALL-OK');
    assert.equal(verdicts.doomed, 'INSTALL-OK');
    assert.equal(verdicts.opt, 'SKIPPED', 'optional skipped without --optional');
    assert.ok(await skillRow('keep'), 'keep row present');
    assert.ok(await skillRow('doomed'), 'doomed row present');
    assert.equal(await skillRow('opt'), undefined, 'opt not installed');

    updateInstallLog(ctx, A.meta, A.plan, pkgA);
    const log = readInstallLog(sb.packagesDir).map((e) => e.name).sort();
    assert.deepEqual(log, ['doomed', 'keep'], 'install log has keep+doomed, not opt');
  });

  await test('--optional installs the optional skill', async () => {
    const ctx = makeCtx({ OPTIONAL: true });
    await runPlan(ctx, A.plan);
    assert.equal(ctx.results.find((r) => r.name === 'opt').verdict, 'INSTALL-OK');
    assert.ok(await skillRow('opt'), 'opt installed under --optional');
    // clean it back up so later assertions start from keep+doomed
    const un = makeCtx({ mode: 'uninstall', OPTIONAL: true });
    await runPlan(un, { ...A.plan, skills: A.plan.skills.filter((s) => s.name === 'opt') });
    assert.equal(await skillRow('opt'), undefined, 'opt removed again');
  });

  // Package B: doomed has been dropped from the package → a tombstone; keep stays; opt still optional.
  const pkgB = pkg(
    'name: ph\nversion: 2\ndescription: x\ncomponents:\n'
    + '  skills:\n    - path: skills/keep\n      version: 1\n'
    + '    - path: skills/doomed\n      handling: removed\n'
    + '    - path: skills/opt\n      version: 1\n      handling: optional\n',
    { 'skills/keep/SKILL.md': SKILL_MD('keep'), 'skills/opt/SKILL.md': SKILL_MD('opt') },
  );
  const B = loadManifest(pkgB);

  await test('install pkgB WITHOUT --removed: tombstone inert, doomed survives', async () => {
    const ctx = makeCtx();
    await runPlan(ctx, B.plan);
    assert.equal(ctx.results.find((r) => r.name === 'doomed').verdict, 'SKIPPED', 'tombstone inert');
    assert.ok(await skillRow('doomed'), 'doomed still present without --removed');
  });

  await test('install pkgB WITH --removed: tombstone removes doomed; keep stays; log slot dropped', async () => {
    const ctx = makeCtx({ REMOVED: true });
    await runPlan(ctx, B.plan);
    const doomed = ctx.results.find((r) => r.name === 'doomed');
    assert.equal(doomed.verdict, 'INSTALL-OK');
    assert.equal(doomed.action, 'removed');
    assert.equal(doomed.op, 'remove', 'tagged as a remove op for the install log');
    assert.equal(await skillRow('doomed'), undefined, 'doomed removed on an INSTALL run');
    assert.ok(await skillRow('keep'), 'keep untouched');

    updateInstallLog(ctx, B.meta, B.plan, pkgB);
    const log = readInstallLog(sb.packagesDir).map((e) => e.name).sort();
    assert.deepEqual(log, ['keep'], 'doomed slot dropped from the install log, keep retained');
  });

  await test('uninstall treats optional normally (no --optional needed) and skips inert tombstone', async () => {
    // keep is installed; opt is not. Uninstall pkgB without flags.
    const ctx = makeCtx({ mode: 'uninstall' });
    await runPlan(ctx, B.plan);
    const byName = Object.fromEntries(ctx.results.map((r) => [r.name, r]));
    assert.equal(byName.keep.verdict, 'INSTALL-OK', 'keep removed');
    assert.equal(byName.keep.op, 'remove');
    assert.equal(byName.opt.op, 'remove', 'optional processed as normal on uninstall');
    assert.equal(byName.doomed.verdict, 'SKIPPED', 'tombstone stays inert on uninstall without --removed');
    assert.equal(await skillRow('keep'), undefined, 'keep gone after uninstall');
  });

  await test('mirror/sync preserves a removed tombstone instead of pruning it', async () => {
    // A package whose only entry is a tombstone for a skill that is absent live. Mirror normally
    // prunes manifest entries whose component is gone — a tombstone must survive that.
    const dir = pkg('name: tomb\nversion: 1\ndescription: x\ncomponents:\n'
      + '  skills:\n    - path: skills/ghost\n      handling: removed\n');
    const r = await runSync(makeCtx(), { packageDir: dir, mode: 'mirror' });
    assert.ok(!r.results.some((x) => x.name === 'ghost' && x.verdict === 'SYNC-REMOVED'), 'tombstone not pruned');
    const m = loadYaml(readFileSync(join(dir, 'ai1-package.yaml'), 'utf8'));
    const ghost = (m.components.skills || []).find((e) => e.path === 'skills/ghost');
    assert.ok(ghost, 'tombstone entry survives the mirror run');
    assert.equal(ghost.handling, 'removed', 'handling: removed preserved');
  });
} finally {
  await sb.teardown(false);
  await closeDb();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}

done();
