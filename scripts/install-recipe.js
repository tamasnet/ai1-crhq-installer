#!/usr/bin/env node
/**
 * Install a single recipe into the local CRHQ satellite.
 *
 * Expected input: a JSON file describing the recipe.
 *   { name, description, steps, ... }
 *
 * Steps (to be implemented):
 *   1. Read and validate the JSON
 *   2. POST/PUT to the CRHQ recipes API
 */

'use strict';

function usage() {
  console.error('Usage: install-recipe.js <recipe.json> [--force] [--dry-run]');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  console.log('[install-recipe] (stub) not yet implemented');
}

main();
