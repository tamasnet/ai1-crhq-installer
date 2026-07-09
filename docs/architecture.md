# Architecture

`ai1-satellite-tools` is both a command-line toolkit and a reusable ESM library for managing satellite resources from Ai1 Packages.

## Product shape

Six CLIs sit on a shared library in `scripts/lib/`:

| CLI | Role | Live dependencies |
|-----|------|-------------------|
| `scripts/install.mjs` | Install/status/uninstall packages; dry-run; sandbox lifecycle; package availability reports. | satellite DB for skills/recipes/agents/jobs; filesystem/nginx/PM2 for services/projects. |
| `scripts/sync.mjs` | Export live satellite state back into a package; `--mirror` makes the package match live state. | satellite DB and installed skill/agent files. |
| `scripts/remote.mjs` | Ai1 Platform Hub client: register, config, heartbeat, install-state push, GitHub token, package download. | Network only. |
| `scripts/action.mjs` | Process queued hub actions from `${REMOTE_BASE_DIR}/actions.json`; `pull-config`, `push-install`, `install-package`, and `drift-report`. | Network only through remote client calls; `install-package` then invokes the local installer. |
| `scripts/drift.mjs` | Read-only drift report: compare install-log components against source packages; list orphans. | satellite DB, filesystem, local package stores. |
| `scripts/diff.mjs` | Read-only package diff: compare a package's components against live equivalents (DB fields, links, files), install-log independent. | satellite DB, filesystem. |
| `scripts/polaris.mjs` | GitHub Client Repository clone helper. | Network + local `git`; uses hub-provided GitHub token. |

The library barrel is `scripts/lib/index.mjs`. Package hooks can import reusable functions from the installed skill path when they need custom behavior.

## Managed resource model

| Type | Package source | Live target | Version source |
|------|----------------|-------------|----------------|
| Skill | `skills/<key>/SKILL.md` + directory assets | `skills` row + `SKILLS_BASE_DIR/<key>` | `skill_versions.version_num` |
| Recipe | `recipes/<name>.md` | `recipes` row | `recipe_versions.version_num` when declared |
| Agent | `agents/<key>/AGENTS.md` + brain files | `agents`, joins, `AGENT_BRAINS_DIR/<key>` | `agent_versions.version_num` when declared |
| Job | `jobs/<name>.yaml` | `background_jobs` row | unversioned |
| Service | `services/<name>/service.yaml` + source | `${SERVICES_BASE_DIR:-~/services}/<name>`, nginx, PM2 | `service.yaml`/manifest only |
| Project | `projects/<name>/project.yaml` + source | `/opt/projects/user/<name>` symlink/copy, nginx, PM2 | `project.yaml`/manifest only |

DB-managed resources are written through knex, not REST, so sandbox mode can redirect all writes to an isolated schema. Services and projects are host resources and are skipped in sandbox mode.

## Install flow

```text
install.mjs <package> [flags]
  -> handle --help / --list-installed / --list-available
  -> load ai1-package.yaml and component files
  -> validate CLI flags, including package-specific install_flags
  -> provision sandbox if requested
  -> create context: flags, env, DB, logger, paths
  -> preflight DB and writable install base
  -> run ordered plan: skills -> recipes -> agents -> jobs -> services -> projects
  -> run optional install_entry hook
  -> update install log when appropriate
  -> report and close DB
```

Uninstall uses the reverse component order. Status is read-only. Dry-run records intended changes without DB/filesystem writes; service/project build commands are skipped unless `--run-build` is passed, and nginx/PM2 apply is always skipped.

## Sync flow

`sync.mjs` is the reverse direction: live satellite -> package directory.

### Plain sync

- The existing manifest is the authority.
- Components listed in `ai1-package.yaml` are exported from the live satellite into their package paths.
- `--add-skill`, `--add-recipe`, `--add-agent`, and `--add-job` register additional live DB components in the manifest and export them.
- `--add-project` moves `/opt/projects/user/<name>` into the package, adds a project entry, and leaves `/opt/projects/user/<name>` as a symlink to the package.
- No manifest entries are removed.
- Package-level `version` is not changed.

### Mirror sync

`--mirror` makes the package match the live satellite within the requested scope.

- Auto-adds live user skills, active recipes, non-system active agents, and non-system jobs.
- Syncs listed components that still exist live.
- Removes in-scope manifest entries whose live component is gone.
- Preserves live skill `install_type` unless `--normalize` is passed.
- Increments the package-level integer `version` only if package content changed.
- Returns an install-log delta that the CLI applies to `${PACKAGES_DIR}/install.json`.
- Services and projects are never auto-added by mirror. Existing project entries are left for git to manage.

Both sync modes edit the package in place and require the destination to be inside a git work tree unless `--force` is used.

## Install log and local package stores

The install log is `${PACKAGES_DIR:-~/packages}/install.json`. It stores install-level metadata plus a flat component list with one slot per component identity (`type:name`):

```json
{
  "install_version": 12,
  "install_changed_at": "2026-06-28T00:00:00.000Z",
  "installed_components": [
    {
      "type": "skill",
      "name": "my-skill",
      "version": 1,
      "package": "my-package",
      "package_version": "1",
      "source": "skills/my-skill/SKILL.md",
      "installed_at": "..."
    }
  ]
}
```

