# Satellite integration reference

This document maps Ai1 Package components to satellite storage. The installer writes satellite resources directly through knex so sandbox mode can redirect writes to an isolated schema.

Package and component names are validated at manifest load before any of the writes below happen — see "Component names" in [`package-manifest-spec.md`](./package-manifest-spec.md) for the allowed character set.

## Database access

All DB work goes through `scripts/lib/db.mjs`, which imports the satellite knex accessor at runtime and applies `INSTALL_SCHEMA` as an optional search path. Do not read or modify satellite core application source files; the import path is a runtime dependency only.

`preflight()` verifies DB reachability before install/uninstall work.

## Tables managed

| Table | Purpose |
|-------|---------|
| `skills` | Skill registry rows. |
| `skill_versions` | Version snapshots for skills. |
| `recipes` | Recipe content rows. |
| `recipe_versions` | Version snapshots for recipes. |
| `agents` | Agent personas/configuration. |
| `agent_versions` | Version snapshots for agents. |
| `agent_skills` | Agent-to-skill links. |
| `agent_recipes` | Agent-to-recipe links. |
| `background_jobs` | Scheduled script jobs. |

The sandbox creates an isolated schema and clones these table shapes from live with `CREATE TABLE ... LIKE ... INCLUDING ALL`.

## Component mappings

