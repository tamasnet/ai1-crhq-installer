# ai1-crhq-installer — Planning Docs

Planning workspace for the `ai1-crhq-installer` skill. **Plan-only — no source code is
changed from these docs.**

## What we're building

A **DB-direct, sandbox-testable** installer that deploys a bundle of resources into a CRHQ
satellite:

| Resource | Store | Sandbox-testable? |
|----------|-------|-------------------|
| Skill | `skills` table + `INSTALL_BASE_DIR/<key>/` | ✅ |
| Recipe | `recipes` table (uuid PK) | ✅ |
| Agent | `agents` + `agent_skills` + `agent_recipes` | ✅ |
| Job | `background_jobs` table | ✅ |
| Service | nginx vhost + PM2 (deploy-project) | ❌ (dry-run only) |

It generalizes the four bespoke installers already on the satellite
(`requirements-installer`, `dev-handoff-installer`, `plaud-installer`, `plaud-ingest`),
which we studied as the canonical pattern.

## Documents (read in this order)

| Doc | Purpose |
|-----|---------|
| [`package-manifest-spec.md`](./package-manifest-spec.md) | **The package manifest format** (`ai1-package.yaml`, v0.2 finalized) — the installer's input contract |
| [`utility-design.md`](./utility-design.md) | **Utility capabilities list + library API** — CLI + importable primitives; sandbox/configurability |
| [`api-design.md`](./api-design.md) | **Signatures & control flow** — `createContext`, primitives, def shapes, `lib/sandbox.mjs`, `install.mjs` flow, exit codes |
| [`architecture.md`](./architecture.md) | Product shape, resource types, layout, flow, services, safety |
| [`canon-conventions.md`](./canon-conventions.md) | **The build contract** — 13 conventions + sandbox compatibility |
| [`integration-reference.md`](./integration-reference.md) | **Authoritative DB schema** (7 tables) + knex usage + REST (read-only) |
| [`testing-and-sandbox.md`](./testing-and-sandbox.md) | The built-in `--sandbox` / `--lifecycle` testing model (self-contained) |
| [`implementation-plan.md`](./implementation-plan.md) | Phase 0 → Phase 8, tests per phase |
| [`decisions-and-open-questions.md`](./decisions-and-open-questions.md) | D-1…D-19 + the OQ log |

## Key decisions (settled)

- **DB-direct via knex** (D-1) — REST can't be sandbox-intercepted; matches the 4 canon installers.
- **ESM `.mjs` + hardcoded knex import** (C1) + **`INSTALL_BASE_DIR`** for all skill fs ops (C2/D-19).
- **Product shape = core lib + generic manifest runner** (D-8); manifest is the input,
  `install_entry` the package-specific hook.
- **Manifest = `ai1-package.yaml`** (D-10) — declarative `components` (skills/recipes/agents/jobs/
  services); spec finalized in `package-manifest-spec.md`.
- **Built-in `--sandbox`** (D-17): self-provisions an isolated schema cloned from live
  (`CREATE TABLE … LIKE`, D-18) + temp dir, installs there, tears down — **no external harness**.
  `--lifecycle` runs the full install→…→reinstall assertions.
- **Vendor-neutral env** (D-15): `INSTALL_BASE_DIR` (the skill-parent dir, D-19) + `INSTALL_SCHEMA`
  (db `searchPath`), each falling back to legacy `CRHQ_BASE_DIR`/`SANDBOX_SCHEMA`.
- Auto-unlock locked skills by default; `--respect-locks` to skip (D-5).
- **Self-contained** except CRHQ deps: `server/db/knex.js`, the DB, and `deploy-project`.

## Still open (build-phase details)

- **D-2b** — services: shell out to `deploy-project` scripts vs inline templates (Phase 6).
- **OQ-14** — sandbox: re-create intra-schema FKs after `LIKE`? exact prerequisite-skill seeding.

All other decisions (D-*, OQ-*) are resolved — see `decisions-and-open-questions.md`.

## Hard rule

Do **not** install onto the live satellite until explicitly told. All testing until then is
sandbox-only (isolated schema + temp dir).
