# API Reference — modules, signatures & control flow

The implementation-level contract for `scripts/lib/` and `scripts/install.mjs`. ESM
throughout; primitives are `async (ctx, def) => result`. The public surface is the barrel
`lib/index.mjs`; anything not exported there is internal.

> Naming: `ctx.BASE` is the **resolved `INSTALL_BASE_DIR`** — the parent dir for skill `<key>`
> directories. `ctx.SCHEMA` is the resolved `INSTALL_SCHEMA` (or `null`).

---

## 1. Env resolution (one place: `context.mjs`)

```js
import { join } from 'path';
function resolveBase() {
  return process.env.INSTALL_BASE_DIR
      || (process.env.CRHQ_BASE_DIR && join(process.env.CRHQ_BASE_DIR, 'user-skills'))  // legacy
      || '/opt/projects/crhq-satellite/user-skills';
}
function resolveSchema() {
  return process.env.INSTALL_SCHEMA || process.env.SANDBOX_SCHEMA || null;   // null → default search_path
}
function resolveBackupBase() {
  return process.env.BACKUP_BASE_DIR || join(homedir(), 'backups');          // backup destination parent
}
```

---

## 2. `lib/db.mjs`

```js
import { getDb } from '/opt/projects/crhq-satellite/server/db/knex.js';  // C1 — hardcoded, interceptable
```

| Export | Signature | Notes |
|--------|-----------|-------|
| `getDb()` | `() => Knex` | Memoized **install** connection. If `INSTALL_SCHEMA` set → `searchPath:[schema]`. Reads env at first call — `--sandbox` sets env **before** this is first called. |
| `getAdminDb()` | `() => Knex` | Memoized **admin** connection with **default** search_path. Used by `sandbox.mjs` for `CREATE/DROP SCHEMA` + `LIKE`-clone + cross-schema seed. Separate instance from `getDb()`. |
| `closeDb()` | `async () => void` | `destroy()` both instances; reset memo. |

> **searchPath mechanism:** `getDb()` applies the schema by building its **own**
> `knex({ ...cfg, searchPath:[SCHEMA] })` from the same connection config the CRHQ module
> exposes (not a per-connection `SET search_path`) — one consistent binding, no pool races.
> The hardcoded `server/db/knex.js` import also keeps the legacy loader-hook harness working.

---

## 3. `lib/log.mjs`

```js
export const VERDICT = {
  OK:'INSTALL-OK', ALREADY:'ALREADY-INSTALLED', PARTIAL:'INSTALL-PARTIAL',
  FAIL:'INSTALL-FAIL', PREREQ:'PREREQ-MISSING', LOCKED:'LOCKED-ROW',
  BACKUP_OK:'BACKUP-OK', BACKUP_SKIP:'BACKUP-SKIP', BACKUP_FAIL:'BACKUP-FAIL',  // backup runs (§14)
};
export function makeLogger({ dryRun = false } = {}) { /* … */ }
// logger API:
//   log.info(msg) log.ok(msg) log.warn(msg) log.error(msg)
//   log.dry(msg)            → prefixes "[dry-run] would " (C7 token)
//   log.installComplete()   → prints "✅ … installed successfully."   (C7 regex)
//   log.uninstallComplete() → prints "Uninstall complete."             (C7 regex)
//   log.backupComplete()    → prints "✅ Backup complete."
//   log.summary(results)    → table of {type,name,verdict}
```

Any line matching `^(error:|❌|fatal:|uncaught|throw)` is a failure signal (C7).

---

## 4. `lib/parse.mjs`

| Export | Signature | Returns |
|--------|-----------|---------|
| `parseFrontmatter(md)` | `(string) => { meta, body }` | `meta` = parsed YAML frontmatter object; `body` = everything after the closing `---`. Hand-rolled. |
| `loadYaml(text)` | `(string) => object` | Full YAML parse via the vendored `yaml` bundle (`lib/vendor/yaml.mjs` — regenerate via the command in its header). |
| `dumpYaml(obj)` | `(object) => string` | YAML document from plain maps/arrays/scalars (the backup path, D-29). Hand-rolled, correct-by-construction: a scalar that isn't provably plain-safe is emitted JSON-double-quoted (valid YAML). `undefined` values omitted. Round-trip tested against the vendored parser. |

## 5. `lib/fs.mjs` (all paths absolute; honor `ctx.DRY_RUN` via the `opts.dryRun` arg)

