# DB Schema & Integration Reference

**Authoritative** — schema below was **verified against the live DB** (Phase 0, §6) and
cross-checked against the four reference installers. (It was originally drafted from the old
`installer-sandbox` DDL, but the live read is the source of truth — and the built-in sandbox
now clones from live, D-18, so there's no separate DDL to drift.)

Resource writes are **DB-direct via knex** (see `canon-conventions.md` C1, C9). REST is
read-only here and not used for installs.

## 1. knex accessor

```js
import { getDb } from '/opt/projects/crhq-satellite/server/db/knex.js';  // hardcoded — C1
const db = getDb();
// ... await db.destroy() on every exit
```
Connection (from sandbox harness defaults): pg, `DB_HOST` localhost, `DB_PORT` 5433,
`DB_USER`/`DB_PASSWORD`/`DB_NAME` from `.env`. In sandbox mode, `searchPath=[INSTALL_SCHEMA]`
(legacy `SANDBOX_SCHEMA`) — D-15.

## 2. Tables

### `skills` — PK `name` (no `id`)

| Column | Type / default | Notes |
|--------|----------------|-------|
| `name` | varchar PK | unique key; never `.returning('id')` |
| `description` | text | usually parsed from SKILL.md frontmatter |
| `skill_path` | text **NOT NULL** default `''` | standardized to **`db://skills/<name>`** (OQ-10) — location-independent |
| `skill_dir` | text | `${INSTALL_BASE_DIR}/<key>` (absolute; `INSTALL_BASE_DIR` = the skill-parent dir, D-19) |
| `is_global` | bool default false | installers set false |
| `is_active` | bool default true | |
| `locked`, `locked_at`, `locked_by` | bool/ts/varchar | PG trigger blocks UPDATE on locked rows → unlock first (C5) |
| `content` | text | the SKILL.md body (or full md) |
| `skill_type` | varchar **NOT NULL** default `'system'` | **installers set `'user'`** |
| `created_at`, `updated_at` | timestamptz | set `new Date()` |
| `search_embedding` | vector(1536) | leave null; backfilled elsewhere |
| `hub_version`, `hub_synced_at`, `org_skill_id`, `org_version` | | hub/org sync — leave default |

Insert minimal set used by canon: `name, description, content, skill_type:'user',
skill_path, skill_dir, is_active:true, is_global:false, created_at, updated_at`.

### `skill_versions` — version history

PK `id serial`; FK `skill_name → skills(name) ON DELETE CASCADE`; UNIQUE `(skill_name,
version_num)`. **Installers don't write this directly** — it's maintained by the platform
(the harness only reads it to confirm versioning). Don't insert into it.

### `recipes` — PK `id uuid` (gen_random_uuid), `name` UNIQUE

| Column | Type / default | Notes |
|--------|----------------|-------|
| `id` | uuid PK default gen_random_uuid() | **omit on insert** — auto-generated |
| `name` | varchar **NOT NULL UNIQUE** | lookup key |
| `description` | text NOT NULL default `''` | |
| `content` | text NOT NULL default `''` | |
| `is_active` | bool default true | |
| `created_by` | varchar | optional |
| `created_at`, `updated_at` | timestamptz | |
| `search_embedding` | vector(1536) | leave null |

> ⚠️ `agent_recipes.recipe_id` is this **uuid**. To link, look up
> `db('recipes').where('name', X).select('id').first()` and use `.id`.

### `agents` — PK `key`

| Column | Type / default | Notes |
|--------|----------------|-------|
| `key` | varchar PK | e.g. `dev-handoff-agent` |
| `name` | varchar NOT NULL | |
| `description` | text | |
| `icon` | varchar NOT NULL default `'🤖'` | |
| `default_model` | varchar default `'sonnet'` | **column is `default_model`, not `model`** |
| `mode` | varchar default `'cli'` | installers set `'cli'` |
| `system_prompt_path` | text | optional |
| `is_active` | bool default true | |
| `capabilities` | jsonb default `'[]'` | |
| `instructions` | text | optional |
| `is_system` | bool default false | |
| `provider` | varchar NOT NULL default `'claude'` | |
| `cloned_from`, `hub_version` | | leave default |
| `created_at`, `updated_at` | timestamptz | |

Canon insert is minimal: `key, name, description, mode, is_active, created_at, updated_at`
— everything else rides on defaults. Update path preserves the existing row (only set
name/description/mode/is_active/updated_at).

### `agent_skills` — PK `(agent_key, skill_name)`

- Columns: `agent_key`, `skill_name`, `added_at`, `source` (NOT NULL default `'hub'`).
- FKs: `agents(key) ON DELETE CASCADE`, `skills(name) ON UPDATE CASCADE ON DELETE CASCADE`.
- **Only attach skills that exist and are active.** Insert with
  `.onConflict(['agent_key','skill_name']).ignore()`.

### `agent_recipes` — PK `(agent_key, recipe_id)`

- Columns: `agent_key`, `recipe_id` (**uuid** FK `recipes(id)`), `added_at`.
- Resolve `recipe_id` from name first; `.onConflict(['agent_key','recipe_id']).ignore()`.

### `background_jobs` — PK `id varchar`

Key columns installers set: `id` (`job-<ts>-<rand>`), `name`, `description`, `schedule`
(cron), `timezone`, `job_type` (`'script'`), `script_path` (`'node'`), `script_args`
(`<abs script> <args>`), `timeout_minutes`, `max_concurrent`, `skip_if_running`, `enabled`,
`run_count` (0), `created_at`, `updated_at`. Optional: `agent`, `task`, `recipe_id`,
`model`, `is_system`, `background_sessions`, `is_toggleable`. (Full column list in the
sandbox DDL.)

## 3. REST (read-only context; NOT used for installs)

- `GET /api/skills`, `GET /api/skills/<name>`, `GET /api/skills/search?q=` — discovery.
- `GET /api/agents` → `{agents:[{key,name,icon,description,mode,model,skills[]...}]}`.
- `GET /api/recipes` → `{recipes:[...]}`.
- content-api.js / `PUT /api/settings/skills/<name>` exist but are **not** the install path
  (can't be sandbox-intercepted). Listed only so we don't accidentally reach for them.

## 4. Read-only verification commands (safe; run in Phase 0)

```bash
# Confirm live columns match this doc (no writes):
node --input-type=module -e "import('/opt/projects/crhq-satellite/server/db/knex.js').then(async m=>{const db=m.getDb();for(const t of ['skills','recipes','agents','agent_skills','agent_recipes','background_jobs']){console.log('\n#',t);console.log(Object.keys(await db(t).columnInfo()).join(', '));}await db.destroy();})"
```
(If the live schema differs from the sandbox DDL, update this doc and `canon-conventions.md`.)

## 5. Known inconsistencies to standardize in our build

- `skill_path` value format — **resolved: `db://skills/<name>`** (OQ-10).
- Agent flag name: `--no-agent` (dev-handoff) vs `--skip-agent` (requirements) — pick one
  (recommend `--no-agent`).
- `skill_dir` — **resolved: `${INSTALL_BASE_DIR}/<key>`** (absolute; D-19).

## 6. Phase 0 verification — live DB (2026-05-31) ✅

`columnInfo()` was run against the live DB. **The schema above matches** (all 7 tables, col
names/types/defaults). Refinements captured from the live read:

- **`skills.skill_path`** is `NOT NULL` with **no default** on live (the sandbox DDL gives it
  `DEFAULT ''`). → the installer **must always set `skill_path`** on insert; never rely on a
  default. (Reinforces the v1.1 NOT-NULL bug.)
- **`recipes.description` and `recipes.content`** are `NOT NULL DEFAULT ''` → never pass `null`
  (empty string is fine).
- **`agents`**: `icon NOT NULL DEFAULT '🤖'`, `provider NOT NULL DEFAULT 'claude'`,
  `default_model DEFAULT 'sonnet'` — minimal insert (key/name/description/mode) is safe.
- **`search_embedding`** is pgvector (`USER-DEFINED`) on `skills`/`recipes` → leave `null`.
- **varchar length limits** (validate in `manifest.mjs`/`validate`):
  `skills.name(100)`, `agents.key(50)`, `agents.mode(10)`, `agents.default_model(20)`,
  `recipes.name(200)`, `agent_skills.skill_name(100)`,
  `background_jobs.id(50)/name(255)/schedule(100)/timezone(50)`.
- **Sandbox privilege confirmed**: the DB user can `CREATE SCHEMA` / `DROP … CASCADE` and a
  schema-qualified table is fully isolated — so the built-in `--sandbox` DB-isolation mechanism
  (and the `LIKE`-clone of D-18) is viable on this satellite.