File copies are additive by default. With `--strict` (requires `--include`), installs also delete target files absent from the package; protected names (manifest `protect` + defaults — see the spec's "Component protect") always survive both strict prune and sync export. When a skill or agent has no package asset directory, strict install still prunes the live tree (same as an empty asset tree).

### Skill

Source: `skills/<key>.md` and optional `skills/<key>/` assets.

Install behavior:

- Parse frontmatter `name`, `version`, `description`; body becomes `skills.content`.
- Upsert `skills` by `name`.
- Set `skill_path` to `db://skills/<name>`.
- Set `skill_dir` to `SKILLS_BASE_DIR/<name>`.
- Default to `skill_type='org'` and `locked=true`.
- Use `skill_type='user'` and `locked=false` for `install_type: user` or `--install-skills-as-user`.
- Copy optional assets from `skills/<key>/` to `skill_dir`.
- Record `skill_versions.version_num` from the component version.

Uninstall removes the DB row, version history, and skill directory unless `--respect-locks` skips a locked row.

### Recipe

Source: `recipes/<name>.md`.

Install behavior:

- Parse frontmatter `name`, `description`, optional `version`; body becomes `recipes.content`.
- Upsert `recipes` by `name`; UUID primary key is database-generated.
- Set `is_active=true`.
- Record `recipe_versions.version_num` when a version is declared.

Agent recipe links resolve recipe names to recipe UUIDs.

### Agent

Source: `agents/<key>.md` and optional `agents/<key>/` brain files.

Install behavior:

- `.md` frontmatter `name` maps to `agents.key`.
- `display_name` maps to `agents.name`.
- Body maps to `agents.instructions` when non-empty.
- Optional frontmatter maps to `description`, `mode`, `default_model`, `agent_type`, `icon`, `provider`, `system_prompt_path`, and `capabilities`.
- Upsert `agents` by `key`, with `is_active=true`.
- Sync `agent_skills` to the declared installed active skill names.
- Sync `agent_recipes` to declared recipe names resolved to UUIDs.
- Copy optional files under `agents/<key>/` to `AGENT_BRAINS_DIR/<key>`; runtime dirs (`memory`, `activity`, …) are protected.
- Record `agent_versions.version_num` when a version is declared.

Uninstall removes the agent row, joins, and version history. It preserves the brain folder because it may contain runtime state.

### Job

Source: `jobs/<name>.yaml`.

Install behavior:

- Required fields: `name`, `schedule`, `script`.
- Schedule aliases expand to cron before storage.
- Insert/update `background_jobs` by `name`.
- New rows get an id shaped like `job-<timestamp>-<random>`.
- Store `job_type='script'`, `script_path='node'`, and `script_args=<SKILLS_BASE_DIR>/<script> [args]`.
- Set timeout/concurrency/enabled fields from YAML or defaults.
- Validate `requires` by checking required installed skill directories before writes.

Jobs are unversioned.

### Service

Source: `services/<name>/service.yaml` and service source tree.

Install behavior:

- Required fields: `name`, `version`, `start`.
- Optional `build` runs before apply. It is a single shell command string or a YAML list of commands run sequentially (fail-fast on the first non-zero exit). During dry-run, build commands are skipped by default (pass `--run-build` to execute them).
- Copy source to `${SERVICES_BASE_DIR:-~/services}/<name>`.
- Write `.env`, `ecosystem.config.cjs`, and nginx vhost.
- Bind nginx upstream to `127.0.0.1:<port>`.
- Start/save PM2 and reload nginx.

Services are not DB-resident and are not exported by `sync.mjs`.

### Project

Source: `projects/<name>/project.yaml` and project source tree.

Install behavior:

- Required fields: `name`, `version`, `start`.
- Optional `build` runs before apply. It is a single shell command string or a YAML list of commands run sequentially (fail-fast on the first non-zero exit). During dry-run, build commands are skipped by default (pass `--run-build` to execute them).
- By default, create/update `/opt/projects/user/<name>` as a symlink to the package project directory.
- With `--copy-projects`, copy source to `/opt/projects/user/<name>` instead.
- Write `.env`, `ecosystem.config.cjs`, and nginx vhost.
- Bind nginx upstream to `127.0.0.1:<port>`.
- Start/save PM2 and reload nginx.

Projects are not DB-resident. `sync.mjs --add-project=<name>` moves the live `/opt/projects/user/<name>` directory into the package and replaces it with a symlink; mirror mode never auto-adds projects, and later sync/mirror runs do not export project content.

## Version history

`version-history.mjs` stores positive integer component versions in satellite version tables:

| Component | Table | Entity key | Body snapshot column |
|-----------|-------|------------|----------------------|
| Skill | `skill_versions` | `skill_name` | `content` |
| Recipe | `recipe_versions` | `recipe_id` | `content` |
| Agent | `agent_versions` | `agent_key` | `instructions` |

On install, the declared component version is upserted. On sync/mirror, the current live version is read as `MAX(version_num)` and written back to the package. A missing skill version history exports as version `1` with a warning. A lower declared version warns but still records.

## Sync/export mappings

`sync.mjs` uses the reverse of the install mappings:

- Skills: regenerate `skills/<key>.md` from the DB row and copy installed skill assets from `skill_dir` except protected names.
- Recipes: regenerate the Markdown file from the DB row.
- Agents: regenerate `agents/<key>.md` from the DB row/joins and copy brain files except protected names.
- Jobs: export only script/node jobs whose script path is under `SKILLS_BASE_DIR`.
- Services: not exported.
- Projects: added only with `--add-project`, then left to git.

Unrepresentable components are reported as skipped rather than exported incorrectly.

## Hook scripts

Packages and components may declare optional `before` / `after` script paths in `ai1-package.yaml`. Hook subprocesses inherit the install environment (`INSTALL_SCHEMA`, `SKILLS_BASE_DIR`, etc.) plus `INSTALL_MODE`, `INSTALL_PACKAGE`, `INSTALL_DRY_RUN`, and `INSTALL_COMPONENTS`. Component hooks also receive `INSTALL_COMPONENT` and `INSTALL_COMPONENT_OP`.

Package `before` runs once before the declarative pass on install only. Package `after` runs after the pass and install-log update on install, uninstall, and status. Component hooks wrap each action-bound component. See the "Hook scripts" section in [`package-manifest-spec.md`](./package-manifest-spec.md) for scoped-run behavior and CLI flags (`--with-package-scripts`, `--no-scripts`).