| Export | Signature | Returns |
|--------|-----------|---------|
| `copyTree(srcDir, destDir, opts)` | `(string,string,{dryRun}) => number` | entries copied (or would-copy count in dry-run; zero writes). |
| `writeIfChanged(path, content, opts)` | `(string,string,{dryRun}) => boolean` | true if it wrote (or would). Skips identical content (idempotent). |
| `removeTree(path, opts)` | `(string,{dryRun}) => boolean` | true if removed (or would). |
| `safeName(name)` | `(string) => string` | filesystem-safe base name for a component (backup path): keep `[A-Za-z0-9._-]`, other runs → `-`; never empty/dot-leading. Caller dedupes collisions. |

## 6. `lib/prereq.mjs` (C12)

| Export | Signature | Behavior |
|--------|-----------|----------|
| `requireSkills(ctx, names)` | `(ctx,string[]) => void` | each must exist + `is_active` in `ctx.db`; else throw `PrereqError(names_missing)` (→ verdict `PREREQ-MISSING`, exit 1). |
| `requireFiles(ctx, paths)` | `(ctx,string[]) => void` | each must `existsSync`; else `PrereqError`. Paths resolved against `ctx.BASE` when relative. |

## 6a. `lib/preflight.mjs`

| Export | Signature | Behavior |
|--------|-----------|----------|
| `preflight(ctx)` | `async (ctx) => void` | `select 1` against `ctx.db` (DB reachable); then probe-write the dir the mode writes into — `ctx.BASE` for install/uninstall, `ctx.BACKUP_BASE` for backup, none for status. Failure → `PreflightError` → transport exit `2`, before any component work. |
| `PreflightError` | `class extends Error` | |

## 6b. `lib/install-log.mjs` — `${PACKAGES_DIR}/install.json` (D-24)

| Export | Signature | Behavior |
|--------|-----------|----------|
| `resolvePackagesDir()` | `() => string` | `PACKAGES_DIR \|\| join(homedir(),'packages')`. |
| `installLogPath(dir?)` | `(string?) => string` | `<packagesDir>/install.json`. |
| `readInstallLog(dir?)` | `(string?) => object` | Parsed log (`{}` if absent); throws on a non-object. |
| `updateInstallLog(ctx, meta, plan, packageRoot)` | `=> string\|null` | Applies the finished run to the log; returns the path written, or `null` when skipped (dry-run, status, nothing processed). |

Log shape — keyed by package name:

```js
{ "<package>": { version, installed_at, components: [
    { type, name, version?, installed_at, source }   // source = component manifest file, relative to package root
] } }
```

Rules: only processed `OK`/`ALREADY` results change entries (install upserts — `ALREADY`
keeps its original date; uninstall deletes, with the package key removed alongside its last
component). Failures leave the log alone. A corrupt log is warned about and rebuilt. The CLI
wraps the call so a log write failure warns instead of failing the install.

## 6c. `lib/filter.mjs` — `--include` / `--exclude` (component selection)

| Export | Signature | Behavior |
|--------|-----------|----------|
| `compileMatcher(pattern, label?)` | `(string,string?) => (name)=>boolean` | No regex metacharacter (`` . ^ $ * + ? ( ) [ ] { } \| \ ``) → exact match (`name === pattern`, i.e. `^pattern$`). Otherwise → `new RegExp(pattern).test(name)` (case-sensitive, unanchored). Invalid regex → throw `FilterError`. |
| `makeFilter({include, exclude})` | `({string?,string?}) => (name)=>boolean` | Selected iff matches `include` (or none) AND not `exclude`. Compiles eagerly (fail-fast). |
| `hasFilter({include, exclude})` | `=> boolean` | True if either pattern was supplied. |
| `FilterError` | `class extends Error` | Mapped by `install.mjs` to exit `2` (usage). |

## 6d. `lib/flags.mjs` — supported-option contract (dependency-free)

The single source of truth for which CLI options each mode accepts. Kept free of `db`/`log` imports
so `manifest.mjs` can reuse `STANDARD_FLAG_NAMES` without pulling in the knex layer.

