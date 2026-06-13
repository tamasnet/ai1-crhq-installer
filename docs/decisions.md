# Decision Record

The settled design decisions and their rationale, kept because code and docs reference the
IDs. All are resolved; there are no open questions. (The full deliberation history is in git
history of `decisions-and-open-questions.md`.)

## Core shape

| ID | Decision | Why |
|----|----------|-----|
| **D-1** | Install mechanism = **DB-direct via knex**; no REST for writes | REST can't be sandbox-intercepted; matches the satellite's established installers. |
| **D-1a / C1** | ESM `.mjs` + **hardcoded** knex import path | Only an ESM static import is interceptable by a loader hook. |
| **D-8** | Product shape = **core library + generic manifest runner** | Packages can be pure manifest *or* a 10-line `install_entry` that imports the lib; one codebase to sandbox-test. |
| **D-9** | **Jobs** (`background_jobs`) are a first-class component type | Every reference installer registers jobs. |
| **D-10** | Manifest = **`ai1-package.yaml`** — declarative `components` inventory + optional `install_entry` | Spec: `package-manifest-spec.md`. Cross-cutting implementation concerns deliberately kept OUT of it. |
| **D-12** | The utility is **both a CLI and a library** (primitives exported via `lib/index.mjs`) | One DB/fs chokepoint; `install_entry` scripts inherit sandbox-correctness for free. |
| **D-14** | The library is **opt-in**; pre-existing bespoke installers keep working unchanged | Backward compatible. |

## Configuration & paths

| ID | Decision | Why |
|----|----------|-----|
| **D-15** | Vendor-neutral env names: `INSTALL_BASE_DIR` / `INSTALL_SCHEMA`, with legacy fallback to `CRHQ_BASE_DIR` / `SANDBOX_SCHEMA` | The manifest is CRHQ-independent, so the utility's public knobs are too; fallback preserves compat with the older external harness. |
| **D-19 / C2** | `INSTALL_BASE_DIR` = the **skill-parent dir** (not the satellite root); core does `join(INSTALL_BASE_DIR, key)` | No `user-skills` knowledge in core logic — the literal survives only in the legacy shim + default. |
| **OQ-10 / C3** | `skill_path` = `db://skills/<name>` | Location-independent; doesn't bake the fs layout into the DB. |
| **D-1c / OQ-U4** | Schema configurability is **native**: `getDb()` applies `INSTALL_SCHEMA` as knex `searchPath` | No loader-hook dependency for sandboxing. |
| **OQ-U1** | Library import path = canonical absolute path (mirror of the knex.js convention) | Stable, interception-friendly, zero install magic. A `@ai1/installer` alias is a possible later DX upgrade. |

## Behavior

