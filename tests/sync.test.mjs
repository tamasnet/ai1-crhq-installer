#!/usr/bin/env node
// sync / mirror feature verification — the reverse of install. Self-contained: provisions a sandbox
// schema + temp dirs, installs examples/bundle (DB types only) into it, then exercises lib/sync.mjs
// against the sandbox schema (getDb()'s INSTALL_SCHEMA redirect — sync has no sandbox mode of its
// own). Asserts:
//   • mirror bootstrap: full live inventory → installable package; scope + skip rules; version 1
//   • round trip: uninstall everything, reinstall from a mirror package → identical rows
//   • fidelity: a user skill keeps install_type:user (mirror); --normalize strips it
//   • --type / --include scope (mirror)
//   • dry-run: zero filesystem writes
//   • plain sync (no --mirror): keeps a dead manifest entry (SYNC-SKIP), never bumps package version
//   • mirror diff: component version bump, removal of a gone component, integer package-version bump
//     only on real content change (a no-op run does not bump)
// Run from the project root:  node tests/sync.test.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, lstatSync, readlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { provisionSandbox } from '../scripts/lib/sandbox.mjs';
import { closeDb } from '../scripts/lib/db.mjs';
import { loadManifest } from '../scripts/lib/manifest.mjs';
import { runPlan } from '../scripts/lib/run.mjs';
import { runSync } from '../scripts/lib/sync.mjs';
import { updateInstallLogForMirror, readInstallLog, installLogPath } from '../scripts/lib/install-log.mjs';
import { recordVersion } from '../scripts/lib/version-history.mjs';
import { dumpYaml, loadYaml, parseFrontmatter } from '../scripts/lib/parse.mjs';
import { makeCtx, harness } from './_helpers.mjs';

const { test, done } = harness();
const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sb = await provisionSandbox({ ts: stamp, seed: false });
const workBase = mkdtempSync(join(tmpdir(), 'ai1-sync-'));
console.log(`sandbox ${sb.schema} @ ${sb.baseDir}\n`);

const DB_TYPES = ['skills', 'recipes', 'agents', 'jobs'];   // never touch the service path in tests
const pkgDir = (name) => { const d = join(workBase, name); mkdirSync(d, { recursive: true }); return d; };
// sctx — a context for runSync: db + SKILLS_BASE + log + DRY_RUN (runSync returns its own results).
const sctx = (over = {}) => makeCtx(over);
const mirror = (dir, over = {}, opts = {}) => runSync(sctx(over), { packageDir: dir, mode: 'mirror', ...opts });
const readManifest = (dir) => loadYaml(readFileSync(join(dir, 'ai1-package.yaml'), 'utf8'));
const db = makeCtx().db;

// Pin the satellite id so the mirror-bootstrap package name (satellitePackageName) is assertable.
const prevSatelliteId = process.env.SATELLITE_ID;
process.env.SATELLITE_ID = 'myzone-tamas';   // → ai1-tamas