| Export | Signature | Behavior |
|--------|-----------|----------|
| `FLAG_SPEC` | `{ install:{bool[],value[]}, backup:{bool[],value[]} }` | Standard flags per mode. `bool` = present/absent; `value` = require `--flag=<v>`. |
| `STANDARD_FLAG_NAMES` | `Set<string>` | All standard flag names (+ `--help`). Used for the "not supported by `<mode>`" message and to forbid `install_flags` shadowing a standard flag. |
| `validateFlags(argv,{mode,declared})` | `=> void \| throws UsageError` | Reject the first unsupported option, or a value flag with no value (bare `--flag` / empty `--flag=`), or a value on a boolean flag. `declared` = package-specific `install_flags` names accepted in `install` mode. Positionals and `--help` are skipped. |
| `wantsHelp(argv)` | `(string[]) => boolean` | True if `--help` is present (CLIs short-circuit to `usage()` + exit `0`). |
| `usage(mode)` | `(string) => string` | The help text for `install` / `backup`. |
| `declaredFlagNames(meta)` | `(meta) => string[]` | Package-specific flag names from `meta.install_flags`. |
| `UsageError` | `class extends Error` | Mapped by both CLIs to exit `2` (usage). |

---

## 7. `lib/manifest.mjs`

```js
loadManifest(pathOrDir) → { meta, plan, packageRoot }
validateManifest(meta)  → void | throws ManifestError   // required fields, enums, shapes, version pins
```

- `pathOrDir`: a file (`ai1-package.yaml`) or a dir (defaults to `<dir>/ai1-package.yaml`).
- `packageRoot` = dir containing the manifest; all component `path`s resolve against it.
- `plan` is **ordered** and grouped:

```js
plan = {
  skills:   [SkillDef],    recipes:  [RecipeDef],
  agents:   [AgentDef],    jobs:     [JobDef],
  services: [ServiceDef],
}
```

### Def shapes (parsed source — install-time fields computed by primitives from `ctx`)

```js
SkillDef   = { key, name, description, version, srcDir, content, installType? }  // content = SKILL.md (full md); installType: 'org'|'user'
RecipeDef  = { name, description, content, srcFile, version? }
AgentDef   = { name, display_name, description, mode, default_model?, icon?, provider?, system_prompt_path?, capabilities?, instructions?, skills:[], recipes:[], srcFile }  // .md frontmatter + body→instructions; name → agents.key, display_name → agents.name (D-23/D-32)
JobDef     = { name, description, schedule, timezone?, script, args?, timeout_minutes?,
               max_concurrent?, skip_if_running?, enabled?, requires:[], srcFile }
ServiceDef = { name, version, start, port?, cwd?, build?, env?, nginx?, srcDir }   // port omitted → allocated at deploy
```

`key`/`name`/`version` for a skill come from `SKILL.md` frontmatter; a service's
`name`/`version` come from `service.yaml`. **`validateManifest` enforces that `version`
matches the `components[].version` pin for both skills and services** (required), and for
recipes if a pin is present.

---

## 8. `lib/context.mjs` — `createContext(argv)`

```js
const ctx = await createContext(process.argv);
```

Builds and returns:

```js
const ctx = await createContext(argv, opts /* { mode? } — backup.mjs passes { mode:'backup' } */);
ctx = {
  // parsed flags
  mode: 'install'|'uninstall'|'status'|'backup',   // --uninstall/--status (default install); 'backup' set by its CLI entry
  DRY_RUN, RESPECT_LOCKS, INSTALL_SKILLS_AS_USER, JSON,
  TYPE /* string[]|null — --type=<types> (comma-separated/repeatable; formerly --only) */,
  INCLUDE, EXCLUDE /* string|null — --include=/--exclude= name filter (regex; see §6c) */,
  NAME /* string|null — --name= (backup package name, D-27) */,
  SANDBOX, KEEP, LIFECYCLE,
  packageArg,                              // manifest path/dir arg (default '.'); backup: output base dir override

  // resolved env
  BASE,          // resolveBase()        — skill-parent dir
  SCHEMA,        // resolveSchema()      — or null
  PACKAGES_DIR,  // resolvePackagesDir() — install-log home (D-24)
  BACKUP_BASE,   // backup mode: resolve(packageArg) when given, else resolveBackupBase()

  // wired deps
  db,      // getDb()         — install knex (searchPath = SCHEMA)
  log,     // makeLogger({dryRun:DRY_RUN})
  results: [],                             // accumulator of RunResult (see §12)

  // methods
  record(r),          // push a RunResult, mirror to log
  report(),           // log.summary + completion string; set process.exitCode by taxonomy
  async close(),      // closeDb()
}
```

