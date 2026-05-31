# Ai1 Package Standard — ThinkBot hardening review

**For:** Tamás (Affable Co.) · **From:** Justin / ThinkBot · **Date:** 2026-05-30
**Re:** your draft `Ai1 Package Standard` (2026-05-27)

Tamás — the standard is a strong skeleton; the manifest + directory layout + utility-owns-lifecycle model are exactly right and we're adopting them internally as-is. We get that your goal is **org-distribution** — one `ai1-crhq-installer` that grabs a package bundle and installs the components onto a satellite (with Plaud as your test case). Below are hardening notes from real CRHQ-satellite installs we've shipped + reviewed (the Plaud suite, the dev-handoff suite).

**Two buckets.** Our lessons come from **locally-run, per-skill installers** (`node scripts/install.mjs`). Your `ai1-crhq-installer` is a **platform-level org-distribution path** that may legitimately differ (where it writes, how agents attach, what API it uses). So:

- **A) 8 universal burns** — environment-independent; they bite any install path including yours. Cited to runnable code + version-stamped CHANGELOG entries.
- **B) verify-against-YOUR-org-path** — true for *local* installs; the org path may handle them natively. Flagged, not asserted.

Sources are cited so you can check each one — the canon Plaud + dev-handoff installers and their CHANGELOGs (the version-stamped fixes), plus one live authenticated read of `ai1-dev` on 2026-05-30 that settled a couple of these against the real platform.

---

## A) Universal burns (apply to any install path, including org-distribution)

| # | Gap | In your draft? | We verified | One-line fix |
|---|---|---|---|---|
| 2 | `skills` PK is `name` (no `id` column) | ❌ Missing | ✅ live-confirmed on ai1-dev | `.where({name})`; never `.returning('id')` |
| 3 | Prereq `existsSync` before cron rows | 🟡 Partial | canon code + live dormant-cron evidence | declaring a dep ≠ enforcing it; check files before registering jobs |
| 4 | No blanket `sudo` in docs | ❌ Missing | canon installers (no sudo anywhere) | operator commands use plain `node` |
| 5 | Idempotency (check-then-upsert) | 🟡 Partial | canon code | re-run = update-or-skip, never blind-insert |
| 8 | `installer-sandbox` validation gate | ❌ Missing | present in `ai1-system` (3 scripts) | install→status→idempotency→uninstall→reinstall before publish |
| 9 | Secret-pattern scan + satellite-reality gaps | ❌ Missing | our pre-publish gate | scan for keys/PEM/.env before publish |
| 10 | `CRHQ_BASE_DIR` override | ❌ Missing | canon code (line-cited) | `process.env.CRHQ_BASE_DIR || '/opt/...'` so sandbox can isolate |
| 11 | Install-result taxonomy | ❌ Missing (advanced) | canon code + tests | machine-parseable run verdicts across satellites |

## B) Verify against YOUR org-install path (the live read partly settled #1)

> **Live read of `/api/settings/skills` on ai1-dev (HTTP 200, 2026-05-30):** `skill_type` has **four** values, each with a different on-disk location (from the live `skill_dir` field):

| skill_type | live count | on-disk (`skill_dir`) |
|---|---|---|
| `system` | 12 | under `skills/` (hub-synced; `skill_dir` null, path `skills/<name>/SKILL.md`) |
| `store` | 4 | under `skills/` |
| `user` | 39 | **`/opt/projects/crhq-satellite/user-skills/<name>`** ✅ |
| `org` | 7 | `skill_dir: null` (not exposed by API) — **your path** |

| # | Question for the org path | What the live read showed | How to settle it |
|---|---|---|---|
| 1 | Where do org-distributed skills land? | **`user`-type skills confirmed under `user-skills/`** (real `skill_dir`). **`org`-type skills** (your path — 7 already live, e.g. `brain-installer`, `org_skill_id:98 org_version:4`) report `skill_dir: null`, so where they physically land is **not** exposed remotely. | Install Plaud via your path → check the `org` row's on-disk location on the box. |
| 6 | Do org-distributed skills need an explicit agent attachment to be invocable? | **Not assessable from this endpoint** — the skill record carries no agent field. | After org-install, open a session and try invoking a Plaud skill with no manually-attached agent. |
| 7 | Should the installer write via direct knex or an API? | Your design choice — flagging only that the `cr-api` HTTP shim was brittle for us locally. | n/a — your call. |

Legend: ❌ absent · 🟡 mentioned but not enforced · ✅ live-confirmed on ai1-dev 2026-05-30.

---

## The annotated diff — where each gap attaches to YOUR doc

