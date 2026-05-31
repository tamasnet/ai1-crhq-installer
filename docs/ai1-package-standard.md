# Ai1 Package Standard

**Status:** Draft — for dev team review  
**Date:** 2026-05-27

---

## Overview

An **Ai1 package** is a versioned, self-contained directory tree that bundles one or more skills, agents, recipes, and/or cron jobs for coordinated deployment. A package is the right unit when components are tightly coupled — they share a common purpose, must be installed in order, or are meaningless without each other.

A single `ai1-package.yaml` file at the root of the tree is the canonical machine-readable manifest.

---

## Directory Layout

```
<package-name>/                ← kebab-case name
  ai1-package.yaml             ← canonical manifest (required)
  CHANGELOG.md                 ← required; semver history
  README.md                    ← human-facing docs + usage

  skills/                      ← bundled skills (each a complete, standalone skill tree)
    <skill-key>/
      SKILL.md
      scripts/
      tests/                   ← optional
    <skill-key>/
      ...

  agents/                      ← bundled agent definitions (omit if unused)
    <agent-key>.json

  recipes/                     ← bundled recipe definitions (omit if unused)
    <recipe-name>.md

  scheduled-jobs/                   ← bundled job definitions (omit if unused)
    <job-name>.json

  scripts/                     ← package-level orchestration ONLY
    install.mjs                ← main entry point; sequences component installs
    smoke-test.mjs             ← post-install validation (optional)

  services/                    ← bundled services, e.g. web apps/APIs (omit if unused)

  data/                        ← optional: shared assets/configs spanning components
```

**Rules:**
- `scripts/` at the package root is for installer orchestration only. Component-level scripts live inside their own subtree (e.g. `skills/plaud-login/scripts/`).
- Unused component dirs (`agents/`, `recipes/`, `scheduled-jobs/`) are omitted — don't create empty dirs.
- A package with no `scripts/install.mjs` is valid (declarative-only).

---

## ai1-package.yaml Schema

```yaml
# ── Identity ──────────────────────────────────────────────────────────────────
name: plaud-suite           # kebab-case, globally unique
version: 1.0.0              # semver
description: >
  Full Plaud voice-recorder stack. One-command install of OAuth login,
  hourly brain ingest, and the background job that drives it.
installer: 1.0.0            # minimum installer utility version required

# ── Discovery (agent-facing) ──────────────────────────────────────────────────
triggers:
  - /plaud-suite
  - "install plaud"
  - "deploy plaud"
  - "set up plaud"

# ── Classification ────────────────────────────────────────────────────────────
category: Integration-suite
classification: client-facing
complexity: Beginner
foundational: false
status: stable              # draft | mvp-draft | stable | deprecated

# ── Components (explicit inventory of bundled items) ──────────────────────────
components:
  skills:
    - path: skills/plaud-login      # relative to package root
      version: 0.4.0                # must match version in that skill's SKILL.md
    - path: skills/plaud-ingest
      version: 0.2.3
  agents:
    - path: agents/plaud-agent.json
  recipes: []
  cron_jobs: []

# ── Dependencies (external — installed separately, not bundled) ───────────────
dependencies:
  - brain-architecture            # skill key or package name

# ── Credentials ───────────────────────────────────────────────────────────────
credentials_needed: []
provides_credentials:
  - plaud

# ── Install interface ─────────────────────────────────────────────────────────
# install_entry is invoked by the installer utility for package-specific steps only.
# Standard lifecycle (component registration, dependency checks, dry-run, status,
# uninstall) is handled by the utility itself — not by this script.
install_entry: scripts/install.mjs   # optional; omit if no package-specific steps needed

# Package-specific flags only — do not re-declare --dry-run / --status / --uninstall
install_flags:
  - name: --no-ingest
    description: Skip plaud-ingest; install plaud-login only
```

**Required fields:** `name`, `version`, `description`, `shape`, `components`  
**Optional but recommended:** `triggers`, `dependencies`, `install_flags`, `status`

---

## Bundled Component Conventions

### Skills (`skills/<key>/`)

Each bundled skill is a complete, independently-usable skill tree:

- `SKILL.md` with flat YAML frontmatter + markdown body. All metadata goes in frontmatter — no separate `<!-- SKILL-META -->` HTML comment block.
- `scripts/` for implementation; `tests/` for smoke tests (optional).
- Independently versioned. The version in `SKILL.md` frontmatter must match the version listed under `components.skills` in `ai1-package.yaml`.

Example `SKILL.md` frontmatter:
```yaml
---
name: plaud-login
version: 0.4.0
description: "OAuth handshake for the Plaud voice-recorder integration..."
category: Integration
classification: client-facing
complexity: Beginner
foundational: false
dependencies: []
credentials_needed: []
provides_credentials: [plaud]
triggers:
  - /plaud-login
  - "plaud login"
  - "connect plaud"
updatedAt: 2026-05-14
---
```

### Agents (`agents/<key>.json`)

Same JSON schema as platform agent definitions: `key`, `name`, `description`, `mode`, `model`.

### Recipes (`recipes/<name>.md`)

YAML frontmatter + markdown body, same format as platform recipe definitions.

### Cron Jobs (`scheduled-jobs/<name>.json`)

Same schema as platform cron job definitions.

---

## Versioning

- The package version (`ai1-package.yaml` → `version`) follows semver and represents the suite as a whole.
- Bundled components are versioned independently. Their versions are pinned in the `components` inventory.
- `CHANGELOG.md` is required and documents version history at the package level. Component-level changelogs may be maintained separately inside each component subtree.
- Bumping a bundled component version requires bumping the package version (at minimum a patch bump).

---

## Install Interface

An external **installer utility** drives the standard install lifecycle. It reads `ai1-package.yaml`, registers bundled components, verifies dependencies, and handles the standard flags:

| Flag | Handled by |
|---|---|
| `--dry-run` | Installer utility — previews all actions without making changes |
| `--status` | Installer utility — prints install status for all bundled components |
| `--uninstall` | Installer utility — removes all components in reverse dependency order |

If a package includes `scripts/install.mjs`, the utility invokes it for **package-specific steps only** — things the utility cannot infer from the manifest (e.g. provisioning an OAuth session, seeding data, starting a background process). The standard flags are forwarded to the script as environment/argv so it can respect them (e.g. skip side effects when `--dry-run` is set), but the script does not need to implement them from scratch.

`install_entry` in `ai1-package.yaml` is optional. Omit it if there are no package-specific steps beyond what the utility handles automatically.

Package-specific flags (e.g. `--no-ingest`, `--skip-agent`) are declared under `install_flags` in `ai1-package.yaml` and documented in `README.md`.

---

## Dependencies

The `dependencies` array lists external prerequisites — skills or packages that must be installed before this package can be installed. Dependencies are not bundled; they are declared so the installer can verify or delegate to them.

```yaml
dependencies:
  - brain-architecture      # atomic skill
  - security-suite          # another package
```