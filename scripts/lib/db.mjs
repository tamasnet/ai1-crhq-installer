// db.mjs — canonical knex wrapper. DB access goes ONLY through the hardcoded import below
// so the sandbox loader hook can intercept it; getDb() additionally honors INSTALL_SCHEMA via a
// native knex searchPath, which is how the built-in --sandbox redirects writes.
import { getDb as getCrhqDb, closeDb as closeCrhqDb } from '/opt/projects/crhq-satellite/server/db/knex.js';
import { createRequire } from 'module';

// Resolve the `knex` factory from the satellite's own dependency tree (anchored at the hardcoded
// knex module path). We only resolve the package — we never read knex.js's contents.
const require = createRequire('/opt/projects/crhq-satellite/server/db/knex.js');

let installDb = null;     // schema-scoped install connection (=== base when no INSTALL_SCHEMA)
let scopedOwned = false;  // true when installDb is a separate instance we created and must destroy

function resolveSchema() {
  return process.env.INSTALL_SCHEMA || process.env.SANDBOX_SCHEMA || null;
}

// Admin connection: default search_path (public). Used by sandbox.mjs for CREATE/DROP SCHEMA,
// the LIKE-clone, cross-schema seed, and snapshots. This is the CRHQ base instance.
export function getAdminDb() {
  return getCrhqDb();
}

// Install connection: memoized. Reads env at first call — the sandbox must set INSTALL_SCHEMA
// before this is first invoked.
export function getDb() {
  if (installDb) return installDb;
  const base = getCrhqDb();
  const schema = resolveSchema();
  if (!schema) {
    installDb = base;          // no override → reuse the base connection
    scopedOwned = false;
  } else {
    const Knex = require('knex');
    installDb = Knex({ ...base.client.config, searchPath: [schema] });
    scopedOwned = true;
  }
  return installDb;
}

export async function closeDb() {
  if (scopedOwned && installDb) await installDb.destroy();
  installDb = null;
  scopedOwned = false;
  await closeCrhqDb();          // destroys the CRHQ base (admin) instance
}
