---
name: ai1-crhq-installer
description: Install a versioned package of CRHQ resources — skills, recipes, agents, background jobs — and standalone services (nginx + PM2 web apps) into a CRHQ satellite from a declarative ai1-package.yaml manifest, or back up the satellite's current resources to such a package. DB-direct via knex, idempotent, and sandbox-testable. Use to bulk-install or update a packaged set of CRHQ resources, deploy a service alongside a satellite, build/test such a package, or take a restorable backup of the satellite's skills/recipes/agents/jobs.
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

## Backup (the reverse of install)

```bash
node scripts/backup.mjs                          # → ${BACKUP_BASE_DIR:-~/backups}/<satellite-id>-backup/
node scripts/backup.mjs --dry-run                # preview what would be backed up; zero fs writes
node scripts/backup.mjs /path/to/backups         # positional arg overrides BACKUP_BASE_DIR
node scripts/backup.mjs --name=my-snapshot       # package/dir name override
node scripts/backup.mjs --type=skills,recipes --include='^acme-' --json
node scripts/install.mjs ~/backups/<name>        # RESTORE — a backup is an installable package
```

`backup` reads the satellite's current DB state and writes it out as an installable package in
the same `ai1-package.yaml` manifest format. **Scope:** active `org`/`user` skills (platform
`system` skills excluded), active recipes, non-system agents, non-system script jobs. Each run
**overwrites the package dir in place** — but builds in a staging dir and swaps only after the
generated manifest validates, so a failed run never damages the previous backup. Components the
format can't express (e.g. a job whose script lives outside `INSTALL_BASE_DIR`) are reported as
`BACKUP-SKIP` with a warning, never fatally. The version is date-based (e.g. `2026.6.12`); a
skill with no recoverable version is pinned `0.0.0` with a warning.

It is **live and read-only against the DB** by design — there is no `--status`, `--uninstall`, or
`--sandbox` (those flags are rejected). `--dry-run` previews a backup: the full discovery/scope/skip
reporting runs (so you can test `--type`/`--include`/`--exclude` combinations), but **nothing is
written** and any previous backup is left untouched. `--type`/`--include`/`--exclude`/`--json` work
exactly as for install (`services` are not DB-resident and not covered); `--help` prints usage.

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
      install_type: org        # optional: 'org' (default, locked) | 'user' (unlocked)
  recipes:
    - path: recipes/my-recipe.md
  agents:
    - path: agents/my-agent.md
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
  `INSTALL_BASE_DIR/<key>/`; `skill_path:'db://skills/<name>'`. **By default the row registers as an
  org skill, `locked`** (`skill_type:'org'`); set the component entry's `install_type: user` — or
  pass `--install-skills-as-user` — to register it as an unlocked `user` skill instead. Either way
  the assets live under `INSTALL_BASE_DIR` (we don't write to where real org skills live; only the
  registration differs).
- **Recipe** — `recipes/<name>.md`: frontmatter (`name`, `description`) + body → `recipes.content`.
- **Agent** — `agents/<name>.md`: YAML frontmatter (`name` → CRHQ agent key, `display_name`, `mode`,
  `default_model`, `icon`, `provider`, `system_prompt_path`, `capabilities`, `skills:[]`,
  `recipes:[]`) + a Markdown body that becomes the agent's `instructions`. Omitted frontmatter
  fields ride DB defaults. Only existing+active skills attach; recipe names resolve to ids; stale
  links are removed on re-run.
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
| `--install-skills-as-user` | Register **all** skills as unlocked `user` skills (overrides the org default and any per-skill `install_type`). |
| `--type=<types>` | Process only the listed types — one or more of `skills`/`recipes`/`agents`/`jobs`/`services`, comma-separated and/or the flag repeated (e.g. `--type=skills,recipes`). |
| `--include=<pat>` | Process only components whose name matches `<pat>` (see below). |
| `--exclude=<pat>` | Skip components whose name matches `<pat>`. Applied after `--include`. |
| `--sandbox` | Provision an isolated schema (cloned from live) + temp dir, install there, tear down. Services are skipped. |
| `--keep` | With `--sandbox`: keep the schema + temp dir for inspection. |
| `--lifecycle` | With `--sandbox`: run install → status → idempotency → uninstall → reinstall assertions. |
| `--json` | Machine-readable result output. |
| `--help` | Print usage and exit `0`. |

