# Ai1 Package manifest specification v2.0

An Ai1 Package is an installable directory tree. Its root contains `ai1-package.yaml`, which explicitly lists every component the installer should manage.

The manifest is the source of truth. Files that exist in the package but are not listed under `components` are ignored.

**Manifest v2** separates DB-backed content (`.md` files) from filesystem assets (optional sibling directories). Requires installer version `2` or later.

## Package layout

```text
<package>/
├── ai1-package.yaml
├── README.md                    # optional human instructions
├── skills/<skill-key>.md        # → skills.content (DB)
├── skills/<skill-key>/          # optional assets (→ SKILLS_BASE_DIR/<key>)
│   └── scripts/
├── recipes/<recipe-name>.md
├── agents/<agent-key>.md        # → agents row + instructions (DB)
├── agents/<agent-key>/          # optional brain files (→ AGENT_BRAINS_DIR/<key>)
├── jobs/<job-name>.yaml
├── services/<service-name>/
│   ├── service.yaml
│   └── ...                      # service source
├── projects/<project-name>/
│   ├── project.yaml
│   └── ...                      # git-managed project source
└── scripts/…                   # optional package before/after hook scripts
```

A package may contain any subset of component types, but `components` must be present in the manifest.
Manifest component keys are plural (`skills`, `recipes`, etc.). CLI `--type` filters use singular
values (`skill`, `recipe`, etc.).

## Manifest schema

```yaml
name: my-package                 # required package identifier
version: 1                       # required package release label; string or number accepted
description: Package summary.    # required
installer: 2                     # optional minimum ai1-satellite-tools installer version

components:
  skills:
    - path: skills/my-skill.md
      version: 1                 # required positive integer; must match .md frontmatter version
      install_type: org          # optional: org (default, locked) or user (unlocked)
      handling: normal           # optional: normal (default) | removed | optional | strict
      protect: ['!config']       # optional: extend/trim the protected-names set (see Component protect)
      before: scripts/pre-skill.mjs   # optional: run before this component's operation
      after: scripts/post-skill.mjs # optional: run after this component's operation
  recipes:
    - path: recipes/my-recipe.md
      version: 1                 # optional positive integer
  agents:
    - path: agents/my-agent.md
      version: 1                 # optional positive integer
  jobs:
    - path: jobs/my-job.yaml
  services:
    - path: services/my-service
      version: 1                 # required positive integer; must match service.yaml version
  projects:
    - path: projects/my-project
      version: 1                 # required positive integer; must match project.yaml version

before: scripts/prepare.mjs
after: scripts/install.mjs
flags:
  - name: --skip-extra
    description: Package-specific flag forwarded to hook scripts.
```

### Required fields

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Package name. |
| `version` | yes | Package release label. It is not a component version. |
| `description` | yes | Package summary. |
| `components` | yes | Mapping of component type to list of entries. |
| `installer` | no | Positive integer minimum installer version; current installer version is `2`. |
| `before` | no | Package script run before declarative install (install mode only). |
| `after` | no | Package script run after declarative install/status/uninstall. |
| `install_entry` | no | Deprecated alias for `after`. |
| `flags` | no | Package-specific flags accepted by `install.mjs` and forwarded to hook scripts. |
| `install_flags` | no | Deprecated alias for `flags`. |

Unknown component types are invalid. Unknown top-level metadata is tolerated by YAML parsing but ignored by the installer.

### Component versions

Component versions are positive integers.

| Component | Version rule |
|-----------|--------------|
| Skill | Required in manifest and `skills/<key>.md`; values must match. Recorded in `skill_versions`. |
| Recipe | Optional in manifest/frontmatter; if both are present, values must match. Recorded in `recipe_versions` when present. |
| Agent | Optional in manifest/`agents/<key>.md`; if both are present, values must match. Recorded in `agent_versions` when present. |
| Job | Not versioned. |
| Service | Required in manifest and `service.yaml`; values must match. |
| Project | Required in manifest and `project.yaml`; values must match. |

