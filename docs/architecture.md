# Architecture

What `ai1-crhq-installer` is and how it's put together. The manifest format it consumes is
`package-manifest-spec.md`; module-level signatures are `api-design.md`; the build rules are
`canon-conventions.md`.

## 1. Product shape: a CLI and a library in one

The utility is a **shared core library** (`scripts/lib/`, exposed via `lib/index.mjs`) with a
**generic manifest-driven runner** (`scripts/install.mjs`) on top.

- The **CLI** drives declarative installs from `ai1-package.yaml`: it loads and validates the
  manifest, builds an ordered plan, and dispatches each component to the matching core
  primitive.
- The **library** exports the same primitives (`upsertSkill`, `upsertAgent`, …, plus
  `createContext` and the parsing/fs/logging helpers) so a package's `install_entry` script —
  or a standalone bespoke installer — reuses them instead of re-implementing the canon
  patterns. Import path: the canonical absolute path
  `/opt/projects/crhq-satellite/user-skills/ai1-crhq-installer/scripts/lib/index.mjs`
  (mirrors the knex.js convention; a package that imports it declares a minimum `installer: <n>`).

Both consumers share `createContext` and `runPlan`, so the CLI and a package hook exercise
identical code paths. The library is opt-in: pre-existing bespoke installers on a satellite
keep working untouched.

## 2. Resource types

| Type | Store | Sandbox-testable? | Mechanism |
|------|-------|-------------------|-----------|
| Skill | `skills` table + `INSTALL_BASE_DIR/<key>/` fs | ✅ | upsert row + copy assets |
| Recipe | `recipes` table | ✅ | upsert row (uuid PK) |
| Agent | `agents` + `agent_skills` + `agent_recipes` | ✅ | upsert + sync joins |
| Job | `background_jobs` table | ✅ | upsert job row |
| Service | nginx vhost + PM2 process | ❌ (skipped under `--sandbox`) | inline deploy templates; dry-run = build only |

