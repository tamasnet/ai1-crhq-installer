# ai1-satellite-tools

A **generic, manifest-driven toolkit** (a CRHQ skill) for managing a satellite's resources:
**install** versioned packages of **skills, recipes, agents, jobs, services**, **sync** live state
back into a package repo (`--mirror` = full backup), plus a **remote** client for the Ai1 Platform
Hub. DB-direct, idempotent, and self-sandboxing. It generalizes the satellite's bespoke canon
installers into one reusable utility.

**Status:** v1 complete and live. `npm test` green (sandbox-backed); zero runtime deps (`yaml`
vendored — no `npm install`). Deployed to
`/opt/projects/crhq-satellite/user-skills/ai1-satellite-tools/` and registered as a live skill;
the live service apply/remove paths are smoke-tested.

## Read first (the contracts — in `docs/`)
1. `docs/README.md` — orientation + doc map
2. `docs/package-manifest-spec.md` — the `ai1-package.yaml` input format (v1.0)
3. `docs/architecture.md` — product shape, module layout, control flow, CLI surface
4. `docs/api-design.md` — exact module/function signatures + `install.mjs` control flow
- Build rules: `docs/canon-conventions.md` (C1–C13) · DB schema + CRHQ mapping: `docs/integration-reference.md`
- Decision rationale (D-* / OQ-* IDs cited in code): `docs/decisions.md`

## Non-negotiables (violating these breaks sandboxing or safety)
- **ESM `.mjs` only.** DB access *only* via the hardcoded import
  `import { getDb } from '/opt/projects/crhq-satellite/server/db/knex.js'` (C1). No REST for writes.
- **All skill filesystem writes under `INSTALL_BASE_DIR`** — the parent dir for each skill `<key>`
  dir (D-19): `INSTALL_BASE_DIR || join(CRHQ_BASE_DIR,'user-skills') || '/opt/projects/crhq-satellite/user-skills'`.
- **`getDb()` is schema-configurable:** honor `INSTALL_SCHEMA` (`|| SANDBOX_SCHEMA`) → knex `searchPath`.
- **Idempotent** upserts; emit canon completion strings (C7); standard flags
  `--dry-run / --status / --uninstall / --respect-locks / --install-skills-as-user / --type=<types> / --include / --exclude / --json / --sandbox [--keep --lifecycle] / --help`.
  `--type` takes one or more component types (comma-separated/repeatable; renamed from `--only`).
  `--include`/`--exclude` filter components by name (regex; a metacharacter-free value is an exact `^name$` match; case-sensitive).
  **Option validation (`scripts/lib/flags.mjs`):** both CLIs reject an unsupported option or a value flag with no value (message + exit 2) before any side effect; `--help` prints usage (exit 0). Install's supported set = standard flags + the manifest's declared `install_flags` (now enforced, not just forwarded).
  **Skills default to org + `locked`** (`skill_type:'org'`); per-skill `install_type: user` in the manifest entry, or `--install-skills-as-user` (wins), registers them unlocked as `user` skills. Assets stay under `INSTALL_BASE_DIR` either way (D-22).

