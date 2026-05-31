# Ai1 Package Standard — ANNOTATED with ThinkBot notes

> Tamás's original 2026-05-27 draft **verbatim**, with ThinkBot comments inline as `> 💬 [ThinkBot]` callouts. Each callout cites runnable code (canon `install.mjs` file:line, version-stamped CHANGELOG entries) and a verification status. Companion summary: `tamas-package-standard-REVIEW.md`. Source: `tamas-ai1-package-standard.md`.

---

**Status:** Draft — for dev team review
**Date:** 2026-05-27

## Overview

An **Ai1 package** is a versioned, self-contained directory tree that bundles one or more skills, agents, recipes, and/or cron jobs for coordinated deployment. A package is the right unit when components are tightly coupled — they share a common purpose, must be installed in order, or are meaningless without each other.

A single `ai1-package.yaml` file at the root of the tree is the canonical machine-readable manifest.

> 💬 **[ThinkBot] ✅ Agree fully.** The package-as-unit + single-manifest model matches how we bundle (Plaud = login + ingest + installer + agent + cron). Adopting `ai1-package.yaml` internally as our multi-unit format.

## Directory Layout

```
<package-name>/                ← kebab-case name
  ai1-package.yaml             ← canonical manifest (required)
  CHANGELOG.md                 ← required; semver history
  README.md                    ← human-facing docs + usage
  skills/<skill-key>/SKILL.md, scripts/, tests/
  agents/<agent-key>.json
  recipes/<name>.md
  scheduled-jobs/<name>.json
  scripts/install.mjs          ← main entry point; sequences component installs
  scripts/smoke-test.mjs       ← post-install validation (optional)
  services/
  data/
```

> 💬 **[ThinkBot] ⚠️ GAP 1 (partly verified — install TARGET).** Where do components *register on the satellite*? A live read of `/api/settings/skills` (2026-05-30, HTTP 200) shows `skill_type` has **four** values, each with a distinct on-disk location (live `skill_dir` field): `user` (39) → **`/opt/projects/crhq-satellite/user-skills/<name>`** ✅, `system` (12) + `store` (4) → `skills/`, **`org` (7) → `skill_dir: null`** (not exposed). So our `user-skills/` rule is **confirmed for the non-org path**; the **org path (yours)** doesn't expose its target via the API — settle by inspecting an `org` install on the box. (`/api/skills/org` 404s — org skills surface via `skill_type:'org'`, not a dedicated route; `org` rows carry `org_skill_id`/`org_version`.) *Source:* `plaud-login/scripts/install.mjs:42-52` · CHANGELOG v0.3.1.

> 💬 **[ThinkBot] ⚠️ GAP 4 — no blanket `sudo`.** Wherever docs/`scripts/` show operator commands: use plain `node`, never `sudo node`. The agent owns `user-skills/` (775) so sudo is unneeded, and many satellites' agent user has no sudo → `sudo node …` fails `not in sudoers`. *Source:* CHANGELOG plaud-installer v0.1.1; zero `sudo` in any canon installer.

**Rules:**
- `scripts/` at the package root is for installer orchestration only. Component-level scripts live inside their own subtree.
- Unused component dirs are omitted — don't create empty dirs.
- A package with no `scripts/install.mjs` is valid (declarative-only).

> 💬 **[ThinkBot] ✅ Good rules.** "Omit unused dirs" + "declarative-only valid" both match our practice.

## ai1-package.yaml Schema

```yaml
name: plaud-suite
version: 1.0.0
description: >
  Full Plaud voice-recorder stack...
installer: 1.0.0
triggers: [/plaud-suite, "install plaud", ...]
category: Integration-suite
classification: client-facing
complexity: Beginner
foundational: false
status: stable
components:
  skills:
    - path: skills/plaud-login
      version: 0.4.0           # must match version in that skill's SKILL.md
  agents: [...]
dependencies:
  - brain-architecture
credentials_needed: []
provides_credentials: [plaud]
install_entry: scripts/install.mjs   # optional
install_flags:
  - name: --no-ingest
```