`createContext` is the **only** place flags are parsed and env resolved — `install.mjs` and
any `install_entry` share it, so behavior is identical.

---

## 9. `lib/core/*` — primitives

All are `async (ctx, def) => RunResult`. They honor `ctx.DRY_RUN` (zero writes, `log.dry(...)`),
`ctx.RESPECT_LOCKS`, and append to `ctx.results` via `ctx.record`.

### `core/skill.mjs`
```js
upsertSkill(ctx, def)  // SkillDef
// 0. registration type: asUser = ctx.INSTALL_SKILLS_AS_USER || def.installType==='user'
//    → skill_type = asUser?'user':'org'; locked = !asUser   (default = org + locked)
// 1. row = db('skills').where({name:def.name}).first()
// 2. if row.locked: RESPECT_LOCKS ? skip(LOCKED) : (on an actual update) unlock first (C5 — the
//    live PG trigger forbids UPDATE on a locked row)
// 3. computed: skillDir = join(ctx.BASE, def.key); skillPath = `db://skills/${def.name}`
// 4. insert|update skills {name,description,content,skill_type,locked,skill_path,skill_dir,
//                          is_active:true,is_global:false,updated_at,(created_at on insert)}
// 5. copyTree(def.srcDir, skillDir, {dryRun})   // assets → INSTALL_BASE_DIR/<key> (always)
// → { type:'skill', name, verdict, action:'created'|'updated'|'skipped', files }
removeSkill(ctx, nameOrDef)   // unlock-then-delete (or --respect-locks skips) + removeTree(join(BASE,key))
statusSkill(ctx, nameOrDef)   // { present, active, filesPresent }
exportSkill(ctx, row, { outRoot, relPath })   // backup (§14): copy skill_dir tree → outRoot/relPath, then
// regenerate SKILL.md from the row (DB content authoritative; version from content/on-disk frontmatter
// else '0.0.0' + warn). → { …, entry:{path, version, install_type?} } for the generated manifest
```

### `core/recipe.mjs`
```js
upsertRecipe(ctx, def)  // insert|update recipes by name {name,description,content,is_active:true,…}; uuid auto
removeRecipe(ctx, nameOrDef)
statusRecipe(ctx, nameOrDef) // { present, active }
exportRecipe(ctx, row, { outRoot, relPath })  // backup: frontmatter{name,description} + body=content (no version col in DB)
```

### `core/agent.mjs`
```js
upsertAgent(ctx, def)
// 1. insert|update agents by key=def.name {key, name:def.display_name, description, mode,
//    is_active:true, (default_model?, icon?, provider?, system_prompt_path?, capabilities? (jsonb),
//    instructions?)} — each optional field set only when present, else DB default; drift-checked (D-32)
// 2. sync agent_skills: for each def.skills → attach IFF skill exists+active; onConflict ignore;
//    remove stale links not in def.skills
// 3. sync agent_recipes: resolve each name→recipe_id (uuid); onConflict ignore; remove stale
removeAgent(ctx, nameOrDef)   // del agent_skills + agent_recipes + agents row
statusAgent(ctx, nameOrDef)   // { present, active, skills:[], recipes:[] }
exportAgent(ctx, row, { outRoot, relPath })   // backup: reverse D-23 (key→name, name→display_name) as
// an .md — frontmatter (incl. provider/system_prompt_path/capabilities when non-default) + body=instructions;
// joins resolve to names. Fully lossless round trip (D-32)
```

### `core/job.mjs`
```js
upsertJob(ctx, def)
// 1. prereq: requireSkills(ctx, def.requires) (coarse C12 guard)
// 2. script_args = join(ctx.BASE, def.script) + (def.args ? ' '+def.args : '')
// 3. insert|update background_jobs by name {id:`job-<ts>-<rand>` on insert, job_type:'script',
//    script_path:'node', script_args, schedule, timezone?, timeout_minutes?, max_concurrent?,
//    skip_if_running?, enabled:def.enabled??true, run_count:0 on insert, …}
removeJob(ctx, nameOrDef)     // del background_jobs by name
statusJob(ctx, nameOrDef)     // { present, enabled, schedule }
exportJob(ctx, row, { outRoot, relPath, skillNames })  // backup: script/node jobs whose script lives
// under BASE → script_args reverse-split to {script, args}; requires re-derived from the script's
// skill segment when in skillNames. Anything else → BACKUP-SKIP + warn (D-28)
```

### `core/service.mjs` (non-DB; inline deploy templates)
```js
installService(ctx, def)
// build step always runs (validate version pin + run def.build + render .env / ecosystem.config.cjs / nginx vhost)
// DRY_RUN → stop after build (skip apply); SANDBOX → skipped entirely.
// else apply: copy source → /opt/projects/user/<name>/, port alloc, pm2 start/save, nginx reload
removeService(ctx, nameOrDef) // pm2 delete + rm vhost + rm project dir + reload (never touch crhq-satellite)
statusService(ctx, nameOrDef) // { dirPresent, pm2Present, vhostPresent }
```

---

## 10. `lib/run.mjs` — `runPlan(ctx, plan)`

The shared plan dispatcher used by both the CLI and the sandbox lifecycle suite.

```js
export const ORDER = ['skills','recipes','agents','jobs','services'];
// --type=<types> restricts which TYPES run; intersected with ORDER so canonical install
// order holds regardless of input order (unknown names select nothing).
// mode picks the primitive: install→upsert*, --uninstall→remove* (types reversed), --status→status*.
// --include/--exclude: each def's `name` (the canonical id for every type) tested against the
// compiled matcher; selection is reflected in ctx.plannedSkills/plannedRecipes so dry-run
// dependency previews stay accurate. Zero-match → warn (list available) + exit 0.
// Continue-and-report: a failing component records INSTALL-FAIL but doesn't abort the rest.
```

---

## 11. `lib/sandbox.mjs`

```js
const TABLES = ['skills','skill_versions','recipes','agents','agent_skills','agent_recipes','background_jobs'];

