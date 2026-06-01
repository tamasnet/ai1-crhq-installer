# Implementation Plan

Phased build for `ai1-crhq-installer`, shaped by the canon + sandbox findings.
**Plan-only** — no code until the planning session is approved.

Assumes product shape **C** (shared core lib + generic manifest runner) and that the
existing CommonJS scaffold is migrated to **ESM `.mjs`** (required by C1).

## Phase 0 — Verify the schema is live-accurate (DONE 2026-05-31)

- [x] `columnInfo()` probe vs documented schema — **MATCH** (7 tables). Refinements recorded in
      `integration-reference.md §6` (skill_path no-default; recipes NOT-NULL desc/content;
      varchar length limits).
- [x] Confirm DB user can `CREATE/DROP SCHEMA` with isolation — **PASS** (sandbox DB-isolation
      viable here).
- [x] Lock product-shape (D-8), jobs type (D-9), manifest (D-10), env names (D-15) — all confirmed.
- [~] **Full lifecycle run — DEFERRED to build phase** (requires our installer to exist).
      Note: we now **build the sandbox into the utility** (`--sandbox`, D-17) rather than depend
      on the external `installer-sandbox` harness, so there's nothing external to stage. A useful
      Phase 0 finding stands: the 4 on-satellite canon installers **hardcode `BASE`** (don't
      honor `CRHQ_BASE_DIR`) → they can't be safely sandbox-run against the real FS, which is
      exactly why our installer must honor `INSTALL_BASE_DIR` (C2).

**Exit:** schema + sandbox-privilege confirmed; D-8/9/10/15/17 decided. **First build-phase
task:** scaffold `lib/` (incl. `sandbox.mjs`) and self-test with `--sandbox --lifecycle`.

## Phase 1 — Core library (`lib/`) — map: `utility-design.md` Part C · signatures: `api-design.md` — ✅ DONE 2026-06-01

> All `lib/` modules + `lib/core/*` + `sandbox.mjs` + thin `install.mjs` built (commit a8e6c10).
> `node scripts/install.mjs examples/bundle --sandbox --lifecycle` is green; dry-run + negatives verified.

- [ ] `db.mjs` — **static hardcoded** `import getDb from server/db/knex.js` (C1) + `INSTALL_SCHEMA`
      `searchPath` (B4) + `closeDb()`.
- [ ] `log.mjs` — prefixed logging, `[dry-run]` markers, canon completion strings (C7), `VERDICT`.
- [ ] `parse.mjs` — `parseFrontmatter` (SKILL.md → `{meta, body}`) + `loadYaml` (zero-dep if reasonable).
- [ ] `fs.mjs` — `copyTree` / `writeIfChanged` / `removeTree`, all `INSTALL_BASE_DIR`-rooted (C2).
- [ ] `manifest.mjs` — load + validate `ai1-package.yaml`, resolve paths, normalize to an ordered plan.
- [ ] `prereq.mjs` — `requireSkills` / `requireFiles` (C12).
- [ ] `context.mjs` — `createContext(argv)` → bound `{db,BASE,DRY_RUN,RESPECT_LOCKS,mode,log,results}` (B3).
- [ ] `index.mjs` — public API barrel (the stable import surface, B2).
- [ ] `core/{skill,recipe,agent,job,service}.mjs` — per-type `upsert*`/`remove*`/`status*` primitives
      (dry-run/lock/idempotency/join-sync baked in) — the decomposed former "installer-core".
- [ ] `sandbox.mjs` — `--sandbox`: provision (`CREATE SCHEMA` + `CREATE TABLE … LIKE … INCLUDING
      ALL`, D-18) + seed prerequisite skills + redirect `INSTALL_SCHEMA`/`INSTALL_BASE_DIR` +
      teardown (`--keep` to preserve); `--lifecycle` assertion suite (D-17).

**Exit:** `node --input-type=module -e` smoke tests pass for manifest + parse; core
primitives unit-exercised via `--sandbox` (self-provisioned isolated schema).

## Phase 2 — Skill + Recipe install — ✅ DONE 2026-06-01

- [x] `upsertSkill`: unlock-if-needed (C5) → insert|update (`skill_type:'user'`, `skill_path`,
      `skill_dir`=`${INSTALL_BASE_DIR}/<key>`, `skill_path`=`db://skills/<name>`, NOT-NULL fields set)
      → copy assets to `${INSTALL_BASE_DIR}/<key>/`.
