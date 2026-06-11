# Decisions & Open Questions

Living log. Updated after studying the canon installers + sandbox harnesses.

## Decisions

| ID | Decision | Status | Rationale |
|----|----------|--------|-----------|
| **D-1** | Install mechanism = **DB-direct via knex** (no REST for resource writes) | **Confirmed (user)** | Required for sandbox testing — REST can't be intercepted. Matches all 4 canon installers. |
| **D-1a** | Installer is **ESM `.mjs`** and imports knex via the **hardcoded** path `/opt/.../server/db/knex.js` | Firm | C1 — only ESM static-import is interceptable by `sandbox-hooks.mjs`. Current CommonJS scaffold must migrate. |
| **D-1b** | Skill fs ops derive from `INSTALL_BASE_DIR` (the **skill-parent dir**) — see D-19 for resolution | Firm (user-requested) | C2 — configurable; legacy fallback for harness compat (D-15). |
| **D-1c** | Schema configurable via `process.env.INSTALL_SCHEMA \|\| process.env.SANDBOX_SCHEMA` → knex `searchPath` (native in `getDb()`, B4 Mode 2) | Firm | Delivers "configurable DB schema"; legacy fallback keeps the canon loader-hook harness working. |
| **D-2** | Services = **reuse deploy-project conventions** | Provisional | Avoids duplicating nginx/PM2/SSL/port logic. |
| **D-2b** | Services: shell out to deploy-project scripts **vs** inline templates | **Resolved (2026-06-01)** → **inline templates** | `deploy-project` exposes **no reusable scripts** (no `scripts/` dir — it's a procedural runbook), so there is nothing to shell out to. `core/service.mjs` inlines the nginx-vhost / `ecosystem.config.cjs` / `.env` templates + port allocation, honoring its security rules (127.0.0.1 binding, chmod 640 `.env`, never touch `crhq-satellite`). |
| **D-3** | Idempotent; flags `--dry-run`/`--status`/`--uninstall`/`--respect-locks` (+ `--no-agent`/`--no-job`) | Firm | Canon C4; required by the sandbox lifecycle. |
| **D-4** | Install order skills → recipes → agents → jobs → services; uninstall reverses | Firm | Dependency order (C13). |
| **D-5** | Locked skills: **auto-unlock then update by default; `--respect-locks` to skip** | **Revised** | Aligns with canon (was "refuse unless --force"). |
| **D-6** | Zero new runtime deps. Frontmatter splitting hand-rolled; YAML parsing uses `yaml` **vendored as a single bundled file** (`scripts/lib/vendor/yaml.mjs`, built with esbuild). | **Resolved (2026-06-07)** | Achieves the zero-`npm install` goal while keeping full YAML compliance (vs a fragile hand-rolled parser for user-authored manifests). `package.json` has no `dependencies`; knex/pg resolve from the satellite at runtime. Regenerate the bundle via the command in its header. |
| **D-7** | `--dry-run` = zero side effects; output contains "would…" and >200 bytes | Firm | C7; it's our built-in pre-flight check. |
| **D-8** | **Product shape = C (core lib + generic manifest runner)** | **Confirmed (user)** | Best fit for the brief + DRYs the canon installers; keeps scaffolder optional. The manifest is the runner's input; `install_entry` is the package-specific hook. |
| **D-9** | Add **jobs** (`background_jobs`) as a first-class resource type | **Confirmed (user)** | Every canon installer registers jobs; rounds out the system. Now a `jobs` component in the package manifest. |
| **D-10** | Manifest = **`ai1-package.yaml`** at the package root — declarative `components` inventory (skills/recipes/agents/jobs/services) + optional `install_entry` hook. Spec finalized in `package-manifest-spec.md` (v0.2) | **Confirmed (user)** | Builds on the Ai1 Package Standard draft + a hardening review; cross-cutting impl concerns kept OUT of the spec (utility-owned, §7). |
| **D-11** | ~~Reuse `installer-sandbox` + `sandbox-install-test`~~ → **superseded by D-16/D-17.** Still reuse `deploy-project` for services | Revised | Sandboxing is now built into the utility; only `deploy-project` (a CRHQ dependency) is reused. |
| **D-16** | **Drop `sandbox-install-test` dependency** | **Confirmed (user)** | It tests the sandbox harness itself; not needed here. Our built-in `--dry-run` is the pre-flight check. |
| **D-17** | **Absorb `installer-sandbox` into the utility** as a built-in **`--sandbox`** mode — the utility is self-contained (except CRHQ deps: `server/db/knex.js`, the DB, `deploy-project`) | **Confirmed (user)** | `--sandbox` provisions an isolated schema + temp dir, sets `INSTALL_SCHEMA`/`INSTALL_BASE_DIR` internally, installs into there, reports, tears down. No external harness, no `--loader` hook (relies on native `INSTALL_SCHEMA`, OQ-U4). |
| **D-18** | Sandbox schema is **cloned from live** via `CREATE TABLE sandbox_x.<t> (LIKE public.<t> INCLUDING ALL)` (not hardcoded DDL) | **Confirmed (design)** | Zero schema drift (Phase 0 showed the old hardcoded DDL had already drifted); self-contained; auto-tracks production. FK re-creation + seed strategy are details (OQ-14). |
| **D-19** | **`INSTALL_BASE_DIR` = the parent dir for skill `<key>` directories** (not the satellite root). Core does `join(INSTALL_BASE_DIR, key)`; no `user-skills` in the logic. Resolution: `INSTALL_BASE_DIR \|\| join(CRHQ_BASE_DIR,'user-skills') \|\| '/opt/projects/crhq-satellite/user-skills'`. `skill_dir`=`${INSTALL_BASE_DIR}/<key>`, `skill_path`=`db://skills/<name>` | **Confirmed (user)** | Removes the CRHQ-specific `user-skills/` segment from the installer's core + keeps the manifest unaware of it. The `user-skills` literal survives only in the legacy-compat shim + default. |
| **D-2a** | Services dry-run = **run the build step, skip the deploy-project apply** | **Confirmed (user)** | Surfaces build errors without touching nginx/PM2/live state. |
| **D-12** | Utility is **both a CLI and a library** — primitives exported for bundled `install_entry` scripts + standalone installers to import | **Confirmed (user direction)** | DRYs the canon installers; one DB/fs chokepoint. Detailed in `utility-design.md`. |
| **D-13** | The library is the vehicle for the earlier **"configurable base path + schema"** ask: `INSTALL_BASE_DIR` (fs) + `INSTALL_SCHEMA`→`searchPath` (db), inherited by any importer | **Confirmed (design)** | Library-based installers become sandbox-correct for free; loader hook optional. |
| **D-14** | Library is **opt-in**; canon installers keep working unchanged | Firm | Backward compatible; migrate later if useful. |
| **D-15** | **Vendor-neutral env names**: `INSTALL_BASE_DIR` / `INSTALL_SCHEMA` as the public interface, each with legacy fallback to `CRHQ_BASE_DIR` / `SANDBOX_SCHEMA` | **Confirmed (user)** | Package manifest is intended CRHQ-independent, so the utility's knobs are too. Fallback preserves compatibility with the existing `installer-sandbox` harness (which sets the legacy names) — without forking it. Full platform independence is **not** a current goal; only the public surface is neutralized now. |
| **D-20** | **`--include` / `--exclude` component filter** (`lib/filter.mjs`), matched against each component's canonical name (agents → `key`, else → `name`). Value is a **regex**; a value with **no regex metacharacter is an exact `^name$` match**; matching is **case-sensitive**. Selected iff matches `--include` (or none) AND not `--exclude`; composes with `--only`/`--no-agent`/`--no-job` and applies to install/uninstall/status. | **Confirmed (user, 2026-06-11)** | User asks: filter to a subset, regex with literal-as-exact shortcut. Both flags shipped together (symmetric). **Zero-match → warn + exit 0** (treat "nothing to do" as success, not a typo-failure — user choice); invalid regex → `FilterError` exit 2. Case-sensitive matches grep's default + the precise spirit of the exact-match case. Filtering lives in `runPlan` (the single dispatch point) and is reflected in `ctx.plannedSkills`/`plannedRecipes` so dry-run dependency previews stay accurate. |

## Open Questions

| ID | Question | Status | How to resolve |
|----|----------|--------|----------------|
| **OQ-1** | REST write endpoints for agents/recipes? | **Moot** | Superseded by D-1 (DB-direct). |
| **OQ-2** | Live schema matches the sandbox DDL documented here? | **Resolved (2026-05-31)** | `columnInfo()` probe — MATCH. Refinements in `integration-reference.md §6`. CREATE/DROP-SCHEMA privilege confirmed. |
| **OQ-3** | Skill asset path `skills/` vs `user-skills/`? | **Resolved** | `${INSTALL_BASE_DIR}/<key>` — INSTALL_BASE_DIR is the skill-parent dir (C3/D-19); on CRHQ it's `.../user-skills` |
| **OQ-4** | Recipe source format? | **Resolved** | `recipes/<name>.md` — YAML frontmatter (`name`/`description`/optional `version`) + Markdown body → `recipes.content` (package-manifest-spec §5.2). |
| **OQ-5/OQ-6** | Service: shell-out vs inline; port allocation rule | Partially resolved | Shell-out vs inline = **D-2b** (open, Phase 6). Port allocation = delegated to `deploy-project` (`port` now optional). |
| **OQ-7** | Is importing `server/db/knex.js` acceptable for a distributable skill? | **Resolved** | Yes — it's the sanctioned canon mechanism (runtime import, never modify). The CLAUDE.md boundary forbids *modifying/printing* core files, not importing them. |
| **OQ-8** | Agent fields settable on insert (`default_model`, `icon`, `provider`, `capabilities`)? | **Resolved** | Yes; canon inserts minimal + relies on defaults. Column is `default_model` (not `model`). |
| **OQ-9** | Multi-satellite path portability | Partially resolved | `INSTALL_BASE_DIR` (D-1b/D-15) covers fs; the knex import path stays hardcoded for interception (C1). `SATELLITE_ID` for service URLs from env. |
| **OQ-10** | `skill_path` value: `user-skills/<name>` vs `db://skills/<name>` | **Resolved** | `db://skills/<name>` — location-independent; doesn't bake `user-skills` into the DB (aligns with D-19). |
| **OQ-11** | `--no-agent` vs `--skip-agent` naming | **Resolved** | `--no-agent` (canon's `--skip-agent` is a legacy alias). |
| **OQ-U1…U5** | Utility/library design choices (lib import path; `install_entry` on uninstall/status; `--json`; native `INSTALL_SCHEMA`; refactor canon installers) | **Resolved (user)** — see `utility-design.md §D`: U1 canonical absolute path (alias later) · U2 yes · U3 yes · U4 yes · U5 no | — |
| **OQ-12** | ~~Staging `installer-sandbox` on the satellite~~ | **Obsolete (D-17)** | We build the sandbox into the utility; nothing external to stage. |
| **OQ-13** | The 4 on-satellite canon installers hardcode `BASE` (not FS-isolated under sandbox) | Noted | Reinforces D-1b/C2: our installer MUST honor `INSTALL_BASE_DIR`. |
| **OQ-14** | Built-in sandbox details: re-create intra-schema FKs after `LIKE`? how to seed prerequisite skills (copy real `skills` rows vs minimal placeholders)? | Open (build) | `LIKE INCLUDING ALL` omits FKs; decide whether fidelity needs them. Seed by copying live `skills(name,is_active,skill_type,skill_path)` so agent-attach + dep checks mirror reality. |
| **OQ-A1…A5** | Signature-level choices | **Resolved** — baked into `api-design.md`: A1 own `knex({...,searchPath})` from CRHQ cfg · A2 single small `yaml` dep (frontmatter hand-rolled) · A3 `install_entry` via `spawnSync('node',…)` subprocess (all modes) · A4 `ts`/ids minted at CLI entry, threaded into lib · A5 snapshot = names+counts+join pairs+files (deepen only if it misses drift) | — |

## Reference installers (studied this session)

- `requirements-installer` — 2 skills + recipe + agent; knex; `--status/--uninstall/--skip-agent`;
  locked-row handling; deprecation cleanup.
- `dev-handoff-installer` — cleanest template; `CRHQ_BASE_DIR`, `--dry-run/--respect-locks/--no-agent`;
  explicit note that direct-knex couples to `server/` but "canon convention wins."
- `plaud-installer` — **suite/composition** pattern: spawns sub-installers, forwards flags,
  reverse-order uninstall, prereq halt, idempotent re-run.
- `plaud-ingest` — skill + **background_job** registration; prereq + migration-column checks (C12).
- `installer-sandbox` — lifecycle test harness (schema-per-run + temp FS + loader hook).
- `sandbox-install-test` — fast pre-push dry-run check.

## Conventions reference

The 13 canon conventions live in `canon-conventions.md`; the authoritative DB schema in
`integration-reference.md`. Those two are the build contract.
