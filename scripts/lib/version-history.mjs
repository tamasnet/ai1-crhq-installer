// version-history.mjs — round-trip a component's integer version through its CRHQ *_versions table.
// skill_versions / recipe_versions / agent_versions are parallel: a per-entity integer
// `version_num` (UNIQUE per entity), where the live ("current") version is MAX(version_num). The FK
// to the main table is ON DELETE CASCADE, so a real uninstall drops history automatically; the
// FK-less --sandbox needs the explicit cleanup removeVersions() provides.
//
//   install  → recordVersion(): write the package's declared version as a version_num row so CRHQ's
//              number matches the package (idempotent merge; warns on a non-incrementing version).
//   backup   → currentVersion(): read MAX(version_num) as the live version to pin in the package.
//
// Only DB-resident, versioned types participate (skills/recipes/agents). Jobs have no version table;
// services/projects aren't DB-resident (their version lives in service.yaml/project.yaml + the install log).

// type → its version table, FK column to the main row, and the column that holds the body.
const SPEC = {
  skill: { table: 'skill_versions', fk: 'skill_name', body: 'content' },
  recipe: { table: 'recipe_versions', fk: 'recipe_id', body: 'content' },
  agent: { table: 'agent_versions', fk: 'agent_key', body: 'instructions' },
};

export function versionTable(type) {
  return SPEC[type]?.table || null;
}

// Highest version_num recorded for an entity (its current/live version), or null if none.
export async function currentVersion(db, type, fkValue) {
  const s = SPEC[type];
  if (!s || fkValue == null) return null;
  const row = await db(s.table).where({ [s.fk]: fkValue }).max('version_num as mx').first();
  return row?.mx ?? null;
}

// Upsert the version_num row for an installed component, snapshotting its current body. Idempotent:
// re-recording the same version merges the snapshot, never duplicates. Warns (warn-and-continue)
// when the version is strictly lower than what's already recorded. No DB write in dry-run —
// just logs the intent. The caller resolves fkValue (recipes need the row uuid).
export async function recordVersion(ctx, type, { fkValue, version, name, description, body }) {
  const s = SPEC[type];
  if (!s || version == null) return;
  const { db, log, DRY_RUN } = ctx;

  const cur = await currentVersion(db, type, fkValue);
  if (cur != null && version < cur) {
    log.warn(`${type} ${name}: version ${version} is lower than the recorded version ${cur} (downgrade) — recording it anyway`);
  }
  if (DRY_RUN) { log.dry(`record ${type} ${name} as version ${version} in ${s.table}`); return; }

  const summary = ctx.PACKAGE ? `Installed from ${ctx.PACKAGE.name} v${ctx.PACKAGE.version}` : 'Installed by ai1-satellite-tools';
  const snapshot = { name: name ?? null, description: description || '', [s.body]: body || '', changed_by: 'ai1-installer', change_summary: summary };
  await db(s.table)
    .insert({ [s.fk]: fkValue, version_num: version, ...snapshot, created_at: new Date() })
    .onConflict([s.fk, 'version_num']).merge(snapshot);
}

// Delete an entity's version history — mirrors the real-DB ON DELETE CASCADE in the FK-less sandbox
// (and is a harmless no-op on the real DB, where the cascade already fired). Skipped in dry-run.
export async function removeVersions(ctx, type, fkValue) {
  const s = SPEC[type];
  if (!s || fkValue == null || ctx.DRY_RUN) return;
  await ctx.db(s.table).where({ [s.fk]: fkValue }).del();
}
