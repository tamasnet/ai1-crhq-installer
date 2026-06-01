# Installer Canon Conventions

The ai1-system "installer-conventions" distilled from the four reference installers
(`requirements-installer`, `dev-handoff-installer`, `plaud-installer`, `plaud-ingest`)
and the `installer-sandbox` + `sandbox-install-test` harnesses. **An installer that
follows ALL of these is automatically sandbox-testable and passes pre-push audit.**

This is the build checklist for `ai1-crhq-installer`.

---

## C1 — ESM + static, hardcoded knex import (must be interceptable)

- The installer is an **ESM `.mjs`** file (not CommonJS `.js`).
- DB access uses **exactly** this line, with the path hardcoded:
  ```js
  import { getDb } from '/opt/projects/crhq-satellite/server/db/knex.js';
  ```
- **Do NOT** build this path from `BASE`/env and **do NOT** use `require()`. The sandbox
  ESM loader hook (`sandbox-hooks.mjs`) matches `specifier.endsWith('server/db/knex.js')`
  and swaps in a schema-scoped knex. Computing the path or using CJS defeats interception
  → the installer would hit the real `public` schema during tests. **This is the #1 rule.**
- The import may live in a `lib/db.mjs` wrapper — the hook matches the specifier regardless
  of which module imports it.

> ⚠️ This means the current scaffold's CommonJS `scripts/install.js` + `install-*.js`
> must be **rewritten as ESM `.mjs`** (see migration note in `architecture.md`).

## C2 — `INSTALL_BASE_DIR` = the parent dir for skill `<key>` directories

**`INSTALL_BASE_DIR` is the directory under which each skill's `<key>` folder is created**
(vendor-neutral; D-15/D-19). The installer core does `join(INSTALL_BASE_DIR, key)` and has
**no knowledge** of the CRHQ-specific `user-skills/` segment — that lives entirely in the
configured value. Resolution:

```js
import { join } from 'path';
const INSTALL_BASE_DIR =
     process.env.INSTALL_BASE_DIR                                          // canonical: the skill-parent dir
  || (process.env.CRHQ_BASE_DIR && join(process.env.CRHQ_BASE_DIR, 'user-skills'))  // legacy: CRHQ_BASE_DIR is the satellite ROOT
  || '/opt/projects/crhq-satellite/user-skills';                          // default on a CRHQ satellite
// skill assets → join(INSTALL_BASE_DIR, key);  skill_dir (DB) = that same absolute path
```
The `user-skills/` literal appears **only** in the CRHQ legacy-compat shim + the default — never
in the core logic. The sandbox sets `INSTALL_BASE_DIR` to a temp dir so installs never touch the
real tree.

## C3 — Skill install dir = `INSTALL_BASE_DIR/<key>`

- Skill assets copy to `${INSTALL_BASE_DIR}/<key>/...`. On a CRHQ satellite `INSTALL_BASE_DIR`
  resolves to `.../user-skills` (webuser-owned); never write to the system `skills/` tree.
- `skill_dir` (DB) = `${INSTALL_BASE_DIR}/<key>` (absolute).
- `skill_path` (DB) = **`db://skills/<name>`** — standardized (OQ-10 resolved). Location-independent,
  doesn't bake in `user-skills`. NOT-NULL, so always set it.

## C4 — Standard flags

