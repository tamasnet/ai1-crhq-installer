# Ai1 Package Manifest — Specification (v1.0 DRAFT)

The `ai1-package.yaml` manifest format: how a versioned bundle of agentic resources —
skills, recipes, agents, jobs, services — is described for coordinated, declarative install
by a compliant installer. The format itself is platform-independent.

> **Scope discipline:** this spec defines the **declarative manifest only**. How an installer
> persists components (database tables, file trees, process managers), its idempotency and
> safety mechanics, and its testing model are **installer responsibilities, not manifest
> fields** (§7). The CRHQ implementation of those responsibilities is documented separately
> in `canon-conventions.md` and `integration-reference.md`.

---

## 1. Concepts

- **Package** — a versioned, self-contained directory tree bundling one or more
  **components** (skills, recipes, agents, jobs, services) for coordinated install.
- **Package manifest** — a single `ai1-package.yaml` at the tree root; the canonical
  machine-readable description. This is what the installer consumes.
- **Component** — one bundled item, declared in the manifest's `components` inventory and
  living in its type's directory.
- **Dependency** — an *external* prerequisite **package** that is **not** bundled, only
  declared so the installer can verify/await it.
- **The installer owns the lifecycle.** It reads the manifest and performs the standard
  install/status/uninstall declaratively. A package only ships an `install_entry` script for
  steps the installer *cannot infer* (an OAuth handshake, a data seed, starting a process).
  Standard flags are never re-implemented per package.

The manifest is the installer's input; `install_entry` is the escape hatch.

### Component types

| Type | What it is |
|------|-----------|
| **Skill** | A capability the platform's agents can invoke: instructions (`SKILL.md`) plus optional scripts and tests. |
| **Recipe** | A reusable piece of agent-facing content: a named, described Markdown document. |
| **Agent** | A configured agent persona: identity and config plus Markdown `instructions`, and references to the skills and recipes it uses. |
| **Job** | A scheduled (cron-style) background task that runs a script shipped by one of the bundled skills. |
| **Service** | A standalone long-running web application, deployed behind the platform's reverse proxy and process manager. |

---

## 2. Directory layout

```
<package-name>/                  ← kebab-case, globally unique
  ai1-package.yaml               ← manifest (REQUIRED)
  CHANGELOG.md                   ← optional semver history
  README.md                      ← optional human docs + usage

  skills/<skill-key>/            ← each a complete standalone skill tree
    SKILL.md                     ← flat YAML frontmatter + body
    scripts/                     ← implementation
    tests/                       ← optional
  recipes/<name>.md              ← frontmatter + body (content component)
  agents/<name>.md               ← frontmatter + body (instructions) — content component
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
- Optional unused component dirs — empty `agents/`, `jobs/`, etc — are ignored.
- A package with **no `scripts/install.mjs` is valid** (purely declarative).
- The `components` inventory in the manifest is the **source of truth**: a file present in a
  component dir but *not* listed in `components` is **not installed** (explicit inventory,
  no accidental installs).

---

## 3. `ai1-package.yaml` schema

```yaml
# ── Identity (required) ───────────────────────────────────────────────────────
name: plaud-suite              # kebab-case, globally unique
version: 1.0.0                 # semver — the SUITE version
description: >
  Full Plaud voice-recorder stack. One-command install of OAuth login,
  hourly brain ingest, and the background job that drives it.
installer: ">=1.0.0"           # min installer version (semver range); optional

# ── Components — explicit inventory (required) ────────────────────────────────
# Install order = the order types appear below, then array order within a type:
#   skills → recipes → agents → jobs → services.   Uninstall reverses.
components:
  skills:
    - path: skills/plaud-login    # relative to package root
      version: 0.4.0              # REQUIRED for skills; must match SKILL.md frontmatter
      install_type: user          # optional: 'org' (default, locked) | 'user' (unlocked)
    - path: skills/plaud-ingest
      version: 0.2.3
  recipes:
    - path: recipes/plaud-pipeline.md
  agents:
    - path: agents/plaud-agent.md
  jobs:
    - path: jobs/plaud-ingest-crawl.yaml
  services:
    - path: services/plaud-broker      # dir containing service.yaml + source
      version: 1.0.0                   # REQUIRED for services; must match service.yaml