| ID | Decision | Why |
|----|----------|-----|
| **D-4 / C13** | Install order skills → recipes → agents → jobs → services; uninstall reverses | Dependency order. |
| **D-5 / C5** | Locked skills: auto-unlock-then-update by default; `--respect-locks` to skip | Matches canon behavior. |
| **D-22** | Skills default to **org + `locked`**; per-skill `install_type: user` or global `--install-skills-as-user` (which wins) registers unlocked `user` skills | Org skills are the norm. Only the DB registration changes — assets always land under `INSTALL_BASE_DIR` (no write access to where real org skills live). `install_type` lives in the manifest component entry, not SKILL.md. |
| **D-21** | `--type=<types>` (renamed from `--only`) is multi-valued (comma-separated/repeatable); the old `--no-agent`/`--no-job` toggles are removed | One flag expresses any type subset; `runPlan` intersects with the canonical order. `--type` reads better next to `--include`/`--exclude`. |
| **D-30** | **Strict option handling** (`lib/flags.mjs`): both CLIs reject an unsupported option or a value flag with no value (message + usage exit 2) before any side effect; `--help` prints usage (exit 0). Install's supported set = standard flags + the manifest's **declared `install_flags`** (now enforced, not just silently forwarded); a manifest may not shadow a standard flag | A typo or wrong-mode flag should fail loudly, not silently do the wrong thing. Tying the accepted package-flag set to `install_flags` keeps the existing forwarding feature while making "unsupported" well-defined. The flag contract lives in one dependency-free module so `manifest.mjs` can share it without importing the DB layer. |
| **D-20** | `--include`/`--exclude` filter by component name; regex, with metacharacter-free values as exact `^name$`; case-sensitive; zero-match = warn + exit 0; invalid regex = exit 2 | Subset installs without editing the manifest. Zero-match is "nothing to do", not a typo-failure. |
| **D-33** | `--list-installed` prints the install log (`${PACKAGES_DIR}/install.json`) as a `TYPE/NAME/VERSION/FROM` table sorted by type (canonical order) then name; `--json` emits the sorted array; empty log → notice. Standalone install-mode boolean that, like `--help`, short-circuits before manifest/validation/DB/sandbox — log-only, exit 0 (2 if unreadable). Formatting lives in `install-log.mjs` (`sortInstalled`/`formatInstalledList`) so it's unit-testable DB-free | A queryable view of installed state without a package or DB connection. Reusing the log (not the DB) keeps it dependency-free and consistent with the D-24 record; pairing the human table with `--json` serves both eyeballs and automation. |
| **D-23** | Agent manifest fields follow the common pattern: `name` (the canonical identifier, stored as CRHQ `agents.key`) + `display_name` (stored as `agents.name`); the former `key` field is rejected with a pointer to the rename | Every component type shares the `name`/`description` shape, so filters, summaries, and docs treat all types uniformly. |
| **D-24** | **Install log** at `${PACKAGES_DIR}/install.json` (default `~/packages`): a **flat list**, one entry per component (`type:name`) `{type, name, version?, package, package_version, source, installed_at}` (source = the component's manifest file relative to its package root). One slot per component mirrors the DB's one-row-per-name rule, so re-installing a component (newer version of the same package, or a different package) **transfers ownership by overwriting that slot** — no duplicates, and a partial upgrade reads as mixed `package_version`s. Never written in dry-run/status; uninstall deletes the entry; `--sandbox` redirects `PACKAGES_DIR` to a throwaway dir; a write failure warns but never fails the install | A queryable record of what's installed, independent of the DB. Component-keyed (not package-keyed) because the DB allows exactly one component per name — making that the log's primary key keeps an impossible "two packages own one skill" state unrepresentable and reduces ownership transfer to a plain upsert. Removal-not-tombstoning keeps it a statement of current state, not a history (git/DB hold history). |
| **OQ-U2** | `install_entry` runs on **all modes** (install/uninstall/status), receiving the mode | Keeps teardown symmetric; the hook decides what to do. |
| **OQ-U3** | `--json` machine-readable report | Cheap; enables automation over the verdict taxonomy. |
| **D-7 / C7** | `--dry-run` = zero side effects; output contains "would…" and >200 bytes | It's the built-in pre-flight check. |

## Backup (`backup.mjs` — the reverse of install)

| ID | Decision | Why |
|----|----------|-----|
| **D-25** | Backup scope = active `org`+`user` skills, active recipes, non-system active agents, non-system jobs; platform `system` components and inactive rows are out of scope; **services excluded in v1** | System components are restored by the platform, not a package; the manifest can't express `is_active:false` (restoring one would silently re-activate it); services aren't DB-resident and their source of truth is the original package. |
| **D-26** | Output = `${BACKUP_BASE_DIR}/<name>/` (env, default `~/backups`; positional arg overrides), **overwritten in place** each run — built in a staging dir and swapped only after the generated manifest passes the real `loadManifest()` | One current snapshot, user-managed rotation (git/rsync hold history). The stage-validate-swap makes a failed backup unable to clobber the previous good one, and guarantees the output is installable at parse level. |
| **D-27** | Package identity: name = `<satellite-id>-backup` (`SATELLITE_ID` env, else hostname minus `crhq-`; `--name` overrides); version = date-based (`YYYY.M.D`), minted at the CLI entry; a skill with no recoverable frontmatter version pins `0.0.0` + warning | Multi-satellite backups distinguishable by default; the date names the snapshot; `0.0.0` keeps the manifest valid (skill version pins are required) without inventing fake versions. |
| **D-28** | Lossiness is explicit, never fatal: a component the format can't express (non-script job, script outside `INSTALL_BASE_DIR`) → `BACKUP-SKIP` (severity 0) + warning | Backup is best-effort over a live DB that contains more shapes than the manifest format models; silent omission would read as "covered", aborting would block the rest of the backup. (The agent fields that D-28 originally listed as lossy — `instructions`, `capabilities`, `system_prompt_path`, `provider` — now round-trip via the `.md` format, D-32.) |
| **D-29** | YAML **emission** is hand-rolled (`dumpYaml`, ~60 lines): plain scalars only when provably safe, JSON-double-quoted otherwise (valid YAML); round-trip tested against the vendored parser | Extends D-6 — the vendored bundle only exports `parse`, and regenerating it for `stringify` adds weight for shapes we fully control. JSON-escape fallback makes it correct by construction. |
| **D-31** | Backup supports `--dry-run`: the full discovery/scope/export pipeline runs — including the D-28 skip rules, warnings, and per-component verdicts — with **zero filesystem writes** (the `export*` primitives thread `ctx.DRY_RUN` into the fs helpers); the generated manifest is validated in memory and the previous backup is untouched. Still no `--status`/`--uninstall`/`--sandbox` | Lets the operator see what a backup would contain and test `--type`/`--include`/`--exclude` combinations without overwriting the current snapshot. Reuses install's existing dry-run plumbing (one convention, C7 `would` markers) instead of inventing a backup-specific preview mode. |
| **D-32** | Agents are a **content-bearing** component: `agents/<name>.md` = YAML frontmatter (config) + Markdown body (`instructions`). Frontmatter now also carries `provider`, `system_prompt_path`, and `capabilities` (jsonb). Install sets each only when present (else DB default; `capabilities` is `JSON.stringify`d) and drift-checks them; backup emits each only when non-default, so the round trip is lossless and idempotent. **Clean break — the former `.yaml` agent format is no longer parsed.** | These fields are needed (exposed while building backup, which previously dropped them under D-28). An agent's `instructions` is Markdown, so the agent belongs with skills/recipes as a frontmatter+body component rather than flat YAML. The project is pre-release with one example agent, so a clean switch beats carrying a dual-format parser. |

## Services

| ID | Decision | Why |
|----|----------|-----|
| **D-2 / D-2b** | Services follow the satellite's deploy-project conventions, implemented as **inline templates** in `core/service.mjs` | deploy-project ships no callable scripts (it's a runbook) — so the nginx-vhost / ecosystem / `.env` templates + port allocation are inlined, honoring its security rules (127.0.0.1 binding, chmod 640 `.env`, never touch `crhq-satellite`). |
| **D-2a** | Service dry-run = run the **build step**, skip the apply | Surfaces build errors without touching nginx/PM2/live state. |

