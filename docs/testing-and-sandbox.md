# Testing & Sandbox

How `ai1-crhq-installer` is tested without touching the live satellite. Sandboxing is
**built into the utility** (`--sandbox`) — no external harness. The payoff of the library
design (all DB through `getDb()`, all fs through `INSTALL_BASE_DIR`): the utility points
those two knobs at an isolated schema + temp dir and runs a real install into there.

## Built-in `--sandbox`

```bash
# Install a package into a throwaway isolated schema + temp dir, report, tear down:
node scripts/install.mjs examples/bundle --sandbox

# Keep the sandbox (schema + temp dir) for inspection:
node scripts/install.mjs examples/bundle --sandbox --keep

# Full lifecycle assertion suite in the sandbox:
node scripts/install.mjs examples/bundle --sandbox --lifecycle
```

What `--sandbox` does (`lib/sandbox.mjs`):
1. **Provision** — `CREATE SCHEMA sandbox_<ts>`; for each managed table
   `CREATE TABLE sandbox_<ts>.<t> (LIKE public.<t> INCLUDING ALL)` — clones the **live**
   schema, so the sandbox can never drift from production. Seeds prerequisite `skills` rows
   copied from live so agent-attach + dependency checks mirror the real satellite.
2. **Redirect** — set `INSTALL_SCHEMA=sandbox_<ts>` + `INSTALL_BASE_DIR=<tempdir>` +
   `PACKAGES_DIR=<tempdir>`. All DB writes land in the sandbox schema; all fs writes
   (including the install log) under the temp dirs.
3. **Run** — the requested op (install by default).
4. **Teardown** — `DROP SCHEMA … CASCADE` + rm tempdir, unless `--keep`.

## `--lifecycle` assertion suite

With `--sandbox --lifecycle`, the utility runs and asserts:

| Phase | Assert |
|-------|--------|
| Fresh install | completes; skills have content; recipes/agents/jobs created; agent joins populated |
| Status | runs clean |
| Idempotency | second install → **zero** state drift |
| Uninstall | completes; schema left clean (rows + joins + jobs gone) |
| Reinstall | reproduces the original state |

Exit non-zero if any phase fails; `--json` emits a machine-readable verdict.

## Pre-flight: `--dry-run`

`--dry-run` makes **zero** writes (DB/fs; build-only for services) and prints the plan with
"would …" lines. This is the fast pre-flight check — run it on every change:

```bash
node scripts/install.mjs examples/bundle --dry-run
```

## Test suite (`npm test`)

Sandbox-backed suites, one per area (a reachable satellite DB is required):

| Suite | Covers |
|-------|--------|
| `tests/skill-recipe.test.mjs` | skill row fields, org+locked default + `install_type`/`--install-skills-as-user` overrides, asset copy + idempotency, C5 lock handling both ways, dry-run zero-write, removal, recipe lifecycle, negatives (missing SKILL.md, version pin, invalid `install_type`) |
| `tests/agent.test.mjs` | minimal-row + DB defaults, recipe name→uuid resolution, attach filtering (missing/inactive skipped), stale-link sync both directions, clean removal of row + joins |
| `tests/job.test.mjs` | id minting + canon columns, `script_args` under `INSTALL_BASE_DIR`, schedule aliases + raw cron, stable id across re-runs, C12 `requires` → `PrereqError` |
| `tests/runner.test.mjs` | preflight pass/fail, `install_entry` flag forwarding across all modes (incl. a declared package flag), multi-valued `--type` |
| `tests/service.test.mjs` | template renderers (127.0.0.1 binding, TLS, white-label branch, secrets excluded), `nextFreePort`, dry-run no-write, sandbox-skip, secret hygiene |
| `tests/filter.test.mjs` | `--include`/`--exclude` matcher semantics (exact vs regex, compose with `--type`, zero-match exit 0, invalid regex exit 2) |
| `tests/options.test.mjs` | CLI option validation (D-30) for both entries: `--help` usage/exit 0, unsupported option + value-flag-without-value → exit 2, backup's "not supported by backup" (and `--dry-run` accepted, D-31), undeclared package flag rejected — **DB-free** |
| `tests/install-log.test.mjs` | install.json bookkeeping (D-24): flat entry shape (incl. `package`/`package_version`), ALREADY date preservation, dry-run/status no-write, partial + full uninstall removal, ownership transfer (newer package version + different package name → no duplicate), partial-upgrade mixed `package_version`s, corrupt-log recovery, `PACKAGES_DIR` override — **DB-free** |
| `tests/backup.test.mjs` | backup (D-25..D-29, D-31): dumpYaml round-trips, scope + skip rules, component reconstruction vs DB rows, overwrite-in-place via staged swap, uninstall → reinstall-from-backup round trip, `--type`/`--include` filters, dry-run (full reporting, zero fs writes, previous backup untouched) |

Each suite provisions its own sandbox; several also run a scoped `--sandbox --lifecycle`.

> Note: `LIKE` doesn't clone the skills lock **trigger**, so the suite validates the
> installer's lock *logic*, not the DB trigger itself.

## Notes & boundaries

- **Services aren't sandbox-covered** (no nginx/PM2 model) — `--sandbox` skips them
  entirely. The live apply/remove paths are verified by an explicit, authorized,
  non-sandbox smoke test (`--type=services` install + uninstall of the sample service).
- The sandbox **seeds** prerequisite skills from live; if a package's agent references a
  skill not present on the satellite, attach is skipped (by design) — keep agents' skills
  within the installed/seeded set or have the package install them first.
- `LIKE INCLUDING ALL` **omits foreign keys**; they are deliberately not re-created —
  guarded join inserts + explicit join cleanup make them unnecessary for the lifecycle
  assertions.
