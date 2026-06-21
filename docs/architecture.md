# Architecture

What `ai1-satellite-tools` is and how it's put together. The manifest format it consumes is
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
  `/opt/projects/crhq-satellite/user-skills/ai1-satellite-tools/scripts/lib/index.mjs`
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
ai1-satellite-tools/
├── SKILL.md                      # skill doc (canonical usage)
├── ai1-package.yaml              # the installer dogfoods its own manifest format
├── package.json                  # type: module; zero runtime deps
├── scripts/
│   ├── install.mjs               # generic CLI entry: flags → preflight → plan → dispatch
│   ├── sync.mjs                  # sync satellite → package repo; --mirror = reverse-of-install backup (§10)
│   ├── remote.mjs                # Ai1 Platform Hub client CLI — subcommand dispatch (§12)
│   ├── polaris.mjs               # GitHub Client-Repository client CLI — subcommand dispatch (§13)
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
│       ├── list-available.mjs   # --list-available: scan local package stores + join the install log (§5)
│       ├── version-history.mjs  # component integer version ↔ CRHQ *_versions round-trip (D-34)
│       ├── run.mjs              # runPlan: ordered dispatch shared by CLI + lifecycle suite
│       ├── sync.mjs            # sync/--mirror export pipeline (§10), reusable as runSync()
│       ├── identity.mjs        # resolveSatelliteId / satellitePackageName — dependency-free (D-43)
│       ├── remote.mjs           # hub client: register/get-config/heartbeat/github-token/get-package — DB-free, fetch-based (§12)
│       ├── polaris.mjs          # Client-Repository client: init (clone) — DB-free, shells out to git (§13)
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
  --list-installed  print the install log (sorted; +--json for the array) and exit — standalone, DB-free
  --list-available  scan PACKAGE_BASE_DIR + REPOS_BASE_DIR, join the install log, print every component
                    with STATUS (available|installed|missing) + its package LOCATION; exit — standalone, DB-free
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

remote.mjs <subcommand> [flags]          # Ai1 Platform Hub client — see §12; DB-free
  register         self-enroll this satellite with the hub; store the per-remote key in id.json
    --hub=<url>                hub base URL (else AI1_HUB_URL / HUB_URL)
    --token=<tok>              shared enrollment secret (else AI1_BOOTSTRAP_TOKEN / BOOTSTRAP_TOKEN)
    --remote-id=<id>           identity to claim (else SATELLITE_ID, else hostname minus 'crhq-')
    --remote-type=<type>       reported at enrollment (default 'crhq-satellite')
    --schema-version=<n>       reported at enrollment (default 1)
    --force                    overwrite an existing id.json (discards the stored token)
    --json / --help

polaris.mjs <subcommand> [flags]         # GitHub Client-Repository client — see §13; DB-free
  init             clone this satellite's Client Repository into ${REPOS_BASE_DIR}/<repo> (default ~/repos)
    --owner=<org>              GitHub owner/org (else AI1_GITHUB_OWNER, else MyZone-AI)
    --repo=<name>              repository name (else satellitePackageName())
    --json / --help

Option validation (lib/flags.mjs): install and backup reject an unsupported option, or a value flag
given no value (a bare --type or empty --type=), with a message + usage exit 2 — before any side
effect. In install, the supported set is the standard flags PLUS the package manifest's declared
install_flags (forwarded to install_entry); any other option is rejected. --help short-circuits.
remote and polaris apply the same strict validation per-subcommand (their own supported sets), reusing UsageError.
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
never touch it; uninstalling deletes the entry. **`sync.mjs --mirror` also reconciles it** (D-48):
for the components a mirror carries it upserts installed slots (attributed to the mirror package) and
drops removed ones, leaving untouched components alone. Bookkeeping only — a log write failure warns,
it doesn't fail the install or the mirror.

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

## 10. Backup — the reverse of install (`sync.mjs --mirror`)

> **⚠ Updated by D-41.** This section was written for the standalone `backup.mjs`, which has been
> **folded into `sync.mjs --mirror`** (`lib/sync.mjs`, exposed as `runSync({mode:'mirror'})`). The
> reverse-of-install *intent* below still holds, but the mechanics changed: mirror takes the
> destination as the `<package-dir>` positional (no `BACKUP_BASE_DIR`/`--name`), **reconciles in
> place** (add new / sync existing / remove gone — git-recoverable, no stage→swap), preserves skill
> `install_type` unless `--normalize`, and bumps an integer package `version` only on a
> content-changing run. It also **reconciles `${PACKAGES_DIR}/install.json`** to the live satellite
> for the components it carries — installed slots upserted (attributed to the mirror package), removed
> ones dropped (D-48). Both sync modes **refuse a `<package-dir>` not inside a git repository** (the
> in-place recovery net) unless `--force` (D-49). Read `backup.mjs` below as `sync.mjs --mirror`.

`sync.mjs --mirror` reads the satellite's CRHQ-resident components from the DB and writes them back
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

## 12. Remote — the Ai1 Platform Hub client (`remote.mjs`)

