# Installer Canon Conventions

The CRHQ installer conventions (C1–C13) this utility implements and enforces. They distill
the satellite's established installer pattern; **an installer that follows ALL of them is
automatically sandbox-testable and safe to run against a satellite.** Code comments
reference these IDs.

---

## C1 — ESM + static, hardcoded knex import (must be interceptable)

- The installer is **ESM `.mjs`** (not CommonJS `.js`).
- DB access uses **exactly** this line, with the path hardcoded:
  ```js
  import { getDb } from '/opt/projects/crhq-satellite/server/db/knex.js';
  ```
- **Do NOT** build this path from `BASE`/env and **do NOT** use `require()`. A sandbox ESM
  loader hook matches `specifier.endsWith('server/db/knex.js')` and swaps in a schema-scoped
  knex; computing the path or using CJS defeats interception → the installer would hit the
  real `public` schema during tests. **This is the #1 rule.**
- The import lives in the `lib/db.mjs` wrapper — the hook matches the specifier regardless
  of which module imports it.

## C2 — `INSTALL_BASE_DIR` = the parent dir for skill `<key>` directories

**`INSTALL_BASE_DIR` is the directory under which each skill's `<key>` folder is created**
(vendor-neutral). The installer core does `join(INSTALL_BASE_DIR, key)` and has **no
knowledge** of the CRHQ-specific `user-skills/` segment — that lives entirely in the
configured value. Resolution:

```js
import { join } from 'path';
const INSTALL_BASE_DIR =
     process.env.INSTALL_BASE_DIR                                          // canonical: the skill-parent dir
  || (process.env.CRHQ_BASE_DIR && join(process.env.CRHQ_BASE_DIR, 'user-skills'))  // legacy: CRHQ_BASE_DIR is the satellite ROOT
  || '/opt/projects/crhq-satellite/user-skills';                          // default on a CRHQ satellite
// skill assets → join(INSTALL_BASE_DIR, key);  skill_dir (DB) = that same absolute path
```
The `user-skills/` literal appears **only** in the legacy-compat shim + the default — never
in the core logic. The sandbox sets `INSTALL_BASE_DIR` to a temp dir so installs never touch
the real tree.

## C3 — Skill install dir = `INSTALL_BASE_DIR/<key>`

- Skill assets copy to `${INSTALL_BASE_DIR}/<key>/...`. On a CRHQ satellite that resolves to
  `.../user-skills` (webuser-owned); never write to the system `skills/` tree.
- `skill_dir` (DB) = `${INSTALL_BASE_DIR}/<key>` (absolute).
- `skill_path` (DB) = **`db://skills/<name>`** — location-independent, doesn't bake in
  `user-skills`. NOT-NULL on live with no default, so always set it.

## C4 — Standard flags

Required: `--dry-run`, `--status`, `--uninstall`, `--respect-locks`, `--help`. Type/name scoping
is via `--type=<types>` (multi-valued; formerly `--only`) plus `--include`/`--exclude`; skill
registration type via `--install-skills-as-user`. The full CLI surface is `architecture.md` §5;
package manifests may add package-specific flags only (`install_flags`). Options are validated
(`lib/flags.mjs`): an unsupported option or a value flag with no value fails with a usage exit `2`.

## C5 — Lock handling (PG trigger blocks updates on locked rows)

- Default: if `row.locked`, **unlock then update** (`update({ locked: false })` first).
  Removal likewise unlocks-then-deletes.
- With `--respect-locks`: **skip** locked rows (don't unlock, don't write).
- Skills this installer registers default to org + `locked:true`; an idempotent re-run of an
  unchanged org skill makes no writes and leaves it locked.

## C6 — Idempotent upsert

- Look up existing (`where('name'|'key', …).first()`) → `UPDATE` if present else `INSERT`.
- Join tables: `insert(...).onConflict([cols]).ignore()`.
- Re-running produces identical end-state. `install → uninstall → status` shows clean;
  `install → install` shows no drift; `uninstall → install` reproduces the original.
  (These are exactly the phases the built-in `--sandbox --lifecycle` suite asserts.)

## C7 — Completion strings the harness greps (don't paraphrase loosely)

| Mode | Output MUST match | Example |
|------|-------------------|---------|
| install | `/install(ation\|ed)\s+(complete\|successfully)/i` | `✅ … installed successfully.` |
| uninstall | `/uninstall\s+complete/i` | `Uninstall complete.` |
| dry-run | contains `would` / `dry` / `preview`, stdout > 200 bytes | `[dry-run] would create …` |

Treat any line matching `^(error:|❌|fatal:|uncaught|throw)` as a failure signal in dry-run
output.

## C8 — Lifecycle hygiene

- One `try/catch` around `main`; `await db.destroy()` on every exit path (success, error,
  prereq-halt).
- Exit `0` on success, non-zero on failure (this utility's full code map:
  `api-design.md` §13).

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

## C11 — Skill description from SKILL.md frontmatter

Parse `description:` out of the skill's own `SKILL.md` frontmatter rather than duplicating
the string in two places.

## C12 — Prereq checks BEFORE any DB write

Verify dependencies first (dependency skill present + active, required files exist) and
**halt with an actionable message + specific exit code** before touching rows. Prevents
registering a cron/job that fails every tick.

## C13 — Composition via sub-installers (suite pattern)

A suite installer `spawnSync('node', [subInstaller, ...passthrough], {stdio:'inherit'})`
for each sub-installer:
- forwards common flags (`--dry-run`, `--status`, `--uninstall`, `--respect-locks`);
- installs in declared order, **uninstalls in REVERSE order**;
- halts on first failure with "re-run is idempotent, it'll pick up where it left off".

This is also how the generic runner invokes a package's `install_entry`.

---

## Sandbox contract — built into the utility

The utility self-provides its sandbox via **`--sandbox`** (`lib/sandbox.mjs`) — no external
harness, no `--loader` hook. For any installer obeying C1–C8 it will:

1. `CREATE SCHEMA sandbox_<ts>` cloned from live: `CREATE TABLE sandbox_<ts>.<t>
   (LIKE public.<t> INCLUDING ALL)` (zero drift) + seed prerequisite skills from live.
2. Set `INSTALL_SCHEMA=sandbox_<ts>` + `INSTALL_BASE_DIR=<tempdir>` internally; `getDb()`
   applies the `searchPath` natively. (Legacy `SANDBOX_SCHEMA`/`CRHQ_BASE_DIR` are still
   honored for back-compat with the older external harness.)
3. Run the op; with `--lifecycle`: **fresh install → status → idempotency → uninstall →
   clean check → reinstall**. Then `DROP SCHEMA CASCADE` + rm temp dir (unless `--keep`).

If C1 (interceptable / schema-aware knex) or C2 (`INSTALL_BASE_DIR`) is violated, an install
would mutate the real satellite — so these two are non-negotiable.
