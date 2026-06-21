#!/usr/bin/env node
// Sample install_entry — the escape hatch for package-specific steps the declarative installer
// can't infer (OAuth, data seed, starting a one-off process). The runner forwards the mode +
// standard + package-specific flags as argv, and INSTALL_SCHEMA / INSTALL_BASE_DIR via env, so this
// hook honors --dry-run / --uninstall / --status and targets the same (sandbox) schema.
//
// A production hook would import the installer library and reuse the primitives, e.g.:
//   import { createContext, requireSkills, upsertSkill } from
//     '<satellite-root>/user-skills/ai1-satellite-tools/scripts/lib/index.mjs';
// This sample stays dependency-free so it runs before the installer is itself installed.
const argv = process.argv.slice(2);
const mode = argv.includes('--uninstall') ? 'uninstall' : argv.includes('--status') ? 'status' : 'install';
const dry = argv.includes('--dry-run');

if (argv.includes('--skip-extra')) {
  console.log('[sample-entry] --skip-extra set; skipping package-specific steps.');
  process.exit(0);
}

console.log(`[sample-entry] ${mode}${dry ? ' (dry-run)' : ''}: no package-specific steps for the sample bundle.`);
process.exit(0);
