# Ai1 Package Manifest — Specification (v0.2, finalized for build)

**Supersedes** the 2026-05-27 draft (`ai1-package-standard.md`). Incorporates the ThinkBot
review (`tamas-package-standard-REVIEW.md` / `-ANNOTATED.md`) **and** the canon/sandbox
learnings in `canon-conventions.md` + `integration-reference.md`.

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
| `components.skills[].version` | **Required per skill** — must equal that skill's `SKILL.md` `version` |
| `components.*[].version` (non-skill) | Optional |

> **Changed from draft:** removed `shape` from the required list (it was never defined in
> the schema and the example used `category`/`classification` instead — the review's nit).
> Classification is captured by `category` + `classification`.

---

## 5. Bundled component file formats

**One syntax, two file kinds — no JSON.** Everything in a package is YAML:

- **Content components** (skill, recipe) carry a long-form body that becomes a DB `content`
  column, so they're **Markdown** (`.md`) — YAML frontmatter for metadata + a Markdown body.
- **Config components** (agent, job, service descriptor) are pure structured config, so they're
  **YAML** (`.yaml`) — same syntax as `ai1-package.yaml` and as the `.md` frontmatter.

So the only reason `.md` exists is an authored prose body; otherwise it's YAML throughout.
(The agent/job/service *schemas* still match the platform definitions — only the on-disk
serialization is YAML, since the utility maps them to DB columns itself via knex.)

### Skill — `skills/<key>/SKILL.md` (+ `scripts/`, optional `tests/`)
Flat YAML frontmatter, no `<!-- SKILL-META -->` block:
```yaml
---
name: plaud-login
version: 0.4.0                 # must match components.skills[].version
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
```
Utility installs → `skills` row (`skill_type:'user'`, `skill_path`, `skill_dir`) + copies the
tree to the operator-configured skill-install dir `${INSTALL_BASE_DIR}/<name>/` (the manifest is
unaware of this path — D-19). `description`/`version` parsed from frontmatter.

### Recipe — `recipes/<name>.md`
YAML frontmatter (`name`, `description`) + markdown body → `recipes` row (uuid PK auto).

### Agent — `agents/<key>.yaml`
```yaml
key: plaud-agent
name: Plaud Agent
description: "..."
mode: cli
default_model: sonnet         # optional
icon: "🎙️"                    # optional
skills: [plaud-login, plaud-ingest, memory]
recipes: [plaud-pipeline]
```
Utility upserts the `agents` row (by `key`) and syncs joins: attaches each `skills[]` entry
**only if installed + active** (`agent_skills`), resolves each `recipes[]` name → uuid
(`agent_recipes`). Because agents install *after* skills/recipes, bundled components are
attachable. Column is `default_model` (not `model`); minimal insert relies on defaults.

### Job — `jobs/<name>.yaml`
```yaml
name: plaud-ingest-crawl
description: Hourly Plaud sync into brain
schedule: "0 * * * *"            # cron, or alias: hourly|every-15-min|every-30-min|daily
timezone: America/Vancouver      # optional, default UTC
script: plaud-ingest/scripts/crawl-plaud.js   # path under the skill-install root: <skill-key>/scripts/<file>
args: "--limit 50"               # optional
timeout_minutes: 10
max_concurrent: 1
skip_if_running: true
enabled: true
requires: [plaud-ingest]         # optional: skill keys whose files must exist first
```
Utility maps → `background_jobs` row: `id=job-<ts>-<rand>`, `job_type:'script'`,
`script_path:'node'`, `script_args = join(INSTALL_BASE_DIR, script) + ' ' + args`. Before registering,
it verifies each `requires` skill is installed and its `scripts/` dir exists (coarse GAP-3
guard); deeper dynamic-import-chain checks remain the package's `install_entry` job. On
failure it halts with a two-ways-forward message + `--no-job` escape.

### Service — `services/<name>/` with `service.yaml` + source
```yaml
name: plaud-broker
port: 4300
start: node server.js
cwd: ./
env:
  NODE_ENV: production
nginx:
  subdomain: plaud
  ssl: true
```
Not DB-resident. Utility follows `deploy-project` conventions (copy → `/opt/projects/user/<name>/`,
`.env` from `env`, `ecosystem.config.cjs`, nginx vhost, port, PM2). **Dry-run runs the build
step but skips the deploy-project apply** (D-2a) — secrets never logged.

---

## 6. Install / uninstall order & standard flags

- **Install order:** skills → recipes → agents → jobs → services; within a type, array order.
- **Uninstall:** exact reverse. (Matches canon C13.)
- Finer control than this ordering implies → use `install_entry`.

**Standard flags — utility-owned, never declared in the manifest:**
`--dry-run`, `--status`, `--uninstall`, `--respect-locks`, `--no-agent`, `--no-job`,
`--only=<type>`. The utility forwards them to `install_entry` (argv) so package-specific
steps can honor them. `install_flags` is ONLY for package-specific flags (e.g. `--no-ingest`).

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
`ai1-package.yaml` filename · `jobs` key/dir naming · `version` pin required for **skills only**
· coarse `requires` on jobs kept · `installer` field is a **min-version range** (`">=1.0.0"`).

## 10. Changes from the 2026-05-27 draft

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