## Sandbox & dependencies

| ID | Decision | Why |
|----|----------|-----|
| **D-16 / D-17** | Sandboxing is **built in** (`--sandbox` / `--keep` / `--lifecycle`); the external `installer-sandbox` + `sandbox-install-test` harnesses are not dependencies | Self-contained except CRHQ deps (`server/db/knex.js`, the DB, nginx/PM2). |
| **D-18** | Sandbox schema is **cloned from live** via `CREATE TABLE … (LIKE public.<t> INCLUDING ALL)` | Zero schema drift (hardcoded DDL had already drifted once); auto-tracks production. |
| **OQ-14** | Sandbox seeds `skills` rows from live; intra-schema FKs are **not** re-created | Seeding makes agent-attach + dep checks mirror reality; guarded join inserts + explicit join cleanup make FKs unnecessary. |
| **D-6** | Zero npm runtime deps: frontmatter hand-rolled; `yaml` **vendored** as one bundled file (`lib/vendor/yaml.mjs`) | Zero-`npm install` goal with full YAML compliance. Regenerate via the command in the bundle's header. |
| **OQ-7** | Importing `server/db/knex.js` at runtime is sanctioned | It's the canon mechanism; the safety boundary forbids *modifying/printing* core files, not importing them. |

## Provenance

The canon (C1–C13) was distilled from the four installers already on the satellite —
`requirements-installer`, `dev-handoff-installer`, `plaud-installer`, `plaud-ingest` — plus
the `installer-sandbox` / `sandbox-install-test` harnesses, which this utility generalizes
and absorbs.
