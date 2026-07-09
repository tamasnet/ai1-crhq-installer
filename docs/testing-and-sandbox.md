# Testing and sandbox

`ai1-satellite-tools` includes a built-in sandbox for validating DB-backed installs without touching live satellite resources.

## Sandbox mode

```bash
node scripts/install.mjs examples/bundle --sandbox
node scripts/install.mjs examples/bundle --sandbox --keep
node scripts/install.mjs examples/bundle --sandbox --lifecycle
```

Sandbox mode:

1. Creates an isolated Postgres schema named `sandbox_<timestamp>`.
2. Clones the managed satellite table structures from live into that schema.
3. Seeds prerequisite skill rows needed for realistic agent/job checks.
4. Redirects `INSTALL_SCHEMA`, `SKILLS_BASE_DIR`, `AGENT_BRAINS_DIR`, and `PACKAGES_DIR` to isolated locations.
5. Runs the requested install/status/uninstall workflow.
6. Drops the schema and removes temp dirs unless `--keep` is set.

Services and projects are skipped in sandbox mode because nginx and PM2 are live host resources.

## Lifecycle assertions

`--sandbox --lifecycle` runs a full assertion suite against the package:

| Phase | Checks |
|-------|--------|
| Fresh install | Creates rows/files and links agents to available skills/recipes. |
| Status | Reports current state without writes. |
| Idempotency | A second install produces no state drift. |
| Uninstall | Removes managed DB rows/files; agent brain folders remain preserved. |
| Reinstall | Recreates the same managed state. |

A lifecycle failure exits non-zero. `--json` emits machine-readable phase results.

## Dry-run

```bash
node scripts/install.mjs <package> --dry-run
node scripts/sync.mjs <package-dir> --dry-run
node scripts/sync.mjs <package-dir> --mirror --dry-run
```

Dry-run performs validation and planning with zero DB or package filesystem writes. Service/project build commands are skipped by default during install dry-run (pass `--run-build` to execute them); nginx/PM2 apply is always skipped.

## Test suite

Run the full suite:

```bash
npm test
```

Coverage summary:

| Suite | Coverage |
|-------|----------|
| `fs.test.mjs` | copyTree/pruneTree/diffTree/syncInstallTree: mode preservation, idempotency, prune paths (incl. missing srcDir), content-only vs strict comparison. |
| `protect.test.mjs` | Protected-names defaults, `!` negation, top-level/path/`**` glob matching, manifest validation. |
| `strict.test.mjs` | `--strict` install pruning (including asset-less skills/agents), protect interaction, CLI scope validation. |
| `skill-recipe.test.mjs` | Skill/recipe install, uninstall, lock handling, versions, dry-run, validation failures. |
| `agent.test.mjs` | Agent rows, config fields, skill/recipe joins, brain directory handling, removal. |
| `job.test.mjs` | Job schedule aliases, script args, prereqs, idempotency, removal. |
| `service.test.mjs` | Service/project artifact rendering, port selection, dry-run, sandbox skip, symlink handling, secret placement. |
| `service-live.test.mjs` | Live nginx/PM2 apply/remove (requires `AI1_LIVE_SERVICE_TEST=1`; otherwise skipped). |
| `runner.test.mjs` | Preflight, install entry forwarding, component type selection. |
| `validate.test.mjs` | Name/env-value validation and manifest error paths. |
| `filter.test.mjs` | Include/exclude matching and invalid regex handling. |
| `handling.test.mjs` | `handling: removed`/`optional` install, uninstall, and sync behavior. |
| `options.test.mjs` | CLI option validation (incl. `--strict` scope) and installed/available list modes. |
| `install-log.test.mjs` | Install log shape, ownership transfer, mirror reconciliation, formatting. |
| `list-available.test.mjs` | Package store scanning and status classification. |
| `sync.test.mjs` | Plain sync, mirror mode, manifest reconciliation, version handling, filters, dry-run. |
| `archive.test.mjs` | Package archive extraction hardening. |
| `remote.test.mjs` | Hub client protocol against a stub server. |
| `action.test.mjs` | Queued hub action processing, per-action removal/error tracking, CLI options. |
| `polaris.test.mjs` | GitHub Client Repository clone helper and token handling. |
| `identity.test.mjs` | Satellite id and package name resolution. |
| `drift.test.mjs` | Install-log drift states, orphan detection, report formatting. |
| `diff.test.mjs` | Package → live diff states, db/link/file detail, `--strict` metadata sensitivity, CLI. |

## Service/project validation boundary

Sandbox tests do not apply nginx or PM2 changes. Before a real service/project install:

1. Run `node scripts/install.mjs <package> --dry-run`.
2. Inspect the service's `service.yaml` or project's `project.yaml`, build command, and environment values.
3. Confirm the intended service/project name is not the satellite core service name.
4. Install only on the satellite where the web app should become live.
