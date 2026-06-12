# Utility Design — `ai1-crhq-installer`

How the installer utility is structured: **a CLI and a library in one.** The CLI drives
declarative installs from `ai1-package.yaml`; the library exposes the same primitives so
bundled `install_entry` scripts (and standalone skill installers) reuse them instead of
re-inventing the canon patterns — which also makes sandboxing trivial.

Consolidates the capability list previously scattered across `architecture.md §6`,
`canon-conventions.md` (C1–C13), and `package-manifest-spec.md §7–§8`.

---

## Part A — Capability list (what the utility must implement)

Each item tagged with its source convention for traceability.

### A1. Manifest handling
- [ ] Locate & load `ai1-package.yaml` (default `./ai1-package.yaml`; or explicit path arg).
- [ ] Parse YAML; **validate** against the spec — required fields, component shapes, enums.
- [ ] Validate skill **version pins** match each `SKILL.md` frontmatter `version` (spec §4).
- [ ] Resolve component paths relative to the package root.
- [ ] Build the ordered **install plan**: skills → recipes → agents → jobs → services; within a
      type, array order (spec §6). Uninstall = reverse.
- [ ] Honor the `installer:` min-version requirement (refuse if utility too old).

### A2. Component upserts (DB-direct via knex; idempotent)
- [ ] **Skill** — parse `SKILL.md` frontmatter; lock handling (C5); insert|update `skills` row
      (`skill_type`/`locked` from `install_type` — default org+locked, D-22; `skill_path`, `skill_dir`,
      all NOT-NULL cols); copy tree to `${INSTALL_BASE_DIR}/<key>/`. (integration-ref §2; C3)
- [ ] **Recipe** — parse `.md` frontmatter+body; insert|update `recipes` (uuid PK auto).
- [ ] **Agent** — parse `.yaml`; insert|update `agents` by `key` (minimal cols + defaults);
      sync `agent_skills` (attach only existing+active skills); resolve recipe name→uuid; sync
      `agent_recipes`. (integration-ref §2)
- [ ] **Job** — parse `.yaml`; expand `script`→`join(INSTALL_BASE_DIR, script)` + `args`;
      `requires` prereq guard (C12); insert|update `background_jobs` (`id=job-<ts>-<rand>`).
- [ ] **Service** — parse `service.yaml`; deploy-project emit; **dry-run = build only, skip
      apply** (D-2a).

### A3. Lifecycle operations
- [ ] `install` (full, or `--only=<types>` for a subset of types).
- [ ] `uninstall` (reverse order; DB rows + joins + fs trees + jobs + services).
- [ ] `status` (per component: DB present/active? files present? job registered? service up?).
- [ ] **Idempotent re-run** — second install produces zero drift (C6; sandbox asserts this).

### A4. `install_entry` orchestration
- [ ] After declarative component install, invoke the package's `install_entry` (if declared)
      for package-specific steps the utility can't infer (OAuth, seed, start a process).
- [ ] Forward **mode + standard flags** to it (argv/env) so it can honor `--dry-run` etc.
- [ ] Run it on uninstall/status too (it receives the mode) — **decision OQ-U2**.

### A5. Cross-cutting enforcement (the conventions, applied to every component)
- [ ] DB-direct through a single `getDb()` wrapper; name-PK upserts; never `.returning('id')`
      (C1, C9; GAP 2).
- [ ] All filesystem ops under `INSTALL_BASE_DIR` (legacy fallback `CRHQ_BASE_DIR`) (C2; GAP 10).
- [ ] Lock handling: auto-unlock by default, `--respect-locks` to skip (C5).
- [ ] Idempotency: check-then-upsert, `onConflict.ignore()` on joins (C6; GAP 5).
- [ ] Dry-run: **zero** side effects for DB resources, build-only for services; output contains
      "would…" and >200 bytes (C7).