# ── Dependencies — external, NOT bundled (optional) ───────────────────────────
dependencies:
  - brain-architecture          # package name; verified, not installed

# ── Credentials (optional; discovery/orchestration metadata) ──────────────────
credentials_needed: []
provides_credentials:
  - plaud                       # e.g. via plaud-login

# ── Install interface (optional) ──────────────────────────────────────────────
# Invoked ONLY for package-specific steps the installer can't infer. The installer
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
| `installer` | Optional |
| `dependencies`, `credentials_needed`, `provides_credentials` | Optional |
| `install_entry`, `install_flags` | Optional |
| `components.skills[].version` | **Required** — must equal that skill's `SKILL.md` `version` |
| `components.skills[].install_type` | Optional — `org` (default, locked) or `user` (unlocked); see §5.1 |
| `components.services[].version` | **Required** — must equal that service's `service.yaml` `version` |
| `components.{recipes,agents,jobs}[].version` | Optional |

---

## 5. Bundled component conventions

**One syntax, two file kinds — no JSON.** Content-bearing components (skill, recipe, agent) are
**Markdown** (`.md`): YAML frontmatter + a body that becomes the component's content (for an
agent, the body is its `instructions`). Config-only components (job, service descriptor) are
**YAML** (`.yaml`). Each
component's fields are fully specified below — **a package is self-describing**; the
installer maps these to its platform's stores itself, so nothing here defers to an external
"platform definition."

### 5.1 Skill — `skills/<key>/`
Layout: `SKILL.md` (flat YAML frontmatter + Markdown body) + optional `scripts/`, `tests/`.

```yaml
---
name: plaud-login              # the skill's unique name and its install <key>
version: 0.4.0                 # must equal components.skills[].version
description: "OAuth handshake for the Plaud integration…"
dependencies: []
credentials_needed: []
provides_credentials: [plaud]
triggers: [/plaud-login, "connect plaud"]
updatedAt: 2026-05-14
---
(Markdown body — the skill's content/instructions)
```

| Frontmatter | Req | Meaning / use |
|-------------|-----|---------------|
| `name` | ✅ | unique skill name + install `<key>`; kebab-case, ≤100 chars |
| `version` | ✅ | must equal `components.skills[].version` |
| `description` | ✅ | discovery text (third-person, trigger words) |
| `dependencies` | – | external prereqs (skill keys / package names) |
| `credentials_needed`,`provides_credentials` | – | credential orchestration |
| `triggers` | – | agent-facing invocation phrases |
| `updatedAt` | – | informational |

The installer registers the skill and copies the whole skill tree to its configured skill
install root. The manifest is deliberately **unaware of that location** — it is an
installer/operator concern.

**Registration type (`install_type`):** the component entry's optional `install_type`
controls how the skill is registered. `org` (the default) registers it as an
organization-level skill, **locked** against casual edits; `user` registers it as an
unlocked user-level skill. The value must be `org` or `user` (anything else is a manifest
error). The installer's `--install-skills-as-user` flag forces **all** skills to `user`,
overriding any per-skill `install_type`.

### 5.2 Recipe — `recipes/<name>.md`
Markdown file: YAML frontmatter + Markdown body.

```yaml
---
name: plaud-pipeline           # unique recipe name (lookup key)
description: "End-to-end Plaud capture → brain pipeline."
version: 1.0.0                 # optional; if set, must equal components.recipes[].version
---
(Markdown body — the recipe's content)
```

| Frontmatter | Req | Meaning / use |
|-------------|-----|---------------|
| `name` | ✅ | unique lookup key; ≤200 chars |
| `description` | ✅ | required discovery text |
| `version` | – | optional pin |

### 5.3 Agent — `agents/<name>.md`
Markdown file: YAML frontmatter for the config fields + a Markdown body that becomes the agent's
**`instructions`** (its persona / system-prompt text). An empty body leaves `instructions` at the
DB default.

