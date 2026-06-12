// preflight.mjs — fail fast before any component work: confirm the DB is reachable and that the
// directory the mode writes into is writable (INSTALL_BASE_DIR for installs, BACKUP_BASE_DIR for
// backups). A failure is a transport-class error → exit 2.
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

export class PreflightError extends Error {
  constructor(message) { super(message); this.name = 'PreflightError'; }
}

export async function preflight(ctx) {
  try {
    await ctx.db.raw('select 1');
  } catch (e) {
    throw new PreflightError(`database not reachable: ${e.message}`);
  }

  if (ctx.mode === 'status') return;           // status is read-only — no write probe needed

  // Backup reads the DB and writes only under BACKUP_BASE_DIR; installs write under BASE.
  const [dir, label] = ctx.mode === 'backup' ? [ctx.BACKUP_BASE, 'BACKUP_BASE_DIR'] : [ctx.BASE, 'INSTALL_BASE_DIR'];
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.ai1-write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  } catch (e) {
    throw new PreflightError(`${label} not writable (${dir}): ${e.message}`);
  }
}
