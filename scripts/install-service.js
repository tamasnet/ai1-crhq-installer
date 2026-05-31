#!/usr/bin/env node
/**
 * Install a standalone web service alongside the CRHQ satellite.
 *
 * Expected input: a folder containing:
 *   - service.json   { name, port, start, cwd, env?, nginx: { subdomain, ssl } }
 *   - application source code
 *
 * Steps (to be implemented):
 *   1. Validate service.json
 *   2. Copy source to /opt/projects/user/<name>/
 *   3. Write nginx vhost to /etc/nginx/projects.d/<name>.conf (with SSL if requested)
 *   4. Reload nginx
 *   5. Start (or restart) PM2 process named <name>
 *   6. Persist PM2 process list
 *
 * Note: services are NOT registered with CRHQ — they only live as nginx + PM2 entries.
 */

'use strict';

function usage() {
  console.error('Usage: install-service.js <service-folder> [--force] [--dry-run]');
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  console.log('[install-service] (stub) not yet implemented');
}

main();
