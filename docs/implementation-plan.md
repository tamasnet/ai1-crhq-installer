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

- [x] `upsertSkill`: registration type from `install_type` (default org+locked — D-22) → unlock-if-
      needed before an update (C5) → insert|update (`skill_type`/`locked`, `skill_dir`=`${INSTALL_BASE_DIR}/<key>`,
      `skill_path`=`db://skills/<name>`, NOT-NULL fields set) → copy assets to `${INSTALL_BASE_DIR}/<key>/`.
- [x] `upsertRecipe`: insert|update by name (uuid auto).
- [x] Wire `--dry-run`/`--status`/`--uninstall` for both.
- [x] `install_type` (manifest entry) + `--install-skills-as-user` → org/user registration (added 2026-06-11, D-22).

**Test:** `tests/skill-recipe.test.mjs` (`npm test`) — 19 assertions green: row-level fields,
org+locked default + `install_type: user`/`--install-skills-as-user` overrides (D-22),
asset copy + idempotency, **C5 lock handling both ways**, dry-run zero-write, status, removal,
recipe lifecycle, missing-SKILL.md + version-pin + invalid-`install_type` negatives, and a
skills+recipes-only `--sandbox --lifecycle`. (Note: `LIKE` doesn't clone the skills lock TRIGGER, so the test
validates the installer's lock *logic*, not the DB trigger.)

## Phase 3 — Agent install + join sync — ✅ DONE 2026-06-01

- [x] `upsertAgent`: insert|update by key (minimal columns, rely on defaults).
- [x] Sync `agent_skills` (attach only existing+active skills; remove stale; onConflict ignore).
- [x] Resolve `recipe_id` by name; sync `agent_recipes`.

**Test:** `tests/agent.test.mjs` (`npm test`) — 10 assertions green: minimal-row + DB defaults
(provider/icon/default_model), recipe name→uuid resolution, attach filtering (missing + inactive
skills skipped), add/remove-stale skill sync, recipe sync + stale removal, field update, dry-run
zero-write, status, clean removal of row + all join links, and a full
skill+recipe+agent `--sandbox --lifecycle`. (Shared test helper extracted to `tests/_helpers.mjs`.)

## Phase 4 — Jobs (background_jobs) — ✅ DONE 2026-06-01

- [x] `upsertJob`: insert|update by name; `id = job-<ts>-<rand>`, `job_type:'script'`,
      `script_path:'node'`, `script_args:'<abs> <args>'`, cron/timezone/limits/enabled.
- [x] Prereq-check pattern (C12) where a job depends on another skill. (Per-type scoping is via
      `--only`, not a dedicated job toggle — see D-21.)

**Test:** `tests/job.test.mjs` (`npm test`) — 9 assertions green: id minting + canon columns
(`job_type`/`script_path`/`run_count`), `script_args` resolved under `INSTALL_BASE_DIR` (+ args),
schedule-alias expansion (`hourly`/`daily`/`every-15-min`) + raw-cron passthrough, idempotent
re-run with stable id, update preserves id, **C12 `requires` prereq → PrereqError**,
dry-run zero-write, status, removal, and a skill+job `--sandbox --lifecycle` (present post-install,
gone post-uninstall).

## Phase 5 — Generic runner (`install.mjs`) — ✅ DONE 2026-06-01

- [x] Parse flags + manifest; build plan; **preflight** (`lib/preflight.mjs` — DB reachable; BASE
      writable for write modes; failure = transport exit 2).
- [x] Dispatch **skills → recipes → agents → jobs → services**; uninstall reverses (via `runPlan`).
- [x] `--only=<types>` (multi-valued — comma-separated/repeatable; D-21), `--dry-run`, `--status`, `--uninstall`, `--respect-locks`, `--json`.
- [x] `--include=<pat>` / `--exclude=<pat>` component-name filter (added 2026-06-11, D-20; `lib/filter.mjs`).
- [x] Removed `--no-agent`/`--no-job` — subsumed by multi-valued `--only` (2026-06-11, D-21).
- [x] Aggregate summary; continue-and-report with non-zero exit on any failure.
- [x] **`install_entry` hook (A4 / OQ-U2)** — after the declarative pass, spawn `node <entry>` as a
      subprocess for all modes, forwarding mode + standard + package-specific flags (sandbox-internal
      flags and the package path are not forwarded; INSTALL_SCHEMA/BASE_DIR inherited via env).

**Test:** `tests/runner.test.mjs` (`npm test`) — 8 assertions green via the real CLI (spawnSync):
preflight pass + unwritable-BASE→PreflightError; install_entry runs with correct flag forwarding
for install/dry-run+pkg-flag/uninstall/status/`--only` (incl. multi-valued `--only=skills,recipes`).
Plus `--sandbox --lifecycle` over `examples/bundle` green and `--dry-run` clean "would…" output (both
re-verified post-preflight). Type/name selection itself is covered by `tests/filter.test.mjs`.

## Phase 6 — Services (deploy-project) — ✅ DONE 2026-06-01 (live apply pending smoke test)

- [x] **D-2b resolved → inline templates** (deploy-project ships no callable scripts; it's a
      runbook). `core/service.mjs` emits `.env` / `ecosystem.config.cjs` / nginx vhost via pure
      renderers, allocates a port (`nextFreePort`), and drives pm2/nginx directly.
- [x] `service.mjs`: render artifacts + build step + live `applyService` (copy source, write
      `.env` chmod 640, ecosystem, vhost; pm2 start+save; nginx reload). Never touches
      `crhq-satellite`; binds 127.0.0.1 only (deploy-project Rule 1).
- [x] `--dry-run` runs build + render, **skips apply** (D-2a). **`--sandbox` skips services
      entirely** (not modelled) — verified no live writes when a service package runs in sandbox.

**Test:** `tests/service.test.mjs` (`npm test`) — 9 assertions green: renderEnv / renderEcosystem
(secrets excluded) / renderNginx (127.0.0.1, crhq host, TLS, no 0.0.0.0; ssl:false; white-label),
`nextFreePort`, dry-run no-write, sandbox-skip, secret hygiene (GAP 9).
⚠️ **Pending:** the live `applyService`/`removeService` paths are implemented but unverified — they
need the one explicit live service smoke test (requires authorization; not run this session).

## Phase 7 — Package manifest + sample — ✅ DONE 2026-06-01

- [x] `examples/bundle/ai1-package.yaml` — full identity + metadata (triggers/category/…),
      `components` inventory, `install_entry: scripts/install.mjs` + `install_flags`.
- [x] `examples/bundle/` now exercises **every** component type: skill + recipe + agent + job +
      **service** (`services/ai1-sample-svc/`) + the `install_entry` hook.
- [x] `SKILL.md` + `README.md` rewritten from the old REST-stub design to the final
      DB-direct/sandbox design (manifest, flags, component conventions, library API, safety).

**Verified:** `--sandbox --lifecycle examples/bundle` green (service sandbox-skipped); plain
`--sandbox examples/bundle` runs the `install_entry` with zero live service writes.

## Phase 8 — Install gate — ✅ DONE 2026-06-07 (user-authorized live)

- [x] Deployed to the canonical path `/opt/projects/crhq-satellite/user-skills/ai1-crhq-installer/`
      (rsync) and registered in the live DB via `POST /api/skills` → discoverable at
      `/api/skills/ai1-crhq-installer`. Read-only `--status` against live confirmed connectivity.
- [x] **Live service smoke test PASSED** — real `--only=services` install of `ai1-sample-svc`
      deployed via PM2 + nginx; served on `:4310`, through nginx, and over the public **white-label**
      URL `https://myzone-tamas-ai1-sample.crhq.ai`; `.env` chmod 640. `--only=services --uninstall`
      left the box clean (PM2 process + vhost + project dir removed; nginx still valid). Validated
      the previously-untested `applyService`/`removeService` paths, incl. the WL vhost branch.
- Two fixes surfaced by the smoke test: sample `server.js` → CommonJS (runs as bare `node server.js`);
  `removeService` now removes the project dir (was leaving `.env` behind).

## Testing strategy (summary)

- Per-change: `--dry-run` over the sample bundle (fast, zero-write gate).
- Per-phase: `--sandbox --lifecycle` over the sample bundle (self-contained full lifecycle).
- Negative cases: malformed manifest, missing SKILL.md, locked skill (+/- `--respect-locks`),
  missing dependency (C12 halt + exit code).
- Services: explicit non-sandbox smoke test (the sandbox models DB + fs, not nginx/PM2).

## Deliverables checklist

- [x] `lib/{index,context,db,manifest,parse,fs,log,prereq,preflight,filter,run,sandbox}.mjs` + `lib/core/{skill,recipe,agent,job,service}.mjs`
- [x] `scripts/install.mjs` generic runner (incl. `--sandbox` + `install_entry`)
- [x] `examples/bundle/` complete sample (with its `ai1-package.yaml`)
- [x] Updated `SKILL.md` + `README.md`
- [x] Green `--sandbox --lifecycle` over the sample bundle
- [x] Phase 8 — install gate: deployed + registered on live; live service smoke test passed + cleaned up
