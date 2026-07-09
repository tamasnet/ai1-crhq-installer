# Ai1 Package manifest specification v1.0

An Ai1 Package is an installable directory tree. Its root contains `ai1-package.yaml`, which explicitly lists every component the installer should manage.

The manifest is the source of truth. Files that exist in the package but are not listed under `components` are ignored.

## Package layout

```text
<package>/
├── ai1-package.yaml
├── README.md                    # optional human instructions
├── skills/<skill-key>/
│   ├── SKILL.md
│   └── scripts/                 # optional skill assets/scripts
├── recipes/<recipe-name>.md
├── agents/<agent-key>/
│   ├── AGENTS.md
│   └── ...                      # optional brain files
├── jobs/<job-name>.yaml
├── services/<service-name>/
│   ├── service.yaml
│   └── ...                      # service source
├── projects/<project-name>/
│   ├── project.yaml
│   └── ...                      # git-managed project source
└── scripts/install.mjs          # optional install_entry hook
```

A package may contain any subset of component types, but `components` must be present in the manifest.
Manifest component keys are plural (`skills`, `recipes`, etc.). CLI `--type` filters use singular
values (`skill`, `recipe`, etc.).

## Manifest schema

```yaml
name: my-package                 # required package identifier
version: 1                       # required package release label; string or number accepted
description: Package summary.    # required
installer: 1                     # optional minimum ai1-satellite-tools installer version

components:
  skills:
    - path: skills/my-skill
      version: 1                 # required positive integer; must match SKILL.md version
      install_type: org          # optional: org (default, locked) or user (unlocked)
      handling: normal           # optional: normal (default) | removed | optional
      protect: ['!config']       # optional: extend/trim the protected-names set (see Component protect)
  recipes:
    - path: recipes/my-recipe.md
      version: 1                 # optional positive integer
  agents:
    - path: agents/my-agent
      version: 1                 # optional positive integer
  jobs:
    - path: jobs/my-job.yaml
  services:
    - path: services/my-service
      version: 1                 # required positive integer; must match service.yaml version
  projects:
    - path: projects/my-project
      version: 1                 # required positive integer; must match project.yaml version

install_entry: scripts/install.mjs
install_flags:
  - name: --skip-extra
    description: Package-specific flag forwarded to install_entry.
```

### Required fields

| Field | Required | Notes |
|-------|----------|-------|
| `name` | yes | Package name. |
| `version` | yes | Package release label. It is not a component version. |
| `description` | yes | Package summary. |
| `components` | yes | Mapping of component type to list of entries. |
| `installer` | no | Positive integer minimum installer version; current installer version is `1`. |
| `install_entry` | no | Package-specific hook run after declarative install/status/uninstall. |
| `install_flags` | no | Package-specific flags accepted by `install.mjs` and forwarded to `install_entry`. |

Unknown component types are invalid. Unknown top-level metadata is tolerated by YAML parsing but ignored by the installer.

### Component versions

Component versions are positive integers.

| Component | Version rule |
|-----------|--------------|
| Skill | Required in manifest and `SKILL.md`; values must match. Recorded in `skill_versions`. |
| Recipe | Optional in manifest/frontmatter; if both are present, values must match. Recorded in `recipe_versions` when present. |
| Agent | Optional in manifest/`AGENTS.md`; if both are present, values must match. Recorded in `agent_versions` when present. |
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
| `removed` | no-op, unless `--removed` → **remove** | no-op, unless `--removed` → **remove** | Tombstone for a component no longer shipped in the package. |
| `optional` | skipped, unless `--optional` → install | remove (no flag required) | Opt-in component. Uninstall and status treat it like a normal component. |

```yaml
components:
  skills:
    - path: skills/legacy-skill     # files may be deleted from the package
      handling: removed             # version pin not required for a tombstone
      name: legacy-skill            # optional: override the name derived from the path basename
    - path: skills/beta-skill
      version: 1
      handling: optional
```

