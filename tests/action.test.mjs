#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from './_helpers.mjs';
import { runActions, ActionError } from '../scripts/lib/action.mjs';

const { test, done } = harness();
const root = fileURLToPath(new URL('..', import.meta.url));
const actionsFile = (dir) => join(dir, 'actions.json');

async function withRemoteDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'action-'));
  const old = process.env.REMOTE_BASE_DIR;
  process.env.REMOTE_BASE_DIR = dir;
  try { await fn(dir); }
  finally {
    if (old == null) delete process.env.REMOTE_BASE_DIR;
    else process.env.REMOTE_BASE_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeActions(dir, actions, extra = {}) {
  writeFileSync(actionsFile(dir), `${JSON.stringify({ actions, actions_fetched_at: '2026-06-28T19:29:14.651Z', ...extra }, null, 2)}\n`);
}

function runCli(args, { base } = {}) {
  const dir = base ?? mkdtempSync(join(tmpdir(), 'action-cli-'));
  const r = spawnSync(process.execPath, ['scripts/action.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, REMOTE_BASE_DIR: dir },
  });
  return { ...r, dir, out: `${r.stdout}${r.stderr}` };
}

console.log('action.mjs library:');

await test('processes supported actions in order and removes each action from actions.json', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [
      { type: 'pull-config', config_version: 3 },
      { type: 'push-install' },
    ]);
    const calls = [];

    const result = await runActions({}, {
      now: new Date('2026-06-28T20:00:00.000Z'),
      pullConfig: async () => { calls.push('pull-config'); return { changed: true, configVersion: 5 }; },
      pushInstall: async () => { calls.push('push-install'); return { installVersion: 7, componentCount: 2 }; },
    });

    assert.deepEqual(calls, ['pull-config', 'push-install']);
    assert.equal(result.processed, 2);
    assert.equal(result.remaining, 0);
    assert.deepEqual(result.results.map((r) => r.type), ['pull-config', 'push-install']);
    const file = JSON.parse(readFileSync(actionsFile(dir), 'utf8'));
    assert.deepEqual(file.actions, []);
    assert.equal(file.actions_fetched_at, '2026-06-28T19:29:14.651Z');
    assert.equal(statSync(actionsFile(dir)).mode & 0o777, 0o600);
  });
});

await test('--limit processing leaves later actions queued', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [
      { type: 'pull-config', config_version: 3 },
      { type: 'push-install' },
    ]);
    const calls = [];

    const result = await runActions({ limit: 1 }, {
      pullConfig: async () => { calls.push('pull-config'); return { changed: false, configVersion: 3 }; },
      pushInstall: async () => { calls.push('push-install'); return {}; },
    });

    assert.deepEqual(calls, ['pull-config']);
    assert.equal(result.processed, 1);
    assert.equal(result.remaining, 1);
    assert.deepEqual(JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions, [{ type: 'push-install' }]);
  });
});

await test('install-package downloads a package then runs install.mjs with scoped flags', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [{
      type: 'install-package',
      package_name: 'widget',
      package_version: '3',
      install_type: 'skill,recipe',
      install_include: '^ai1-',
      install_exclude: 'draft',
      install_optional: true,
    }]);
    const calls = [];

    const result = await runActions({}, {
      getPackage: async (flags) => {
        calls.push(['get-package', flags]);
        return { name: flags.name, version: flags.version, packageDir: '/packages/widget@3' };
      },
      installPackage: async (packageDir, args) => {
        calls.push(['install', packageDir, args]);
        return { packageDir, flags: args, exitCode: 0 };
      },
    });

    assert.deepEqual(calls, [
      ['get-package', { name: 'widget', version: 3 }],
      ['install', '/packages/widget@3', ['--type=skill,recipe', '--include=^ai1-', '--exclude=draft', '--optional']],
    ]);
    assert.equal(result.processed, 1);
    assert.equal(result.results[0].type, 'install-package');
    assert.equal(result.results[0].result.name, 'widget');
    assert.equal(result.results[0].result.version, 3);
    assert.deepEqual(JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions, []);
  });
});