```yaml
---
name: plaud-agent              # canonical identifier — same pattern as every other component
display_name: Plaud Agent
description: "Runs the Plaud capture + ingest pipeline."
mode: cli                      # optional, default cli
default_model: sonnet          # optional, default sonnet
icon: "🎙️"                     # optional, default 🤖
provider: claude               # optional, default claude
system_prompt_path: prompts/plaud.txt   # optional
capabilities: [search, recall]          # optional, default []
skills: [plaud-login, plaud-ingest, memory]   # attached iff installed + active
recipes: [plaud-pipeline]                      # attached by recipe name
---
(Markdown body — the agent's `instructions`)
```

| Field | Req | Meaning / use |
|-------|-----|---------------|
| `name` | ✅ | unique agent identifier; ≤50 chars |
| `display_name` | ✅ | human display name |
| `description` | – | discovery text |
| `mode` | – | execution mode (default `cli`) |
| `default_model` | – | model alias (default `sonnet`) |
| `icon` | – | display icon (default `🤖`) |
| `provider` | – | model provider (default `claude`) |
| `system_prompt_path` | – | path to an external system-prompt file |
| `capabilities` | – | list of capability tags (default `[]`) |
| `skills` | – | skill names to attach; a skill that is not installed + active is **skipped with a warning**, not an error |
| `recipes` | – | recipe names to attach |
| *(body)* | – | Markdown → the agent's `instructions` |

Every frontmatter field is optional except `name`/`display_name`; an omitted field rides its DB
default rather than overwriting an existing value. Agents install after skills and recipes, so the
bundled components they reference are attachable. Re-installing an agent **syncs** its attachments:
desired links are added, stale links are removed.

### 5.4 Job (scheduled / background) — `jobs/<name>.yaml`
```yaml
name: plaud-ingest-crawl
description: Hourly Plaud sync into brain
schedule: "0 * * * *"          # cron, or alias: hourly | every-15-min | every-30-min | daily
script: plaud-ingest/scripts/crawl-plaud.js   # path under the skill install root: <skill-key>/scripts/<file>
args: "--limit 50"             # optional
timezone: America/Vancouver    # optional, default UTC
timeout_minutes: 10            # optional, default 30
max_concurrent: 1              # optional, default 1
skip_if_running: true          # optional, default true
enabled: true                  # optional, default true
requires: [plaud-ingest]       # optional: skill keys that must be installed first
```

| Field | Req | Meaning / use |
|-------|-----|---------------|
| `name` | ✅ | unique job name (lookup key); ≤255 chars |
| `schedule` | ✅ | cron expression or alias (`hourly`/`every-15-min`/`every-30-min`/`daily`) |
| `script` | ✅ | path under the skill install root (`<skill-key>/scripts/<file>`) — the bundled skill ships the script; the installer resolves the absolute path |
| `description` | – | discovery text |
| `args` | – | appended to the script invocation |
| `timezone` | – | default `UTC` |
| `timeout_minutes` | – | default `30` |
| `max_concurrent` | – | default `1` |
| `skip_if_running` | – | default `true` |
| `enabled` | – | default `true` |
| `requires` | – | skill keys whose install must exist before the job registers (coarse guard against a job that fails every tick) |

If a `requires` skill is absent the installer halts with a two-ways-forward message —
install the skill, or scope the run to the other types with `--type`. Deeper
dynamic-import-chain checks are the package's `install_entry` job.

### 5.5 Service (standalone web app) — `services/<name>/`
Layout: `service.yaml` + the application source. A service is a long-running process
deployed behind the platform's process manager and reverse proxy; it is not an
agent-registry resource.

```yaml
name: plaud-broker
version: 1.0.0                 # REQUIRED — must equal components.services[].version
port: 4300                     # optional — installer allocates a free port if omitted
start: node server.js
cwd: ./                        # optional, default ./
build: npm ci && npm run build # optional — command run during the build step
env:                           # optional → written to the service's env file (secrets never logged)
  NODE_ENV: production
nginx:                         # optional — reverse-proxy exposure
  subdomain: plaud             # default: <name>
  ssl: true                    # default: true
```