`handling: removed` is for retiring a component cleanly across a fleet. When a skill is dropped from a package, leaving a tombstone entry lets the next `--removed` install delete the now-orphaned component from satellites that still have it. Because the component's files may already be gone, a `removed` entry is **not** loaded from disk and needs **no** version pin — the installer only needs the component's name. The name is the entry's explicit `name` when given, otherwise the path basename (with the extension stripped for single-file recipes/jobs).

Activating flags (`install.mjs`):

| Flag | Effect |
|------|--------|
| `--removed` | Act on `handling: removed` entries: remove those components on both install and uninstall (and report their live state under `--status`). |
| `--optional` | Also install `handling: optional` entries on an install run. Not needed for uninstall. |

Components skipped by their handling mode are reported with a `SKIPPED` verdict (exit-code neutral) so they remain visible in the run summary and `--json` output.

### Component protect

Every component entry may carry an optional `protect` list: simple glob patterns (`*` matches any run of characters, `?` one character; everything else is literal) matched against **top-level** names in the component's install/live directory — never nested elements or full paths. A protected name is treated as runtime state, not package content:

- a `--strict` install never deletes it from the install target (protected directories are skipped entirely, contents unexamined);
- `sync` / `sync --mirror` never export it into the package.

Install **copy** is unaffected: a package that ships a file/dir with a protected name installs it as one-way seed data — copied in, then never pruned or synced afterward. The installer warns when a package ships protected names so this is deliberate.

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
        - '!config'      # this service ships a real config/ directory — sync + strict-prune it
        - 'sessions'     # extra runtime dir to preserve
```

`protect` applies to skills, agents, and copy-mode services/projects (the component types with a managed file tree). Symlink-mode projects need no protection — the deployed path is the package source itself.

## Components

### Skill: `skills/<key>/SKILL.md`

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

The Markdown body becomes `skills.content`. The whole skill directory is copied to `SKILLS_BASE_DIR/<name>`. `install_type: org` registers a locked org skill. `install_type: user` registers an unlocked user skill. `--install-skills-as-user` overrides every skill entry to `user`.

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

### Agent: `agents/<key>/AGENTS.md`

Agents are directory components. `AGENTS.md` configures the DB row and supplies the agent instructions; sibling files are copied as the agent's brain.

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

The body becomes `agents.instructions`. Skill links attach only to installed active skills. Recipe links resolve by recipe name. The whole directory copies to `AGENT_BRAINS_DIR/<name>`. Uninstall removes the DB row and joins but preserves the brain folder.

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
port: 4310
build: npm run build
env:
  NODE_ENV: production
app_name: my-service
ssl: true
```

Required fields: `name`, `version`, `start`. Optional fields: `port`, `build`, `env`, `app_name`, `ssl`.

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
port: 4311
build: npm run build
env:
  NODE_ENV: production
app_name: my-project
ssl: true
```

Projects use the same nginx/PM2 schema as services, including the `build` field (a single shell command string or a YAML list run sequentially). A real install creates or updates `/opt/projects/user/<name>` as a symlink to the project directory inside the package, then writes `.env`, `ecosystem.config.cjs`, nginx config, and PM2 state the same way services do. Pass `--copy-projects` to copy the project source into `/opt/projects/user/<name>` instead of symlinking. Sandbox mode skips projects. Dry-run renders the plan but skips nginx/PM2 apply; build commands are skipped by default (pass `--run-build` to execute them).

`sync.mjs --add-project=<name>` moves `/opt/projects/user/<name>` into `projects/<name>` inside the package, adds the manifest entry, and replaces the live directory with a symlink. If the live project has no `project.yaml`, a minimal valid default (`name`, `version: 1`, `start: node server.js`) is generated inside the package for the author to edit. Mirror mode never auto-adds projects, and later sync/mirror runs do not export project content; git is the source of truth after the initial add.

## Install entry hook

`install_entry` is for package-specific operations the declarative installer cannot infer. It is run after the declarative pass for install, status, and uninstall. The runner forwards standard flags and declared `install_flags`, and it inherits the same environment (`INSTALL_SCHEMA`, `SKILLS_BASE_DIR`, etc.).

Keep hooks idempotent and make them honor `--dry-run`, `--status`, and `--uninstall`.