- [ ] Completion strings the harness greps (C7) + **result taxonomy** + exit codes (§A6).
- [ ] Prereq/dependency checks **before** writes; halt with actionable msg + code (C12).
- [ ] `db.destroy()` on every exit path; structured try/catch (C8).
- [ ] Secret hygiene: never log secrets from `service.yaml` `env` (GAP 9 at install-time).

### A6. Output & result contract
- [ ] Per-component verdict: `INSTALL-OK | ALREADY-INSTALLED | INSTALL-PARTIAL | INSTALL-FAIL
      | PREREQ-MISSING | LOCKED-ROW` (spec §8; GAP 11).
- [ ] Exit codes: `0` ok/already · `1` fail/prereq/lock · `2` transport.
- [ ] Human summary by default; optional `--json` machine-readable report — **decision OQ-U3**.

### A7. Flag handling
- [ ] Standard flags (utility-owned): `--dry-run`, `--status`, `--uninstall`, `--respect-locks`,
      `--install-skills-as-user` (force unlocked `user` skills; default is org+locked — D-22),
      `--only=<types>` (one or more types, comma-separated/repeatable — replaces `--no-agent`/`--no-job`, D-21),
      `--include=<pat>`, `--exclude=<pat>`, **`--sandbox`** (+ `--keep`, `--lifecycle`).
      `--include`/`--exclude` filter by component name (regex; a metacharacter-free value is an exact
      `^name$` match; case-sensitive).
- [ ] Parse package-specific `install_flags` from the manifest; forward to `install_entry`.

### A8. Built-in sandbox (self-contained — D-17; replaces external `installer-sandbox`)
- [ ] **`--sandbox`** — provision an isolated schema (`sandbox_<ts>`, cloned from live via
      `CREATE TABLE … LIKE … INCLUDING ALL`, D-18) + a temp `INSTALL_BASE_DIR`; set
      `INSTALL_SCHEMA`/`INSTALL_BASE_DIR` internally; run the op into there; report; tear down.
- [ ] `--keep` — preserve the schema + temp dir (print their names) for inspection.
- [ ] `--lifecycle` — additionally run the full assertion suite (install → status →
      idempotency → uninstall → reinstall), absorbing what the external harness did.
- [ ] No external harness, no `--loader` hook (relies on native `INSTALL_SCHEMA`, OQ-U4).

---

## Part B — Utility as a library (answer to "provide methods to included scripts?")

**Yes.** The utility ships its primitives as an importable ESM module so bundled
`install_entry` scripts and standalone skill installers don't re-implement the canon. This is
both a DX win (less boilerplate, fewer bugs) and the cleanest path to sandboxing.

### B1. Why this also fixes configurability (your earlier ask)

The public env interface is **vendor-neutral** (D-15) — the package manifest is meant to be
CRHQ-independent, so the utility's knobs are too:

```js
import { join } from 'path';
// INSTALL_BASE_DIR = the parent dir under which each skill's <key> folder is created (D-19).
// Core does join(INSTALL_BASE_DIR, key) — no `user-skills` knowledge in the logic.
const INSTALL_BASE_DIR =
     process.env.INSTALL_BASE_DIR
  || (process.env.CRHQ_BASE_DIR && join(process.env.CRHQ_BASE_DIR, 'user-skills'))  // legacy: CRHQ_BASE_DIR is the satellite ROOT
  || '/opt/projects/crhq-satellite/user-skills';
const SCHEMA = process.env.INSTALL_SCHEMA || process.env.SANDBOX_SCHEMA || null;     // null → default schema
```
The legacy fallbacks keep us compatible with the old `installer-sandbox` harness (which sets the
satellite-root `CRHQ_BASE_DIR` + `SANDBOX_SCHEMA`) without forking it — we just append
`user-skills` to reconstruct the skill-parent dir.

Every install script that uses the library funnels:
- **all DB access** through one `getDb()` → a single place to make the **schema** configurable
  (`INSTALL_SCHEMA` → knex `searchPath`), and the single interception point for the loader hook.