**Option handling.** Both CLIs validate their options before doing any work: an **unsupported
option**, or a **value flag given no value** (e.g. a bare `--type` or empty `--type=`), prints a
message and exits `2` without proceeding. In `install`, the supported set is the standard flags above
**plus** any package-specific flags the manifest declares in `install_flags` (forwarded to
`install_entry`); anything else is rejected. `--help` short-circuits everything and prints usage.

Result verdicts: `INSTALL-OK | ALREADY-INSTALLED | INSTALL-PARTIAL | INSTALL-FAIL | PREREQ-MISSING
| LOCKED-ROW`. Exit codes: `0` ok/already · `1` fail/prereq/lock · `2` transport (DB/manifest/preflight).

### Selecting a subset (`--include` / `--exclude`)

`--include` / `--exclude` narrow which components a run touches, **by name** — the same identifier the
summary prints (every component type by its `name`). They apply to every mode
(install, uninstall, status) and compose with `--type` (type scope).

The value is a **regular expression**, with one special case: **if it contains no regex
metacharacters (`` . ^ $ * + ? ( ) [ ] { } | \ ``) it is an exact, anchored match** — `foo` behaves
like `^foo$`. To match a substring or set, include a metacharacter. Matching is **case-sensitive**.
A component is processed iff it matches `--include` (or none was given) **and** does not match
`--exclude`. A filter that matches **zero** components is not an error: the run warns (listing the
available names) and exits `0`. An invalid regex is a usage error (exit `2`).

```bash
node scripts/install.mjs <pkg> --include=my-skill                 # exact match — just that skill
node scripts/install.mjs <pkg> --include='^acme-'                 # everything whose name starts acme-
node scripts/install.mjs <pkg> --include='skill|recipe'           # substring/alternation (regex)
node scripts/install.mjs <pkg> --exclude='-job$' --status         # status of all but *-job components
node scripts/install.mjs <pkg> --type=skills --include='^acme-'   # acme- skills only
```

Because `--include` / `--exclude` start with `--`, they are also **forwarded to a package's
`install_entry`** (like the other standard flags). The declarative pass enforces them; a hook chooses
whether to honor them for its own steps.

## Configuration (environment)

- `INSTALL_BASE_DIR` — parent dir for skill `<key>` folders (default
  `/opt/projects/crhq-satellite/user-skills`; legacy fallback `CRHQ_BASE_DIR` + `/user-skills`).
- `INSTALL_SCHEMA` — Postgres schema for DB writes (applied as a knex `searchPath`; legacy fallback
  `SANDBOX_SCHEMA`). Set automatically by `--sandbox`.
- `PACKAGES_DIR` — where the install log lives (default `~/packages`). Every real install/uninstall
  updates `${PACKAGES_DIR}/install.json` — a flat list with one entry per component carrying its
  name, version, source provenance (`package` + `package_version`) and install date. One slot per
  component, so re-installing from a newer or different package transfers ownership in place rather
  than duplicating. Dry-run and status never touch it, and uninstalled entries are removed outright.
  Redirected to a throwaway dir by `--sandbox`.
- `BACKUP_BASE_DIR` — parent dir under which `backup` writes its package dir (default `~/backups`;
  the CLI's positional argument overrides it). `SATELLITE_ID` (when set) names the default backup
  package `<satellite-id>-backup`.

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

See [`docs/api-design.md`](./docs/api-design.md) for the full surface and
[`docs/architecture.md`](./docs/architecture.md) §1 for the library design.

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
│   ├── backup.mjs         # CLI entry — backup (reverse of install): DB state → installable package
│   └── lib/               # db, manifest, parse, fs, log, prereq, preflight, context, filter, install-log, run, backup, sandbox,
│       ├── core/          #   index  +  core/{skill,recipe,agent,job,service}
│       └── vendor/        #   yaml.mjs — vendored single-file YAML parser (zero npm install)
├── examples/bundle/       # complete sample package (every component type)
├── tests/                 # sandbox-backed suites (npm test)
└── docs/                  # design + spec (package-manifest-spec, api-design, …)
```

## Development & testing

**No `npm install` required** — the installer has **zero runtime dependencies**. `yaml` is vendored
as a single bundled file (`scripts/lib/vendor/yaml.mjs`); knex/pg resolve from the satellite at
runtime via the hardcoded `server/db/knex.js` import.

```bash
npm test        # all sandbox-backed suites
```

On a satellite this skill is installed at
`/opt/projects/crhq-satellite/user-skills/ai1-crhq-installer/` and registered in the skill registry.