DB resources are written **directly via knex** (no REST — it can't be sandbox-intercepted).
Services are standalone web apps outside the DB.

## 3. Layout

```
ai1-crhq-installer/
├── SKILL.md                      # skill doc (canonical usage)
├── ai1-package.yaml              # the installer dogfoods its own manifest format
├── package.json                  # type: module; zero runtime deps
├── scripts/
│   ├── install.mjs               # generic CLI entry: flags → preflight → plan → dispatch
│   └── lib/
│       ├── index.mjs            # public API barrel — the stable import surface
│       ├── context.mjs          # createContext: flag parse + env resolve → bound ctx
│       ├── db.mjs               # getDb/getAdminDb/closeDb — hardcoded knex import + INSTALL_SCHEMA searchPath (C1)
│       ├── manifest.mjs         # load + validate ai1-package.yaml → ordered plan
│       ├── parse.mjs            # parseFrontmatter (hand-rolled), loadYaml (vendored yaml)
│       ├── fs.mjs               # copyTree/writeIfChanged/removeTree — INSTALL_BASE_DIR-rooted (C2)
│       ├── log.mjs              # logging + dry-run markers + completion strings + VERDICT
│       ├── prereq.mjs           # requireSkills, requireFiles (C12)
│       ├── preflight.mjs        # DB reachable + BASE writable, before any component work
│       ├── filter.mjs           # --include/--exclude name matcher
│       ├── flags.mjs            # supported-option contract: validateFlags + --help usage (dependency-free)
│       ├── install-log.mjs      # ${PACKAGES_DIR}/install.json — record of installed components
│       ├── version-history.mjs  # component integer version ↔ CRHQ *_versions round-trip (D-34)
│       ├── run.mjs              # runPlan: ordered dispatch shared by CLI + lifecycle suite
│       ├── sandbox.mjs          # --sandbox: provision (LIKE-clone) + seed + redirect + teardown
│       ├── vendor/yaml.mjs      # the yaml package, bundled (zero `npm install`)
│       └── core/                # per-type primitives
│           ├── skill.mjs        # upsertSkill / removeSkill / statusSkill
│           ├── recipe.mjs
│           ├── agent.mjs        # + agent_skills / agent_recipes join sync
│           ├── job.mjs
│           └── service.mjs      # inline nginx/PM2 deploy templates
├── examples/bundle/              # complete runnable sample (every component type + install_entry)
└── tests/                        # sandbox-backed suites (npm test)
```

## 4. Control flow

```
install.mjs <package> [flags]
  → (--help? print usage, exit 0)
  → loadManifest(packageArg)    # validate → ordered plan (no DB; read first so install_flags are known)
  → validateFlags(argv)         # reject unsupported option / missing value → usage exit 2, before any side effect
  → (--sandbox? provision isolated schema + temp dir, set env)
  → createContext(argv)         # the ONLY place accepted flags are parsed and env resolved
  → preflight(ctx)              # DB reachable; BASE writable (write modes) — fail = exit 2
  → runPlan(ctx, plan)          # skills → recipes → agents → jobs → services (uninstall reverses)
  → update install log          # ${PACKAGES_DIR}/install.json — skipped in dry-run/status
  → install_entry subprocess    # if declared — all modes, standard flags forwarded as argv
  → ctx.report()                # summary + completion string + exit code
  → (sandbox teardown unless --keep)
```

Continue-and-report: a failing component is recorded as `INSTALL-FAIL` but doesn't abort the
rest; the run exits non-zero if any component failed.

## 5. CLI surface

```
install.mjs [<package>] [flags]          # <package> = dir with ai1-package.yaml, or the file; default .
  --dry-run        plan only, zero writes (DB/fs; build-only for services)
  --status         report install state for the manifest
  --uninstall      remove everything in the manifest (reverse order)
  --respect-locks  skip locked skill rows instead of unlocking
  --install-skills-as-user  register all skills as unlocked user skills (default: org, locked)
  --type=<types>   restrict to a subset of skills|recipes|agents|jobs|services
                   (comma-separated and/or repeatable, e.g. --type=skills,recipes)
  --include=<pat>  process only components whose name matches <pat> (regex; metachar-free = exact ^pat$)
  --exclude=<pat>  skip components whose name matches <pat> (applied after --include)
  --json           machine-readable result report
  --sandbox        run into a throwaway isolated schema + temp dir (self-contained)
    --keep         preserve the sandbox (schema + temp dir) for inspection
    --lifecycle    run install→status→idempotency→uninstall→reinstall assertions
  --help           print usage and exit 0

backup.mjs [<backup-base-dir>] [flags]   # reverse of install — see §10; default base = BACKUP_BASE_DIR
  --name=<pkg>     package (and output dir) name; default <satellite-id>-backup (D-27)
  --dry-run        preview what would be backed up (full scope/skip reporting); zero fs writes (D-31)
  --type / --include / --exclude / --json   same semantics as install (services never apply)
  --help           print usage and exit 0
                   # no --status/--uninstall/--sandbox: live, read-only, non-destructive

Option validation (lib/flags.mjs): both CLIs reject an unsupported option, or a value flag given
no value (a bare --type or empty --type=), with a message + usage exit 2 — before any side effect.
In install, the supported set is the standard flags PLUS the package manifest's declared
install_flags (forwarded to install_entry); any other option is rejected. --help short-circuits.
```

## 6. Configuration

Env knobs, vendor-neutral names, with legacy fallbacks for the older CRHQ harness names:

```js
// INSTALL_BASE_DIR = the parent dir under which each skill's <key> folder is created.
// Core does join(INSTALL_BASE_DIR, key) — no `user-skills` knowledge in the logic.
INSTALL_BASE_DIR || join(CRHQ_BASE_DIR, 'user-skills') || '/opt/projects/crhq-satellite/user-skills'
// DB schema → knex searchPath (null = default schema):
INSTALL_SCHEMA || SANDBOX_SCHEMA || null
// Where the install log (install.json) lives:
PACKAGES_DIR || join(homedir(), 'packages')
// BACKUP_BASE_DIR = the parent dir under which `backup` writes its package dir (§11):
BACKUP_BASE_DIR || join(homedir(), 'backups')      // positional CLI arg overrides
```

**Install log (D-24):** every real install/uninstall updates `${PACKAGES_DIR}/install.json` —
a flat list with one entry per installed component (`type:name`), `{type, name, version?,
package, package_version, source, installed_at}` (`source` = the component's manifest file
relative to its package root). One slot per component mirrors the DB's one-row-per-name rule,
so re-installing a component — from a newer version of the same package or from a different
package — transfers ownership by overwriting that slot; duplicates can't occur and a partial
upgrade shows as mixed `package_version`s across a package's components. Dry-run and status
never touch it; uninstalling deletes the entry. Bookkeeping only — a log write failure warns,
it doesn't fail the install.

**Version round-trip (D-34):** component `version`s are positive integers. On install,
`lib/version-history.mjs` records the integer as the component's CRHQ `version_num`
(`skill_versions`/`recipe_versions`/`agent_versions`, current = `MAX(version_num)`, idempotent
merge, downgrade warns); on backup it reads `MAX(version_num)` back as the pin. Uninstall drops
the history via the FK `ON DELETE CASCADE` — mirrored explicitly in the FK-less sandbox, which now
clones the two added version tables alongside `skill_versions`. The package-level `version` stays a
free-form label.

Every consumer of the library funnels **all DB access** through `getDb()` (one place the
schema applies) and **all fs access** through `INSTALL_BASE_DIR`-rooted helpers (one place
the base path applies). That single-chokepoint property is what makes the built-in sandbox a
matter of pointing two env vars at an isolated schema and a temp dir.

## 7. Services (inline deploy templates)

Services are not DB-resident and not sandbox-covered. `core/service.mjs` owns the deploy
inline (the satellite's `deploy-project` skill is a procedural runbook with no callable
scripts, so its conventions are implemented here, honoring its security rules):

- copy source → `/opt/projects/user/<name>/`
- write `.env` from `service.yaml` `env` (chmod 640; secrets never logged)
- write `ecosystem.config.cjs` + the nginx vhost (127.0.0.1 binding;
  `{SATELLITE_ID}-<subdomain>.crhq.ai`, incl. the white-label branch)
- allocate a free port if none pinned; PM2 start + save; nginx reload

**Dry-run:** the build step runs (surfacing build errors) but the apply is skipped — no
nginx/PM2/port/reload. **Sandbox:** services are skipped entirely (the sandbox models DB +
fs, not nginx/PM2). Never run PM2 against `crhq-satellite`.

## 8. Built-in sandbox

`--sandbox` makes the utility self-testing with no external harness:

1. **Provision** — `CREATE SCHEMA sandbox_<ts>`; for each managed table
   `CREATE TABLE sandbox_<ts>.<t> (LIKE public.<t> INCLUDING ALL)` — cloned from **live**, so
   the sandbox can't drift from production. Seed prerequisite `skills` rows copied from live
   so agent-attach and dependency checks mirror reality. (FKs aren't re-created; guarded
   join inserts + explicit join cleanup make them unnecessary.)
2. **Redirect** — set `INSTALL_SCHEMA=sandbox_<ts>` + `INSTALL_BASE_DIR=<tempdir>` +
   `PACKAGES_DIR=<tempdir>` (so the install log never touches the real one).
3. **Run** — the requested op; with `--lifecycle`, the full assertion suite
   (see `testing-and-sandbox.md`).
4. **Teardown** — `DROP SCHEMA … CASCADE` + rm tempdir, unless `--keep`.

## 9. Safety boundaries (MANDATORY)

- The knex import path is hardcoded (C1) — never derived from env — but **never modify** any
  core satellite file. Importing `server/db/knex.js` at runtime is the sanctioned mechanism;
  reading/editing/printing its contents is not.
- All skill fs writes go under `${INSTALL_BASE_DIR}` (C2) and `/opt/projects/user/<svc>` for
  services.
- Never run PM2 against `crhq-satellite`; service process names are the package's own.
- `--dry-run` = zero side effects. Locked rows handled per `--respect-locks` (C5).
- Secrets from `service.yaml` `env` → the service `.env` only; never echoed to logs.
- Prereq checks before writes (C12); halt with an actionable message + exit code.

## 10. Backup — the reverse of install (`backup.mjs`)

`backup.mjs` reads the satellite's CRHQ-resident components from the DB and writes them back
out as an **installable package** in the same `ai1-package.yaml` manifest format, under
`${BACKUP_BASE_DIR}/<name>/`. Restore = `install.mjs <that dir>`. Always live and
non-destructive (DB reads only; fs writes only under `BACKUP_BASE_DIR`) — hence no sandbox or
lock handling. `--dry-run` (D-31) runs the full discovery/scope/export pipeline — including the
D-28 skip rules and warnings, so filter/type options can be tested — with zero filesystem writes:
the generated manifest is validated in memory and any previous backup is left untouched. Module:
`lib/backup.mjs` + `export*` primitives co-located in `lib/core/*` (signatures: `api-design.md` §14).

- **Scope (D-25):** active `org`/`user` skills (not platform `system` skills), active recipes,
  non-system active agents, non-system jobs. Inactive rows are out of scope (the manifest
  can't express `is_active:false`).
- **Reconstruction:** SKILL.md is regenerated from the DB row (DB content authoritative; the
  integer version is the live CRHQ number `MAX(skill_versions.version_num)`, else `1` + warning —
  D-34) and the skill tree copies from `skill_dir`. Agents reverse the D-23 mapping
  (`agents.key → name`, `agents.name → display_name`) as an `.md` (frontmatter + `instructions`
  body, including `provider`/`system_prompt_path`/`capabilities` — D-32) with joins resolved to
  names; jobs reverse-resolve `script_args` to a BASE-relative `script`. A component the format
  can't express (non-script job, script outside `INSTALL_BASE_DIR`) is `BACKUP-SKIP`ped/warned,
  never fatal (D-28).
- **Overwrite-in-place (D-26):** each run replaces `${BACKUP_BASE_DIR}/<name>/`, but the
  package is built in a staging dir and swapped in only after it passes the same
  `loadManifest()` validation an install would run — a failed backup never clobbers the
  previous good one.
- **Identity (D-27):** package name defaults to `<satellite-id>-backup` (`SATELLITE_ID` env,
  else hostname minus `crhq-`); `--name` overrides. Version is date-based (`2026.6.12`),
  minted at the CLI entry.
- Services are **out of scope in v1** (not DB-resident; their source of truth is the original
  package).

## 11. Dependencies

- **CRHQ deps (the only external ones):** `server/db/knex.js` (DB accessor), the satellite
  DB, and nginx/PM2 on the host for services.
- **Zero npm runtime deps:** `yaml` is vendored as a single bundled file
  (`scripts/lib/vendor/yaml.mjs`); frontmatter parsing is hand-rolled; knex/pg resolve from
  the satellite at runtime.
