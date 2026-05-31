#!/usr/bin/env node
/**
 * ai1-crhq-installer — main entry point.
 *
 * Reads a manifest JSON file and dispatches each declared resource to the
 * appropriate per-type installer. Not yet implemented — this is a stub that
 * prints the parsed manifest so the wiring can be tested end-to-end first.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage: install.js <manifest.json> [--dry-run] [--force]');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const manifestPath = path.resolve(args[0]);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');

  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const baseDir = path.dirname(manifestPath);

  console.log(`[ai1-installer] manifest: ${manifest.name} v${manifest.version}`);
  console.log(`[ai1-installer] baseDir:  ${baseDir}`);
  console.log(`[ai1-installer] dryRun:   ${dryRun}`);
  console.log(`[ai1-installer] force:    ${force}`);
  console.log('[ai1-installer] resources:');
  for (const [kind, items] of Object.entries(manifest.resources || {})) {
    console.log(`  - ${kind}: ${items.length}`);
  }

  // TODO: dispatch to install-skill.js / install-agent.js / install-recipe.js / install-service.js
  console.log('[ai1-installer] (stub) installer dispatch not yet implemented');
}

main();