- **all filesystem access** through helpers that read `INSTALL_BASE_DIR` → **base path**
  configurable, and authors *can't forget* C2.

So "make the base path and DB schema configurable" (your earlier requirement) becomes a
property of the library, inherited by anything that imports it. A library-based installer can
even be sandboxed **without** the ESM loader hook, because `getDb()` natively honors
`INSTALL_SCHEMA` (see B4).

### B2. Public API surface (semver'd; gated by manifest `installer:`)

```js
// imported by install_entry scripts and standalone skill installers
import {
  createContext,                       // parse argv → bound context (see B3)
  getDb, closeDb,                      // canonical knex wrapper (schema-aware)
  parseFrontmatter, loadYaml,         // SKILL.md / *.yaml parsing
  copyTree, writeIfChanged, removeTree,// fs helpers — all honor INSTALL_BASE_DIR
  log, VERDICT,                        // dry-run markers, completion strings, taxonomy
  upsertSkill,  removeSkill,  statusSkill,
  upsertRecipe, removeRecipe, statusRecipe,
  upsertAgent,  removeAgent,  statusAgent,
  upsertJob,    removeJob,    statusJob,
  installService, removeService, statusService,
  requireSkills, requireFiles,        // C12 prereq guards
} from '<installer-lib>';             // import path — decision OQ-U1
```

### B3. The context object (makes an install_entry ~10 lines)

`createContext(process.argv)` parses the standard flags and returns a bound context that
carries `{ db, BASE, DRY_RUN, RESPECT_LOCKS, mode, log, results }`. Primitives accept it so a
package hook reads cleanly:

```js
import { createContext, upsertSkill, requireSkills } from '<installer-lib>';

const ctx = await createContext(process.argv);   // honors --dry-run/--status/--uninstall/--respect-locks
try {
  if (ctx.mode === 'uninstall') {
    await ctx.removeSkill('my-skill');
  } else {
    requireSkills(ctx, ['brain-architecture']);   // halts with PREREQ-MISSING if absent
    await upsertSkill(ctx, { dir: 'skills/my-skill' });
    // ...package-specific steps the utility can't infer...
  }
  ctx.report();                                   // prints summary + completion string, sets exit code
} finally {
  await ctx.close();                              // db.destroy()
}
```

The script never touches `BASE`, the knex import, lock logic, or the taxonomy directly — it
inherits all of it. That is the DRY + sandbox payoff in one.

### B4. Sandbox — built into the utility (D-17)

The utility **provisions its own sandbox** — no external `installer-sandbox` harness, no
`--loader` hook. `lib/sandbox.mjs` (see Part C) does:

1. **Provision** — using a default-`searchPath` knex: `CREATE SCHEMA sandbox_<ts>`, then for each
   managed table `CREATE TABLE sandbox_<ts>.<t> (LIKE public.<t> INCLUDING ALL)` (D-18 — clones
   live columns/defaults/constraints/indexes, zero drift). Optionally re-add intra-schema FKs
   and **seed** prerequisite `skills` rows copied from live so agent-attach + dep checks mirror
   reality (OQ-14).
2. **Redirect** — set `INSTALL_SCHEMA=sandbox_<ts>` + `INSTALL_BASE_DIR=<tempdir>`; `getDb()`
   then builds knex with `searchPath:[sandbox_<ts>]` (native, B1) and `fs.mjs` writes under the
   temp dir. All component installs land in the sandbox.
3. **Run** — the requested op (install by default); with `--lifecycle`, the full
   install→status→idempotency→uninstall→reinstall assertion suite.
4. **Teardown** — `DROP SCHEMA sandbox_<ts> CASCADE` + rm tempdir, unless `--keep`.

> **Legacy-compat (optional):** because `getDb()` also reads the legacy `SANDBOX_SCHEMA` and the
> canonical hardcoded knex import is interceptable, the utility *still* runs correctly if someone
> drives it under the old external loader-hook harness — but we no longer depend on it.

### B5. Distribution / import path (OQ-U1)

