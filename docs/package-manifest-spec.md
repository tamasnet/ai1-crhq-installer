# Ai1 Package Manifest — Specification (v0.2, finalized for build)

Finalized package manifest format. Synthesizes the original Ai1 Package Standard draft
(2026-05-27) + a hardening review with the canon/sandbox learnings in `canon-conventions.md` +
`integration-reference.md`.

> **Scope discipline (per Tamás):** this spec defines the **declarative manifest only**.
> Cross-cutting *implementation* concerns the review raised — name-PK upserts, idempotency,
> `INSTALL_BASE_DIR`, the sandbox gate, secret scanning, the verdict taxonomy — are **utility
> responsibilities, not manifest fields**. They live in `canon-conventions.md`. See §7.

---

## 1. Concepts

- **Package** — a versioned, self-contained directory tree bundling one or more
  **components** (skills, recipes, agents, jobs, services) for coordinated install.
- **Package manifest** — a single `ai1-package.yaml` at the tree root; the canonical
  machine-readable description. This is what `ai1-crhq-installer` consumes.
- **Component** — one bundled item, declared in the manifest's `components` inventory and
  living in its type's directory.
- **Dependency** — an *external* prerequisite (skill or package) that is **not** bundled,
  only declared so the utility can verify/await it.
- **The utility owns the lifecycle.** `ai1-crhq-installer` reads the manifest and performs
  the standard install/status/uninstall declaratively. A package only ships an
  `install_entry` script for steps the utility *cannot infer* (OAuth handshake, data seed,
  starting a process). Standard flags are never re-implemented per package.

This is exactly product shape **C** (core lib + generic manifest runner, decision D-8): the
manifest is the runner's input; `install_entry` is the escape hatch.

---

## 2. Directory layout

```
<package-name>/                  ← kebab-case, globally unique
  ai1-package.yaml               ← manifest (REQUIRED)
  CHANGELOG.md                   ← REQUIRED; semver history
  README.md                     ← REQUIRED; human docs + usage

  skills/<skill-key>/            ← each a complete standalone skill tree
    SKILL.md                     ← flat YAML frontmatter + body
    scripts/                     ← implementation
    tests/                       ← optional
  recipes/<name>.md              ← frontmatter + body (content component)
  agents/<key>.yaml              ← config component
  jobs/<name>.yaml               ← scheduled (background) job — config component
  services/<name>/               ← service.yaml + app source

  scripts/                       ← PACKAGE-LEVEL orchestration ONLY
    install.mjs                  ← optional install_entry (package-specific steps)
    smoke-test.mjs               ← optional post-install validation
  data/                          ← optional shared assets spanning components
```

**Rules**
- Root `scripts/` is for package orchestration only; component scripts live in their own
  subtree (e.g. `skills/plaud-ingest/scripts/`).
- **Omit unused component dirs** — never create empty `agents/`, `jobs/`, etc.
- A package with **no `scripts/install.mjs` is valid** (purely declarative).
- The `components` inventory in the manifest is the **source of truth**: a file present in a
  component dir but *not* listed in `components` is **not installed** (explicit inventory,
  no accidental installs).

> **Naming reconciliation (changed from draft):** the draft mixed `scheduled-jobs/` (dir)
> with `cron_jobs` (manifest key). Standardized to **`jobs/`** dir + **`jobs:`** key, which
> maps to the `background_jobs` table.

---

## 3. `ai1-package.yaml` schema

```yaml
# ── Identity (required) ───────────────────────────────────────────────────────
name: plaud-suite              # kebab-case, globally unique
version: 1.0.0                 # semver — the SUITE version
description: >
  Full Plaud voice-recorder stack. One-command install of OAuth login,
  hourly brain ingest, and the background job that drives it.
installer: ">=1.0.0"           # min ai1-crhq-installer version (semver range); optional

# ── Discovery (agent-facing; optional) ────────────────────────────────────────
triggers:
  - /plaud-suite
  - "install plaud"
  - "deploy plaud"

# ── Classification (optional, recommended) ────────────────────────────────────
category: integration-suite
classification: client-facing  # client-facing | internal
complexity: beginner           # beginner | intermediate | advanced
foundational: false
status: stable                 # draft | mvp-draft | stable | deprecated

# ── Components — explicit inventory (required) ────────────────────────────────
# Install order = the order types appear below, then array order within a type:
#   skills → recipes → agents → jobs → services.   Uninstall reverses.
components:
  skills:
    - path: skills/plaud-login    # relative to package root
      version: 0.4.0              # REQUIRED for skills; must match SKILL.md frontmatter
    - path: skills/plaud-ingest
      version: 0.2.3
  recipes:
    - path: recipes/plaud-pipeline.md
  agents:
    - path: agents/plaud-agent.yaml
  jobs:
    - path: jobs/plaud-ingest-crawl.yaml
  services:
    - path: services/plaud-broker      # dir containing service.yaml + source
      version: 1.0.0                   # REQUIRED for services; must match service.yaml

# ── Dependencies — external, NOT bundled (optional) ───────────────────────────
dependencies:
  - brain-architecture          # skill key OR package name; verified, not installed

# ── Credentials (optional; discovery/orchestration metadata) ──────────────────
credentials_needed: []
provides_credentials:
  - plaud                       # e.g. via plaud-login

# ── Install interface (optional) ──────────────────────────────────────────────
# Invoked ONLY for package-specific steps the utility can't infer. The utility
# forwards the standard flags as argv so the script can respect them (e.g. skip
# side effects on --dry-run). Omit entirely if there are no such steps.
install_entry: scripts/install.mjs

# Package-SPECIFIC flags only. Do NOT re-declare standard flags (see §6).
install_flags:
  - name: --no-ingest
    description: Install plaud-login only; skip plaud-ingest + its job
```

