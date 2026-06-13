# ai1-crhq-installer — Documentation

Design and reference docs for the `ai1-crhq-installer` skill: a **DB-direct,
sandbox-testable** installer that deploys a versioned package of resources into a CRHQ
satellite from a declarative `ai1-package.yaml` manifest.

| Resource | Store | Sandbox-testable? |
|----------|-------|-------------------|
| Skill | `skills` table + `INSTALL_BASE_DIR/<key>/` | ✅ |
| Recipe | `recipes` table (uuid PK) | ✅ |
| Agent | `agents` + `agent_skills` + `agent_recipes` | ✅ |
| Job | `background_jobs` table | ✅ |
| Service | nginx vhost + PM2 | ❌ (build-only dry-run; skipped in sandbox) |

For usage, start at the repo root: `SKILL.md` (canonical usage) and `README.md`
(quick start). `examples/bundle/` is a complete runnable sample package.

## The documents

| Doc | Purpose |
|-----|---------|
| [`package-manifest-spec.md`](./package-manifest-spec.md) | **The package manifest format** (`ai1-package.yaml`, v1.0) — the installer's input contract (platform-independent) |
| [`architecture.md`](./architecture.md) | Product shape (CLI + library), module layout, control flow, CLI surface, configuration, services, safety boundaries |
| [`api-design.md`](./api-design.md) | **Module reference** — signatures, def shapes, `createContext`, primitives, `runPlan`, `lib/sandbox.mjs`, exit codes |
| [`canon-conventions.md`](./canon-conventions.md) | **The build contract** — conventions C1–C13 + the sandbox contract |
| [`integration-reference.md`](./integration-reference.md) | **Authoritative DB schema** (9 managed tables, live-verified) + the manifest → CRHQ storage mapping |
| [`testing-and-sandbox.md`](./testing-and-sandbox.md) | The built-in `--sandbox` / `--lifecycle` testing model + the `npm test` suites |
| [`decisions.md`](./decisions.md) | Settled design decisions (D-* / OQ-* / C-* rationale index, referenced from code comments) |

## Cornerstones

- **DB-direct via knex** — REST can't be sandbox-intercepted. ESM `.mjs` with the hardcoded
  knex import (C1); all skill fs ops under `INSTALL_BASE_DIR` (C2).
- **Manifest in, lifecycle owned by the utility** — packages declare `components`; an
  optional `install_entry` covers only what the utility can't infer.
- **Built-in `--sandbox`** — self-provisions an isolated schema cloned from live + a temp
  dir, installs there, tears down; `--lifecycle` runs the full assertion suite. No external
  harness.
- **Configurable** — `INSTALL_BASE_DIR` (skill-parent dir) + `INSTALL_SCHEMA`
  (knex `searchPath`); vendor-neutral names, with legacy `CRHQ_BASE_DIR`/`SANDBOX_SCHEMA` fallbacks.
- **Zero npm runtime deps** — `yaml` vendored; knex/pg resolve from the satellite.

## Hard rule

Do **not** install onto the live satellite unless explicitly told. All testing is
sandbox-only (isolated schema + temp dir via `--sandbox`).