`install_version` increments, and `install_changed_at` updates, only when the `installed_components` state changes. Legacy flat-array logs remain readable and are upgraded on the next actual install-state change.

`install.mjs --list-installed` reads this log only. `install.mjs --list-available` scans:

- `${PACKAGE_BASE_DIR:-~/packages}` for downloaded packages.
- `${REPOS_BASE_DIR:-~/repos}` for Client Repository packages under `platform/` and `user/`.

It cross-references package manifests with the install log and reports `available`, `installed`, or `missing` per component/version.

## Key modules

```text
scripts/
├── install.mjs, sync.mjs, remote.mjs, action.mjs, polaris.mjs
└── lib/
    ├── index.mjs              # public export surface
    ├── context.mjs            # flag/env resolution and runtime context
    ├── db.mjs                 # knex access and optional schema/searchPath
    ├── manifest.mjs           # manifest/component parsing and validation
    ├── run.mjs                # ordered install/status/uninstall dispatch
    ├── sync.mjs               # package export and mirror reconciliation
    ├── remote.mjs             # hub protocol client
    ├── action.mjs             # queued hub action processor
    ├── polaris.mjs            # GitHub clone helper
    ├── sandbox.mjs            # isolated schema/filesystem lifecycle
    ├── install-log.mjs        # install.json read/write/report helpers
    ├── list-available.mjs     # local package store scanner
    ├── version-history.mjs    # satellite *_versions table round-trip
    ├── parse.mjs              # frontmatter/YAML helpers
    ├── fs.mjs                 # copy/write/remove/diff helpers
    ├── protect.mjs            # protected-names matcher (strict prune + sync export skips)
    ├── diff.mjs               # package → live component diff
    ├── flags.mjs              # strict option validation
    ├── filter.mjs             # include/exclude matching
    ├── identity.mjs           # satellite id -> package name helpers
    ├── core/                  # per-component install/remove/status/export primitives
    └── vendor/yaml.mjs        # vendored YAML parser
```

## Configuration

| Variable | Default | Used for |
|----------|---------|----------|
| `SKILLS_BASE_DIR` | `<satellite-root>/user-skills` | Installed skill directories. |
| `AGENT_BRAINS_DIR` | `<satellite-root>/documents/agent-brains` | Installed agent brain directories. |
| `INSTALL_SCHEMA` | unset | Optional DB schema/search path; sandbox sets it. |
| `PACKAGES_DIR` | `~/packages` | Install log and package store default. |
| `PACKAGE_BASE_DIR` | `~/packages` | `remote.mjs get-package` extraction base and availability scan. |
| `SERVICES_BASE_DIR` | `~/services` | Deployed service copies. |
| `REMOTE_BASE_DIR` | `~/remote` | Hub identity/config/state/action files. |
| `REPOS_BASE_DIR` | `~/repos` | Client Repository checkout base. |

`remote.mjs heartbeat` refreshes `${REMOTE_BASE_DIR}/state.json` with `install_version` and `install_changed_at` from `${PACKAGES_DIR}/install.json` before it reports state to the hub.

The optional cron helper `scripts/heartbeat-actions.sh` chains heartbeat with `action.mjs` when
`actions.json` has queued items; it requires `jq` on `PATH`.

`remote.mjs push-install` sends the full normalized `${PACKAGES_DIR}/install.json` state to the hub with `PUT /remote/install`.

`action.mjs` reads `${REMOTE_BASE_DIR}/actions.json`, processes actions in order, and writes the
file after every action. Successful actions are removed. On failure, processing stops and the failed
action remains with `status: "error"`, `error_message`, `error_at`, and `attempts`. `--limit=<n>`
caps the number processed; `--dry-run` validates and reports the selected actions without side
effects or queue mutation; `--json` returns a machine-readable summary. `install-package` actions
download a registered package via `remote.mjs get-package`, then call `install.mjs` on the extracted
package; `install_type`, `install_include`, and `install_exclude` map to `--type`, `--include`, and
`--exclude`, while boolean `install_optional` maps to `--optional`.

Legacy `CRHQ_BASE_DIR` and `SANDBOX_SCHEMA` fallbacks remain for existing harnesses.

## Services and projects

Services and projects are deployed inline by `core/service.mjs`:

1. Run optional `build` command.
2. For services, copy source to `${SERVICES_BASE_DIR:-~/services}/<name>`. For projects, symlink `/opt/projects/user/<name>` to the package project directory by default, or copy there with `--copy-projects`.
3. Write `.env` with `PORT`, `NODE_ENV`, and declared env values; set mode `0640`.
4. Write `ecosystem.config.cjs` for PM2.
5. Write nginx vhost under `/etc/nginx/projects.d/<name>.conf` using a localhost upstream.
6. Start/save PM2 and reload nginx.

Safety constraints:

- Services/projects are never modeled in sandbox mode.
- Dry-run never applies nginx/PM2 changes; build commands run only when `--run-build` is passed.
- A service/project named the satellite core service name is refused.
- Secrets are written only to `.env` and never into PM2 config or logs.

## Safety boundaries

- Do not read, modify, copy, or restart satellite core application files. Runtime imports are allowed; source inspection/modification is not.
- Keep package source edits inside the package repo and use git for recovery.
- Run `--dry-run` or `--sandbox --lifecycle` before live installs.
- Treat `sync --mirror` as an in-place package edit; use `--dry-run` first on important repos.
- Treat service/project installs as live host mutations.
