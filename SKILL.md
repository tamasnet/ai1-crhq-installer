---
name: ai1-crhq-installer
description: Install a versioned package of CRHQ resources — skills, recipes, agents, background jobs — and standalone services (nginx + PM2 web apps) into a CRHQ satellite from a declarative ai1-package.yaml manifest. DB-direct via knex, idempotent, and sandbox-testable. Use to bulk-install or update a packaged set of CRHQ resources, deploy a service alongside a satellite, or build/test such a package.
---

# Ai1 CRHQ Installer

A **DB-direct, manifest-driven** installer that deploys a **package** — a versioned bundle of
components — into a CRHQ satellite. Idempotent, sandbox-testable, and self-contained except for its
CRHQ dependencies (`server/db/knex.js`, the database, and nginx/PM2 for services).

## What it installs

| Component | Stored in | Sandbox-testable? |
|-----------|-----------|-------------------|
| **skill** | `skills` table + assets under `INSTALL_BASE_DIR/<key>/` | ✅ |
| **recipe** | `recipes` table | ✅ |
| **agent** | `agents` + `agent_skills` + `agent_recipes` | ✅ |
| **job** | `background_jobs` table | ✅ |
| **service** | nginx vhost + PM2 process (not DB-resident) | ❌ — skipped under `--sandbox` |

Skills, recipes, agents and jobs are written **directly to the database via knex** — not REST, which
can't be intercepted for sandbox isolation. Services are standalone web apps deployed via nginx +
PM2; they do not appear in the CRHQ UI.

## Quick start

```bash
node scripts/install.mjs <package> --dry-run              # preview; zero writes
node scripts/install.mjs <package> --sandbox --lifecycle  # isolated full-lifecycle self-test
node scripts/install.mjs <package>                        # real install (writes live DB; deploys services)
node scripts/install.mjs <package> --status              # report per-component state
node scripts/install.mjs <package> --uninstall           # remove (reverse order)
```

`<package>` is a directory containing an `ai1-package.yaml` (or a path to the file itself; defaults
to `.`). See `examples/bundle/` for a complete sample with every component type.

## The package manifest (`ai1-package.yaml`)

A package is a versioned directory with a single `ai1-package.yaml` at its root declaring an
**explicit `components` inventory** (a file present but not listed is not installed). Minimal shape:

```yaml
name: my-bundle
version: 1.0.0
description: ...
installer: ">=0.1.0"            # optional min installer version
components:
  skills:
    - path: skills/my-skill     # dir with SKILL.md (+ optional scripts/)
      version: 0.1.0            # REQUIRED — must equal SKILL.md frontmatter version
  recipes:
    - path: recipes/my-recipe.md
  agents:
    - path: agents/my-agent.yaml
  jobs:
    - path: jobs/my-job.yaml
  services:
    - path: services/my-svc     # dir with service.yaml + app source
      version: 1.0.0            # REQUIRED — must equal service.yaml version
install_entry: scripts/install.mjs   # optional hook for steps the installer can't infer
```

Install order is **skills → recipes → agents → jobs → services**; uninstall reverses.
Full specification: [`docs/package-manifest-spec.md`](./docs/package-manifest-spec.md).

## Component conventions (summary)

- **Skill** — `skills/<key>/SKILL.md`: YAML frontmatter (`name`, `version`, `description`) + a
  Markdown body that becomes `skills.content`; optional `scripts/`. Assets copy to
  `INSTALL_BASE_DIR/<key>/`; the row is `skill_type:'user'`, `skill_path:'db://skills/<name>'`.
- **Recipe** — `recipes/<name>.md`: frontmatter (`name`, `description`) + body → `recipes.content`.
- **Agent** — `agents/<key>.yaml`: `key`/`name`/`mode`/`default_model`/`icon`/`skills:[]`/`recipes:[]`.
  Only existing+active skills attach; recipe names resolve to ids; stale links are removed on re-run.
