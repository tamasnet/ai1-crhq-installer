#!/usr/bin/env node
/**
 * Install a single agent into the local CRHQ satellite.
 *
 * Expected input: a JSON file describing the agent.
 *   { name, description, systemPrompt, model, tools?, ... }
 *
 * Steps (to be implemented):
 *   1. Read and validate the JSON
 *   2. POST/PUT to the CRHQ agents API
 */

'use strict';

function usage() {
  console.error('Usage: install-agent.js <agent.json> [--force] [--dry-run]');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  console.log('[install-agent] (stub) not yet implemented');
}

main();