---

## 4. Required vs optional fields

| Field | Requirement |
|-------|-------------|
| `name`, `version`, `description`, `components` | **Required** |
| `installer`, `triggers`, `category`, `classification`, `complexity`, `foundational`, `status` | Optional (recommended) |
| `dependencies`, `credentials_needed`, `provides_credentials` | Optional |
| `install_entry`, `install_flags` | Optional |
| `components.skills[].version` | **Required** — must equal that skill's `SKILL.md` `version` |
| `components.services[].version` | **Required** — must equal that service's `service.yaml` `version` |
| `components.{recipes,agents,jobs}[].version` | Optional |

> **Changed from draft:** removed `shape` from the required list (it was never defined in
> the schema and the example used `category`/`classification` instead — the review's nit).
> Classification is captured by `category` + `classification`.

---

## 5. Bundled component conventions

**One syntax, two file kinds — no JSON.** Content-bearing components (skill, recipe) are
**Markdown** (`.md`): YAML frontmatter + a body that becomes a DB `content` column. Config-only
components (agent, job, service descriptor) are **YAML** (`.yaml`). Each component's fields are
fully specified below — **a package is self-describing**; the utility maps these to DB columns
(or, for services, to deploy-project artifacts) itself, so nothing here defers to an external
"platform definition."

### 5.1 Skill — `skills/<key>/`
Layout: `SKILL.md` (flat YAML frontmatter + Markdown body) + optional `scripts/`, `tests/`.

```yaml
---
name: plaud-login              # = skills.name (PK) and the install <key>
version: 0.4.0                 # must equal components.skills[].version
description: "OAuth handshake for the Plaud integration…"
category: integration
classification: client-facing
complexity: beginner
foundational: false
dependencies: []
credentials_needed: []
provides_credentials: [plaud]
triggers: [/plaud-login, "connect plaud"]
updatedAt: 2026-05-14
---
(Markdown body — becomes skills.content)
```

| Frontmatter | Req | Maps to / use |
|-------------|-----|---------------|
| `name` | ✅ | `skills.name` (PK) + install `<key>`; kebab-case, ≤100 chars |
| `version` | ✅ | must equal `components.skills[].version` |
| `description` | ✅ | `skills.description` (third-person, trigger words) |
| `category`,`classification`,`complexity`,`foundational` | – | classification/discovery metadata |
| `dependencies` | – | external prereqs (skill keys / package names) |
| `credentials_needed`,`provides_credentials` | – | credential orchestration |
| `triggers` | – | agent-facing invocation phrases |
| `updatedAt` | – | informational |

Install: upsert `skills` (`skill_type:'user'`, `skill_path='db://skills/<name>'`,
`skill_dir='${INSTALL_BASE_DIR}/<key>'`, `is_active:true`) + copy the tree to
`${INSTALL_BASE_DIR}/<key>/` (operator-configured; the manifest is unaware of it — D-19).

### 5.2 Recipe — `recipes/<name>.md`
Markdown file: YAML frontmatter + Markdown body.

```yaml
---
name: plaud-pipeline           # = recipes.name (UNIQUE)
description: "End-to-end Plaud capture → brain pipeline."
version: 1.0.0                 # optional; if set, must equal components.recipes[].version
---
(Markdown body — becomes recipes.content)
```

| Frontmatter | Req | Maps to / use |
|-------------|-----|---------------|
| `name` | ✅ | `recipes.name` (UNIQUE lookup key); ≤200 chars |
| `description` | ✅ | `recipes.description` (NOT NULL) |
| `version` | – | optional pin |

Install: upsert `recipes` by name (`id` uuid auto, `content` NOT NULL, `is_active:true`).

### 5.3 Agent — `agents/<key>.yaml`
```yaml
key: plaud-agent
name: Plaud Agent
description: "Runs the Plaud capture + ingest pipeline."
mode: cli                      # optional, default cli
default_model: sonnet          # optional, default sonnet
icon: "🎙️"                     # optional, default 🤖
skills: [plaud-login, plaud-ingest, memory]   # attach iff installed + active
recipes: [plaud-pipeline]                      # attach by name → recipes.id
```

| Field | Req | Maps to / use |
|-------|-----|---------------|
| `key` | ✅ | `agents.key` (PK); ≤50 chars |
| `name` | ✅ | `agents.name` |
| `description` | – | `agents.description` |
| `mode` | – | `agents.mode` (default `cli`) |
| `default_model` | – | `agents.default_model` (default `sonnet`; **the column is `default_model`, not `model`**) |
| `icon` | – | `agents.icon` (default `🤖`) |
| `skills` | – | each → `agent_skills` **iff** the skill is installed + active (else skipped with a warning) |
| `recipes` | – | each name → resolved to `recipes.id` (uuid) → `agent_recipes` |

Install: upsert `agents` by `key` (minimal insert; other columns ride DB defaults — e.g.
`provider='claude'`), then **sync** `agent_skills` and `agent_recipes` (add desired, drop stale,
`onConflict` ignore). Runs after skills + recipes so bundled components are attachable.

### 5.4 Job (scheduled / background) — `jobs/<name>.yaml`
```yaml
name: plaud-ingest-crawl
description: Hourly Plaud sync into brain
schedule: "0 * * * *"          # cron, or alias: hourly | every-15-min | every-30-min | daily
script: plaud-ingest/scripts/crawl-plaud.js   # path under the skill-install root: <skill-key>/scripts/<file>
args: "--limit 50"             # optional
timezone: America/Vancouver    # optional, default UTC
timeout_minutes: 10            # optional, default 30
max_concurrent: 1              # optional, default 1
skip_if_running: true          # optional, default true
enabled: true                  # optional, default true
requires: [plaud-ingest]       # optional: skill keys whose install dir must exist first
```

| Field | Req | Maps to / use |
|-------|-----|---------------|
| `name` | ✅ | `background_jobs.name` (lookup key); ≤255 chars |
| `schedule` | ✅ | cron expression or alias (`hourly`/`every-15-min`/`every-30-min`/`daily`) |
| `script` | ✅ | path under the skill-install root; resolved to `join(INSTALL_BASE_DIR, script)` |
| `description` | – | `background_jobs.description` |
| `args` | – | appended to the script invocation |
| `timezone` | – | default `UTC` |
| `timeout_minutes` | – | default `30` |
| `max_concurrent` | – | default `1` |
| `skip_if_running` | – | default `true` |
| `enabled` | – | default `true` |
| `requires` | – | skill keys whose install dir must exist before registering (coarse C12 guard) |

Install: upsert `background_jobs` by name — `id='job-<ts>-<rand>'`, `job_type:'script'`,
`script_path:'node'`, `script_args=join(INSTALL_BASE_DIR, script)[+ ' ' + args]`, `run_count:0`.
Halts with a two-ways-forward message + `--no-job` escape if a `requires` skill is absent
(deeper dynamic-import-chain checks remain the package's `install_entry` job).

### 5.5 Service (nginx + PM2 web app) — `services/<name>/`
Layout: `service.yaml` + the application source. **Not DB-resident** — deployed via the
`deploy-project` conventions (D-2).

```yaml
name: plaud-broker
version: 1.0.0                 # REQUIRED — must equal components.services[].version
port: 4300                     # optional — deploy-project allocates a free port if omitted
start: node server.js
cwd: ./                        # optional, default ./
build: npm ci && npm run build # optional — command run during the build step
env:                           # optional → written to the service's .env (secrets never logged)
  NODE_ENV: production
nginx:                         # optional
  subdomain: plaud             # default: <name>
  ssl: true                    # default: true
```

| Field | Req | Use |
|-------|-----|-----|
| `name` | ✅ | project dir name, PM2 process name, default subdomain |
| `version` | ✅ | must equal `components.services[].version` (mirrors skills) |
| `port` | – | listen port; if omitted, `deploy-project` allocates a free one |
| `start` | ✅ | PM2 start command |
| `cwd` | – | working dir relative to the service dir (default `./`) |
| `build` | – | command run during the **build step** (e.g. `npm ci && npm run build`) |
| `env` | – | key/values written to the service `.env`; **secrets never echoed to logs** |
| `nginx.subdomain` | – | default `<name>` → `{SATELLITE_ID}-<subdomain>.crhq.ai` |
| `nginx.ssl` | – | default `true` |

Install (deploy-project, D-2): copy source → `/opt/projects/user/<name>/`, write `.env` from
`env`, `ecosystem.config.cjs`, and the nginx vhost; allocate the port; PM2 start + save; nginx
reload. **Dry-run runs the build step (incl. `build`) but skips the deploy-project apply**
(D-2a). Never run PM2 against `crhq-satellite`.

---

## 6. Install / uninstall order & standard flags

- **Install order:** skills → recipes → agents → jobs → services; within a type, array order.
- **Uninstall:** exact reverse. (Matches canon C13.)
- Finer control than this ordering implies → use `install_entry`.

**Standard flags — utility-owned, never declared in the manifest:**
`--dry-run`, `--status`, `--uninstall`, `--respect-locks`, `--no-agent`, `--no-job`,
`--only=<type>`, `--include=<pat>`, `--exclude=<pat>`. The utility forwards them to `install_entry`
(argv) so package-specific steps can honor them. `install_flags` is ONLY for package-specific flags
(e.g. `--no-ingest`).

`--include`/`--exclude` select a subset of components **by name** (skills/recipes/jobs/services by
`name`, agents by `key`). The value is a regex; a value with no regex metacharacter is an exact
`^name$` match (case-sensitive). Selected iff it matches `--include` (or none given) and not
`--exclude`; these compose with `--only`. A filter matching zero components warns and exits `0`.

---

## 7. NOT in the manifest — utility responsibilities (review GAPs → here, not the spec)

These are enforced by `ai1-crhq-installer` for **every** package; keeping them out of the
manifest is deliberate (Tamás's scope call). Full detail in `canon-conventions.md`.

| Review GAP | Where it lives |
|------------|----------------|
| name-PK upsert; never `.returning('id')` (GAP 2) | utility — `lib/core/*` (C-schema) |
| idempotent check-then-upsert; `onConflict.ignore()` (GAP 5) | utility — `lib/core/*` (C6) |
| `INSTALL_BASE_DIR` for all fs ops (GAP 10) | utility + any `install_entry` (C2) |
| publish gate (GAP 8) | built-in `--sandbox --lifecycle` (`testing-and-sandbox.md`) |
| secret-pattern scan before publish (GAP 9) | publish gate (not install-time) |
| install-result taxonomy + exit codes (GAP 11) | utility output contract (see §8) |
| no `sudo` in operator docs (GAP 4) | README/INSTALL authoring rule |
| prereq `existsSync` of a cron's import chain (GAP 3) | `install_entry` (+ coarse `requires` in §5) |
| org install target / agent reachability / write-path (GAPs 1,6,7) | resolved by D-1 (knex) / verify live |

---

## 8. Result taxonomy (optional, recommended — GAP 11)

Not a manifest field, but the contract the utility prints so installs are machine-parseable:
`INSTALL-OK | ALREADY-INSTALLED | INSTALL-PARTIAL | INSTALL-FAIL | PREREQ-MISSING | LOCKED-ROW`,
exit codes `0` ok/already · `1` fail/prereq/lock · `2` transport. (Defer to utility design;
listed here so the manifest stays clean of it.)

---

## 9. Settled choices (v0.2)

These were confirmed and are now part of the spec (no longer open):
`ai1-package.yaml` filename · `jobs` key/dir naming · `version` pin required for **skills and
services** (optional for recipes/agents/jobs) · coarse `requires` on jobs kept · `installer`
field is a **min-version range** (`">=1.0.0"`).

## 10. Changes from the 2026-05-27 draft

- **Self-contained component conventions (§5).** Every component type (skill, recipe, agent,
  job, service) has a full inline field reference — no more "matches platform definitions"
  deferral. Each field documents required/optional + what it maps to.
- **Services require a `version`** (mirrors skills) — both `components.services[].version` and
  `service.yaml.version`, which must match. Added optional `build` field to `service.yaml`.
- **No JSON.** All config components serialize as **YAML** (`agents/<key>.yaml`,
  `jobs/<name>.yaml`, `services/<name>/service.yaml`); Markdown (`.md`) is used only for
  content-bearing components (skills, recipes) where the body becomes a DB row. One syntax
  (YAML) across the manifest, frontmatter, and config files.
- Added `services` to `components`; documented `service.yaml`.
- Reconciled `scheduled-jobs`/`cron_jobs` → `jobs`; specified `jobs/<name>.yaml` format +
  `script`/`requires` resolution.
- Removed undefined `shape` from required fields.
- Made install/uninstall **order** explicit (type order + array order; reverse uninstall).
- Specified agent join-attachment semantics (existing+active skills; recipe name→uuid).
- Pulled all cross-cutting implementation items out of the spec into §7 (utility-owned).
- Clarified standard vs package-specific flag ownership.
