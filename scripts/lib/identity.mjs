// identity.mjs — satellite identity helpers. DEPENDENCY-FREE (only `os` + env), so any utility —
// including the DB-free remote client — can import it without pulling in the knex/log layers. The
// goal is that the name a satellite publishes its own resources under is computed ONE way everywhere.
import { hostname } from 'node:os';

// The satellite's id: `SATELLITE_ID` env when set, else the host name minus its conventional `crhq-`
// prefix (the D-27/D-37 convention).
export function resolveSatelliteId() {
  return process.env.SATELLITE_ID || hostname().replace(/^crhq-/, '');
}

// The package name a satellite publishes its OWN resources under (e.g. a mirror/backup package).
// Heuristic, applied in order to the satellite id:
//   1. start from the satellite id,
//   2. drop a leading `myzone-` if present,
//   3. ensure a leading `ai1-` (add it when absent).
// e.g. `myzone-tamas` → `ai1-tamas`, `tamas` → `ai1-tamas`, `ai1-foo` → `ai1-foo`,
//      `myzone-ai1-foo` → `ai1-foo`.
export function satellitePackageName(satelliteId = resolveSatelliteId()) {
  let name = String(satelliteId);
  if (name.startsWith('myzone-')) name = name.slice('myzone-'.length);
  if (!name.startsWith('ai1-')) name = `ai1-${name}`;
  return name;
}
