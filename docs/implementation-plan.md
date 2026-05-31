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
- [~] **Full `installer-sandbox` lifecycle run — DEFERRED to early build phase.** Two blockers
      found that make it inappropriate to run under the planning-only constraint:
      1. `installer-sandbox` lives in `ai1-repos` with **no `node_modules`**; ESM ignores
         `NODE_PATH`, so `import knex`/`dotenv` won't resolve until the harness is **staged on
         the satellite** (a build action).
      2. The 4 on-satellite canon installers **hardcode `BASE`** (don't honor `CRHQ_BASE_DIR`),
         so running them through the sandbox would write to the **real** `user-skills/`. The
         safe subject is our **own** `INSTALL_BASE_DIR`-honoring installer (doesn't exist yet) or
         `dev-handoff`/`plaud` once their deps resolve.

**Exit:** schema + sandbox-privilege confirmed; D-8/9/10/15 decided. **First build-phase task:**
stage `installer-sandbox` on the satellite and run the lifecycle against our installer.

## Phase 1 — Core library (`lib/`)

- [ ] `db.mjs` — **static hardcoded** `import getDb from server/db/knex.js` (C1) + `destroy()`.
- [ ] `log.mjs` — prefixed logging, `[dry-run]` markers, and the canon completion strings (C7).
- [ ] `frontmatter.mjs` — parse SKILL.md frontmatter → `{ meta, body }` (zero-dep).
- [ ] `manifest.mjs` — load YAML/JSON, validate, resolve paths, normalize to a plan.
- [ ] `installer-core.mjs` — primitives with dry-run/lock/idempotency baked in:
      `upsertSkill, upsertRecipe, upsertAgent, upsertJob, remove*, status*`.

**Exit:** `node --input-type=module -e` smoke tests pass for manifest + frontmatter; core
primitives unit-exercised against a scratch sandbox schema.

## Phase 2 — Skill + Recipe install

- [ ] `upsertSkill`: unlock-if-needed (C5) → insert|update (`skill_type:'user'`, `skill_path`,
      `skill_dir`, NOT-NULL fields set) → copy `${BASE}/user-skills/<name>/`.
- [ ] `upsertRecipe`: insert|update by name (uuid auto).
- [ ] Wire `--dry-run`/`--status`/`--uninstall` for both.

**Test:** sandbox lifecycle with a skills+recipes-only manifest → green.

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

**Test:** full `installer-sandbox` lifecycle over `examples/bundle/` (skill+recipe+agent+job)
→ all phases green. `sandbox-install-test --dir scripts` → pass.

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

- Per-change: `sandbox-install-test --dir scripts` (fast dry-run gate).
- Per-phase: `installer-sandbox --installer scripts/install.mjs` (full lifecycle).
- Negative cases: malformed manifest, missing SKILL.md, locked skill (+/- `--respect-locks`),
  missing dependency (C12 halt + exit code).
- Services: explicit non-sandbox smoke test (harnesses don't model nginx/PM2).

## Deliverables checklist

- [ ] `lib/{db,log,frontmatter,manifest,installer-core,service}.mjs`
- [ ] `scripts/install.mjs` generic runner
- [ ] `examples/bundle/` complete sample (with its `ai1-package.yaml`)
- [ ] Updated `SKILL.md` + `README.md`
- [ ] Green `installer-sandbox` lifecycle + passing `sandbox-install-test`
