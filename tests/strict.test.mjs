#!/usr/bin/env node
// --strict install: prune stale files from install targets; requires --include (type optional).
// Run from the project root:  node tests/strict.test.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { provisionSandbox } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { upsertSkill } from '../scripts/lib/core/skill.mjs';
import { upsertAgent } from '../scripts/lib/core/agent.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));
const install = (args) => spawnSync(process.execPath, ['scripts/install.mjs', 'examples/bundle', ...args],
  { cwd: root, encoding: 'utf8' });
const out = (r) => `${r.stdout}${r.stderr}`;

const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sb = await provisionSandbox({ ts: stamp, seed: false });
console.log(`sandbox ${sb.schema} @ ${sb.baseDir}\n`);

try {
  const { plan } = loadManifest('examples/bundle');
  const skillDef = plan.skills[0];
  const agentDef = plan.agents[0];
  const skillDir = join(sb.baseDir, skillDef.key);
  const brainDir = join(process.env.AGENT_BRAINS_DIR, agentDef.name);

  console.log('skill strict:');

  await test('upsertSkill --strict removes stale files from skill dir', async () => {
    const ctx = makeCtx({ STRICT: true });
    await upsertSkill(ctx, skillDef);
    writeFileSync(join(skillDir, 'stale.js'), '// old');
    await upsertSkill(ctx, skillDef);
    assert.equal(existsSync(join(skillDir, 'stale.js')), false);
    assert.ok(existsSync(join(skillDir, 'scripts', 'hello.js')));
  });

  await test('upsertSkill without --strict leaves stale files', async () => {
    const ctx = makeCtx();
    await upsertSkill(ctx, skillDef);
    writeFileSync(join(skillDir, 'leftover.js'), '// stay');
    await upsertSkill(ctx, skillDef);
    assert.ok(existsSync(join(skillDir, 'leftover.js')));
    rmSync(join(skillDir, 'leftover.js'));
  });

  console.log('\nagent strict:');

  await test('upsertAgent --strict removes stale brain files but keeps memory/', async () => {
    const ctx = makeCtx({ STRICT: true });
    await upsertAgent(ctx, agentDef);
    writeFileSync(join(brainDir, 'stale.txt'), 'gone');
    mkdirSync(join(brainDir, 'memory'), { recursive: true });
    writeFileSync(join(brainDir, 'memory', 'session.md'), 'keep');
    await upsertAgent(ctx, agentDef);
    assert.equal(existsSync(join(brainDir, 'stale.txt')), false);
    assert.ok(existsSync(join(brainDir, 'memory', 'session.md')));
  });

  console.log('\nCLI validation:');

  await test('--strict without --include → exit 2', () => {
    const r = install(['--strict', '--sandbox']);
    assert.equal(r.status, 2);
    assert.match(out(r), /--strict requires --include/);
  });

  await test('--strict with --type only (no --include) → exit 2', () => {
    const r = install(['--strict', '--type=skill', '--sandbox']);
    assert.equal(r.status, 2);
    assert.match(out(r), /--strict requires --include/);
  });

  await test('--strict with --type=skill is accepted', () => {
    const r = install(['--strict', '--type=skill', '--include=ai1-sample-skill', '--sandbox', '--dry-run']);
    assert.equal(r.status, 0, out(r));
    assert.match(out(r), /prune 0 extra|copy assets|noop/);
  });

  await test('--strict with --status is rejected', () => {
    const r = install(['--strict', '--type=skill', '--status']);
    assert.equal(r.status, 2);
    assert.match(out(r), /--strict is only supported for install/);
  });
} finally {
  await sb.teardown(false);
  await closeDb();
}

done();
