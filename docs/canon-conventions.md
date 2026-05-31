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

## C2 — configurable base dir for ALL filesystem operations

Our utility's canonical env var is **`INSTALL_BASE_DIR`** (vendor-neutral; D-15). For
compatibility with the existing `installer-sandbox` harness — which sets the legacy
`CRHQ_BASE_DIR` — resolve a precedence chain:

```js
const BASE = process.env.INSTALL_BASE_DIR
          || process.env.CRHQ_BASE_DIR        // legacy fallback — the canon harness sets this
          || '/opt/projects/crhq-satellite';  // default on a CRHQ satellite
```
Every read of bundled data and every write to `user-skills/` derives from `BASE`. The
sandbox harness sets the base to a temp dir (e.g. `.scratch/sandbox-<ts>`) so installs
never touch the real tree.

## C3 — Install target is `user-skills/`, not `skills/`

- Skill assets copy to `${BASE}/user-skills/<name>/...` (webuser-owned). `skills/` is
  managed differently — do not write there.
- `skill_dir` = `${BASE}/user-skills/<name>`
- `skill_path` = `user-skills/<name>` (plaud) **or** `db://skills/<name>` (requirements/dev-handoff).
  Both observed; column is just NOT-NULL. **Pick one and be consistent** — recommend
  `user-skills/<name>` (most recent convention).

## C4 — Standard flags

Required: `--dry-run`, `--status`, `--uninstall`, `--respect-locks`.
Optional/contextual: `--no-agent` / `--skip-agent`, `--no-job`, `--schedule <cron|alias>`,
and similar per-bundle toggles.

## C5 — Lock handling (PG trigger blocks updates on locked rows)

- Default: if `row.locked`, **unlock then update** (`update({ locked: false })` first).
- With `--respect-locks`: **skip** locked rows (don't unlock, don't write).

## C6 — Idempotent upsert

- Look up existing (`where('name'|'key', …).first()`) → `UPDATE` if present else `INSERT`.
- Join tables: `insert(...).onConflict([cols]).ignore()`.
- Re-running produces identical end-state. `install → uninstall → status` shows clean;
  `install → install` shows no drift; `uninstall → install` reproduces the original.
  (These are exactly the phases `installer-sandbox` checks.)

## C7 — Completion strings the harness greps (don't paraphrase loosely)

| Mode | Output MUST match | Example |
|------|-------------------|---------|
| install | `/install(ation\|ed)\s+(complete\|successfully)/i` | `✅ … installed successfully.` |
| uninstall | `/uninstall\s+complete/i` | `Uninstall complete.` |
| dry-run | contains `would` / `dry` / `preview`, stdout > 200 bytes | `[dry-run] would create …` |

`sandbox-install-test` also fails on any line matching `^(error:|❌|fatal:|uncaught|throw)`.

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

## Sandbox contract (what makes an installer testable)

`node user-skills/installer-sandbox/scripts/test.mjs --installer <path-to-install.mjs>`
will, for any installer obeying C1–C8:

1. `CREATE SCHEMA sandbox_<ts>` with prod-matching DDL (7 tables) + seed utility skills.
2. Set the schema + base-dir env (the existing harness uses `SANDBOX_SCHEMA` +
   `CRHQ_BASE_DIR`; our utility also reads `INSTALL_SCHEMA`/`INSTALL_BASE_DIR` — D-15).
3. Run `node --loader sandbox-hooks.mjs <install.mjs>` through the lifecycle:
   **fresh install → status → idempotency (2nd install, state diff) → uninstall →
   clean check → reinstall → final status**, then `DROP SCHEMA CASCADE` + rm temp dir.

If C1 (interceptable knex) or C2 (`INSTALL_BASE_DIR`/`CRHQ_BASE_DIR`) is violated, the test would mutate the
real satellite — so these two are non-negotiable.
