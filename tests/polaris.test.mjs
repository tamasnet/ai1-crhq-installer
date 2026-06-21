#!/usr/bin/env node
// polaris.mjs — the satellite's Client-Repository client (init subcommand). DB-free: it shells out
// to `git` and reuses the hub client's github-token resolver, so this suite needs no sandbox. It
// covers the pure input resolution + the git wiring two ways: (1) in-process unit tests that inject a
// fake getToken/runGit to assert the resolved plan and that the credential is carried in git's env
// config (never argv, never logged); (2) an integration test that drives the REAL git binary against
// a local bare repo over file:// to prove the spawn/clone/error path; plus (3) CLI tests via spawn
// for usage, strict option handling, and the not-registered / existing-checkout failure mappings.
// Run from the project root:  node tests/polaris.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './_helpers.mjs';
import {
  resolveInitInputs, resolveOwner, resolveRepo, resolveReposBase, runInit, gitClone,
  PolarisError, DEFAULT_GITHUB_OWNER,
} from '../scripts/lib/polaris.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));
const tmps = [];
const mkTmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };

// Run fn with env vars temporarily overlaid (undefined value = delete), restoring afterwards so the
// in-process tests don't leak state into each other.
function withEnv(over, fn) {
  const saved = {};
  for (const k of Object.keys(over)) {
    saved[k] = process.env[k];
    if (over[k] === undefined) delete process.env[k];
    else process.env[k] = over[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(over)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const CLEAN_ENV = { SATELLITE_ID: 'myzone-test', AI1_GITHUB_OWNER: undefined, REPOS_BASE_DIR: undefined };

// ── Input resolution ──────────────────────────────────────────────────────
console.log('polaris init input resolution:');

await test('defaults: owner=MyZone-AI, repo=satellitePackageName, dest under ~/repos', () => {
  withEnv(CLEAN_ENV, () => {
    const i = resolveInitInputs({});
    assert.equal(i.owner, 'MyZone-AI');
    assert.equal(i.owner, DEFAULT_GITHUB_OWNER);
    assert.equal(i.repo, 'ai1-test');                              // myzone-test → ai1-test
    assert.equal(i.dest, join(resolveReposBase(), 'ai1-test'));
    assert.equal(i.remoteUrl, 'https://github.com/MyZone-AI/ai1-test.git');
  });
});

await test('--owner / --repo flags override; flag beats AI1_GITHUB_OWNER env', () => {
  withEnv({ ...CLEAN_ENV, AI1_GITHUB_OWNER: 'env-org' }, () => {
    assert.equal(resolveOwner(undefined), 'env-org');             // env beats default
    assert.equal(resolveOwner('flag-org'), 'flag-org');           // flag beats env
    const i = resolveInitInputs({ owner: 'Acme', repo: 'custom-repo' });
    assert.equal(i.owner, 'Acme');
    assert.equal(i.repo, 'custom-repo');
    assert.equal(i.remoteUrl, 'https://github.com/Acme/custom-repo.git');
  });
});

await test('REPOS_BASE_DIR overrides the clone root', () => {
  withEnv({ ...CLEAN_ENV, REPOS_BASE_DIR: '/srv/repos' }, () => {
    assert.equal(resolveReposBase(), '/srv/repos');
    assert.equal(resolveInitInputs({}).dest, '/srv/repos/ai1-test');
  });
});

await test('--repo overrides satellitePackageName', () => {
  withEnv(CLEAN_ENV, () => assert.equal(resolveRepo('explicit'), 'explicit'));
  withEnv(CLEAN_ENV, () => assert.equal(resolveRepo(undefined), 'ai1-test'));
});

await test('malformed owner/repo (slash, traversal) → usage error', () => {
  withEnv(CLEAN_ENV, () => {
    assert.throws(() => resolveInitInputs({ owner: 'a/b' }), /invalid owner/);
    assert.throws(() => resolveInitInputs({ repo: 'a/b' }), /invalid repo/);
    assert.throws(() => resolveInitInputs({ repo: '..' }), /invalid repo/);
    assert.throws(() => resolveInitInputs({ owner: 'a b' }), /invalid owner/);
  });
});

// ── runInit with injected token + git ───────────────────────────────────────
console.log('\npolaris init (injected token + git):');

await test('happy path: resolves token, clones, returns summary; token only in git env config', async () => {
  const base = mkTmp('polaris-init-');
  await withEnv({ SATELLITE_ID: 'myzone-acme', AI1_GITHUB_OWNER: undefined, REPOS_BASE_DIR: base }, async () => {
    let gitArgs = null; let gitEnv = null; let tokenAsked = 0;
    const getToken = async () => { tokenAsked++; return { token: 'ghs_SECRET123' }; };
    const runGit = (args, { env } = {}) => { gitArgs = args; gitEnv = env; mkdirSync(args[2], { recursive: true }); return { status: 0 }; };

    const result = await runInit({}, { getToken, runGit });
    assert.equal(tokenAsked, 1);
    assert.deepEqual(result, {
      owner: 'MyZone-AI', repo: 'ai1-acme',
      dir: join(base, 'ai1-acme'), url: 'https://github.com/MyZone-AI/ai1-acme.git',
    });
    // git invoked as: clone <tokenless-url> <dest>
    assert.deepEqual(gitArgs, ['clone', 'https://github.com/MyZone-AI/ai1-acme.git', join(base, 'ai1-acme')]);
    // The credential rides in env config — never in argv.
    const b64 = Buffer.from('x-access-token:ghs_SECRET123').toString('base64');
    assert.equal(gitEnv.GIT_CONFIG_COUNT, '1');
    assert.equal(gitEnv.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(gitEnv.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${b64}`);
    assert.equal(gitEnv.GIT_TERMINAL_PROMPT, '0');
    assert.ok(!gitArgs.some((a) => a.includes('ghs_SECRET123')), 'token must not appear in argv');
  });
});

await test('existing destination → PolarisError; token + git never touched', async () => {
  const base = mkTmp('polaris-exists-');
  await withEnv({ SATELLITE_ID: 'myzone-acme', AI1_GITHUB_OWNER: undefined, REPOS_BASE_DIR: base }, async () => {
    mkdirSync(join(base, 'ai1-acme'), { recursive: true });        // pre-create the checkout
    let tokenAsked = 0; let gitCalled = 0;
    const getToken = async () => { tokenAsked++; return { token: 't' }; };
    const runGit = () => { gitCalled++; return { status: 0 }; };
    await assert.rejects(runInit({}, { getToken, runGit }), (e) => e instanceof PolarisError && /already exists/.test(e.message));
    assert.equal(tokenAsked, 0, 'must fail before resolving a token');
    assert.equal(gitCalled, 0);
  });
});

await test('token resolution failure propagates; git never runs', async () => {
  const base = mkTmp('polaris-notok-');
  await withEnv({ SATELLITE_ID: 'myzone-acme', AI1_GITHUB_OWNER: undefined, REPOS_BASE_DIR: base }, async () => {
    let gitCalled = 0;
    const getToken = async () => { throw new Error('not registered'); };
    const runGit = () => { gitCalled++; return { status: 0 }; };
    await assert.rejects(runInit({}, { getToken, runGit }), /not registered/);
    assert.equal(gitCalled, 0);
  });
});

await test('git non-zero exit → PolarisError', async () => {
  const base = mkTmp('polaris-gitfail-');
  await withEnv({ SATELLITE_ID: 'myzone-acme', AI1_GITHUB_OWNER: undefined, REPOS_BASE_DIR: base }, async () => {
    const getToken = async () => ({ token: 't' });
    const runGit = () => ({ status: 128 });
    await assert.rejects(runInit({}, { getToken, runGit }), (e) => e instanceof PolarisError && /git clone failed \(exit 128\)/.test(e.message));
  });
});

await test('git spawn error → PolarisError (could not run git)', () => {
  assert.throws(
    () => gitClone({ remoteUrl: 'https://github.com/x/y.git', token: 't', dest: '/tmp/x' },
      { runGit: () => ({ error: new Error('ENOENT') }) }),
    (e) => e instanceof PolarisError && /could not run git/.test(e.message));
});

await test('gitClone with no token → PolarisError', () => {
  assert.throws(() => gitClone({ remoteUrl: 'u', token: '', dest: 'd' }, { runGit: () => ({ status: 0 }) }),
    (e) => e instanceof PolarisError && /no GitHub token/.test(e.message));
});

// ── Real git integration (local bare repo over file://) ─────────────────────
console.log('\npolaris gitClone — real git against a local bare repo:');

await test('clones a real repo and leaves a clean tokenless origin', () => {
  const work = mkTmp('polaris-src-');
  const git = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  // Build a source repo with one commit, then a bare repo to clone from.
  git(['init', '-q', '-b', 'main', work]);
  git(['-C', work, 'config', 'user.email', 't@example.com']);
  git(['-C', work, 'config', 'user.name', 'Test']);
  writeFileSync(join(work, 'README.md'), '# hello\n');
  git(['-C', work, 'add', '.']);
  git(['-C', work, 'commit', '-q', '-m', 'init']);
  const bare = join(mkTmp('polaris-bare-'), 'repo.git');
  git(['clone', '-q', '--bare', work, bare]);

  const dest = join(mkTmp('polaris-dest-'), 'checkout');
  const url = `file://${bare}`;
  // Real runGit; token is irrelevant for file:// (the http extraheader simply isn't sent).
  gitClone({ remoteUrl: url, token: 'unused', dest });
  assert.ok(existsSync(join(dest, 'README.md')), 'cloned working tree present');
  const origin = git(['-C', dest, 'remote', 'get-url', 'origin']);
  assert.equal(origin, url, 'origin is the clean URL with no embedded credential');
  const cfg = readFileSync(join(dest, '.git', 'config'), 'utf8');
  assert.ok(!/extraheader/i.test(cfg), 'auth header is not persisted to .git/config');
});

await test('clone of a nonexistent remote → PolarisError', () => {
  const dest = join(mkTmp('polaris-noremote-'), 'checkout');
  assert.throws(() => gitClone({ remoteUrl: `file://${join(tmpdir(), 'definitely-missing-' + process.pid + '.git')}`, token: 't', dest }),
    (e) => e instanceof PolarisError && /git clone failed/.test(e.message));
});

// ── CLI (spawn) ─────────────────────────────────────────────────────────────
console.log('\npolaris.mjs CLI:');

function polaris(args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, ['scripts/polaris.mjs', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

await test('no args → usage on stdout, exit 2', () => {
  const r = polaris([]);
  assert.equal(r.code, 2);
  assert.match(r.out, /Subcommands:/);
  assert.match(r.out, /init/);
});

await test('--help → usage, exit 0', () => {
  const r = polaris(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /polaris/);
});

await test('unknown subcommand → exit 2', () => {
  const r = polaris(['frobnicate']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown subcommand/);
});

await test('init unknown option → exit 2', () => {
  const r = polaris(['init', '--nope']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option/);
});

await test('init --owner with no value → exit 2', () => {
  const r = polaris(['init', '--owner=']);
  assert.equal(r.code, 2);
  assert.match(r.err, /requires a value/);
});

await test('init --json given a value → exit 2', () => {
  const r = polaris(['init', '--json=1']);
  assert.equal(r.code, 2);
  assert.match(r.err, /does not take a value/);
});

await test('init when not registered with the hub → PolarisError/RemoteError, exit 1', () => {
  const remoteBase = mkTmp('polaris-cli-remote-');   // empty: no id.json
  const reposBase = mkTmp('polaris-cli-repos-');
  const r = polaris(['init'], { env: { SATELLITE_ID: 'myzone-cli', AI1_GITHUB_OWNER: undefined, REMOTE_BASE_DIR: remoteBase, REPOS_BASE_DIR: reposBase } });
  assert.equal(r.code, 1);
  assert.match(r.err, /not registered/);
});

await test('init refuses to clobber an existing checkout (before any hub call), exit 1', () => {
  const remoteBase = mkTmp('polaris-cli-remote2-');
  const reposBase = mkTmp('polaris-cli-repos2-');
  mkdirSync(join(reposBase, 'ai1-cli'), { recursive: true });
  const r = polaris(['init'], { env: { SATELLITE_ID: 'myzone-cli', AI1_GITHUB_OWNER: undefined, REMOTE_BASE_DIR: remoteBase, REPOS_BASE_DIR: reposBase } });
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists/);
});

for (const d of tmps) rmSync(d, { recursive: true, force: true });
done();
