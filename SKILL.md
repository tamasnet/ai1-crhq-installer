---
name: ai1-satellite-tools
version: 1
description: Manage a satellite's resources with Ai1 Packages. Use when an agent needs to install, update, remove, or status-check packaged skills, recipes, agents, background jobs, services, or projects from ai1-package.yaml; sync live satellite edits back into a package; mirror live skill/agent/recipe/job definitions into a version-controllable package with sync --mirror; list installed or available local packages; register the satellite with the Ai1 Platform Hub; pull remote config, send heartbeats, process queued hub actions, download registered packages, resolve the hub-provided GitHub token; or clone the satellite's Polaris customer repository.
---

# Ai1 Satellite Tools

Use this skill to manage a satellite from declarative **Ai1 Packages**. An Ai1 Package is a directory with `ai1-package.yaml` plus component files for skills, recipes, agents, jobs, services, and projects.

The toolkit is DB-direct for satellite resources, nginx/PM2-direct for services/projects, and idempotent.

IMPORTANT: When working with Ai1 Packages you MUST use only tools from this skill. Do not manipulate, download or otherwise work with Ai1 Packages directly. Always display results from `--list-installed` or `--list-available` as a table.

## Command map

Run commands from the skill/project root unless using an installed absolute path.

| Need | Command |
|------|---------|
| Install package | `node scripts/install.mjs <package>` |
| Check package status | `node scripts/install.mjs <package> --status` |
| Uninstall package | `node scripts/install.mjs <package> --uninstall` |
| List installed components | `node scripts/install.mjs --list-installed` |
| List locally available components | `node scripts/install.mjs --list-available` |
| Sync manifest-listed live edits into package | `node scripts/sync.mjs <package-dir>` |
| Add a live component to a package | `node scripts/sync.mjs <package-dir> --add-skill=<name>` |
| Mirror live definitions into package | `node scripts/sync.mjs <package-dir> --mirror` |
| Register with hub | `node scripts/remote.mjs register --hub=<url> --token=<bootstrap>` |
| Unregister locally | `node scripts/remote.mjs unregister` |
| Pull hub config | `node scripts/remote.mjs pull-config` |
| Send heartbeat | `node scripts/remote.mjs heartbeat` |
| Process queued hub actions | `node scripts/action.mjs` |
| Drift report (live vs packages) | `node scripts/drift.mjs` |
| Diff a package against live | `node scripts/diff.mjs <package>` |
| Push install state to hub | `node scripts/remote.mjs push-install` |
| Download registered package | `node scripts/remote.mjs get-package --name=<name> --version=<n>` |
| Clone Polaris customer repository | `node scripts/polaris.mjs init` |

`<package>` may be a directory containing `ai1-package.yaml` or the manifest file path. If omitted for install/status/uninstall, it defaults to `.`.

## Package install workflow

For normal satellite operation, install the package directly:

```bash
node scripts/install.mjs <package>
```

Packages are expected to be built and tested before they are distributed to satellites. Use `--status`
to inspect what is installed, and `--uninstall` only when removing a package's components.

Install order is `skills → recipes → agents → jobs → services → projects`. Uninstall runs in reverse order.

Common install flags:

| Flag | Meaning |
|------|---------|
| `--status` | Report per-component live state. |
| `--uninstall` | Remove package components. Agent brain folders are preserved. |
| `--copy-projects` | For project components, copy source into `/opt/projects/user/<name>` instead of symlinking to the package directory. |
| `--removed` | Act on `handling: removed` tombstone entries — remove those components on both install and uninstall (default: inert). |
| `--optional` | Also install `handling: optional` entries (default: skipped on install; uninstall removes them regardless). |
| `--json` | Emit machine-readable output. |

Development/testing flags:

| Flag | Meaning |
|------|---------|
| `--dry-run` | Preview with no DB writes and no nginx/PM2 apply. Service/project build commands are **skipped** by default; pass `--run-build` to execute them. |
| `--run-build` | With `--dry-run`: run service/project build shell commands (default: skipped, keeping previews side-effect free). |
| `--sandbox` | Provision an isolated DB schema and temp install dirs, then tear them down. For package/installer testing, not normal satellite installs. |
| `--lifecycle` | With `--sandbox`, assert install/status/idempotency/uninstall/reinstall. |
| `--keep` | With `--sandbox`, leave the schema and dirs for inspection. |
| `--type=skill,recipe` | Restrict to component types. Useful for targeted development or repair. |
| `--include=<pattern>` / `--exclude=<pattern>` | Restrict components by name. Plain values are exact matches; regex metacharacters are treated as regex. |
| `--strict` | After copying assets, delete files in the install target not present in the package. Requires `--include`; `--type` is optional (narrows by component type). Applies to skills, agents, and copy-mode services/projects. Protected names (see the `protect` manifest field) are never deleted. Manifest `handling: strict` enables the same pruning for that component without `--strict` or `--include`. |
| `--respect-locks` | Skip locked skills instead of unlocking/updating them. |
| `--install-skills-as-user` | Register all skills as unlocked `user` skills. |