Required: `--dry-run`, `--status`, `--uninstall`, `--respect-locks`.
Optional/contextual: `--no-agent` (canon's `--skip-agent` is a legacy alias), `--no-job`, `--schedule <cron|alias>`,
and similar per-bundle toggles.

## C5 — Lock handling (PG trigger blocks updates on locked rows)

- Default: if `row.locked`, **unlock then update** (`update({ locked: false })` first).
- With `--respect-locks`: **skip** locked rows (don't unlock, don't write).

## C6 — Idempotent upsert

- Look up existing (`where('name'|'key', …).first()`) → `UPDATE` if present else `INSERT`.
- Join tables: `insert(...).onConflict([cols]).ignore()`.
- Re-running produces identical end-state. `install → uninstall → status` shows clean;
  `install → install` shows no drift; `uninstall → install` reproduces the original.
  (These are exactly the phases the built-in `--sandbox --lifecycle` suite checks.)

## C7 — Completion strings the harness greps (don't paraphrase loosely)

| Mode | Output MUST match | Example |
|------|-------------------|---------|
| install | `/install(ation\|ed)\s+(complete\|successfully)/i` | `✅ … installed successfully.` |
| uninstall | `/uninstall\s+complete/i` | `Uninstall complete.` |
| dry-run | contains `would` / `dry` / `preview`, stdout > 200 bytes | `[dry-run] would create …` |

Treat any line matching `^(error:|❌|fatal:|uncaught|throw)` as a failure signal in dry-run
output (a good practice inherited from the old pre-push check).

## C8 — Lifecycle hygiene

- One `try/catch` around `main`; `await db.destroy()` on every exit path (success, error,
  prereq-halt).
- Exit `0` on success, non-zero on failure. Reserve distinct codes for prereq failures
  (canon uses `4` = missing dependency skill, `5` = missing schema/migration).

## C9 — DB-direct only (no REST for resource writes)

All writes go through knex against: `skills`, `recipes`, `agents`, `agent_skills`,
`agent_recipes`, `background_jobs`. content-api/REST is **not** used (it isn't
interceptable by the sandbox and isn't the canon path).

## C10 — Background jobs via the `background_jobs` table

```js
id: `job-${Date.now()}-${rand}`,   // varchar PK
job_type: 'script', script_path: 'node',
script_args: `${SKILL_DIR}/scripts/<entry>.js <args>`,
schedule: '<cron>', timezone, timeout_minutes, max_concurrent, skip_if_running,
enabled: true, run_count: 0,
```
> Note: `Date.now()`/`Math.random()` are fine in installer scripts (only the Workflow
> tool sandbox forbids them).

## C11 — Skill description from SKILL.md frontmatter

Parse `description:` out of the skill's own `SKILL.md` frontmatter rather than duplicating
the string in two places. (plaud-ingest does this with a regex; a proper frontmatter parse
is cleaner.)

## C12 — Prereq checks BEFORE any DB write

Verify dependencies first (dependency skill files present, required migration columns
exist) and **halt with an actionable message + specific exit code** before touching rows.
Prevents registering a cron/job that fails every tick.

## C13 — Composition via sub-installers (suite pattern)

A suite installer `spawnSync('node', [subInstaller, ...passthrough], {stdio:'inherit'})`
for each sub-installer:
- forwards common flags (`--dry-run`, `--status`, `--uninstall`, `--respect-locks`);
- installs in declared order, **uninstalls in REVERSE order**;
- halts on first failure with "re-run is idempotent, it'll pick up where it left off".

---

## Sandbox contract — built into the utility (D-17)

Our utility self-provides the sandbox via **`--sandbox`** (`lib/sandbox.mjs`) — no external
harness, no `--loader` hook. For any installer obeying C1–C8 it will:

1. `CREATE SCHEMA sandbox_<ts>` cloned from live: `CREATE TABLE sandbox_<ts>.<t>
   (LIKE public.<t> INCLUDING ALL)` (D-18, zero drift) + seed prerequisite skills from live.
2. Set `INSTALL_SCHEMA=sandbox_<ts>` + `INSTALL_BASE_DIR=<tempdir>` internally; `getDb()` applies
   the `searchPath` natively (C2 / OQ-U4). (Legacy `SANDBOX_SCHEMA`/`CRHQ_BASE_DIR` still honored
   for back-compat — D-15.)
3. Run the op; with `--lifecycle`: **fresh install → status → idempotency → uninstall →
   clean check → reinstall**. Then `DROP SCHEMA CASCADE` + rm temp dir (unless `--keep`).

If C1 (interceptable / schema-aware knex) or C2 (`INSTALL_BASE_DIR`) is violated, an install
would mutate the real satellite — so these two are non-negotiable. (They're also what let the
built-in `--sandbox` redirect cleanly.)