> 💬 **[ThinkBot] ✅ Strong manifest.** Identity + classification + component version-pinning + `install_entry` optional are all right. Nice touch: pinning component version to its `SKILL.md`.

> 💬 **[ThinkBot] ⚠️ GAP 6 (verify vs org-path) — agent attachment + lock flags.** For our **local** installs, a skill with no `agent_skills` join was UI-unreachable, so we attach a dedicated agent by default and offer `--no-agent` + `--respect-locks`. **You're likely right that org-imported skills are reachable in-session without an explicit attach** (they're in the DB) — worth confirming: after an org-install, open a session and try invoking a Plaud skill with no manually-attached agent. If it's reachable, this isn't needed for the org path. *Source:* `plaud-installer/scripts/install.mjs:62-64`.

> 💬 **[ThinkBot] ⚠️ GAP 9 — `credentials_needed` ≠ secret hygiene.** You track *which* creds a package needs — good — but there's no rule against **shipping** secrets inside the package. Add a publish-time secret-pattern scan (API keys, tokens, `.env`, `credentials.json`, `id_rsa`, PEM bodies, `.p12/.pfx`, browser cookies/storage-state). *(We run a ~20-pattern pre-publish gate on our side; happy to share the pattern set.)*

**Required fields:** `name`, `version`, `description`, `shape`, `components`
**Optional but recommended:** `triggers`, `dependencies`, `install_flags`, `status`

> 💬 **[ThinkBot] 🟡 Nit:** required list says `shape` but the example uses `category`/`classification` — worth reconciling which is the canonical field name.

## Bundled Component Conventions

### Skills
- `SKILL.md` with flat YAML frontmatter — no separate `<!-- SKILL-META -->` HTML comment block.
- Independently versioned; version must match `components.skills`.

> 💬 **[ThinkBot] ✅ Flat-YAML-frontmatter, no HTML-comment block — agrees with where we landed.**

### Agents / Recipes / Cron Jobs
Same JSON/MD schemas as platform definitions.

> 💬 **[ThinkBot] ⚠️ GAP 3 — enforce prereqs before registering a cron.** Your `dependencies:` array is declarative (the utility can verify listed skills exist). But a cron's *dynamic-import chain* is package-specific: the installer MUST `existsSync()` the actual imported files **before** inserting the `scheduled-jobs` row, else the job fires every tick into `ERR_MODULE_NOT_FOUND` — silently (scheduler swallows it). Halt with a two-ways-forward msg + `--no-job` escape. *Source:* `plaud-ingest/scripts/install.mjs:231-254` + `plaud-installer/scripts/install.mjs:116-141` · CHANGELOG plaud-installer v0.1.1. The burn: plaud-ingest v0.1 cron imported a missing dependency and fired ERR_MODULE_NOT_FOUND every tick.

## Versioning
- Package version = semver for the suite. Components versioned independently + pinned. `CHANGELOG.md` required. Bumping a component requires ≥ a patch bump of the package.

> 💬 **[ThinkBot] ✅ Agree.** Mirrors our "CHANGELOG from v0.1" rule — that's exactly where our version-stamped fixes live (the citations above).

## Install Interface

An external **installer utility** drives the standard lifecycle: reads `ai1-package.yaml`, registers components, verifies dependencies, handles `--dry-run` / `--status` / `--uninstall`. `install.mjs` is invoked only for **package-specific steps**; `install_entry` is optional.

> 💬 **[ThinkBot] ✅ This split is the right architecture.** Our hardening items are mostly *what the utility should enforce at register-time*. Mapping:
> - **Utility enforces:** GAP 2 (name-PK), GAP 5 (idempotent upsert), GAP 9 (secret scan), GAP 11 (verdict taxonomy).
> - **Package `install.mjs` hook:** GAP 3 (prereq existsSync), GAP 10 (`CRHQ_BASE_DIR`).
> - **Validation harness wraps both:** GAP 8 (installer-sandbox).
> - **Decide together vs the org path:** GAP 1 (target), GAP 6 (agent), GAP 7 (write path).

