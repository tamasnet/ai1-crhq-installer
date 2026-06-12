#!/usr/bin/env node
// ai1-crhq-installer — backup runner (CLI entry): the reverse of install.mjs. Reads the in-scope
// CRHQ DB-resident components (D-25) and writes an installable package (ai1-package.yaml manifest
// format) to ${BACKUP_BASE_DIR}/<name>/, overwriting the previous backup in place via a staged
// build + swap (D-26). Read-only against the DB — no dry-run, no sandbox, always live.
// Restore = `node scripts/install.mjs <backup-dir>`.
//
// Usage: backup.mjs [<backup-base-dir>] [--name=<pkg>] [--type=<types>] [--include=<pat>]
//                   [--exclude=<pat>] [--json] [--help]
import {
  createContext, preflight, closeDb, validateFlags, usage, wantsHelp, UsageError,
  ManifestError, PreflightError, FilterError,
} from './lib/index.mjs';
import { runBackup } from './lib/backup.mjs';

const argv = process.argv.slice(2);
if (wantsHelp(argv)) { console.log(usage('backup')); process.exit(0); }

try {
  // Reject any unsupported option before opening the DB. Install-lifecycle flags (--dry-run,
  // --sandbox, …) make no sense for a live read-only export and are reported as not-supported.
  validateFlags(argv, { mode: 'backup' });
  const ctx = await createContext(argv, { mode: 'backup' });
  ctx.log.info(`backup → ${ctx.BACKUP_BASE} (schema=${ctx.SCHEMA || 'default'})`);
  await preflight(ctx);                       // DB reachable + BACKUP_BASE_DIR writable — else exit 2
  await runBackup(ctx, { now: new Date() });  // version/date minted here, threaded in (lib stays deterministic)
  ctx.report();
} catch (e) {
  if (e instanceof UsageError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof ManifestError) { console.error(`❌ backup self-check failed — generated manifest invalid: ${e.message}`); process.exitCode = 2; }
  else if (e instanceof FilterError) { console.error(`❌ ${e.message}`); process.exitCode = 2; }
  else if (e instanceof PreflightError) { console.error(`❌ preflight failed: ${e.message}`); process.exitCode = 2; }
  else { console.error(`❌ fatal: ${e.stack || e.message}`); process.exitCode = 2; }
} finally {
  await closeDb();
}