await test('install-package validates package fields before side effects', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [{ type: 'install-package', package_name: 'widget' }]);
    const calls = [];

    await assert.rejects(
      runActions({}, {
        getPackage: async () => { calls.push('get-package'); return {}; },
        installPackage: async () => { calls.push('install'); return {}; },
      }),
      /package_version/,
    );

    assert.deepEqual(calls, []);
    const action = JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions[0];
    assert.equal(action.status, 'error');
    assert.match(action.error_message, /package_version/);
  });
});

await test('install-package validates install_optional as boolean', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [{
      type: 'install-package',
      package_name: 'widget',
      package_version: 3,
      install_optional: 'yes',
    }]);

    await assert.rejects(runActions({}, {
      getPackage: async () => { throw new Error('should not download'); },
      installPackage: async () => { throw new Error('should not install'); },
    }), /install_optional/);

    const action = JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions[0];
    assert.equal(action.status, 'error');
    assert.match(action.error_message, /install_optional/);
  });
});

await test('dry-run validates planned actions without side effects or queue mutation', async () => {
  await withRemoteDir(async (dir) => {
    const queued = [
      { type: 'push-install' },
      {
        type: 'install-package',
        package_name: 'widget',
        package_version: 3,
        install_optional: true,
      },
    ];
    writeActions(dir, queued);

    const result = await runActions({ dryRun: true }, {
      pushInstall: async () => { throw new Error('should not push'); },
      getPackage: async () => { throw new Error('should not download'); },
      installPackage: async () => { throw new Error('should not install'); },
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.processed, 0);
    assert.equal(result.wouldProcess, 2);
    assert.equal(result.remaining, 2);
    assert.deepEqual(result.results.map((r) => r.status), ['dry-run', 'dry-run']);
    assert.deepEqual(result.results[1].plan.installFlags, ['--optional']);
    assert.deepEqual(JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions, queued);
  });
});

await test('failure marks the current action with status/error and stops', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [
      { type: 'pull-config', config_version: 3 },
      { type: 'push-install' },
    ]);
    const calls = [];

    await assert.rejects(
      runActions({}, {
        now: new Date('2026-06-28T20:00:00.000Z'),
        pullConfig: async () => { calls.push('pull-config'); throw new Error('hub temporarily unavailable'); },
        pushInstall: async () => { calls.push('push-install'); return {}; },
      }),
      (e) => e instanceof ActionError && /pull-config failed/.test(e.message),
    );

    assert.deepEqual(calls, ['pull-config']);
    const file = JSON.parse(readFileSync(actionsFile(dir), 'utf8'));
    assert.equal(file.actions.length, 2);
    assert.equal(file.actions[0].type, 'pull-config');
    assert.equal(file.actions[0].status, 'error');
    assert.equal(file.actions[0].error_message, 'hub temporarily unavailable');
    assert.equal(file.actions[0].error_at, '2026-06-28T20:00:00.000Z');
    assert.equal(file.actions[0].attempts, 1);
    assert.deepEqual(file.actions[1], { type: 'push-install' });
  });
});

await test('unsupported action type is recorded as a failed action', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [{ type: 'restart-the-moon' }]);
    await assert.rejects(runActions({}), /unsupported action type: restart-the-moon/);
    const action = JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions[0];
    assert.equal(action.status, 'error');
    assert.match(action.error_message, /unsupported action type/);
  });
});

await test('queued action (with key) calls completeAction with completed on success', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [{ type: 'pull-config', key: 'abc123', config_version: 3 }]);
    const completions = [];

    const result = await runActions({}, {
      now: new Date('2026-06-28T20:00:00.000Z'),
      pullConfig: async () => ({ changed: false, configVersion: 3 }),
      completeAction: async (key, body) => { completions.push({ key, body }); return { key, status: body.status }; },
    });

    assert.equal(result.processed, 1);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].key, 'abc123');
    assert.equal(completions[0].body.status, 'completed');
    assert.deepEqual(JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions, []);
  });
});