The package-level `version` is separate. `sync.mjs --mirror` increments it only when package content changes.

### Component names

Names are used directly as database keys and filesystem path segments, so they are validated at manifest load and a violation rejects the whole package before any write. The package `name` and every component `name` (skill/recipe/agent/job/service/project, plus a `handling: removed` tombstone name) must contain only letters, digits, `.`, `_`, and `-`, and may not be `.` or `..`. This prevents path traversal (a name can never contain `/`).

A service/project `app_name` (the nginx vhost subdomain) is stricter still — a DNS label: letters, digits, and `-` only. When `app_name` is omitted it defaults to `name`.

### Component handling

Every component entry may carry an optional `handling` field that controls whether and how the installer acts on it. It applies to all six component types.

| Value | Install | Uninstall | Notes |
|-------|---------|-----------|-------|
| `normal` (default) | install/update | remove | Assumed when `handling` is omitted. |
| `strict` | install/update (with file-tree pruning) | remove | Same lifecycle as `normal`; skills, agents, and copy-mode services/projects prune extras on install without CLI `--strict`. No effect on recipes/jobs or symlink-mode projects. Does not affect drift/diff. |
| `removed` | no-op, unless `--removed` → **remove** | no-op, unless `--removed` → **remove** | Tombstone for a component no longer shipped in the package. |
| `optional` | skipped, unless `--optional` → install | remove (no flag required) | Opt-in component. Uninstall and status treat it like a normal component. |

```yaml
components:
  skills:
    - path: skills/legacy-skill.md   # files may be deleted from the package
      handling: removed              # version pin not required for a tombstone
      name: legacy-skill             # optional: override the name derived from the path basename
    - path: skills/beta-skill.md
      version: 1
      handling: optional
    - path: skills/tight-skill.md
      version: 1
      handling: strict
      protect: ['!config']
```

`handling: removed` is for retiring a component cleanly across a fleet. When a skill is dropped from a package, leaving a tombstone entry lets the next `--removed` install delete the now-orphaned component from satellites that still have it. Because the component's files may already be gone, a `removed` entry is **not** loaded from disk and needs **no** version pin — the installer only needs the component's name. The name is the entry's explicit `name` when given, otherwise the path basename (with the extension stripped for single-file recipes/jobs).

Activating flags (`install.mjs`):

| Flag | Effect |
|------|--------|
| `--removed` | Act on `handling: removed` entries: remove those components on both install and uninstall (and report their live state under `--status`). |
| `--optional` | Also install `handling: optional` entries on an install run. Not needed for uninstall. |

Components skipped by their handling mode are reported with a `SKIPPED` verdict (exit-code neutral) so they remain visible in the run summary and `--json` output.

### Component hook scripts

Any component entry may declare optional `before` and `after` script paths. They run around that component's declarative operation (`upsert`, `remove`, or `status`) when the component is action-bound this run. Component hooks run even on scoped installs (`--type`, `--include`, `--exclude`) unless `--no-scripts` is passed. A failing component `before` script skips that component's operation; other components continue.

### Component protect

Every component entry may carry an optional `protect` list. Patterns use simple globs: `*` matches any run of characters within one path segment, `?` one character, `**` zero or more segments. Matching is tiered:

| Pattern shape | Matches |
|---|---|
| No `/` (e.g. `data`, `.*`) | Top-level name only |
| Contains `/` (e.g. `scripts/node_modules`) | Anchored path prefix from the component root and all descendants |
| Contains `**` (e.g. `**/node_modules`) | At any depth |

A protected path is treated as runtime state, not package content:

- a `--strict` install never deletes it from the install target (protected directories are skipped entirely, contents unexamined);
- `sync` / `sync --mirror` never export it into the package.

Install **copy** is unaffected: a package that ships a protected path installs it as one-way seed data — copied in, then never pruned or synced afterward. The installer warns when a package ships protected paths so this is deliberate.