The installer accepts only standard flags plus package-specific flags declared in `install_flags`. Unknown flags fail before side effects.

## Drift report

`drift.mjs` compares the live satellite against install-log entries and their source packages. Read-only.

```bash
node scripts/drift.mjs
node scripts/drift.mjs --json
node scripts/drift.mjs --package=<name>
node scripts/drift.mjs --type=skill,recipe --include='^acme-'
```

Managed drift checks each `install.json` slot against the logged package@version in local package stores (`PACKAGE_BASE_DIR`, `REPOS_BASE_DIR`). States: `in-sync`, `modified`, `absent`, `source-missing`. Orphans are live components (same curation as `sync --mirror`) plus deployed services/projects not attributed in the install log. The report lists every out-of-sync row in one table with VERSION, PACKAGE, SOURCE (manifest path), LOCATION (local package dir), and DETAIL. File comparison is content-only by default; `--strict` also counts mode/mtime-only differences. Exit code 1 when any drift is found.

## Package diff

`diff.mjs` compares one package's components against their live equivalents — DB fields, agent links, versions, and file trees — regardless of how the live component was installed (no install log involved). Read-only.

```bash
node scripts/diff.mjs <package>
node scripts/diff.mjs <package> --type=skill --include='^acme-' --json
```

States: `in-sync`, `differs`, `absent`, `tombstone`. File detail is status-only (no content diffs): `~` modified, `+` package-only (install would add), `-` live-only (a strict install would delete); protected names are set aside and reported. File comparison is content-only by default; `--strict` also reports mode/mtime-only differences, annotated (`(mode 644→755)` package→live, `(mtime)`). `--copy-projects` mirrors the install flag for copy-mode project deploys. Exit code 1 when anything differs.

## Sync and mirror

`sync.mjs` exports live satellite state back into a package directory. It edits the package in place and refuses destinations outside a git work tree unless `--force` is passed.

### Manifest-driven sync

Use this when the package manifest is the authority and you want to pull live edits for components it already lists.

```bash
node scripts/sync.mjs <package-dir>
node scripts/sync.mjs <package-dir> --add-skill=<name>
node scripts/sync.mjs <package-dir> --add-recipe=<name>
node scripts/sync.mjs <package-dir> --add-agent=<name>
node scripts/sync.mjs <package-dir> --add-job=<name>
node scripts/sync.mjs <package-dir> --add-project=<name>
node scripts/sync.mjs <package-dir> --dry-run
node scripts/sync.mjs <package-dir> --type=skill,recipe --include='^acme-'
```

Plain sync never removes manifest entries and never changes the package-level `version`.
When any `--add-*` or `--remove-*` flag is present, only those mutations run — other manifest
entries are not exported. Run plain sync with no mutation flags afterward to sync the rest.
Use `--type`, `--include`, and `--exclude` to export a subset of manifest entries selectively.
`--add-project=<name>` is special: it moves `/opt/projects/user/<name>` into `projects/<name>` inside the package, adds a project manifest entry, and replaces the live directory with a symlink. The live project must not be its own git repository — remove `.git` first so it is a plain directory. If the project has no `project.yaml`, a valid default is generated inside the package. After that, sync/mirror do not export project content; git owns it.

### Mirror sync

Use `--mirror` when the live satellite is the authority and the package should match it exactly — a reinstallable snapshot of the live definitions.

```bash
node scripts/sync.mjs <package-dir> --mirror
node scripts/sync.mjs <package-dir> --mirror --dry-run
node scripts/sync.mjs <package-dir> --mirror --type=skill,recipe --include='^acme-' --json
node scripts/install.mjs <package-dir>   # reinstall the mirrored state
```

Mirror mode:

- Adds live user skills, active recipes, non-system active agents, and non-system jobs missing from the package.
- Syncs existing manifest entries that still exist live.
- Removes in-scope manifest entries whose live component is gone.
- Preserves live skill `install_type` by default; pass `--normalize` to ship distributable org/locked defaults.
- Bumps the package-level integer `version` only when package content changes.
- Reconciles `${PACKAGES_DIR:-~/packages}/install.json` for exactly the components the mirror carries.

Services and projects are not mirrored because they are not DB-resident; projects are added only through `--add-project` and then managed by git.

## Hub client

`remote.mjs` and `action.mjs` are network-only and DB-free. Runtime identity/config/state/actions live under `${REMOTE_BASE_DIR:-~/remote}` with private file permissions.
`heartbeat` refreshes `${REMOTE_BASE_DIR}/state.json` with `install_version` and `install_changed_at`
from `${PACKAGES_DIR:-~/packages}/install.json` before reporting state to the hub.

```bash
node scripts/remote.mjs register --hub=<url> --token=<bootstrap>
node scripts/remote.mjs unregister
node scripts/remote.mjs pull-config
node scripts/remote.mjs heartbeat
node scripts/action.mjs
node scripts/action.mjs --limit=1
node scripts/action.mjs --dry-run
node scripts/remote.mjs push-install
node scripts/remote.mjs github-token
node scripts/remote.mjs get-package --name=<name> --version=<n>
node scripts/remote.mjs get-package --name=<name> --version=<n> --keep-download
```

`get-package` downloads a registered package archive (`.tar.gz` or `.tgz`), verifies an optional hub-provided `digest`
(sha256 hex) when present, extracts to `${PACKAGE_BASE_DIR:-~/packages}/<name>@<version>`, and
deletes the download by default. Pass `--keep-download` to retain the archive in
`${DOWNLOAD_BASE_DIR:-$TMPDIR}`.

The cron helper `scripts/heartbeat-actions.sh` runs heartbeat then processes queued actions when
present. It requires `jq` on `PATH` to read `actions.json`.

`action.mjs` reads `${REMOTE_BASE_DIR}/actions.json`, processes queued actions in order, and updates
the file after each action. Successful actions are removed. If an action fails, processing stops and
the failed action is left in place with `status: "error"`, `error_message`, `error_at`, and
`attempts` for troubleshooting. Supported action types are `pull-config`, `push-install`,
`install-package`, `drift-report`, and `diff-package`. `install-package` runs `remote.mjs get-package` using `package_name` and
`package_version`, then runs `install.mjs` on the downloaded package. Optional `install_type`,
`install_include`, `install_exclude`, and boolean `install_optional` map to install flags `--type`,
`--include`, `--exclude`, and `--optional`. `drift-report` runs `drift.mjs --json` and completes
with `{ type: "drift-report", data: <drift report> }`. `diff-package` runs the same logic as
`diff.mjs --json` for `package_name`/`package_version`. By default it uses a local package at
`${PACKAGE_BASE_DIR}/<name>@<version>`; when absent, completes with
`{ ok: false, message: "…not available locally…" }` unless boolean `diff_get_package` is true (then
fetches via `get-package` first). Optional `diff_type`, `diff_include`, `diff_exclude`, boolean
`diff_strict`, and boolean `diff_copy_projects` mirror `diff.mjs` flags. Completes with
`{ type: "diff-package", data: <diff report> }`.
Pass `--dry-run` to validate and report queued actions without performing network/install side
effects and without updating `actions.json`.

Never print or persist hub tokens, bootstrap tokens, signed URLs, or GitHub tokens outside the tool's intended secure files/stdout contract.

## Polaris client

`polaris.mjs` clones the satellite's GitHub customer repository into `${REPOS_BASE_DIR:-~/repos}/<repo>` using the GitHub token resolved from the hub identity.

```bash
node scripts/polaris.mjs init
node scripts/polaris.mjs init --owner=MyZone-AI --repo=ai1-example
node scripts/install.mjs ~/repos/<repo>/platform
node scripts/install.mjs ~/repos/<repo>/user
node scripts/sync.mjs ~/repos/<repo>/user --mirror
```

`init` refuses to overwrite an existing checkout.

## Ai1 Package shape

Minimal manifest:

```yaml
name: my-package
version: 1
description: Package description.
installer: 1
components:
  skills:
    - path: skills/my-skill
      version: 1
      install_type: org
  recipes:
    - path: recipes/my-recipe.md
      version: 1
  agents:
    - path: agents/my-agent
      version: 1
  jobs:
    - path: jobs/my-job.yaml
  services:
    - path: services/my-service
      version: 1
  projects:
    - path: projects/my-project
      version: 1
install_entry: scripts/install.mjs
install_flags:
  - name: --skip-extra
    description: Package-specific flag forwarded to install_entry.
```

Component files:

- Skill: `skills/<key>/SKILL.md` with frontmatter `name`, `version`, `description`; body becomes `skills.content`; directory assets are copied to `SKILLS_BASE_DIR/<key>`.
- Recipe: `recipes/<name>.md` with frontmatter `name`, `description`, optional `version`; body becomes `recipes.content`.
- Agent: `agents/<key>/AGENTS.md` with frontmatter `name`, `display_name`, optional config/links/version; body becomes `agents.instructions`; the whole directory copies to `AGENT_BRAINS_DIR/<key>`.
- Job: `jobs/<name>.yaml` with `name`, `schedule`, `script`; scripts resolve under `SKILLS_BASE_DIR`.
- Service: `services/<name>/service.yaml` with `name`, `version`, `start`; source copies to `$SERVICES_BASE_DIR/<name>`, with `.env`, PM2, and nginx generated by the installer.
- Project: `projects/<name>/project.yaml` with the same fields as a service; source symlinks to `/opt/projects/user/<name>` by default (or copies with `--copy-projects`), with `.env`, PM2, and nginx generated by the installer.

Component versions are positive integers. Skills, services, and projects require them. Recipes and agents can carry them. Jobs are unversioned.

Any component entry may also carry an optional `handling` field: `normal` (default — install/uninstall as usual), `strict` (same lifecycle as normal, but file-tree components prune extras on install — no CLI flag needed; no effect on recipes/jobs or symlink projects; does not affect drift/diff), `removed` (a tombstone for a dropped component — inert unless `--removed`, which removes it on both install and uninstall), or `optional` (skipped on install unless `--optional`; uninstall is normal). A `removed` tombstone needs no version pin and is not read from disk, since its files may already be gone.

Any component entry may also carry an optional `protect: []` list — simple glob patterns (`*`/`?`) matched against **top-level** names in the component's install/live directory. Protected names are never deleted by a `--strict` install and never exported by sync, so runtime state survives both directions. Every component gets the defaults (`.*`, `_*`, `activity`, `memory`, `data`, `config`, `state`, `uploads`, `backup`, `logs`, `ecosystem.config.cjs`); the entry's list extends them, and a `!pattern` entry removes that exact default (e.g. `protect: ['!config']` for a component that ships a real `config/` directory). Install copy is unaffected: a package that ships a protected name installs it once as one-way seed data (warned at install, then never pruned or synced).

Full package spec: `docs/package-manifest-spec.md`.

## Environment

| Variable | Meaning |
|----------|---------|
| `SKILLS_BASE_DIR` | Parent dir for installed skill folders. Default `<satellite-root>/user-skills`. |
| `AGENT_BRAINS_DIR` | Parent dir for installed agent brain folders. Default `<satellite-root>/documents/agent-brains`. |
| `INSTALL_SCHEMA` | Optional Postgres schema/search path for DB writes. Sandbox sets this. |
| `PACKAGES_DIR` / `PACKAGE_BASE_DIR` | Package store and install log base. Defaults to `~/packages`. |
| `SERVICES_BASE_DIR` | Parent dir for deployed service copies. Defaults to `~/services`. |
| `REPOS_BASE_DIR` | Clone base for Git repos, including the Polaris customer repository. Defaults to `~/repos`. |
| `REMOTE_BASE_DIR` | Hub client identity/config/state/action base. Defaults to `~/remote`. |

## Safety rules

- Do not read, edit, copy, or restart satellite core application files. The tool imports the satellite knex module at runtime; that does not make the core files editable.
- For normal package installs, use `node scripts/install.mjs <package>`. Use `--dry-run` or `--sandbox --lifecycle` when developing packages, testing the installer, or diagnosing a risky install.
- Treat service/project installs as live host mutations. Services write `$SERVICES_BASE_DIR/<service>`; projects write `/opt/projects/user/<project>`; both write `/etc/nginx/projects.d/<name>.conf` and PM2 state.
- Never deploy or remove a service/project named the satellite core service name.
- Never echo credentials. Service secrets belong only in the generated `.env`; hub/GitHub tokens are credentials.
