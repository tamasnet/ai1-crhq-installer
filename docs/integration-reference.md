# CRHQ Integration Reference — DB schema & manifest mapping

**Authoritative** — the schema below was verified against the live satellite DB
(`columnInfo()` over all 7 tables). The built-in sandbox clones from live (`CREATE TABLE …
LIKE`), so there is no separate DDL to drift.

Resource writes are **DB-direct via knex** (see `canon-conventions.md` C1, C9). REST is
read-only here and not used for installs.

## 1. knex accessor

```js
import { getDb } from '/opt/projects/crhq-satellite/server/db/knex.js';  // hardcoded — C1
const db = getDb();
// ... await db.destroy() on every exit
```
Connection: pg, `DB_HOST` localhost, `DB_PORT` 5433, `DB_USER`/`DB_PASSWORD`/`DB_NAME` from
`.env`. When `INSTALL_SCHEMA` (legacy `SANDBOX_SCHEMA`) is set, the utility's `getDb()`
wrapper applies it as the knex `searchPath`.

## 2. Tables

### `skills` — PK `name` (no `id`)

| Column | Type / default | Notes |
|--------|----------------|-------|
| `name` | varchar(100) PK | unique key; never `.returning('id')` |
| `description` | text | parsed from SKILL.md frontmatter |
| `skill_path` | text **NOT NULL, no default on live** | always set it: **`db://skills/<name>`** (location-independent) |
| `skill_dir` | text | `${INSTALL_BASE_DIR}/<key>` (absolute; `INSTALL_BASE_DIR` = the skill-parent dir) |
| `is_global` | bool default false | installers set false |
| `is_active` | bool default true | |
| `locked`, `locked_at`, `locked_by` | bool/ts/varchar | PG trigger blocks UPDATE on locked rows → unlock first (C5) |
| `content` | text | the SKILL.md body (or full md) |
| `skill_type` | varchar **NOT NULL** default `'system'` | installer default `'org'` + `locked:true`; `install_type: user` / `--install-skills-as-user` → `'user'` + unlocked |
| `created_at`, `updated_at` | timestamptz | set `new Date()` |
| `search_embedding` | vector(1536) | leave null; backfilled elsewhere |
| `hub_version`, `hub_synced_at`, `org_skill_id`, `org_version` | | hub/org sync — leave default |

Insert minimal set: `name, description, content, skill_type, locked, skill_path, skill_dir,
is_active:true, is_global:false, created_at, updated_at`.

### `skill_versions` — version history

PK `id serial`; FK `skill_name → skills(name) ON DELETE CASCADE`; UNIQUE `(skill_name,
version_num)`. **Installers don't write this** — it's maintained by the platform.

### `recipes` — PK `id uuid` (gen_random_uuid), `name` UNIQUE

| Column | Type / default | Notes |
|--------|----------------|-------|
| `id` | uuid PK default gen_random_uuid() | **omit on insert** — auto-generated |
| `name` | varchar(200) **NOT NULL UNIQUE** | lookup key |
| `description` | text NOT NULL default `''` | never pass `null` (empty string is fine) |
| `content` | text NOT NULL default `''` | never pass `null` |
| `is_active` | bool default true | |
| `created_by` | varchar | optional |
| `created_at`, `updated_at` | timestamptz | |
| `search_embedding` | vector(1536) | leave null |

> ⚠️ `agent_recipes.recipe_id` is this **uuid**. To link, look up
> `db('recipes').where('name', X).select('id').first()` and use `.id`.

### `agents` — PK `key`

| Column | Type / default | Notes |
|--------|----------------|-------|
| `key` | varchar(50) PK | e.g. `dev-handoff-agent` |
| `name` | varchar NOT NULL | |
| `description` | text | |
| `icon` | varchar NOT NULL default `'🤖'` | |
| `default_model` | varchar(20) default `'sonnet'` | **column is `default_model`, not `model`** |
| `mode` | varchar(10) default `'cli'` | installers set `'cli'` |
| `system_prompt_path` | text | optional |
| `is_active` | bool default true | |
| `capabilities` | jsonb default `'[]'` | |
| `instructions` | text | optional |
| `is_system` | bool default false | |
| `provider` | varchar NOT NULL default `'claude'` | |
| `cloned_from`, `hub_version` | | leave default |
| `created_at`, `updated_at` | timestamptz | |

Insert sets `key, name, description, mode, is_active, created_at, updated_at` plus any of
`default_model, icon, provider, system_prompt_path, capabilities, instructions` the manifest
carries (the agent `.md` frontmatter + body, D-32); anything omitted rides its DB default.
`capabilities` is `jsonb` — `JSON.stringify` it on write. The update path re-applies the same set
(only when one drifted) and otherwise preserves the row.

