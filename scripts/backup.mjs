#!/usr/bin/env node
// ai1-crhq-installer — backup runner (CLI entry): the reverse of install.mjs. Reads the in-scope
// CRHQ DB-resident components (D-25) and writes an installable package (ai1-package.yaml manifest
// format) to ${BACKUP_BASE_DIR}/<name>/, overwriting the previous backup in place via a staged
// build + swap (D-26). Read-only against the DB — no dry-run, no sandbox, always live.
// Restore = `node scripts/install.mjs <backup-dir>`.
//
// Usage: backup.mjs [<backup-base-dir>] [--name=<pkg>] [--only=<types>] [--include=<pat>]
//                   [--exclude=<pat>] [--json]
import {
  createContext, preflight, closeDb, ManifestError, PreflightError, FilterError,
} from './lib/index.mjs';
import { runBackup } from './lib/backup.mjs';

const argv = process.argv.slice(2);

// Install-lifecycle flags make no sense for a live read-only export — reject loudly rather than
// silently ignore them.
const UNSUPPORTED = ['--dry-run', '--status', '--uninstall', '--sandbox', '--keep', '--lifecycle',
  '--respect-locks', '--install-skills-as-user'];
const bad = argv.filter((a) => UNSUPPORTED.includes(a));
if (bad.length) {
  console.error(`❌ ${bad.join(' ')}: not supported by backup (a live, read-only export — see SKILL.md)`);
  process.exit(2);
}

try {
  const ctx = await createContext(argv, { mode: 'backup' });
  ctx.log.info(`backup → ${ctx.BACKUP_BASE} (schema=${ctx.SCHEMA || 'default'})`);
  await preflight(ctx);                       // DB reachable + BACKUP_BASE_DIR writable — else exit 2
  await runBackup(ctx, { now: new Date() });  // version/date minted here, threaded in (lib stays deterministic)
  ctx.report();
} catch (e) {
  if (e instanceof ManifestError) { console.error(`❌ backup self-check failed — generated manifest invalid: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof FilterError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof PreflightError) { console.error(`❌ preflight failed: ${e.message}`); process.exitCode = 2; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 2; }
} finally {
  await closeDb();
}