> Maps our additions onto your existing section headings so you can drop them in.

### → your **"Install Interface"** section
Your model (utility owns `--dry-run`/`--status`/`--uninstall`; `install.mjs` for package-specific steps) is the right split. Add the universal ones as **utility-enforced** at register-time:

- **[Gap 2 — universal, live-confirmed] `skills` table PK is `name`, no `id` column.** `.where({name})` for updates; `.first()` then `row.name` for status; **no `.returning('id')`** (errors at runtime on a column-less table; `.where({id})` silently matches zero rows → a "successful" install that updated nothing). *Source:* live `GET /api/settings/skills` on ai1-dev 2026-05-30 — record keys are `name, description, skill_path, skill_dir, is_global, is_active, created_at, locked, locked_at, locked_by, content, updated_at, search_embedding, skill_type, hub_version, hub_synced_at, org_skill_id, org_version`; **no `id`**, PK is `name`, type field is `skill_type`, lock is `locked`. + `plaud-login/scripts/install.mjs:147,155,160,175-187` · CHANGELOG v0.3.2.
- **[Gap 10 — universal] `CRHQ_BASE_DIR` override.** `const BASE = process.env.CRHQ_BASE_DIR || '/opt/projects/crhq-satellite'` — never hardcode the base path, so the sandbox (Gap 8) can redirect FS writes to a temp dir. *Source:* `plaud-installer/scripts/install.mjs:36`.
- **[Gap 1 — ⚠️ partly verified] Install target.** Live `skill_dir` shows **`user`-type skills under `/opt/.../user-skills/<name>`** ✅ and `system`/`store` under `skills/`. But **`org`-type skills (your path) report `skill_dir: null`** — the API doesn't expose where org skills physically land. For our *local* installs the agent user could only write `user-skills/` (`skills/` is `webuser:crhq` mode-700; a mis-set `system` died at `mkdir → Permission denied`). Settle the org case by inspecting an `org` install on the box. *Source:* `plaud-login/scripts/install.mjs:42-52` · CHANGELOG v0.3.1.
- **[Gap 6 — ⚠️ verify vs org-path] Agent attachment.** For *local* installs, a skill with no `agent_skills` join was UI-unreachable, so we attach a dedicated agent by default + offer `--no-agent`/`--respect-locks`. The live `/api/settings/skills` record carries no agent field, so we couldn't measure attachment from it — worth confirming whether org-imported skills are reachable in-session without an explicit attach. *Source:* `plaud-installer/scripts/install.mjs:62-64`.

### → your **"Dependencies"** section
- **[Gap 3 — universal] Enforce declared prereqs at install-time.** You have `dependencies: [...]` — strengthen it: declaring a dep is documentation; the installer **must `existsSync()` the actual imported files before registering any cron/job that imports them**, else the job fires every tick into `ERR_MODULE_NOT_FOUND` (silently — the scheduler swallows it). Halt with a two-ways-forward message; provide `--no-job`. *Source:* `plaud-ingest/scripts/install.mjs:231-254` + `plaud-installer/scripts/install.mjs:116-141` · CHANGELOG plaud-installer v0.1.1 · the burn: plaud-ingest v0.1 cron imported a missing dependency and fired into ERR_MODULE_NOT_FOUND every tick. *(Live corroboration: a satellite note on ai1-dev flags installer-created background_jobs sitting dormant with `next_run_at=NULL`.)*

### → your **"Bundled Component Conventions" / install.mjs**
- **[Gap 5 — universal] Idempotency.** Re-running an install MUST NOT duplicate rows or needlessly rewrite files — check-then-insert-or-update, write-if-changed, `onConflict.ignore()` on joins. *Source:* `plaud-login/scripts/install.mjs:147-187` · the canon `token-trimmer-installer` uses this universally.
- **[Gap 4 — universal] No blanket `sudo` in INSTALL.md/SKILL.md.** Operator commands should use plain `node` — on many satellites the agent user has **no sudo** → `sudo node ...` fails with `not in sudoers`. *Source:* CHANGELOG plaud-installer v0.1.1 · zero `sudo` in any canon installer.
- **[Gap 7 — ⚠️ verify vs org-path] Direct knex vs an API.** Our *local* installers write via `getDb` from `server/db/knex.js` for atomicity; the `cr-api` **HTTP shim** was brittle for us (needs a running server, non-atomic). **Your platform installer may have a proper internal API that's the right call there** — your design choice; we're only flagging the brittleness we hit.

