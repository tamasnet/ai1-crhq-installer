// preflight.mjs — fail fast before any component work: confirm the DB is reachable and (for
// write modes) that INSTALL_BASE_DIR is writable. A failure is a transport-class error → exit 2.
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

  if (ctx.mode !== 'status') {                 // status is read-only — no write probe needed
    try {
      mkdirSync(ctx.BASE, { recursive: true });
      const probe = join(ctx.BASE, `.ai1-write-probe-${process.pid}`);
      writeFileSync(probe, 'ok');
      rmSync(probe, { force: true });
    } catch (e) {
      throw new PreflightError(`INSTALL_BASE_DIR not writable (${ctx.BASE}): ${e.message}`);
    }
  }
}
