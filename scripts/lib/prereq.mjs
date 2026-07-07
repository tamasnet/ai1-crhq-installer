// prereq.mjs — dependency guards that run BEFORE any write. A failure throws PrereqError,
// which the runner maps to verdict PREREQ-MISSING (exit 1) so we never register a broken job.
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';

export class PrereqError extends Error {
  constructor(missing, kind = 'skills') {
    super(`Missing required ${kind}: ${missing.join(', ')}`);
    this.name = 'PrereqError';
    this.missing = missing;
    this.kind = kind;
  }
}

// Each named skill must exist and be active in ctx.db (the install schema).
export async function requireSkills(ctx, names = []) {
  const missing = [];
  for (const name of names) {
    const row = await ctx.db('skills').where({ name }).first();
    if (!row || row.is_active === false) missing.push(name);
  }
  if (missing.length) throw new PrereqError(missing, 'skills');
}

// Each path must exist on disk. Relative paths resolve against ctx.SKILLS_BASE (the skill-parent dir),
// so a job can require `<skill-key>` and we check that the skill's install dir is present.
export function requireFiles(ctx, paths = []) {
  const missing = [];
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : join(ctx.SKILLS_BASE, p);
    if (!existsSync(abs)) missing.push(p);
  }
  if (missing.length) throw new PrereqError(missing, 'files');
}
