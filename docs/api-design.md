# API Design — signatures & control flow

Implementation-level contract for Phase 1. Pins down `createContext`, the primitive
signatures, the def shapes, `lib/sandbox.mjs`, and the `install.mjs` control flow so the build
can start from something precise. Consistent with `utility-design.md` (B2/B3) + the decisions
log. ESM throughout; primitives are `async (ctx, def) => result`.

> Naming: `ctx.BASE` is the **resolved `INSTALL_BASE_DIR`** — the parent dir for skill `<key>`
> directories (D-19). `ctx.SCHEMA` is the resolved `INSTALL_SCHEMA` (or `null`).

---

## 1. Env resolution (one place: `context.mjs`)

```js
import { join } from 'path';
function resolveBase() {
  return process.env.INSTALL_BASE_DIR
      || (process.env.CRHQ_BASE_DIR && join(process.env.CRHQ_BASE_DIR, 'user-skills'))  // legacy (D-15/D-19)
      || '/opt/projects/crhq-satellite/user-skills';
}
function resolveSchema() {
  return process.env.INSTALL_SCHEMA || process.env.SANDBOX_SCHEMA || null;   // null → default search_path
}
```

---

## 2. `lib/db.mjs`

```js
import { getDb } from '/opt/projects/crhq-satellite/server/db/knex.js';  // C1 — hardcoded, interceptable
```

| Export | Signature | Notes |
|--------|-----------|-------|
| `getDb()` | `() => Knex` | Memoized **install** connection. If `INSTALL_SCHEMA` set → `searchPath:[schema]` (B4 native). Read env at first call — so `--sandbox` must set env **before** this is first called. |
| `getAdminDb()` | `() => Knex` | Memoized **admin** connection with **default** search_path (no override). Used by `sandbox.mjs` for `CREATE/DROP SCHEMA` + `LIKE`-clone + cross-schema seed. Separate instance from `getDb()`. |
| `closeDb()` | `async () => void` | `destroy()` both instances; reset memo. |

> **searchPath mechanism:** `getDb()` applies the schema by building its **own**
> `knex({ ...cfg, searchPath:[SCHEMA] })` from the same connection config the CRHQ module
> exposes (not a per-connection `SET search_path`) — one consistent binding, no pool races.
> The hardcoded `server/db/knex.js` import stays so the legacy loader hook still works.

---

## 3. `lib/log.mjs`

```js
export const VERDICT = {
  OK:'INSTALL-OK', ALREADY:'ALREADY-INSTALLED', PARTIAL:'INSTALL-PARTIAL',
  FAIL:'INSTALL-FAIL', PREREQ:'PREREQ-MISSING', LOCKED:'LOCKED-ROW',
};
export function makeLogger({ dryRun = false } = {}) { /* … */ }
// logger API:
//   log.info(msg) log.ok(msg) log.warn(msg) log.error(msg)
//   log.dry(msg)            → prefixes "[dry-run] would " (C7 token)
//   log.installComplete()   → prints "✅ … installed successfully."   (C7 regex)
//   log.uninstallComplete() → prints "Uninstall complete."             (C7 regex)
//   log.summary(results)    → table of {type,name,verdict}
```

Any line matching `^(error:|❌|fatal:|uncaught|throw)` is a failure signal (canon-conventions C7).

---

## 4. `lib/parse.mjs`

| Export | Signature | Returns |
|--------|-----------|---------|
| `parseFrontmatter(md)` | `(string) => { meta, body }` | `meta` = parsed YAML frontmatter object; `body` = everything after the closing `---`. Zero-dep hand-roll (D-6). |
| `loadYaml(text)` | `(string) => object` | Parse a `.yaml` file's contents using a single small dep (`yaml`). (`parseFrontmatter` stays hand-rolled; this is the one allowed dep — narrows D-6.) |

## 5. `lib/fs.mjs` (all paths absolute; honor `ctx.DRY_RUN` via the `opts.dryRun` arg)

| Export | Signature | Returns |
|--------|-----------|---------|
| `copyTree(srcDir, destDir, opts)` | `(string,string,{dryRun}) => number` | entries copied (or would-copy count in dry-run; zero writes). |
| `writeIfChanged(path, content, opts)` | `(string,string,{dryRun}) => boolean` | true if it wrote (or would). Skips identical content (idempotent, GAP 5). |
| `removeTree(path, opts)` | `(string,{dryRun}) => boolean` | true if removed (or would). |

