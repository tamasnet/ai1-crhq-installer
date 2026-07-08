# ai1-satellite-tools

`ai1-satellite-tools` is a satellite management skill. It installs, updates, removes, and syncs satellite resources from a declarative Ai1 Package (`ai1-package.yaml`).

It manages:

- Satellite **skills**, **recipes**, **agents**, and **background jobs** directly through the satellite database.
- Standalone **services** as nginx + PM2 web apps under `$SERVICES_BASE_DIR/<service>`.
- Git-managed **projects** as nginx + PM2 web apps under `/opt/projects/user/<project>` symlinked to their package source by default.
- Mirroring live skill/agent/recipe/job definitions back into a version-controllable package.
- Ai1 Platform Hub registration/config/package download workflows.
- Queued hub actions from `${REMOTE_BASE_DIR}/actions.json`.
- GitHub Client Repository checkout flows for `platform/` + `user/` packages.

The package has zero runtime npm dependencies. YAML parsing is vendored; the satellite supplies Node, knex, Postgres access, nginx, PM2, and `jq` (for `scripts/heartbeat-actions.sh`).

> **NOTE:** If you're viewing this README in a Git repository, the actual package structure is assembled by `build-installer.sh` rather than being present in the the repository itself as would be typical for an Ai1 Package.

## Quick start

```bash
# Validate a package without touching live state
node scripts/install.mjs examples/bundle --sandbox --lifecycle
node scripts/install.mjs examples/bundle --dry-run

# Install, inspect, and remove a package
node scripts/install.mjs <package-dir>
node scripts/install.mjs <package-dir> --status
node scripts/install.mjs <package-dir> --uninstall

# Mirror live satellite definitions into the package
node scripts/sync.mjs <repo-or-package-dir> --mirror

# Register with the Ai1 Platform Hub and fetch packages
node scripts/remote.mjs register --hub=<hub-url> --token=<bootstrap-token>
node scripts/action.mjs --dry-run
node scripts/action.mjs
node scripts/remote.mjs get-package --name=<package> --version=<version>

# Clone the satellite's GitHub Client Repository
node scripts/polaris.mjs init
```

## CLIs

| CLI | Purpose |
|-----|---------|
| `scripts/install.mjs` | Install, uninstall, status-check, dry-run, sandbox-test, and list local package availability. |
| `scripts/sync.mjs` | Export live satellite components back into a package; `--mirror` makes the package match the live satellite. |
| `scripts/remote.mjs` | Register with the Ai1 Platform Hub, pull config, heartbeat, push install state, resolve GitHub tokens, and download registered packages. |
| `scripts/action.mjs` | Process queued hub actions (`pull-config`, `push-install`, `install-package`, `drift-report`) from `${REMOTE_BASE_DIR}/actions.json`. |
| `scripts/drift.mjs` | Read-only drift report: compare live satellite state against install-log source packages; list orphans. |
| `scripts/polaris.mjs` | Clone the satellite's GitHub Client Repository using the hub-provided GitHub token. |

## Repository layout

```text
ai1-satellite-tools/
├── SKILL.md                 # agent-facing skill instructions
├── README.md                # quick project overview
├── build-installer.sh       # builds a self-extracting hub-registration installer
├── docs/                    # current v1.0 references
├── examples/bundle/         # complete package example for DB components + service
├── scripts/                 # CLIs and shared library
└── tests/                   # sandbox-backed and DB-free tests
```

## Documentation

Start with:

- [`SKILL.md`](./SKILL.md) — canonical operational instructions for agents.
- [`docs/package-manifest-spec.md`](./docs/package-manifest-spec.md) — package format.
- [`docs/architecture.md`](./docs/architecture.md) — how the CLIs and library fit together.
- [`docs/testing-and-sandbox.md`](./docs/testing-and-sandbox.md) — validation workflow.

## Validation

```bash
npm test
node scripts/install.mjs examples/bundle --sandbox --lifecycle
```

Services and projects are skipped in sandbox mode because nginx and PM2 are live host resources. A real service install mutates nginx, PM2, and `$SERVICES_BASE_DIR/<service>`; a real project install mutates nginx, PM2, and `/opt/projects/user/<project>`.