provisionSandbox({ ts, seed = true })
// admin = getAdminDb(); schema = `sandbox_${ts}`; baseDir = temp skill-parent dir
// CREATE SCHEMA + per table: CREATE TABLE <schema>.<t> (LIKE public.<t> INCLUDING ALL)
//   — clones live columns/defaults/constraints/indexes; FKs are NOT re-created (guarded join
//     inserts + explicit join cleanup make them unnecessary)
// seed: INSERT INTO <schema>.skills SELECT … FROM public.skills  (so agent-attach + dep checks mirror live)
// set INSTALL_SCHEMA + INSTALL_BASE_DIR + PACKAGES_DIR BEFORE createContext/getDb run
// → { schema, baseDir, teardown(keep) }   // teardown: DROP SCHEMA CASCADE + rm tempdir unless keep

runLifecycle(ctx, plan)
// install → status → install#2 (snapshot diff == 0) → uninstall (clean) → reinstall (matches #1)
// → { phases:[{name,passed,detail}], passed }

snapshotState(adminDb, schema)  // → { skill names, row counts per table, join pairs, file list }
diffState(a, b)                 // → string[] of differences
```

> **ID/timestamp generation:** `ts`, the schema name, and `job-<ts>-<rand>` ids are minted at
> the **CLI entry** (`stamp()`) and threaded into lib calls, so `lib/` stays deterministic
> for tests.

---

## 12. `scripts/install.mjs` — control flow

```js
const argv = process.argv.slice(2);
if (wantsHelp(argv)) { console.log(usage('install')); process.exit(0); }   // --help short-circuits
let sb = null;
try {
  // Load the manifest FIRST (no DB/sandbox needed) so install_flags are known, then validate the
  // options — an unsupported option or a value flag with no value → UsageError → exit 2, before
  // any side effect (no sandbox provisioned, no DB opened).
  const { meta, plan, packageRoot } = loadManifest(packageArgOf(argv));
  validateFlags(argv, { mode:'install', declared: declaredFlagNames(meta) });

  if (hasFlag(argv,'--sandbox')) sb = await sandbox.provisionSandbox({ ts: stamp() });  // sets env first

  const ctx  = await createContext(argv);          // reads env (sandbox-redirected if sb)
  await preflight(ctx);                            // DB reachable; BASE writable → else exit 2

  if (sb && ctx.LIFECYCLE) {
    await sandbox.runLifecycle(ctx, plan);
  } else {
    await runPlan(ctx, plan);
    // update ${PACKAGES_DIR}/install.json from ctx.results (D-24) — skipped in dry-run/status;
    // a write failure warns, never fails the install
    // then: install_entry (if meta.install_entry) as a spawnSync('node', [entry, ...]) SUBPROCESS,
    // for ALL modes, forwarding mode + standard + package-specific flags as argv (sandbox-internal
    // flags and the package path are not forwarded; INSTALL_SCHEMA/BASE_DIR inherited via env)
  }
  ctx.report();                                     // completion string + exit code
} catch (e) {
  handleFatal(e);                                   // Usage/Manifest/Prereq/Preflight/Filter → exit code
} finally {
  if (sb) await sb.teardown(hasFlag(argv,'--keep'));
  await closeDb();
}
```

---

## 13. Result taxonomy & exit codes

```js
RunResult = { type, name, verdict /* VERDICT.* */, action?, detail? }
```

| Condition | Verdict | Exit |
|-----------|---------|------|
| created/updated ok | `INSTALL-OK` | 0 |
| already current (no change) | `ALREADY-INSTALLED` | 0 |
| some components failed | `INSTALL-PARTIAL` | 1 |
| component failed | `INSTALL-FAIL` | 1 |
| missing dependency | `PREREQ-MISSING` | 1 |
| locked + `--respect-locks` | `LOCKED-ROW` | 1 |
| component exported (backup) | `BACKUP-OK` | 0 |
| not expressible in the format (backup) | `BACKUP-SKIP` | 0 |
| component export failed (backup) | `BACKUP-FAIL` | 1 |
| unsupported option / value flag with no value (`UsageError`) | (usage) | 2 |
| DB unreachable / BASE unwritable / manifest unreadable / bad filter | (transport/usage) | 2 |

`ctx.report()` sets `process.exitCode` to the max severity across `ctx.results`. `--json`
emits the machine-readable report alongside (for backups, with a `package:{name,version,dir}`
block via `ctx.reportExtra`).

---

## 14. `lib/backup.mjs` + `scripts/backup.mjs` — the reverse of install

```js
export const BACKUP_TYPES = ['skills','recipes','agents','jobs'];  // services out of scope (v1)