The crux: how does a bundled script name `<installer-lib>`?
- **Option 1 (recommend v1): canonical absolute path** — mirror the knex.js convention:
  `import … from '/opt/projects/crhq-satellite/user-skills/ai1-crhq-installer/scripts/lib/index.mjs'`.
  Stable, interception-friendly, zero install magic. The lib reads `INSTALL_BASE_DIR`/`INSTALL_SCHEMA`
  at runtime, so it's sandbox-correct even when imported from the real path.
- **Option 2: env-resolved** — `AI1_INSTALLER_LIB` → dynamic import. Flexible; worse for static
  tooling.
- **Option 3 (future DX): package alias** — the utility drops a `node_modules/@ai1/installer`
  shim/symlink in each package so scripts `import '@ai1/installer'`. Cleanest authoring; adds
  install complexity.

A package that imports the lib must declare `installer: ">=x"` (already in the manifest) so the
right API version is present. The lib is guaranteed present when the utility invokes
`install_entry` (the utility *is* the lib); for standalone runs it's a declared dependency.

### B6. Backward compatibility

The library is **opt-in**. Existing canon installers (dev-handoff, plaud) that hand-roll knex
keep working untouched. New packages use the library; we may later offer a migration that
swaps their boilerplate for `createContext` + primitives.

---

## Part C — Module map (implementation)

```
scripts/
  install.mjs          # CLI entry — thin: createContext + run plan from ai1-package.yaml
  lib/
    index.mjs          # public API barrel (B2) — the stable import surface
    context.mjs        # createContext: flag parse, wiring, results, report()
    db.mjs             # getDb/closeDb — canonical knex import + INSTALL_SCHEMA searchPath (B4)
    manifest.mjs       # load + validate ai1-package.yaml → ordered plan (A1)
    parse.mjs          # parseFrontmatter, loadYaml (C11)
    fs.mjs             # copyTree, writeIfChanged, removeTree — all INSTALL_BASE_DIR-rooted (C2)
    log.mjs            # log + dry-run markers + completion strings + VERDICT taxonomy
    prereq.mjs         # requireSkills, requireFiles (C12)
    sandbox.mjs        # --sandbox: provision (LIKE-clone) + seed + redirect + teardown (B4, D-17/18)
    core/
      skill.mjs        # upsertSkill / removeSkill / statusSkill
      recipe.mjs       # upsert/remove/status
      agent.mjs        # upsert/remove/status + join sync
      job.mjs          # upsert/remove/status
      service.mjs      # installService / removeService / statusService (deploy-project)
```

`install.mjs` and every `core/*` function consume the same `context`, so the CLI and a
package's `install_entry` exercise identical code paths.

> **Exact signatures, def shapes, sandbox provisioning, and the `install.mjs` control flow are
> specified in [`api-design.md`](./api-design.md).**

---

## Part D — Decisions (all confirmed by user)

| ID | Question | Decision |
|----|----------|----------|
| **OQ-U1** | Library import path (B5) | ✅ Option 1 (canonical absolute path) for v1; Option 3 (`@ai1/installer` alias) as a later DX upgrade |
| **OQ-U2** | Does `install_entry` run on uninstall/status too? | ✅ Yes — pass `mode`; the hook decides what to do. Keeps teardown symmetric |
| **OQ-U3** | `--json` machine-readable output? | ✅ Yes (cheap, enables push-loop automation + the verdict taxonomy) |
| **OQ-U4** | Native `INSTALL_SCHEMA` support in `getDb()` (B4 Mode 2)? | ✅ Yes — clean delivery of "configurable schema"; reduces hook fragility |
| **OQ-U5** | Refactor canon installers onto the library now? | ✅ No — keep opt-in; revisit after the lib stabilizes |
| **D-15** | Env var names | ✅ Vendor-neutral `INSTALL_BASE_DIR` / `INSTALL_SCHEMA`, with legacy fallback to `CRHQ_BASE_DIR` / `SANDBOX_SCHEMA` |