Every component starts from the same default set:

```text
.*  _*  activity  memory  data  config  state  uploads  backup  logs  ecosystem.config.cjs
```

The entry's `protect` list extends the defaults. A `!pattern` entry removes that exact pattern from the effective set (literal match on the pattern text, resolved after all additions, so order never matters):

```yaml
components:
  services:
    - path: services/my-api
      version: 1
      protect:
        - '!config'              # this service ships a real config/ directory — sync + strict-prune it
        - 'sessions'              # extra runtime dir to preserve at top level
        - 'scripts/node_modules'  # nested runtime dir under scripts/
        - '**/node_modules'       # any node_modules tree anywhere in the component
```

`protect` applies to skills, agents, and copy-mode services/projects (the component types with a managed file tree). Symlink-mode projects need no protection — the deployed path is the package source itself.

## Components

### Skill: `skills/<key>.md`

```markdown
---
name: my-skill
version: 1
description: Use when an agent needs ...
---

Skill instructions.
```

Required frontmatter:

| Field | Notes |
|-------|-------|
| `name` | Skill key and `skills.name`; max 100 characters. |
| `version` | Positive integer matching `components.skills[].version`. |
| `description` | Discovery text stored in `skills.description`. |

The Markdown body becomes `skills.content`. Optional assets under `skills/<key>/` are copied to `SKILLS_BASE_DIR/<name>`. `install_type: org` registers a locked org skill. `install_type: user` registers an unlocked user skill. `--install-skills-as-user` overrides every skill entry to `user`.

### Recipe: `recipes/<name>.md`

```markdown
---
name: my-recipe
description: Reusable recipe description.
version: 1
---

Recipe content.
```

Required frontmatter: `name`, `description`. Optional: `version`. The body becomes `recipes.content`.

### Agent: `agents/<key>.md`

`agents/<key>.md` configures the DB row and supplies the agent instructions. Optional brain files live under `agents/<key>/`.

```markdown
---
name: my-agent
version: 1
display_name: My Agent
description: Agent summary.
mode: cli
default_model: sonnet
agent_type: orchestrator
icon: "🤖"
provider: claude
system_prompt_path: prompts/main.md
capabilities: [search]
skills: [my-skill]
recipes: [my-recipe]
---

Agent instructions.
```

Required frontmatter: `name`, `display_name`. Optional fields: `version`, `description`, `mode`, `default_model`, `agent_type`, `icon`, `provider`, `system_prompt_path`, `capabilities`, `skills`, `recipes`.

The body becomes `agents.instructions`. Skill links attach only to installed active skills. Recipe links resolve by recipe name. Optional files under `agents/<key>/` copy to `AGENT_BRAINS_DIR/<name>`. Uninstall removes the DB row and joins but preserves the brain folder.

### Job: `jobs/<name>.yaml`

```yaml
name: my-job
description: Runs my task.
schedule: hourly              # alias or raw cron
timezone: UTC
script: my-skill/scripts/run.js
args: --flag=value
timeout_minutes: 30
max_concurrent: 1
skip_if_running: true
enabled: true
requires:
  - my-skill
```

Required fields: `name`, `schedule`, `script`. Schedule aliases: `hourly`, `daily`, `every-15-min`, `every-30-min`. `script` resolves under `SKILLS_BASE_DIR`. `requires` names installed skill directories that must exist before the job is registered; bundle-mate skills count as present during dry-run previews.

### Service: `services/<name>/service.yaml`

```yaml
name: my-service
version: 1
start: node server.js
app_port: 4310
app_deploy: default
build: npm run build
env:
  NODE_ENV: production
app_name: my-service
ssl: true
```

Required fields: `name`, `version`, `start`. Optional fields: `app_port`, `app_deploy`, `build`, `env`, `app_name`, `ssl`.