| Field | Req | Meaning / use |
|-------|-----|---------------|
| `name` | ✅ | service identity: deploy dir name, process name, default subdomain |
| `version` | ✅ | must equal `components.services[].version` (mirrors skills) |
| `port` | – | listen port; if omitted, the installer allocates a free one |
| `start` | ✅ | process start command |
| `cwd` | – | working dir relative to the service dir (default `./`) |
| `build` | – | command run during the **build step** (e.g. `npm ci && npm run build`) |
| `env` | – | key/values written to the service's env file; **secrets never echoed to logs** |
| `nginx.subdomain` | – | public hostname label under the platform's service domain (default `<name>`) |
| `nginx.ssl` | – | serve over TLS (default `true`) |

**Dry-run semantics:** unlike registry components (whose dry-run is a pure preview), a
service dry-run **runs the build step** (surfacing build errors) but **skips the deploy
apply** — no proxy, process-manager, or port changes.

---

## 6. Install / uninstall order & standard flags

- **Install order:** skills → recipes → agents → jobs → services; within a type, array order.
- **Uninstall:** exact reverse.
- Finer control than this ordering implies → use `install_entry`.

**Standard flags — installer-owned, never declared in the manifest:**
`--dry-run`, `--status`, `--uninstall`, `--respect-locks`, `--install-skills-as-user`,
`--type=<types>`, `--include=<pat>`, `--exclude=<pat>`, `--json`, `--help`. The installer forwards
the run-shaping flags to `install_entry` (argv) so package-specific steps can honor them.
`install_flags` is ONLY for package-specific flags (e.g. `--no-ingest`).

**Strict validation.** The installer accepts the standard flags **plus** exactly the flags this
manifest declares in `install_flags`. Any other option — or a value flag (`--type`/`--include`/
`--exclude`) given no value — is rejected with a message and a usage exit (`2`); the run does not
proceed. `--help` prints usage and exits `0`. `install_flags` is therefore enforced, not merely
forwarded, and a declared name may not shadow a standard flag.

- `--install-skills-as-user` registers every skill as an unlocked `user` skill, overriding
  the org default and any per-skill `install_type` (§5.1).
- `--type=<types>` restricts which component **types** run — one or more of
  `skills`/`recipes`/`agents`/`jobs`/`services`, comma-separated and/or the flag repeated
  (e.g. `--type=skills,recipes`). Order within a type and across types always follows the
  canonical install order.
- `--include`/`--exclude` select a subset of components **by `name`** (the same field across
  every component type). The value is a regex; a value with no regex metacharacter is an
  exact `^name$` match (case-sensitive). A component is selected iff it matches `--include`
  (or none is given) and does not match `--exclude`; these compose with `--type`. A filter
  matching zero components warns and exits `0`.

---

## 7. NOT in the manifest — installer responsibilities

These hold for **every** package; keeping them out of the manifest is deliberate. A
compliant installer guarantees:

- **Idempotency** — re-running an install converges to the same state with zero drift.
- **Clean lifecycle** — uninstall removes everything the install created; reinstall
  reproduces the original state.
- **Configurable install locations** — where skill trees land and where registry writes go
  are operator/installer configuration; the manifest never encodes them.
- **Dry-run** — a preview mode with zero side effects (build-only for services, §5.5).
- **Prerequisite checks before any write** — halt with an actionable message, not a
  half-installed package.
- **Secret hygiene** — service `env` values are written to the service's env file only,
  never logged; packages are scanned for embedded secrets before publish, not at install.
- **An install log** — a machine-readable record of installed components (name, version,
  source package + package version, date, source file), one entry per component, maintained
  outside the package and removed on uninstall.
- **A machine-parseable result contract** — §8.

How the CRHQ reference implementation delivers these is specified in
`canon-conventions.md` (conventions C1–C13) and `integration-reference.md` (storage
mapping).

---

## 8. Result taxonomy

Not a manifest field, but the output contract a compliant installer prints so installs are
machine-parseable. Per-component verdicts:

`INSTALL-OK | ALREADY-INSTALLED | INSTALL-PARTIAL | INSTALL-FAIL | PREREQ-MISSING | LOCKED-ROW`

Exit codes: `0` ok/already-installed · `1` fail/prereq/lock · `2` transport (registry
unreachable, manifest unreadable, usage error).