### `agent_skills` — PK `(agent_key, skill_name)`

- Columns: `agent_key`, `skill_name` (varchar(100)), `added_at`, `source` (NOT NULL default `'hub'`).
- FKs: `agents(key) ON DELETE CASCADE`, `skills(name) ON UPDATE CASCADE ON DELETE CASCADE`.
- **Only attach skills that exist and are active.** Insert with
  `.onConflict(['agent_key','skill_name']).ignore()`.

### `agent_recipes` — PK `(agent_key, recipe_id)`

- Columns: `agent_key`, `recipe_id` (**uuid** FK `recipes(id)`), `added_at`.
- Resolve `recipe_id` from name first; `.onConflict(['agent_key','recipe_id']).ignore()`.

### `background_jobs` — PK `id varchar(50)`

Key columns installers set: `id` (`job-<ts>-<rand>`), `name` (varchar(255)), `description`,
`schedule` (varchar(100), cron), `timezone` (varchar(50)), `job_type` (`'script'`),
`script_path` (`'node'`), `script_args` (`<abs script> <args>`), `timeout_minutes`,
`max_concurrent`, `skip_if_running`, `enabled`, `run_count` (0), `created_at`, `updated_at`.
Optional: `agent`, `task`, `recipe_id`, `model`, `is_system`, `background_sessions`,
`is_toggleable`.

## 3. Manifest → CRHQ mapping (how each component type installs)

The component semantics live in `package-manifest-spec.md` §5; this is how the CRHQ
implementation realizes them.

| Component | Install |
|-----------|---------|
| **Skill** | upsert `skills` by `name` — `skill_path='db://skills/<name>'`, `skill_dir='${INSTALL_BASE_DIR}/<key>'`, `skill_type`/`locked` from `install_type` (default `'org'`+locked), `is_active:true` — then copy the skill tree to `${INSTALL_BASE_DIR}/<key>/` |
| **Recipe** | upsert `recipes` by `name` (uuid auto; frontmatter → `description`, body → `content`, `is_active:true`) |
| **Agent** | upsert `agents` by `key` — the manifest's `name` maps to `agents.key`, `display_name` to `agents.name` (D-23); the `.md` body maps to `instructions`, frontmatter to `default_model`/`icon`/`provider`/`system_prompt_path`/`capabilities` (jsonb) when present, else DB defaults (D-32). Then **sync** `agent_skills` and `agent_recipes` (add desired, drop stale, `onConflict` ignore); recipe names resolve to `recipes.id` uuids |
| **Job** | upsert `background_jobs` by `name` — `id='job-<ts>-<rand>'` on insert, `job_type:'script'`, `script_path:'node'`, `script_args=join(INSTALL_BASE_DIR, script)[+ ' ' + args]`, `run_count:0`; schedule aliases expand to cron |
| **Service** | not DB-resident — copy source to `/opt/projects/user/<name>/`, write `.env` (chmod 640), `ecosystem.config.cjs`, and the nginx vhost (127.0.0.1 binding; `{SATELLITE_ID}-<subdomain>.crhq.ai`); allocate the port; PM2 start + save; nginx reload. Never touches the `crhq-satellite` PM2 process. |

Varchar length limits worth validating at manifest load: `skills.name(100)`,
`agents.key(50)`, `agents.mode(10)`, `agents.default_model(20)`, `recipes.name(200)`,
`agent_skills.skill_name(100)`, `background_jobs.id(50)/name(255)/schedule(100)/timezone(50)`.

## 4. REST (read-only context; NOT used for installs)

- `GET /api/skills`, `GET /api/skills/<name>`, `GET /api/skills/search?q=` — discovery.
- `GET /api/agents` → `{agents:[{key,name,icon,description,mode,model,skills[]...}]}`.
- `GET /api/recipes` → `{recipes:[...]}`.
- content-api.js / `PUT /api/settings/skills/<name>` exist but are **not** the install path
  (can't be sandbox-intercepted). Listed only so we don't accidentally reach for them.

## 5. Re-verifying the schema (safe, read-only)

```bash
node --input-type=module -e "import('/opt/projects/crhq-satellite/server/db/knex.js').then(async m=>{const db=m.getDb();for(const t of ['skills','recipes','agents','agent_skills','agent_recipes','background_jobs']){console.log('\n#',t);console.log(Object.keys(await db(t).columnInfo()).join(', '));}await db.destroy();})"
```
If the live schema ever differs from this doc, update this doc — it is the build contract's
schema half.

**Sandbox privilege (confirmed):** the DB user can `CREATE SCHEMA` / `DROP … CASCADE`, and a
schema-qualified table is fully isolated — which is what makes the built-in `--sandbox`
DB-isolation mechanism viable on a satellite.