### → NEW section we'd suggest: **"Publish-readiness gate"**
- **[Gap 8] `installer-sandbox` validation.** Before publish, run the package through an isolated PG schema + temp `CRHQ_BASE_DIR` exercising **install → status → idempotency → uninstall → reinstall**. Catches dry-run-blind failures before a real box does. Your per-package `smoke-test.mjs` is complementary but narrower. *Source:* `ai1-system/user-skills/installer-sandbox/scripts/{test,sandbox-knex,sandbox-hooks}.mjs` (already in canon).
- **[Gap 9] Secret-pattern scan.** Scan staged package content for secret patterns (API keys, tokens, `.env`, `credentials.json`, `id_rsa`, PEM bodies, `.p12/.pfx`, browser cookies/storage-state) before publish — never ship credentials in a package. Pair with git-identity + large-file checks. *(We run a ~20-pattern pre-publish gate on our side; happy to share the pattern set.)*
- **[Gap 11] (advanced/optional) Install-result taxonomy.** A fixed result vocabulary — `INSTALL-OK / ALREADY-INSTALLED / INSTALL-PARTIAL / INSTALL-FAIL / PREREQ-MISSING / LOCKED-ROW` + exit codes (0 ok/already · 1 fail/prereq/lock · 2 transport) — makes install outcomes machine-parseable across satellites. *(We use this in our internal install-runner + verdict parser; happy to share.)*

---

## Where your draft already nails it (credit)

- **`ai1-package.yaml` manifest** with identity / classification / components-with-version-pins / dependencies / credentials — clean, adopting as-is.
- **Required root trio** (`ai1-package.yaml` + `CHANGELOG.md` + `README.md`) — matches our "CHANGELOG from v0.1" rule.
- **Flat YAML frontmatter, no `<!-- SKILL-META -->` block** — agrees with where we landed.
- **Semver + per-component version pinning** (component version must match its `SKILL.md`).
- **Utility owns the lifecycle flags; `install_entry` optional** — right architecture; the universal items are what that utility should enforce at register-time.
- **Omit-unused-dirs, declarative-only packages valid** — good.
- **Org-distribution is already live + populated:** 7 `org`-type skills are installed on ai1-dev today (e.g. `brain-installer` `org_skill_id:98`), surfaced via `skill_type:'org'` with `org_skill_id`/`org_version` — so you're building on an existing mechanism, not from zero.

---

## How these map onto your installer-utility model

Your design has the external utility own the lifecycle, so most of the universal items belong **in the utility**, not each package's `install.mjs`:

- **Utility enforces at register-time:** Gap 2 (name-PK), Gap 5 (idempotent upsert), Gap 9 (secret scan), Gap 11 (verdict taxonomy).
- **Package `install.mjs` (the package-specific hook):** Gap 3 (prereq `existsSync` — only the package knows its cron's dynamic-import chain), Gap 10 (`CRHQ_BASE_DIR` honor).
- **Validation harness wraps both:** Gap 8 (`installer-sandbox`).
- **Docs/operator-facing:** Gap 4 (no `sudo`).
- **Decide together against the org-path:** Gaps 1, 6, 7 (bucket B) — your call once we've confirmed how your installer writes/attaches.

---

## Verification basis

- Every gap is cited to **canon installer code** (file:line) + the **version-stamped CHANGELOG entries** where each fix landed.
- **One live authenticated read (2026-05-30, HTTP 200)** of `/api/settings/skills` on ai1-dev confirmed **GAP 2** (no `id` field; PK `name`; type field `skill_type`; lock `locked`) and the four `skill_type` values (`system` 12, `store` 4, `user` 39, `org` 7). **GAP 1 partly settled** via `skill_dir` — `user` → `/opt/.../user-skills/`, `system`/`store` → `skills/`, `org` → `skill_dir: null` (org target still open). `/api/skills/org` → 404 (org skills surface via `skill_type:'org'`).
- **GAP 6** isn't assessable from that endpoint (no agent field) — needs an install→session→invoke test, which your Plaud build is the natural occasion for.

---

## One open question for you

Your unified `ai1-crhq-installer` utility owns the lifecycle flags. For the **universal** install-time enforcements above (name-PK, idempotency, secret-scan, sandbox, verdict taxonomy) — baked into the **utility** (every package gets them free), or specified as **requirements each package's `install.mjs` must satisfy**? We'd lean utility-owned for the cross-cutting ones and package-hook for the package-specific ones (3, 10). And for **bucket B** (org target / agent / write-path) — once your installer exists, let's compare notes on how it actually behaves rather than us guessing from the local-install side.

*Happy to share the exact diffs, the canon installers, or our secret-scan pattern set directly.*
