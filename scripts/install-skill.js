#!/usr/bin/env node
/**
 * Install a single skill into the local CRHQ satellite.
 *
 * Expected input: a folder containing SKILL.md (with frontmatter: name, description)
 * and optionally a scripts/ subfolder.
 *
 * Steps (to be implemented):
 *   1. Parse SKILL.md frontmatter -> { name, description }
 *   2. Strip frontmatter to get skill body content
 *   3. POST /api/skills (create) or PUT /api/settings/skills/<name> (update)
 *      via content-api.js for safe content submission
 *   4. If scripts/ exists, copy to /opt/projects/crhq-satellite/skills/<name>/scripts/
 */

'use strict';

function usage() {
  console.error('Usage: install-skill.js <skill-folder> [--force] [--dry-run]');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  console.log('[install-skill] (stub) not yet implemented');
}

main();