- [x] `upsertRecipe`: insert|update by name (uuid auto).
- [x] Wire `--dry-run`/`--status`/`--uninstall` for both.

**Test:** `tests/skill-recipe.test.mjs` (`npm test`) — 15 assertions green: row-level fields,
asset copy + idempotency, **C5 lock handling both ways**, dry-run zero-write, status, removal,
recipe lifecycle, missing-SKILL.md + version-pin negatives, and a skills+recipes-only
`--sandbox --lifecycle`. (Note: `LIKE` doesn't clone the skills lock TRIGGER, so the test
validates the installer's lock *logic*, not the DB trigger.)

## Phase 3 — Agent install + join sync

- [ ] `upsertAgent`: insert|update by key (minimal columns, rely on defaults).
- [ ] Sync `agent_skills` (attach only existing+active skills; remove stale; onConflict ignore).
- [ ] Resolve `recipe_id` by name; sync `agent_recipes`.

**Test:** sandbox lifecycle with agent referencing the sample skill+recipe → all asserts green
(agent has skills + recipe; clean uninstall).

## Phase 4 — Jobs (background_jobs)

- [ ] `upsertJob`: insert|update by name; `id = job-<ts>-<rand>`, `job_type:'script'`,
      `script_path:'node'`, `script_args:'<abs> <args>'`, cron/timezone/limits/enabled.
- [ ] `--no-job` toggle; prereq-check pattern (C12) where a job depends on another skill.

**Test:** sandbox: job row present post-install, removed post-uninstall.

## Phase 5 — Generic runner (`install.mjs`)

- [ ] Parse flags + manifest; build plan; preflight (DB reachable, BASE writable).
- [ ] Dispatch **skills → recipes → agents → jobs → services**; uninstall reverses.
- [ ] `--only=<type>`, `--dry-run`, `--status`, `--uninstall`, `--respect-locks`, `--no-agent`.
- [ ] Aggregate summary; continue-and-report with non-zero exit on any failure.

**Test:** `--sandbox --lifecycle` over `examples/bundle/` (skill+recipe+agent+job)
→ all phases green. `--dry-run` → clean "would…" output.

## Phase 6 — Services (deploy-project)

- [ ] `service.mjs`: validate `service.yaml`; emit `/opt/projects/user/<name>/`, `.env`,
      `ecosystem.config.cjs`, nginx vhost; allocate port; PM2 start/reload (never touch
      `crhq-satellite`).
- [ ] `--dry-run` runs the **build step** but **skips the deploy-project apply** (D-2a) —
      no nginx/PM2/port/reload.
- [ ] Decide D-2b (shell out vs inline templates) before coding.

**Test:** dry-run in sandbox; one explicit live service smoke test outside the sandbox.

## Phase 7 — Package manifest + sample

- [ ] `ai1-package.yaml` for the sample package (per `package-manifest-spec.md`) — identity,
      `components` inventory, optional `install_entry`/`install_flags`.
- [ ] Complete `examples/bundle/` exercising every component type (skill+recipe+agent+job+service).
- [ ] Update `SKILL.md` + `README.md` to match the final DB-direct/sandbox design.

## Phase 8 — Install gate (ONLY when told)

- [ ] Provide the one-liner to install onto the live satellite + run `--status`.
- [ ] **Wait for explicit user instruction.** Until then, all testing is sandbox-only.

## Testing strategy (summary)

- Per-change: `--dry-run` over the sample bundle (fast, zero-write gate).
- Per-phase: `--sandbox --lifecycle` over the sample bundle (self-contained full lifecycle).
- Negative cases: malformed manifest, missing SKILL.md, locked skill (+/- `--respect-locks`),
  missing dependency (C12 halt + exit code).
- Services: explicit non-sandbox smoke test (the sandbox models DB + fs, not nginx/PM2).

## Deliverables checklist

- [ ] `lib/{index,context,db,manifest,parse,fs,log,prereq,sandbox}.mjs` + `lib/core/{skill,recipe,agent,job,service}.mjs`
- [ ] `scripts/install.mjs` generic runner (incl. `--sandbox`)
- [ ] `examples/bundle/` complete sample (with its `ai1-package.yaml`)
- [ ] Updated `SKILL.md` + `README.md`
- [ ] Green `--sandbox --lifecycle` over the sample bundle