## 6. `lib/prereq.mjs` (C12)

| Export | Signature | Behavior |
|--------|-----------|----------|
| `requireSkills(ctx, names)` | `(ctx,string[]) => void` | each must exist + `is_active` in `ctx.db`; else throw `PrereqError(names_missing)` (→ verdict `PREREQ-MISSING`, exit 1). |
| `requireFiles(ctx, paths)` | `(ctx,string[]) => void` | each must `existsSync`; else `PrereqError`. Paths resolved against `ctx.BASE` when relative. |

---

## 6a. `lib/filter.mjs` — `--include` / `--exclude` (component selection)

| Export | Signature | Behavior |
|--------|-----------|----------|
| `compileMatcher(pattern, label?)` | `(string,string?) => (name)=>boolean` | No regex metacharacter (`` . ^ $ * + ? ( ) [ ] { } \| \ ``) → exact match (`name === pattern`, i.e. `^pattern$`). Otherwise → `new RegExp(pattern).test(name)` (case-sensitive, unanchored). Invalid regex → throw `FilterError`. |
| `makeFilter({include, exclude})` | `({string?,string?}) => (name)=>boolean` | Selected iff matches `include` (or none) AND not `exclude`. Compiles eagerly (fail-fast). |
| `hasFilter({include, exclude})` | `=> boolean` | True if either pattern was supplied. |
| `FilterError` | `class extends Error` | Mapped by `install.mjs` to exit `2` (usage). |

`runPlan` builds the matcher from `ctx.INCLUDE`/`ctx.EXCLUDE`, tests each component's `nameOf(type,def)`
(agents → `key`, else → `name`), and reflects the selection in `ctx.plannedSkills`/`plannedRecipes`.
A filter selecting 0 of N considered components warns + exits `0` (not an error). The flags compose
with `--only`, `--no-agent`, `--no-job`, and apply to install/uninstall/status alike.

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
SkillDef   = { key, name, description, version, srcDir, content }      // content = SKILL.md (full md)
RecipeDef  = { name, description, content, srcFile }
AgentDef   = { key, name, description, mode, default_model?, icon?, skills:[], recipes:[], srcFile }
JobDef     = { name, description, schedule, timezone?, script, args?, timeout_minutes?,
               max_concurrent?, skip_if_running?, enabled?, requires:[], srcFile }