> 💬 **[ThinkBot] ✅ GAP 2 (live-confirmed 2026-05-30) — DB write contract (the utility needs this).** Live `GET /api/settings/skills` on ai1-dev (HTTP 200): the record has **no `id` field**; PK is **`name`** (type field is `skill_type`, lock is `locked`). Use `.where({name})` for updates, `.first()`→`row.name` for status; **never `.returning('id')`** (errors at runtime) and never `.where({id})` (silently matches zero rows → "successful" install that updated nothing). *Source:* `plaud-login/scripts/install.mjs:147,155,160,175-187` · CHANGELOG v0.3.2; universal `.where('name'/'key')` across canon installers.

> 💬 **[ThinkBot] ⚠️ GAP 7 (verify vs org-path) — write path.** Our **local** installers write via `getDb` from `server/db/knex.js` for atomicity; the `cr-api` **HTTP shim** was brittle for us (needs a running server, non-atomic). **Your platform installer may have a proper internal API that's the right call there** — flagging only the brittleness we hit with the HTTP shim, not prescribing knex for your path.

> 💬 **[ThinkBot] ⚠️ GAP 5 — idempotency is a hard requirement, not implied.** Re-run = check-then-insert-or-update + write-if-changed + `onConflict.ignore()` on join tables. Never blind-insert. *Source:* `plaud-login/scripts/install.mjs:147-187`.

> 💬 **[ThinkBot] ⚠️ GAP 10 — `CRHQ_BASE_DIR` override.** Package `install.mjs` must honor `const BASE = process.env.CRHQ_BASE_DIR || '/opt/projects/crhq-satellite'` — never hardcode the base path — so the sandbox (GAP 8) can redirect FS writes. *Source:* `plaud-installer/scripts/install.mjs:36`.

> 💬 **[ThinkBot] ⚠️ GAP 8 — add a publish-readiness gate.** Before a package is publishable, run it through `installer-sandbox`: isolated PG schema + temp `CRHQ_BASE_DIR`, exercising **install → status → idempotency → uninstall → reinstall**. This catches the dry-run-blind failures (GAPs 1, 2) before a real box does. Your per-package `smoke-test.mjs` is complementary but narrower. *Source:* `ai1-system/user-skills/installer-sandbox/scripts/{test,sandbox-knex,sandbox-hooks}.mjs` (already in canon).

> 💬 **[ThinkBot] ⚠️ GAP 11 (advanced) — result taxonomy.** Define a fixed install-outcome vocabulary so runs are machine-parseable across satellites (needed for any automated push loop): `INSTALL-OK / ALREADY-INSTALLED / INSTALL-PARTIAL / INSTALL-FAIL / PREREQ-MISSING / LOCKED-ROW` + exit codes (0 ok/already · 1 fail/prereq/lock · 2 transport). *(We use this in our internal install-runner + verdict parser; happy to share.)*

| Flag | Handled by |
|---|---|
| `--dry-run` / `--status` / `--uninstall` | Installer utility |

> 💬 **[ThinkBot] ✅ Correct.** Add `--respect-locks` + `--no-agent` here (GAP 6).

## Dependencies

The `dependencies` array lists external prerequisites — installed separately, declared so the installer can verify or delegate.

> 💬 **[ThinkBot] ✅ Right concept** — see GAP 3 for the install-time *enforcement* layer that complements this declaration.

---

## Verification basis

Citations are against **canon installer code + the version-stamped CHANGELOG entries** where each fix landed, plus one **authenticated live read** of `/api/settings/skills` on ai1-dev (2026-05-30, HTTP 200). That read **confirmed GAP 2** (no `id` column; PK `name`; type field `skill_type`; lock `locked`) and showed `skill_type` has four live values (`system` 12, `store` 4, `user` 39, `org` 7). **GAP 1 partly settled** via the live `skill_dir` field — `user` skills are under `/opt/.../user-skills/`, but `org` skills (your path) report `skill_dir: null`, so the org target stays open. **GAP 6** isn't assessable from that endpoint (no agent field on the record); `/api/skills/org` 404s (org skills surface via `skill_type:'org'`).
