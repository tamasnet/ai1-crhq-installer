# ai1-crhq-installer

A **generic, manifest-driven installer** (a CRHQ skill) that deploys a bundle of resources —
**skills, recipes, agents, jobs, services** — into a CRHQ satellite. DB-direct, idempotent, and
self-sandboxing. It generalizes the canon installers (requirements / dev-handoff / plaud) into
one reusable utility.

**Status:** **All phases (1–8) complete.** ESM core `lib/` + `lib/core/*` (skills, recipes, agents,
jobs, services) + generic runner (`install.mjs`: preflight + `install_entry`) + built-in `--sandbox`.
`npm test` = 52 assertions green; zero runtime deps (`yaml` vendored — no `npm install`). Deployed to
`/opt/projects/crhq-satellite/user-skills/ai1-crhq-installer/` and registered as a live skill; the
live service apply/remove paths were smoke-tested end-to-end (incl. the white-label vhost) and
cleaned up. D-2b → inline templates; OQ-14 → seed skills, no FK recreation.

## Read first (the contracts — in `docs/`)
1. `docs/README.md` — orientation + key decisions
2. `docs/package-manifest-spec.md` — the `ai1-package.yaml` input format
3. `docs/api-design.md` — exact module/function signatures + `install.mjs` control flow
4. `docs/implementation-plan.md` — phased build; **start at Phase 1**
- Build rules: `docs/canon-conventions.md` (C1–C13) · DB schema: `docs/integration-reference.md`
- Rationale + open items: `docs/decisions-and-open-questions.md` (D-* / OQ-*)

## Non-negotiables (violating these breaks sandboxing or safety)
- **ESM `.mjs` only.** DB access *only* via the hardcoded import
  `import { getDb } from '/opt/projects/crhq-satellite/server/db/knex.js'` (C1). No REST for writes.
- **All skill filesystem writes under `INSTALL_BASE_DIR`** — the parent dir for each skill `<key>`
  dir (D-19): `INSTALL_BASE_DIR || join(CRHQ_BASE_DIR,'user-skills') || '/opt/projects/crhq-satellite/user-skills'`.
- **`getDb()` is schema-configurable:** honor `INSTALL_SCHEMA` (`|| SANDBOX_SCHEMA`) → knex `searchPath`.
- **Idempotent** upserts; emit canon completion strings (C7); standard flags
  `--dry-run / --status / --uninstall / --respect-locks / --no-agent / --no-job / --only / --sandbox [--keep --lifecycle]`.

## Build target
`scripts/install.mjs` (CLI) + `scripts/lib/` per `api-design.md`:
`{index, context, db, manifest, parse, fs, log, prereq, sandbox}.mjs` + `core/{skill,recipe,agent,job,service}.mjs`.
Self-test (no live writes): `node scripts/install.mjs <package> --sandbox --lifecycle`.

## Safety & workflow
- **Never `git push`.** Trunk branch is `main`. Commit only when asked; show the diff as an
  artifact before committing; commit trailer `Co-Authored-By: CRHQ <noreply@crhq.ai>`.
- **Do not install onto the live satellite** until explicitly told — all testing is sandbox-only
  (isolated schema + temp dir via `--sandbox`).
- Never modify or read the *contents* of core satellite files (`server/`, …); importing
  `server/db/knex.js` at runtime is the one sanctioned exception (C1).
- Build-phase decisions resolved: **D-2b** → inline templates (deploy-project has no callable
  scripts); **OQ-14** → sandbox seeds live skills and does not re-create intra-schema FKs (guarded
  join inserts + explicit join cleanup make them unnecessary).