ServiceDef = { name, version, start, port?, cwd?, build?, env?, nginx?, srcDir }   // port omitted → deploy-project allocates
```

`key`/`name`/`version` for a skill come from `SKILL.md` frontmatter (C11); a service's
`name`/`version` come from `service.yaml`. **`validateManifest` enforces that `version` matches
the `components[].version` pin for both skills and services** (required), and for recipes if a
pin is present.

---

## 8. `lib/context.mjs` — `createContext(argv)`

```js
const ctx = await createContext(process.argv);
```

Builds and returns:

```js
ctx = {
  // parsed flags
  mode: 'install'|'uninstall'|'status',   // from --uninstall/--status (default install)
  DRY_RUN, RESPECT_LOCKS, NO_AGENT, NO_JOB, ONLY /* type|null */,
  INCLUDE, EXCLUDE /* string|null — --include=/--exclude= name filter (regex; see §12) */,
  SANDBOX, KEEP, LIFECYCLE,
  packageArg,                              // manifest path/dir arg (default '.')

  // resolved env (D-19/D-15)
  BASE,    // resolveBase()   — skill-parent dir
  SCHEMA,  // resolveSchema() — or null

  // wired deps
  db,      // getDb()         — install knex (searchPath = SCHEMA)
  log,     // makeLogger({dryRun:DRY_RUN})
  results: [],                             // accumulator of RunResult (see §11)

  // methods
  record(r),          // push a RunResult, mirror to log
  report(),           // log.summary + completion string; set process.exitCode by taxonomy
  async close(),      // closeDb()
}
```

`createContext` is the **only** place flags are parsed and env resolved — `install.mjs` and any
`install_entry` share it, so behavior is identical (D-12).

---

## 9. `lib/core/*` — primitives

All are `async (ctx, def) => RunResult`. They honor `ctx.DRY_RUN` (zero writes, `log.dry(...)`),
`ctx.RESPECT_LOCKS`, and append to `ctx.results` via `ctx.record`.

### `core/skill.mjs`
```js
upsertSkill(ctx, def)  // SkillDef
// 1. row = db('skills').where({name:def.name}).first()
// 2. if row.locked: RESPECT_LOCKS ? skip(LOCKED) : unlock (C5)
// 3. computed: skillDir = join(ctx.BASE, def.key); skillPath = `db://skills/${def.name}` (D-19)
// 4. insert|update skills {name,description,content,skill_type:'user',skill_path,skill_dir,
//                          is_active:true,is_global:false,updated_at,(created_at on insert)}
// 5. copyTree(def.srcDir, skillDir, {dryRun})   // assets → INSTALL_BASE_DIR/<key>
// → { type:'skill', name, verdict, action:'created'|'updated'|'skipped', files }
removeSkill(ctx, nameOrDef)   // del row + removeTree(join(BASE,key))
statusSkill(ctx, nameOrDef)   // { present, active, filesPresent }
```

### `core/recipe.mjs`
```js
upsertRecipe(ctx, def)  // insert|update recipes by name {name,description,content,is_active:true,…}; uuid auto
removeRecipe(ctx, nameOrDef)
statusRecipe(ctx, nameOrDef) // { present, active }
```

### `core/agent.mjs`
```js
upsertAgent(ctx, def)
// 1. insert|update agents by key {key,name,description,mode,is_active:true,(default_model?,icon?)}
//    (minimal; rely on DB defaults — integration-ref §2)
// 2. NO_AGENT? → skip entirely
// 3. sync agent_skills: for each def.skills → attach IFF skill exists+active; onConflict ignore;
//    remove stale links not in def.skills
// 4. sync agent_recipes: resolve each name→recipe_id (uuid) ; onConflict ignore; remove stale
removeAgent(ctx, keyOrDef)    // del agent_skills + agent_recipes + agents row
statusAgent(ctx, keyOrDef)    // { present, active, skills:[], recipes:[] }
```

### `core/job.mjs`
```js
upsertJob(ctx, def)
// 0. NO_JOB? → skip
// 1. prereq: requireSkills(ctx, def.requires) (coarse C12 guard)
// 2. script_args = join(ctx.BASE, def.script) + (def.args ? ' '+def.args : '')
// 3. insert|update background_jobs by name {id:`job-<ts>-<rand>` on insert, job_type:'script',
//    script_path:'node', script_args, schedule, timezone?, timeout_minutes?, max_concurrent?,
//    skip_if_running?, enabled:def.enabled??true, run_count:0 on insert, …}
removeJob(ctx, nameOrDef)     // del background_jobs by name
statusJob(ctx, nameOrDef)     // { present, enabled, schedule }
```

### `core/service.mjs` (non-DB; deploy-project — D-2)
```js
installService(ctx, def)
// build step always runs (validate version pin + run def.build + emit /opt/projects/user/<name>/, .env, ecosystem.config.cjs, nginx vhost)
// DRY_RUN → stop after build (skip deploy-project apply) (D-2a); else apply: port alloc, pm2 start/save, nginx reload
removeService(ctx, nameOrDef) // pm2 delete + rm vhost + reload (never touch crhq-satellite)
statusService(ctx, nameOrDef) // { dirPresent, pm2Present, vhostPresent }
```

---

## 10. `lib/sandbox.mjs` (D-17/D-18)

```js
const TABLES = ['skills','skill_versions','recipes','agents','agent_skills','agent_recipes','background_jobs'];

async function provisionSandbox({ ts, seed = true } = {}) {
  const admin  = getAdminDb();
  const schema = `sandbox_${ts}`;               // `ts` is generated at the CLI entry and passed in — keeps lib deterministic/testable
  const baseDir = `<INSTALL_BASE_DIR-tempdir>`; // e.g. .scratch/sandbox-<ts> (the skill-parent dir, D-19)
  await admin.raw('CREATE SCHEMA ??', [schema]);
  for (const t of TABLES)
    await admin.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, t, t]);  // D-18
  // (optional, OQ-14) re-create intra-schema FKs
  if (seed)                                      // OQ-14 seed: mirror live utility skills so agent-attach works
    await admin.raw(
      'INSERT INTO ??.skills (name,description,skill_path,skill_type,is_active) ' +
      'SELECT name,description,skill_path,skill_type,is_active FROM public.skills', [schema]);
  process.env.INSTALL_SCHEMA   = schema;         // redirect BEFORE createContext/getDb (§2/§8)
  process.env.INSTALL_BASE_DIR = baseDir;
  mkdirSync(baseDir, { recursive: true });
  return { schema, baseDir, async teardown(keep){ if(!keep){ await admin.raw('DROP SCHEMA ?? CASCADE',[schema]); rmSync(baseDir,{recursive:true,force:true}); } } };
}

async function runLifecycle(ctx, plan) {
  // install → status → install#2 (snapshot diff == 0) → uninstall (clean) → reinstall (matches#1)
  // returns { phases:[{name,passed,detail}], passed }
}
function snapshotState(adminDb, schema)         // → { skill names, row counts per table, agent_skills/agent_recipes join pairs, file list }
function diffState(a, b)                        // → string[] of differences (deepen to per-row hashes only if this misses drift)
```

`withSandbox(argv, run)` convenience: `provision → createContext → run(ctx) → report → teardown`.

> **ID/timestamp generation:** `ts`, the schema name, and `job-<ts>-<rand>` ids are minted at
> the **CLI entry** (`stamp()`) and threaded into lib calls, so `lib/` stays deterministic for
> tests. (Canon installers calling `Date.now()` directly is also acceptable — C10.)

---

## 11. `scripts/install.mjs` — control flow

```js
import { createContext } from './lib/context.mjs';
import { loadManifest }  from './lib/manifest.mjs';
import * as sandbox      from './lib/sandbox.mjs';
import * as core         from './lib/index.mjs';   // barrel

const argv = process.argv.slice(2);
let sb = null;
try {
  if (hasFlag(argv,'--sandbox')) sb = await sandbox.provisionSandbox({ ts: stamp() });  // sets env first

  const ctx  = await createContext(argv);          // reads env (sandbox-redirected if sb)
  const { meta, plan, packageRoot } = loadManifest(ctx.packageArg);

  if (sb && ctx.LIFECYCLE) {
    await sandbox.runLifecycle(ctx, plan);
  } else {
    await runPlan(ctx, plan);                       // §12
  }
  ctx.report();                                     // completion string + exit code
} catch (e) {
  handleFatal(e);                                   // ManifestError/PrereqError/transport → exit code
} finally {
  if (sb) await sb.teardown(hasFlag(argv,'--keep'));
  await closeDb();
}
```

### §12 `runPlan(ctx, plan)` — order + mode

```js
const ORDER = ['skills','recipes','agents','jobs','services'];      // D-4
const types = ctx.ONLY ? [ctx.ONLY] : ORDER;
const seq   = ctx.mode === 'uninstall' ? [...types].reverse() : types;   // reverse on uninstall (C13)
// --include/--exclude name filter (lib/filter.mjs). nameOf(type,def) is the canonical id (agents→key,
// else→name). A value with NO regex metacharacter is an exact ^value$ match; otherwise it's compiled
// as a case-sensitive RegExp (invalid → FilterError → exit 2). Selected iff matches include (or none)
// AND not exclude. Also reflected in ctx.plannedSkills/plannedRecipes so dry-run deps stay accurate.
const match = makeFilter({ include: ctx.INCLUDE, exclude: ctx.EXCLUDE });
for (const type of seq) {
  if (type==='agents'   && ctx.NO_AGENT) continue;
  if (type==='jobs'     && ctx.NO_JOB)   continue;
  for (const def of (plan[type]||[]).filter(d => match(nameOf(type,d)))) {
    const fn = core[`${ctx.mode==='uninstall'?'remove':ctx.mode==='status'?'status':'upsert'}${Cap(typeSingular)}`];
    try { ctx.record(await fn(ctx, def)); }
    catch (e) { ctx.record(failResult(type, def, e)); /* continue-and-report */ }
  }
}
// A filter that selects 0 of N considered components → warn (list available) + exit 0, not an error.
// after declarative pass: invoke install_entry (if meta.install_entry) for package-specific steps —
// as a `spawnSync('node', [entry, ...modeAndFlags])` SUBPROCESS (isolation; matches the plaud suite
// pattern), forwarding mode + standard flags as argv (D-12; runs for all modes — install/uninstall/status)
```

Continue-and-report: a failing component is recorded as `INSTALL-FAIL` but doesn't abort the
rest; the run exits non-zero if any failed.

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
| DB unreachable / manifest unreadable | (transport) | 2 |

`ctx.report()` sets `process.exitCode` to the max severity across `ctx.results`.