- **Job** — `jobs/<name>.yaml`: `name`/`schedule`/`script`/`requires:[]`. `schedule` accepts a cron
  expression or an alias (`hourly`, `daily`, `every-15-min`, `every-30-min`). `script` resolves to
  `INSTALL_BASE_DIR/<script>`; `requires` skill dirs must exist first (prereq guard).
- **Service** — `services/<name>/service.yaml`: `name`/`version`/`start`/`port?`/`build?`/`env`/
  `nginx`, plus the app source. Deployed via an nginx reverse proxy (127.0.0.1) + a PM2 process.

Full field reference: [`docs/package-manifest-spec.md` §5](./docs/package-manifest-spec.md).

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Preview; zero DB/fs writes (services: build only, no apply). |
| `--status` | Report per-component install state. |
| `--uninstall` | Remove components in reverse order. |
| `--respect-locks` | Skip locked skills instead of auto-unlocking them. |
| `--no-agent` / `--no-job` | Skip agents / jobs. |
| `--only=<type>` | Process one type (`skills`/`recipes`/`agents`/`jobs`/`services`). |
| `--sandbox` | Provision an isolated schema (cloned from live) + temp dir, install there, tear down. Services are skipped. |
| `--keep` | With `--sandbox`: keep the schema + temp dir for inspection. |
| `--lifecycle` | With `--sandbox`: run install → status → idempotency → uninstall → reinstall assertions. |
| `--json` | Machine-readable result output. |

Result verdicts: `INSTALL-OK | ALREADY-INSTALLED | INSTALL-PARTIAL | INSTALL-FAIL | PREREQ-MISSING
| LOCKED-ROW`. Exit codes: `0` ok/already · `1` fail/prereq/lock · `2` transport (DB/manifest/preflight).

## Configuration (environment)

- `INSTALL_BASE_DIR` — parent dir for skill `<key>` folders (default
  `/opt/projects/crhq-satellite/user-skills`; legacy fallback `CRHQ_BASE_DIR` + `/user-skills`).
- `INSTALL_SCHEMA` — Postgres schema for DB writes (applied as a knex `searchPath`; legacy fallback
  `SANDBOX_SCHEMA`). Set automatically by `--sandbox`.

## Library API

The installer is also a library. `scripts/lib/index.mjs` exports `createContext` plus the
`upsert*`/`remove*`/`status*` primitives, so a package's `install_entry` can reuse the canon instead
of re-implementing it:

```js
import { createContext, requireSkills, upsertSkill }
  from '/opt/projects/crhq-satellite/user-skills/ai1-crhq-installer/scripts/lib/index.mjs';
const ctx = await createContext(process.argv);   // honors --dry-run/--status/--uninstall/...
try { /* package-specific steps */ ctx.report(); } finally { await ctx.close(); }
```

See [`docs/utility-design.md`](./docs/utility-design.md) Part B and
[`docs/api-design.md`](./docs/api-design.md) for the full surface.

## Safety

- DB writes go only through the hardcoded `server/db/knex.js` import (sandbox-interceptable), never
  via REST.
- Idempotent — re-running produces zero drift. Locked skills auto-unlock (or `--respect-locks` to skip).
- Never modifies core satellite files. Services bind `127.0.0.1` only, lock down `.env` (chmod 640),
  and never touch the `crhq-satellite` process.
- Until you explicitly install for real, **all testing is sandbox-only** (isolated schema + temp dir).

## Layout

```
ai1-crhq-installer/
├── SKILL.md
├── scripts/
│   ├── install.mjs        # CLI entry — generic manifest runner
│   └── lib/               # db, manifest, parse, fs, log, prereq, preflight, context, run, sandbox,
│       └── core/          #   index  +  core/{skill,recipe,agent,job,service}
├── examples/bundle/       # complete sample package (every component type)
├── tests/                 # sandbox-backed suites (npm test)
└── docs/                  # design + spec (package-manifest-spec, api-design, …)
```

## Development & testing

```bash
npm install     # one dependency: yaml
npm test        # all sandbox-backed suites
```

This skill lives in `/opt/projects/user/ai1-crhq-installer/` and is **not** installed into the local
satellite yet — install it explicitly when ready (see `docs/implementation-plan.md` Phase 8).