await test('queued action calls completeAction with failed + error fields on failure', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [{ type: 'pull-config', key: 'def456', config_version: 3 }]);
    const completions = [];

    await assert.rejects(
      runActions({}, {
        now: new Date('2026-06-28T20:00:00.000Z'),
        pullConfig: async () => { throw new Error('hub down'); },
        completeAction: async (key, body) => { completions.push({ key, body }); return { key, status: body.status }; },
      }),
      /pull-config failed/,
    );

    assert.equal(completions.length, 1);
    assert.equal(completions[0].key, 'def456');
    assert.equal(completions[0].body.status, 'failed');
    assert.equal(completions[0].body.error_message, 'hub down');
    assert.equal(completions[0].body.error_at, '2026-06-28T20:00:00.000Z');
    assert.equal(completions[0].body.attempts, 1);
    // action is still in the file (marked error, not removed)
    const action = JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions[0];
    assert.equal(action.status, 'error');
  });
});

await test('non-queued action (no key) does not call completeAction', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [{ type: 'push-install' }]);
    const completions = [];

    await runActions({}, {
      pushInstall: async () => ({ installVersion: 1, componentCount: 0 }),
      completeAction: async (key, body) => { completions.push({ key, body }); return { key, status: body.status }; },
    });

    assert.equal(completions.length, 0);
  });
});

await test('completeAction failure is best-effort and does not mask action success', async () => {
  await withRemoteDir(async (dir) => {
    writeActions(dir, [{ type: 'push-install', key: 'ghi789' }]);

    const result = await runActions({}, {
      pushInstall: async () => ({ installVersion: 2, componentCount: 1 }),
      completeAction: async () => { throw new Error('network timeout'); },
    });

    // Action still counted as processed; completeAction error was swallowed
    assert.equal(result.processed, 1);
    assert.deepEqual(JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions, []);
  });
});

await test('absent actions.json is a no-op', async () => {
  await withRemoteDir(async (dir) => {
    const result = await runActions({});
    assert.equal(result.found, false);
    assert.equal(result.processed, 0);
    assert.equal(result.remaining, 0);
    assert.equal(existsSync(actionsFile(dir)), false);
  });
});

console.log('action.mjs CLI:');

await test('--json on an absent queue emits a machine-readable no-op result', () => {
  const r = runCli(['--json']);
  assert.equal(r.status, 0, r.out);
  const out = JSON.parse(r.stdout);
  assert.equal(out.found, false);
  assert.equal(out.processed, 0);
  assert.equal(out.remaining, 0);
  rmSync(r.dir, { recursive: true, force: true });
});

await test('--limit=0 processes nothing and leaves queued actions intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'action-cli-'));
  writeActions(dir, [{ type: 'push-install' }]);
  const r = runCli(['--limit=0'], { base: dir });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no actions processed/);
  assert.deepEqual(JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions, [{ type: 'push-install' }]);
  rmSync(dir, { recursive: true, force: true });
});

await test('--dry-run --json reports queued actions without requiring registration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'action-cli-'));
  writeActions(dir, [{ type: 'push-install' }]);
  const r = runCli(['--dry-run', '--json'], { base: dir });
  assert.equal(r.status, 0, r.out);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.equal(out.processed, 0);
  assert.equal(out.wouldProcess, 1);
  assert.deepEqual(JSON.parse(readFileSync(actionsFile(dir), 'utf8')).actions, [{ type: 'push-install' }]);
  rmSync(dir, { recursive: true, force: true });
});

await test('option validation and help', () => {
  const badLimit = runCli(['--limit=abc']);
  assert.equal(badLimit.status, 2, badLimit.out);
  assert.match(badLimit.out, /--limit requires a non-negative integer/);
  rmSync(badLimit.dir, { recursive: true, force: true });

  const unknown = runCli(['--nope']);
  assert.equal(unknown.status, 2, unknown.out);
  assert.match(unknown.out, /unknown option: --nope/);
  rmSync(unknown.dir, { recursive: true, force: true });

  const badDryRun = runCli(['--dry-run=yes']);
  assert.equal(badDryRun.status, 2, badDryRun.out);
  assert.match(badDryRun.out, /--dry-run does not take a value/);
  rmSync(badDryRun.dir, { recursive: true, force: true });

  const help = spawnSync(process.execPath, ['scripts/action.mjs', '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/action\.mjs/);
  assert.match(help.stdout, /--dry-run/);
});

done();