try {
  // ── seed: install the example bundle + out-of-scope / unrepresentable rows ───────────────────
  // Install the bundle's skill as a USER skill — mirror auto-adds only `user` skills (org/store/system
  // come from their own packages), so the happy-path fixture must be a user skill.
  const { plan } = loadManifest('examples/bundle');
  await runPlan(makeCtx({ TYPE: DB_TYPES, INSTALL_SKILLS_AS_USER: true }), plan);
  const now = new Date();
  const base = { is_active: true, is_global: false, created_at: now, updated_at: now };
  await db('skills').insert({
    name: 'sys-skill', description: 'platform skill', content: 'sys', skill_type: 'system',
    skill_path: 'db://skills/sys-skill', skill_dir: join(sb.baseDir, 'sys-skill'), ...base,
  });
  await db('skills').insert({
    name: 'inactive-skill', description: 'off', content: 'off', skill_type: 'user',
    skill_path: 'db://skills/inactive-skill', skill_dir: join(sb.baseDir, 'inactive-skill'),
    ...base, is_active: false,
  });
  // Active org + store skills — present on the satellite but NOT auto-added by mirror (only user skills are).
  await db('skills').insert({
    name: 'org-skill', description: 'an org skill', content: 'org', skill_type: 'org',
    skill_path: 'db://skills/org-skill', skill_dir: join(sb.baseDir, 'org-skill'), ...base,
  });
  await db('skills').insert({
    name: 'store-skill', description: 'a store skill', content: 'store', skill_type: 'store',
    skill_path: 'db://skills/store-skill', skill_dir: join(sb.baseDir, 'store-skill'), ...base,
  });
  await db('agents').insert({ key: 'sys-agent', name: 'Sys Agent', is_system: true, is_active: true, created_at: now, updated_at: now });
  await db('background_jobs').insert({
    id: 'job-bk-1', name: 'session-job', job_type: 'new_session', script_path: 'node', script_args: 'x',
    schedule: '0 0 * * *', enabled: true, run_count: 0, created_at: now, updated_at: now,
  });
  await db('background_jobs').insert({
    id: 'job-bk-2', name: 'outside-job', job_type: 'script', script_path: 'node',
    script_args: '/elsewhere/run.js --x', schedule: '0 0 * * *', enabled: true, run_count: 0,
    created_at: now, updated_at: now,
  });
  await db('agents').where({ key: 'ai1-sample-agent' }).update({
    provider: 'openai', system_prompt_path: '/prompts/sample.txt',
    capabilities: JSON.stringify(['search', 'recall']),
  });

  // ── mirror bootstrap ─────────────────────────────────────────────────────────────────────────
  console.log('mirror bootstrap:');
  const dirA = pkgDir('pkg-a');

  await test('empty dir → bootstraps an installable package with the in-scope live inventory', async () => {
    const { counts, manifest } = await mirror(dirA);
    assert.equal(manifest.name, 'ai1-tamas', 'mirror names the package via satellitePackageName(SATELLITE_ID)');
    assert.equal(manifest.version, 1, 'fresh package starts at version 1 (not bumped on create)');
    assert.deepEqual(counts, { added: 4, synced: 0, unchanged: 0, removed: 0, skipped: 2, failed: 0 });

    const { plan: bplan, meta } = loadManifest(dirA);   // self-installable at parse level
    assert.deepEqual(bplan.skills.map((s) => s.name), ['ai1-sample-skill']);
    assert.deepEqual(bplan.recipes.map((r) => r.name), ['ai1-sample-recipe']);
    assert.deepEqual(bplan.agents.map((a) => a.name), ['ai1-sample-agent']);
    assert.deepEqual(bplan.jobs.map((j) => j.name), ['ai1-sample-job']);
    assert.equal(meta.components.skills[0].version, 1, 'live CRHQ version pinned');

    // out of scope: only `user` skills are auto-added — org/store/system/inactive skills and the
    // system agent are absent entirely.
    assert.ok(!existsSync(join(dirA, 'skills', 'sys-skill')), 'system skill excluded');
    assert.ok(!existsSync(join(dirA, 'skills', 'inactive-skill')), 'inactive skill excluded');
    assert.ok(!existsSync(join(dirA, 'skills', 'org-skill')), 'org skill not auto-added');
    assert.ok(!existsSync(join(dirA, 'skills', 'store-skill')), 'store skill not auto-added');
    assert.ok(!existsSync(join(dirA, 'agents', 'sys-agent')), 'system agent excluded');
    assert.equal(meta.components.skills[0].install_type, 'user', 'auto-added user skill keeps install_type:user');
    assert.ok(existsSync(join(dirA, 'skills', 'ai1-sample-skill', 'scripts', 'hello.js')), 'skill tree copied');
  });

  await test('unrepresentable live jobs are surfaced as SYNC-SKIP, not added', async () => {
    const { results } = await mirror(pkgDir('pkg-skip'));
    const skips = results.filter((r) => r.verdict === 'SYNC-SKIP').map((r) => r.name).sort();
    assert.deepEqual(skips, ['outside-job', 'session-job']);
  });

  await test('component reconstruction matches the live rows', async () => {
    const { meta: sfm, body: sbody } = parseFrontmatter(readFileSync(join(dirA, 'skills', 'ai1-sample-skill', 'SKILL.md'), 'utf8'));
    assert.equal(sfm.name, 'ai1-sample-skill');
    const srow = await db('skills').where({ name: 'ai1-sample-skill' }).first();
    assert.equal(sbody.replace(/^\n+/, ''), srow.content.replace(/^\n+/, ''), 'skill body = DB content');

    const agent = parseFrontmatter(readFileSync(join(dirA, 'agents', 'ai1-sample-agent', 'AGENTS.md'), 'utf8')).meta;
    assert.equal(agent.provider, 'openai');
    assert.deepEqual(agent.capabilities, ['search', 'recall']);
    assert.deepEqual(agent.skills, ['ai1-sample-skill']);

    const job = loadYaml(readFileSync(join(dirA, 'jobs', 'ai1-sample-job.yaml'), 'utf8'));
    assert.equal(job.script, 'ai1-sample-skill/scripts/hello.js', 'script reverse-resolved relative to SKILLS_BASE');
    assert.deepEqual(job.requires, ['ai1-sample-skill'], 'requires re-derived from the script skill segment');
  });

  await test('agent brain round-trips into the package; runtime dirs are excluded (D-50)', async () => {
    const brainDir = join(process.env.AGENT_BRAINS_DIR, 'ai1-sample-agent');
    assert.ok(existsSync(join(brainDir, 'identity.md')), 'install copied the brain (sibling file) to AGENT_BRAINS_DIR/<key>');
    // Simulate runtime state the agent wrote into its own brain after install.
    mkdirSync(join(brainDir, 'activity'), { recursive: true });
    writeFileSync(join(brainDir, 'activity', 'log.md'), 'runtime log');

    const dirB = pkgDir('pkg-brain');
    await mirror(dirB);
    const ap = join(dirB, 'agents', 'ai1-sample-agent');
    assert.ok(existsSync(join(ap, 'AGENTS.md')), 'AGENTS.md regenerated from the DB');
    assert.ok(existsSync(join(ap, 'identity.md')), 'sibling brain file captured');
    assert.ok(!existsSync(join(ap, 'activity')), 'runtime dir excluded from the capture');

    const { meta, body } = parseFrontmatter(readFileSync(join(ap, 'AGENTS.md'), 'utf8'));
    assert.equal(meta.name, 'ai1-sample-agent');
    assert.equal(meta.provider, 'openai', 'DB config emitted to AGENTS.md frontmatter');
    const arow = await db('agents').where({ key: 'ai1-sample-agent' }).first();
    assert.equal(body.replace(/^\n+/, ''), (arow.instructions || '').replace(/^\n+/, ''), 'AGENTS.md body = DB instructions');

    rmSync(join(brainDir, 'activity'), { recursive: true, force: true });   // keep later runs pristine
  });

  // ── round trip ───────────────────────────────────────────────────────────────────────────────
  console.log('\nround trip:');

  await test('uninstall everything, install the mirror package → state matches', async () => {
    const dirF = pkgDir('pkg-roundtrip');
    await mirror(dirF);

    const snap = async () => ({
      skill: await db('skills').where({ name: 'ai1-sample-skill' }).first(),
      recipe: await db('recipes').where({ name: 'ai1-sample-recipe' }).first(),
      agent: await db('agents').where({ key: 'ai1-sample-agent' }).first(),
      job: await db('background_jobs').where({ name: 'ai1-sample-job' }).first(),
      links: {
        skills: (await db('agent_skills').where({ agent_key: 'ai1-sample-agent' }).orderBy('skill_name')).map((r) => r.skill_name),
        recipes: (await db('agent_recipes').where({ agent_key: 'ai1-sample-agent' })).length,
      },
    });
    const before = await snap();

    await runPlan(makeCtx({ mode: 'uninstall', TYPE: DB_TYPES }), plan);
    assert.equal(await db('skills').where({ name: 'ai1-sample-skill' }).first(), undefined);

    const { plan: bplan } = loadManifest(dirF);
    const ictx = makeCtx();
    await runPlan(ictx, bplan);
    assert.ok(ictx.results.every((r) => r.verdict === 'INSTALL-OK'), JSON.stringify(ictx.results));

    const after = await snap();
    const FIELDS = {
      skill: ['name', 'description', 'content', 'skill_type', 'locked', 'skill_path', 'skill_dir', 'is_active'],
      recipe: ['name', 'description', 'content', 'is_active'],
      agent: ['key', 'name', 'description', 'mode', 'icon', 'is_active', 'instructions', 'provider', 'system_prompt_path', 'capabilities'],
      job: ['name', 'description', 'schedule', 'timezone', 'job_type', 'script_path', 'script_args', 'timeout_minutes', 'enabled'],
    };
    for (const [kind, fields] of Object.entries(FIELDS)) {
      for (const f of fields) assert.deepEqual(after[kind]?.[f], before[kind]?.[f], `${kind}.${f} round-trips`);
    }
    assert.deepEqual(after.links, before.links, 'agent links round-trip');
  });

  // ── fidelity (user vs org skill) ───────────────────────────────────────────────────────────────
  console.log('\nfidelity:');

  await test('mirror preserves a user skill (install_type:user); --normalize strips it', async () => {
    await db('skills').insert({
      name: 'fidelity-skill', description: 'a user skill', content: 'body', skill_type: 'user',
      skill_path: 'db://skills/fidelity-skill', skill_dir: join(sb.baseDir, 'fidelity-skill'), ...base,
    });

    const { manifest: keep } = await mirror(pkgDir('pkg-fid'), {}, { filterSpec: { include: 'fidelity-skill' } });
    assert.deepEqual(keep.components.skills.map((e) => e.path), ['skills/fidelity-skill']);
    assert.equal(keep.components.skills[0].install_type, 'user', 'fidelity preserved');

    const { manifest: norm } = await mirror(pkgDir('pkg-fid-norm'), {}, { filterSpec: { include: 'fidelity-skill' }, normalize: true });
    assert.equal(norm.components.skills[0].install_type, undefined, '--normalize ships the org default');

    await db('skills').where({ name: 'fidelity-skill' }).del();   // keep later runs pristine
  });

  // ── scope ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\nscope:');

  await test('--type restricts to one component type; --include narrows by name', async () => {
    const { manifest: onlySkills } = await mirror(pkgDir('pkg-type'), {}, { typeScope: ['skills'] });
    assert.deepEqual(Object.keys(onlySkills.components), ['skills']);

    const { manifest: onlyRecipe } = await mirror(pkgDir('pkg-inc'), {}, { filterSpec: { include: 'ai1-sample-recipe' } });
    assert.deepEqual(Object.keys(onlyRecipe.components), ['recipes']);
  });

  // ── dry-run ──────────────────────────────────────────────────────────────────────────────────
  console.log('\ndry-run:');

  await test('dry-run reports the plan but writes nothing', async () => {
    const dirD = pkgDir('pkg-dry');
    const { counts } = await mirror(dirD, { DRY_RUN: true });
    assert.equal(counts.added, 4);
    assert.ok(!existsSync(join(dirD, 'ai1-package.yaml')), 'no manifest written');
    assert.ok(!existsSync(join(dirD, 'skills')), 'no component files written');
  });

  await test('dry-run does not touch an existing package', async () => {
    const before = readFileSync(join(dirA, 'ai1-package.yaml'), 'utf8');
    writeFileSync(join(dirA, 'keep-marker.txt'), 'still here');
    await mirror(dirA, { DRY_RUN: true });
    assert.equal(readFileSync(join(dirA, 'ai1-package.yaml'), 'utf8'), before, 'manifest untouched');
    assert.ok(existsSync(join(dirA, 'keep-marker.txt')), 'contents untouched');
    rmSync(join(dirA, 'keep-marker.txt'));
  });

  // ── plain sync (no --mirror) ───────────────────────────────────────────────────────────────────
  console.log('\nplain sync:');

  await test('plain sync keeps a dead manifest entry (SYNC-SKIP) and never bumps the package version', async () => {
    const dirE = pkgDir('pkg-sync');
    writeFileSync(join(dirE, 'ai1-package.yaml'), dumpYaml({
      name: 'sync-keep', version: 5, description: 'x',
      components: { skills: [{ path: 'skills/ai1-sample-skill', version: 1 }], recipes: [{ path: 'recipes/ghost.md' }] },
    }));
    writeFileSync(join(dirE, 'ghost.md'), 'placeholder');   // sync must NOT delete this
    mkdirSync(join(dirE, 'recipes'), { recursive: true });
    writeFileSync(join(dirE, 'recipes', 'ghost.md'), '---\nname: ghost\n---\nghost recipe');

    const { counts, manifest } = await runSync(sctx(), { packageDir: dirE });   // mode defaults to 'sync'
    assert.equal(counts.synced, 1, 'the live skill syncs');
    assert.equal(counts.skipped, 1, 'the ghost recipe is skipped, not removed');
    assert.equal(counts.removed, 0, 'plain sync never removes');
    assert.equal(manifest.version, 5, 'plain sync never touches the package version');
    assert.ok(manifest.components.recipes.some((e) => e.path === 'recipes/ghost.md'), 'ghost entry retained');
    assert.ok(existsSync(join(dirE, 'recipes', 'ghost.md')), 'ghost file retained');
  });

  console.log('\nproject add:');

  await test('--add-project moves /opt/projects/user content into the package and leaves a symlink', async () => {
    const liveBase = pkgDir('live-projects');
    const liveDir = join(liveBase, 'my-project');
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'project.yaml'),
      'name: my-project\nversion: 1\nport: 4555\nstart: node server.js\nnginx:\n  subdomain: my-project\n  ssl: false\n');
    writeFileSync(join(liveDir, 'server.js'), "console.log('project');\n");

    const dirP = pkgDir('pkg-project');
    const { counts, manifest } = await runSync(sctx({ USER_PROJECTS_BASE: liveBase }), {
      packageDir: dirP,
      additions: { projects: ['my-project'] },
    });
    assert.equal(counts.added, 1);
    assert.deepEqual(manifest.components.projects, [{ path: 'projects/my-project', version: 1 }]);
    assert.ok(existsSync(join(dirP, 'projects', 'my-project', 'server.js')), 'project moved into package');
    assert.equal(lstatSync(liveDir).isSymbolicLink(), true, 'live dir replaced by symlink');
    assert.equal(readlinkSync(liveDir), join(dirP, 'projects', 'my-project'));

    const { plan: pplan } = loadManifest(dirP);
    assert.equal(pplan.projects[0].name, 'my-project', 'package remains installable');

    const again = await runSync(sctx({ USER_PROJECTS_BASE: liveBase }), { packageDir: dirP });
    assert.deepEqual(again.counts, { added: 0, synced: 0, unchanged: 0, removed: 0, skipped: 0, failed: 0 }, 'plain sync does not process projects once added');
  });

  // ── mirror diff: version bump, removal, no-op ──────────────────────────────────────────────────
  console.log('\nmirror diff:');
  const dirG = pkgDir('pkg-diff');

  await test('a higher live component version bumps the entry AND the integer package version', async () => {
    await mirror(dirG);
    assert.equal(readManifest(dirG).version, 1);

    // Raise the live version + change the body, then re-mirror.
    await db('skills').where({ name: 'ai1-sample-skill' }).update({ content: 'updated body' });
    await recordVersion(makeCtx(), 'skill', { fkValue: 'ai1-sample-skill', version: 2, name: 'ai1-sample-skill', description: 'd', body: 'updated body' });

    const { counts, manifest } = await mirror(dirG);
    assert.equal(manifest.components.skills[0].version, 2, 'component version bumped to live');
    assert.equal(manifest.version, 2, 'package version incremented on content change');
    assert.equal(counts.removed, 0);
  });

  await test('a component gone from the satellite is removed (entry + file); package version bumps', async () => {
    await db('background_jobs').where({ name: 'ai1-sample-job' }).del();
    const { counts, manifest } = await mirror(dirG);
    assert.equal(counts.removed, 1, 'the deleted job is removed');
    assert.ok(!manifest.components.jobs, 'jobs section emptied + pruned from the manifest');
    assert.ok(!existsSync(join(dirG, 'jobs', 'ai1-sample-job.yaml')), 'job file deleted from the package');
    assert.ok(manifest.components.skills && manifest.components.recipes, 'other components retained');
    assert.equal(manifest.version, 3, 'package version incremented again');
  });

  await test('a no-op mirror reports unchanged (not synced), no version bump, rewrites nothing', async () => {
    const before = readFileSync(join(dirG, 'ai1-package.yaml'), 'utf8');
    const { counts } = await mirror(dirG);
    assert.equal(counts.added, 0);
    assert.equal(counts.removed, 0);
    assert.equal(counts.synced, 0, 'nothing reported as synced when nothing changed');
    assert.equal(counts.unchanged, 3, 'the unchanged components are tallied as unchanged, not synced');
    assert.equal(readManifest(dirG).version, 3, 'version unchanged on a clean run');
    assert.equal(readFileSync(join(dirG, 'ai1-package.yaml'), 'utf8'), before, 'manifest byte-identical');
  });

  // ── install.json reconciliation (D-48): the delta runSync returns, applied like the CLI does ────
  console.log('\nmirror → install.json:');

  await test('mirror records its components in install.json, attributed to the mirror package', async () => {
    const packagesDir = pkgDir('pkgs-log');                 // isolated install log dir
    const ictx = makeCtx({ PACKAGES_DIR: packagesDir });
    const { manifest, installLog } = await runSync(ictx, { packageDir: pkgDir('pkg-log'), mode: 'mirror' });

    const p = updateInstallLogForMirror(ictx, {
      installed: installLog.installed, removed: installLog.removed,
      pkg: { name: manifest.name, version: manifest.version },
    });
    assert.equal(p, installLogPath(packagesDir), 'install.json written');

    const byKey = Object.fromEntries(readInstallLog(packagesDir).map((c) => [`${c.type}:${c.name}`, c]));
    const sk = byKey['skill:ai1-sample-skill'];
    assert.ok(sk, 'the live skill is recorded as installed');
    assert.equal(sk.package, 'ai1-tamas', 'attributed to the mirror package');
    assert.equal(sk.package_version, String(manifest.version));
    assert.equal(sk.version, 2, 'component version reflects the live row');
    assert.equal(sk.source, 'skills/ai1-sample-skill/SKILL.md', 'skill source path');
    assert.ok(byKey['agent:ai1-sample-agent'], 'the live agent is recorded');
    assert.equal(byKey['agent:ai1-sample-agent'].source, 'agents/ai1-sample-agent/AGENTS.md');
    assert.ok(!byKey['job:ai1-sample-job'], 'a component absent from the satellite is not recorded');
  });

  await test('re-mirroring after a component is deleted drops it from install.json', async () => {
    const packagesDir = pkgDir('pkgs-log2');
    const ictx = makeCtx({ PACKAGES_DIR: packagesDir });
    const dirL = pkgDir('pkg-log2');

    // First mirror: recipe present → recorded.
    let res = await runSync(ictx, { packageDir: dirL, mode: 'mirror' });
    updateInstallLogForMirror(ictx, { installed: res.installLog.installed, removed: res.installLog.removed, pkg: { name: res.manifest.name, version: res.manifest.version } });
    assert.ok(readInstallLog(packagesDir).some((c) => c.type === 'recipe' && c.name === 'ai1-sample-recipe'), 'recipe recorded initially');

    // Delete the recipe from the satellite and re-mirror the SAME package.
    await db('recipes').where({ name: 'ai1-sample-recipe' }).del();
    res = await runSync(ictx, { packageDir: dirL, mode: 'mirror' });
    assert.deepEqual(res.installLog.removed, [{ type: 'recipe', name: 'ai1-sample-recipe' }], 'delta reports the removal');
    updateInstallLogForMirror(ictx, { installed: res.installLog.installed, removed: res.installLog.removed, pkg: { name: res.manifest.name, version: res.manifest.version } });

    assert.ok(!readInstallLog(packagesDir).some((c) => c.name === 'ai1-sample-recipe'), 'recipe dropped from install.json');
  });
} finally {
  if (prevSatelliteId === undefined) delete process.env.SATELLITE_ID; else process.env.SATELLITE_ID = prevSatelliteId;
  rmSync(workBase, { recursive: true, force: true });
  await sb.teardown(false);
  await closeDb();
}

done();