`app_port` — TCP port the app listens on (written to `.env` as `PORT`). When omitted, the installer auto-allocates from 4300 upward.

`app_deploy` — which host integration steps to run on install/uninstall. Default `default` (nginx vhost + PM2). `none` deploys files and `.env` only; `nginx` writes the vhost and reloads nginx; `pm2` writes `ecosystem.config.cjs` and starts/saves PM2.

`port` is deprecated in favour of `app_port` but still accepted when `app_port` is omitted. If both are set they must match.

`build` accepts a single shell command string or a YAML list of command strings. A list is run sequentially, in order, and fails fast on the first non-zero exit; empty/whitespace entries are ignored. Each command runs through a shell, so a single string can also chain commands with `&&`/`;`.

```yaml
build:
  - npm ci
  - npm run build
```

A real install copies the service source to `${SERVICES_BASE_DIR:-~/services}/<name>`, writes `.env` at mode `0640`, writes `ecosystem.config.cjs`, writes nginx config under `/etc/nginx/projects.d`, starts/saves PM2, and reloads nginx. Sandbox mode skips services. Dry-run renders the plan but skips nginx/PM2 apply; build commands are skipped by default (pass `--run-build` to execute them).

### Project: `projects/<name>/project.yaml`

```yaml
name: my-project
version: 1
start: node server.js
app_port: 4311
app_deploy: default
build: npm run build
env:
  NODE_ENV: production
app_name: my-project
ssl: true
```

Projects use the same nginx/PM2 schema as services, including the `build` field (a single shell command string or a YAML list run sequentially). A real install creates or updates `/opt/projects/user/<name>` as a symlink to the project directory inside the package, then writes `.env`, `ecosystem.config.cjs`, nginx config, and PM2 state the same way services do. Pass `--copy-projects` to copy the project source into `/opt/projects/user/<name>` instead of symlinking. Sandbox mode skips projects. Dry-run renders the plan but skips nginx/PM2 apply; build commands are skipped by default (pass `--run-build` to execute them).

`sync.mjs --add-project=<name>` moves `/opt/projects/user/<name>` into `projects/<name>` inside the package, adds the manifest entry, and replaces the live directory with a symlink. If the live project has no `project.yaml`, a minimal valid default (`name`, `version: 1`, `start: node server.js`) is generated inside the package for the author to edit. Mirror mode never auto-adds projects, and later sync/mirror runs do not export project content; git is the source of truth after the initial add.

## Hook scripts

Package and component entries may declare optional `before` / `after` script paths (relative to the package root). `.mjs`/`.js` run under `node`; other paths run directly (shebang).

| Scope | Field | When |
|-------|-------|------|
| Package | `before` | Install only — after preflight, before any component writes. Failure aborts the run. |
| Package | `after` | After declarative pass + install log — install, uninstall, and status. |
| Component | `before` / `after` | Around that component's operation when it is action-bound this run. |

On scoped runs (`--type`, `--include`, `--exclude`), **package** scripts are skipped unless `--with-package-scripts` (`--with-entry` is a deprecated alias). **Component** scripts still run for matched components. Pass `--no-scripts` to skip all hooks.

Hook subprocesses inherit `INSTALL_SCHEMA`, `SKILLS_BASE_DIR`, etc., plus:

| Variable | Meaning |
|----------|---------|
| `INSTALL_MODE` | `install`, `uninstall`, or `status` |
| `INSTALL_PACKAGE` | `name@version` |
| `INSTALL_DRY_RUN` | `1` or `0` |
| `INSTALL_COMPONENTS` | Space-separated action-bound list: `skill:foo agent:bar` |
| `INSTALL_COMPONENT` | Current component (component hooks): `service:api` |
| `INSTALL_COMPONENT_OP` | Current verb (component hooks): `upsert`, `remove`, or `status` |

The runner forwards standard flags and declared `flags`. Keep hooks idempotent; honor `--dry-run`, `--status`, and `--uninstall`.
