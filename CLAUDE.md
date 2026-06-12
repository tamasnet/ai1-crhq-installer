# ai1-crhq-installer

A **generic, manifest-driven installer** (a CRHQ skill) that deploys a bundle of resources —
**skills, recipes, agents, jobs, services** — into a CRHQ satellite. DB-direct, idempotent, and
self-sandboxing. It generalizes the satellite's bespoke canon installers into one reusable utility.

**Status:** v1 complete and live. `npm test` green (sandbox-backed); zero runtime deps (`yaml`
vendored — no `npm install`). Deployed to
`/opt/projects/crhq-satellite/user-skills/ai1-crhq-installer/` and registered as a live skill;
the live service apply/remove paths are smoke-tested.

## Read first (the contracts — in `docs/`)
1. `docs/README.md` — orientation + doc map
2. `docs/package-manifest-spec.md` — the `ai1-package.yaml` input format (v1.0)
3. `docs/architecture.md` — product shape, module layout, control flow, CLI surface
4. `docs/api-design.md` — exact module/function signatures + `install.mjs` control flow
- Build rules: `docs/canon-conventions.md` (C1–C13) · DB schema + CRHQ mapping: `docs/integration-reference.md`
- Decision rationale (D-* / OQ-* IDs cited in code): `docs/decisions.md`

## Non-negotiables (violating these breaks sandboxing or safety)
- **ESM `.mjs` only.** DB access *only* via the hardcoded import
  `import { getDb } from '/opt/projects/crhq-satellite/server/db/knex.js'` (C1). No REST for writes.
- **All skill filesystem writes under `INSTALL_BASE_DIR`** — the parent dir for each skill `<key>`
  dir (D-19): `INSTALL_BASE_DIR || join(CRHQ_BASE_DIR,'user-skills') || '/opt/projects/crhq-satellite/user-skills'`.
- **`getDb()` is schema-configurable:** honor `INSTALL_SCHEMA` (`|| SANDBOX_SCHEMA`) → knex `searchPath`.
- **Idempotent** upserts; emit canon completion strings (C7); standard flags
  `--dry-run / --status / --uninstall / --respect-locks / --install-skills-as-user / --type=<types> / --include / --exclude / --json / --sandbox [--keep --lifecycle] / --help`.
  `--type` takes one or more component types (comma-separated/repeatable; renamed from `--only`).
  `--include`/`--exclude` filter components by name (regex; a metacharacter-free value is an exact `^name$` match; case-sensitive).
  **Option validation (`scripts/lib/flags.mjs`):** both CLIs reject an unsupported option or a value flag with no value (message + exit 2) before any side effect; `--help` prints usage (exit 0). Install's supported set = standard flags + the manifest's declared `install_flags` (now enforced, not just forwarded).
  **Skills default to org + `locked`** (`skill_type:'org'`); per-skill `install_type: user` in the manifest entry, or `--install-skills-as-user` (wins), registers them unlocked as `user` skills. Assets stay under `INSTALL_BASE_DIR` either way (D-22).

## Code map
`scripts/install.mjs` + `scripts/backup.mjs` (CLIs) + `scripts/lib/` per `api-design.md`:
`{index, context, db, manifest, parse, fs, log, prereq, preflight, filter, flags, install-log, run, backup, sandbox}.mjs`
+ `core/{skill,recipe,agent,job,service}.mjs` + `vendor/yaml.mjs`.
Install log: `${PACKAGES_DIR:-~/packages}/install.json` (D-24) — updated on real installs/uninstalls only.
Self-test (no live writes): `node scripts/install.mjs <package> --sandbox --lifecycle`.
**Backup** (D-25..D-29): `node scripts/backup.mjs [<base-dir>] [--name= --type= --include= --exclude= --json --help]`
— reverse of install: reads active org/user skills + recipes + non-system agents/jobs from the DB and
writes an installable package to `${BACKUP_BASE_DIR:-~/backups}/<name>/` (default name
`<satellite-id>-backup`), overwrite-in-place via stage→validate→swap. Live + read-only on the DB
(no dry-run/sandbox); restore = `install.mjs <backup-dir>`.

## Safety & workflow
- **`git push` only when explicitly asked.** Trunk branch is `main`. Commit only when asked;
  commit trailer `Co-Authored-By: CRHQ <noreply@crhq.ai>`.
- **Do not install onto the live satellite** unless explicitly told — all testing is sandbox-only
  (isolated schema + temp dir via `--sandbox`).
- Never modify or read the *contents* of core satellite files (`server/`, …); importing
  `server/db/knex.js` at runtime is the one sanctioned exception (C1).
