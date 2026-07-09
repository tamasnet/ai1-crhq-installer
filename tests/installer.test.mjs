#!/usr/bin/env node
// Installer end-to-end — the generated install.sh must extract the bundle in both file mode
// (`sh install.sh`) and pipe mode (`curl | sh`). Pipe mode is exercised through `sh` because
// dash (Debian/Ubuntu /bin/sh) buffers read-ahead of a piped script, so the payload must not
// depend on leftover stdin after the shell has parsed the script.
//   node tests/installer.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same runner as _helpers.mjs harness(), inlined: _helpers imports the db layer, which needs
// a provisioned sandbox this shell-level test doesn't require.
let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
};
const done = () => {
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
};
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'ai1-installer-'));
const installer = join(work, 'install.sh');

const build = spawnSync('sh', [join(ROOT, 'build-installer.sh'), installer], { encoding: 'utf8' });
assert.equal(build.status, 0, `build-installer.sh failed:\n${build.stderr}`);

// Runs the generated installer with install/register steps disabled and returns the result
// plus the extraction dir. `cmd` receives the installer path as $1.
function runInstaller(cmd) {
  const dest = mkdtempSync(join(work, 'inst-'));
  const r = spawnSync('sh', ['-c', cmd, 'sh', installer], {
    encoding: 'utf8',
    env: { ...process.env, AI1_INSTALL_DIR: dest, AI1_RUN_INSTALL: '0', AI1_RUN_REGISTER: '0' },
  });
  return { ...r, dest };
}

function assertExtracted(r, label) {
  assert.equal(r.status, 0, `${label} exited ${r.status}:\n${r.stderr}`);
  const sentinel = join(r.dest, 'skills', 'ai1-satellite-tools', 'scripts', 'remote.mjs');
  assert.ok(existsSync(sentinel), `${label}: expected ${sentinel} to exist`);
  assert.ok(existsSync(join(r.dest, 'ai1-package.yaml')), `${label}: expected ai1-package.yaml`);
}

console.log('generated installer:');

await test('file mode: sh install.sh', () => {
  assertExtracted(runInstaller('sh "$1"'), 'file mode');
});

await test('pipe mode: cat install.sh | sh', () => {
  assertExtracted(runInstaller('cat "$1" | sh'), 'pipe via sh');
});

await test('pipe mode: cat install.sh | bash', () => {
  assertExtracted(runInstaller('cat "$1" | bash'), 'pipe via bash');
});

await test('pipe mode forwards args: --help exits 0 without extracting', () => {
  const r = runInstaller('cat "$1" | sh -s -- --help');
  assert.equal(r.status, 0, `--help exited ${r.status}:\n${r.stderr}`);
  assert.match(r.stdout, /self-extracting installer/);
});

rmSync(work, { recursive: true, force: true });
done();