resolveBackupName()       // → `${SATELLITE_ID || hostname() minus 'crhq-'}-backup` (D-27)
dateVersion(now)          // → 'YYYY.M.D' — minted at the CLI entry, threaded in (lib stays deterministic)

runBackup(ctx, { now })   // → { dir, meta, results }
// 1. discover (D-25): active org/user skills · active recipes · non-system active agents ·
//    non-system jobs — ordered by name (deterministic output). Reads via ctx.db (getDb()), so
//    INSTALL_SCHEMA still applies — tests point it at a sandbox schema; there is no backup sandbox.
// 2. select: --type ∩ BACKUP_TYPES (warn if 'services' requested) + --include/--exclude on the
//    canonical name per type (skills/recipes/jobs: name; agents: key) — same semantics as runPlan,
//    incl. the zero-match warn.
// 3. export each component into a STAGING dir (`<dest>.staging-<pid>`) via core export*
//    primitives (§9); paths are safeName()-sanitized + collision-deduped. Continue-and-report:
//    a throwing component records BACKUP-FAIL but doesn't abort the run.
// 4. write ai1-package.yaml (dumpYaml) from the collected entry objects; self-check with the
//    REAL loadManifest() — the backup must itself be installable (parse-level guarantee).
// 5. swap (D-26): rm dest, rename staging → dest. On any failure the staging dir is removed and
//    the previous backup is left untouched.
//
// --dry-run (D-31): same pipeline, zero fs writes. The export* primitives thread ctx.DRY_RUN
// into the fs helpers (copyTree/writeIfChanged), so steps 1–3 run fully — incl. D-28 skip rules,
// warnings, and per-component verdicts; step 4's self-check becomes an in-memory
// validateManifest(meta) (nothing was staged to load); step 5 is replaced by a
// `[dry-run] would write backup package: <dest>` line. reportExtra.package gains dryRun:true.
```

`scripts/backup.mjs` control flow: `--help`? print `usage('backup')` + exit 0 →
`validateFlags(argv,{mode:'backup'})` (`--dry-run` is accepted (D-31); the other install-lifecycle
flags report "not supported by backup"; unsupported option / missing value → usage exit 2) →
`createContext(argv, { mode:'backup' })` → `preflight` (DB + `BACKUP_BASE` writable) →
`runBackup(ctx, { now: new Date() })` → `ctx.report()` (`✅ Backup complete.`), `closeDb()` in
`finally`. Restore is simply `install.mjs ${BACKUP_BASE_DIR}/<name>`.