## Code map
`scripts/install.mjs` + `scripts/sync.mjs` + `scripts/remote.mjs` + `scripts/polaris.mjs` (CLIs) + `scripts/lib/` per `api-design.md`:
`{index, context, db, manifest, parse, fs, log, prereq, preflight, filter, flags, install-log, version-history, run, sync, remote, polaris, identity, sandbox}.mjs`
+ `core/{skill,recipe,agent,job,service}.mjs` + `vendor/yaml.mjs`.
Install log: `${PACKAGES_DIR:-~/packages}/install.json` (D-24) — updated on real installs/uninstalls only.
Self-test (no live writes): `node scripts/install.mjs <package> --sandbox --lifecycle`.
**Sync / backup** (D-25..D-31, D-41): `node scripts/sync.mjs [<package-dir>] [--mirror [--normalize --type= --include= --exclude=] --add-{skill,recipe,agent,job}= --dry-run --json --help]`
— exports live satellite state (DB + `INSTALL_BASE_DIR`) back into a package repo, git-safe + in-place.
Mirror auto-adds only active **`user`** skills (org/store/system come from their own packages) + recipes
+ non-system agents/jobs; removal is conservative (org/store entries already listed are synced, not purged).
**Default**: manifest-driven — sync the components it
lists, `--add-*` to register more; never removes; package version untouched. **`--mirror`** (the former
`backup.mjs`, D-40): live satellite is authority — add new, sync existing, REMOVE entries+files whose
component is gone (scoped by `--type`/`--include`/`--exclude`); new skills preserve live `install_type`
unless `--normalize`; integer package `version` +1 only on a content-changing run. Empty dir → mirror
bootstraps a manifest named `satellitePackageName()` (D-43: satellite id → drop `myzone-` → ensure
`ai1-`; shared DB-free helper in `lib/identity.mjs`); plain-sync `--add` bootstrap uses the dir name.
Live + read-only on the DB (no sandbox); `--dry-run` previews with zero writes; restore =
`install.mjs <package-dir>`. The core is reusable as `runSync()` from `lib/index.mjs`.
**Remote** (D-36..D-39): hub client, DB-free, **subcommand** CLI — `node scripts/remote.mjs <subcommand>`.
The satellite's side of the Ai1 Platform Hub contract (see `ai1-platform-hub/`). `register` self-enrolls
the satellite via `POST {hub}/remote/register` (bootstrap-token auth, built-in `fetch`) and writes the
minted per-remote key + identity to `${REMOTE_BASE_DIR:-~/remote}/id.json` (atomic, mode 0600):
`remote_id, token, remote_type, schema_version, hub_url, registered_at` — the hub-owned lifecycle
`status` is surfaced but NOT stored (D-38). Inputs resolve flag→env: `--hub=`/`AI1_HUB_URL`,
`--token=`/`AI1_BOOTSTRAP_TOKEN`, `remote_id` = `--remote-id=`/`SATELLITE_ID`/hostname-minus-`crhq-`,
`--remote-type=`(`crhq-satellite`)/`--schema-version=`(`1`); refuses to clobber an existing id.json
without `--force`. `get-config` polls `GET {hub}/remote/config` (Bearer token from id.json) and writes
the raw opaque payload to `${REMOTE_BASE_DIR}/config.json` (atomic, mode 0600), plus a
`state.json` sidecar (`config_version, config_fetched_at`) holding the poll bookkeeping config.json
deliberately omits. Conditional via the hub's ETag: it echoes the sidecar's
`config_version` in `If-None-Match`, so an unchanged config returns a bodyless `304` and both files are
left untouched; `401` hints re-register, `403` = valid token but remote not yet active. `heartbeat`
PUTs a full-replace state report to `PUT {hub}/remote/state` (Bearer token from id.json) — the
`state.json` sidecar contents plus a freshly added `local_time` (UTC with `+00:00` offset; reported,
not persisted) — echoes the server-stamped `reported_at`, and writes the response's advisory
`actions[]` to `${REMOTE_BASE_DIR}/actions.json` wrapped as `{ actions, actions_fetched_at }`
(always written, even when empty). Recording the actions is remote.mjs's only job here — *performing*
them is out of scope (a later consumer reads actions.json). Same 401/403 mapping, DB-free. `github-token`
GETs `{hub}/remote/github-token` (Bearer token from id.json) and prints just the raw token to stdout
(no prefix/log noise, so `TOKEN=$(remote.mjs github-token)` works); the token *is* the text/plain 200
body (nothing persisted). A `404` is the legitimate "no token for this remote" answer → exit 1; same
401/403 mapping. `get-package` (`--name= --version= [--keep-download] [--json]`) resolves a download
URL via `GET {hub}/remote/package?name=&version=&format=json` (Bearer token from id.json) — the hub
returns `{ url, expires_at }`, a short-lived **pre-signed GCS** GET URL. Default behavior: fetch the
signed URL (no auth header — it self-authenticates and is cross-host), stream the archive to
`${DOWNLOAD_BASE_DIR:-<system temp>}/<name>@<version>.<ext>`, extract it (tar/unzip shell-out) into
`${PACKAGE_BASE_DIR:-~/packages}/<name>@<version>` (overwrite-in-place via stage→swap), then delete
the archive unless `--keep-download`. The extracted dir is a ready `install.mjs <dir>` input. `--name`
is required and `--version` must be a positive integer; a hub `404` = that (name, version) isn't
registered → exit 1; same 401/403 mapping, DB-free. The signed URL is a credential — never echoed to
stdout/`--json`. More subcommands (instructions) to follow.
**Polaris** (D-45/D-46): GitHub Client-Repository client, DB-free, **subcommand** CLI — `node scripts/polaris.mjs <subcommand>`.
The Client Repository (see `docs/repo-methodology.md`) pairs a `platform/` Ai1 Package (subtree from the
shared platform parent) with a `user/` Ai1 Package (this satellite's own content); install both with
`install.mjs`, mirror user edits back with `sync.mjs --mirror <repo>/user`. `init` clones it into
`${REPOS_BASE_DIR:-~/repos}/<repo>`: owner resolves `--owner=`/`AI1_GITHUB_OWNER`/`MyZone-AI`, repo
resolves `--repo=`/`satellitePackageName()`; owner/repo are charset-guarded against path/URL escape.
Clones the **default branch**; **always errors if the dest exists** (no `--force`), checked *before* the
token call so it fails fast with no network. Auth reuses `lib/remote.mjs`'s `fetchGithubToken()` (the same
per-remote token `github-token` prints) — so the satellite must be **registered first** — injected via
git's **env-based config** (`GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`, a host-scoped `http.extraheader` Basic
header) so the token never hits argv (`ps`) or the cloned `.git/config`; `origin` stays a clean tokenless
URL. The token is a credential — never logged/echoed. `PolarisError`→exit 1, `RemoteError`→exit 1 (token
resolution), `UsageError`→exit 2. Logic in `lib/polaris.mjs`, entry `scripts/polaris.mjs`; DB-free, so
tested in `tests/polaris.test.mjs` (injected token/git + a real-git file:// integration clone), no sandbox.

## Safety & workflow
- **`git push` only when explicitly asked.** Trunk branch is `main`. Commit only when asked;
  commit trailer `Co-Authored-By: CRHQ <noreply@crhq.ai>`.
- **Do not install onto the live satellite** unless explicitly told — all testing is sandbox-only
  (isolated schema + temp dir via `--sandbox`).
- Never modify or read the *contents* of core satellite files (`server/`, …); importing
  `server/db/knex.js` at runtime is the one sanctioned exception (C1).
