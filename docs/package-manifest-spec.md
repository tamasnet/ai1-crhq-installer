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

The Markdown body becomes `skills.content`. The whole skill directory is copied to `INSTALL_BASE_DIR/<name>`. `install_type: org` registers a locked org skill. `install_type: user` registers an unlocked user skill. `--install-skills-as-user` overrides every skill entry to `user`.

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
icon: "🤖"
provider: claude
system_prompt_path: prompts/main.md
capabilities: [search]
skills: [my-skill]
recipes: [my-recipe]
---

Agent instructions.
```

Required frontmatter: `name`, `display_name`. Optional fields: `version`, `description`, `mode`, `default_model`, `icon`, `provider`, `system_prompt_path`, `capabilities`, `skills`, `recipes`.

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

Required fields: `name`, `schedule`, `script`. Schedule aliases: `hourly`, `daily`, `every-15-min`, `every-30-min`. `script` resolves under `INSTALL_BASE_DIR`. `requires` names installed skill directories that must exist before the job is registered; bundle-mate skills count as present during dry-run previews.

### Service: `services/<name>/service.yaml`

```yaml
name: my-service
version: 1
start: node server.js
port: 4310
build: npm run build
env:
  NODE_ENV: production
nginx:
  subdomain: my-service
  ssl: true
```

Required fields: `name`, `version`, `start`. Optional fields: `port`, `build`, `env`, `nginx.subdomain`, `nginx.ssl`.

A real install copies the service source to `${SERVICES_BASE_DIR:-~/services}/<name>`, writes `.env` at mode `0640`, writes `ecosystem.config.cjs`, writes nginx config under `/etc/nginx/projects.d`, starts/saves PM2, and reloads nginx. Sandbox mode skips services. Dry-run runs the build command and renders the plan but skips nginx/PM2 apply.

### Project: `projects/<name>/project.yaml`

```yaml
name: my-project
version: 1
start: node server.js
port: 4311
build: npm run build
env:
  NODE_ENV: production
nginx:
  subdomain: my-project
  ssl: true
```

Projects use the same nginx/PM2 schema as services. A real install creates or updates `/opt/projects/user/<name>` as a symlink to the project directory inside the package, then writes `.env`, `ecosystem.config.cjs`, nginx config, and PM2 state the same way services do. Pass `--copy-projects` to copy the project source into `/opt/projects/user/<name>` instead of symlinking. Sandbox mode skips projects. Dry-run runs the build command and renders the plan but skips nginx/PM2 apply.

`sync.mjs --add-project=<name>` moves `/opt/projects/user/<name>` into `projects/<name>` inside the package, adds the manifest entry, and replaces the live directory with a symlink. Mirror mode never auto-adds projects, and later sync/mirror runs do not export project content; git is the source of truth after the initial add.

## Install entry hook

`install_entry` is for package-specific operations the declarative installer cannot infer. It is run after the declarative pass for install, status, and uninstall. The runner forwards standard flags and declared `install_flags`, and it inherits the same environment (`INSTALL_SCHEMA`, `INSTALL_BASE_DIR`, etc.).

Keep hooks idempotent and make them honor `--dry-run`, `--status`, and `--uninstall`.