`remote.mjs` is the satellite's side of the **Ai1 Platform Hub** (read-only reference in
`ai1-platform-hub/`): a node *registers* with the hub, then polls its configuration, reports its
state, takes management instructions, and downloads packages. Unlike install/backup it is a
**subcommand** CLI (`remote.mjs <subcommand>`) — the hub has several distinct verbs — and it is
**DB-free and network-only**: the hub is reached over HTTPS with Node's built-in `fetch` (zero
runtime deps, D-6), so it needs no sandbox. Module: `lib/remote.mjs`, entry `remote.mjs` (the
install/backup split). Decisions: D-36..D-39.

- **`register` (D-37):** `POST {hub}/remote/register` with the hub's bootstrap-token self-enroll
  contract. The hub authenticates the enrollment with a shared **bootstrap token**, then either
  self-enrolls a fresh `remote_id` (`∅→registered`, awaiting operator approval) or claims an
  admin-pre-created slot (`pending→active`), minting a **per-remote token** (`<remote_id>.<secret>`)
  returned exactly once. Inputs resolve **flag → env**: hub `--hub=`/`AI1_HUB_URL`, bootstrap
  `--token=`/`AI1_BOOTSTRAP_TOKEN`, `remote_id` `--remote-id=`/`SATELLITE_ID`/hostname-minus-`crhq-`
  (the D-27 identity convention); `remote_type` defaults to `crhq-satellite`, `schema_version` to `1`.
- **Identity store (D-38):** the minted token + identity are persisted to `${REMOTE_BASE_DIR}/id.json`
  (env, default `~/remote`; for development export `REMOTE_BASE_DIR=$(pwd)`), written atomically
  (temp+rename) at mode `0600` — it holds a credential the hub returns only once. Fields:
  `remote_id, token, remote_type, schema_version, hub_url, registered_at`. The lifecycle `status`
  is **not** stored (hub-owned, mutated server-side on approve/reset/revoke) — only surfaced.
- **Safety (D-39):** registration refuses to overwrite an existing `id.json` without `--force`
  (re-registering would discard the only copy of the token, and the hub 409s it anyway). Hub
  rejections map to actionable messages — `401` (bad bootstrap), `409` (cannot register, reset
  hint), unreachable host — all exit 1; option/usage errors exit 2 (strict per-subcommand
  validation, mirroring §5).
- **To follow:** config/state poll (`GET /remote/config`, `PUT /remote/state`), management
  instructions, and package download — each a further subcommand using the stored per-remote token.

## 13. Polaris — the GitHub Client-Repository client (`polaris.mjs`)

`polaris.mjs` manages a satellite from its **GitHub Client Repository** — the parent–client model in
[`repo-methodology.md`](./repo-methodology.md). That repo pairs a `platform/` directory (an Ai1
Package fed from the shared platform **parent** via git subtree) with a `user/` directory (an Ai1
Package of this satellite's own customer/user content). polaris is the bridge between that repo and
the live satellite: `install.mjs <repo>/platform` + `install.mjs <repo>/user` load content in,
`sync.mjs --mirror <repo>/user` pushes live user edits back out to the `user/` package only.

Like `remote.mjs` it is a **subcommand** CLI and **DB-free** — but instead of `fetch`, it shells out
to `git`, and it reuses the hub client's `fetchGithubToken()` for auth (no new network code). Module
`lib/polaris.mjs`, entry `scripts/polaris.mjs`; no sandbox. First subcommand `init` (D-45/D-46):

- **Inputs:** **owner** `--owner=` → `AI1_GITHUB_OWNER` → the `MyZone-AI` default; **repo** `--repo=`
  → `satellitePackageName()` (D-43). Both charset-guarded (`[A-Za-z0-9._-]`, no bare `.`/`..`) so they
  can't escape `REPOS_BASE_DIR` or steer the URL off `github.com/<owner>/<repo>`. Clone root =
  `${REPOS_BASE_DIR:-~/repos}`; dest = `${REPOS_BASE_DIR}/<repo>`; remote = `https://github.com/<owner>/<repo>.git`.
- **Flow:** ensure `REPOS_BASE_DIR` exists → **refuse if `dest` exists** (no `--force`; checked
  *before* the token call, so an existing checkout fails fast with no network) → resolve the GitHub
  token (`fetchGithubToken()`, the same per-remote token `remote.mjs github-token` prints — the
  satellite must be registered first) → `git clone` the **default branch**.
- **Credential handling (D-46):** the token is injected via git's **env-based config**
  (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`, git ≥ 2.31) as a host-scoped
  `http.https://github.com/.extraheader` HTTP Basic header — **not** in the URL, **not** in argv. So
  the token never appears in `ps` and is never persisted to the cloned `.git/config`; `origin` is left
  as the clean tokenless URL. `GIT_TERMINAL_PROMPT=0` makes a bad/missing token fail fast. The token
  and header are never logged/echoed (incl. `--json`).
- **Errors:** `PolarisError` (existing checkout, git failure) and `RemoteError` (token resolution) →
  exit 1; `UsageError` → exit 2; strict per-subcommand option validation (mirroring §5). Tested
  DB-free in `tests/polaris.test.mjs` (injected token/git for the wiring + a real-git `file://`
  integration clone proving the spawn path and clean origin).
- **To follow:** further verbs (pull/update an existing checkout, push synced `user/` changes, manage
  the `platform/` subtree) — each a subcommand reusing the same token + git plumbing.
