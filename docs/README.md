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
| [`testing-and-sandbox.md`](./testing-and-sandbox.md) | How the two existing harnesses verify our installer |
| [`implementation-plan.md`](./implementation-plan.md) | Phase 0 → Phase 8, tests per phase |
| [`decisions-and-open-questions.md`](./decisions-and-open-questions.md) | D-1…D-11 + open questions |

**Manifest-spec inputs (historical):** [`ai1-package-standard.md`](./ai1-package-standard.md)
(Tamás's 2026-05-27 draft), [`tamas-package-standard-REVIEW.md`](./tamas-package-standard-REVIEW.md)
+ [`tamas-package-standard-ANNOTATED.md`](./tamas-package-standard-ANNOTATED.md) (ThinkBot review).
Synthesized into `package-manifest-spec.md`.

## Settled (this session)

- **DB-direct via knex** (user-confirmed) — REST can't be sandbox-intercepted.
- **ESM `.mjs` + hardcoded knex import** + **`INSTALL_BASE_DIR`** for all fs ops → installs are
  redirectable to an isolated Postgres schema + temp filesystem.
- **Built-in `--sandbox`** (D-17): the utility self-provisions an isolated schema (cloned from
  live via `CREATE TABLE … LIKE`, D-18) + temp dir, installs into there, and tears down — **no
  external harness**. `--lifecycle` runs the full install→…→reinstall assertions.
- **Configurable base path + schema** via **vendor-neutral env** (D-15): `INSTALL_BASE_DIR`
  (files) + `INSTALL_SCHEMA` (db `searchPath`), each falling back to legacy
  `CRHQ_BASE_DIR`/`SANDBOX_SCHEMA`.
- Auto-unlock locked skills by default; `--respect-locks` to skip.
- **Self-contained** except CRHQ deps: `server/db/knex.js`, the DB, and `deploy-project`
  (services). Dropped: external `installer-sandbox` + `sandbox-install-test` (D-16/D-17).

## Settled (this turn)

- **D-8** Product shape = core-lib + generic manifest runner. **D-9** jobs are a first-class
  resource type. **D-2a** services dry-run runs the build but skips the deploy-project apply.
- **D-10** Manifest = `ai1-package.yaml` (declarative `components` + optional `install_entry`).
  Spec finalized in `package-manifest-spec.md`.

## Still open

- 5 small manifest choices in `package-manifest-spec.md` §9 (filename, `jobs` naming,
  version-pin scope, `requires` on jobs, `installer` field semantics) — recommendations given.
- **D-2b** Services: shell out to deploy-project scripts vs inline templates (Phase 6).

## Hard rule

Do **not** install onto the live satellite until explicitly told. All testing until then is
sandbox-only (isolated schema + temp dir).
