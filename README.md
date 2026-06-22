# ai1-satellite-tools

`ai1-satellite-tools` is a satellite management skill. It installs, updates, removes, backs up, and restores satellite resources from a declarative Ai1 Package (`ai1-package.yaml`).

It manages:

- Satellite **skills**, **recipes**, **agents**, and **background jobs** directly through the satellite database.
- Standalone **services** as nginx + PM2 web apps under `$SERVICES_BASE_DIR/<service>`.
- Git-managed **projects** as nginx + PM2 web apps under `/opt/projects/user/<project>` symlinked to their package source by default.
- Satellite backups by syncing live DB/filesystem state back into an installable package.
- Ai1 Platform Hub registration/config/package download workflows.
- GitHub Client Repository checkout flows for `platform/` + `user/` packages.

The package has zero runtime npm dependencies. YAML parsing is vendored; the satellite supplies Node, knex, Postgres access, nginx, and PM2.

## Quick start

```bash
# Validate a package without touching live state
node scripts/install.mjs examples/bundle --sandbox --lifecycle
node scripts/install.mjs examples/bundle --dry-run

# Install, inspect, and remove a package
node scripts/install.mjs <package-dir>
node scripts/install.mjs <package-dir> --status
node scripts/install.mjs <package-dir> --uninstall

# Back up the live satellite into an installable package
node scripts/sync.mjs <repo-or-package-dir> --mirror

# Register with the Ai1 Platform Hub and fetch packages
node scripts/remote.mjs register --hub=<hub-url> --token=<bootstrap-token>
node scripts/remote.mjs get-package --name=<package> --version=<version>

# Clone the satellite's GitHub Client Repository
node scripts/polaris.mjs init
```

## CLIs

| CLI | Purpose |
|-----|---------|
| `scripts/install.mjs` | Install, uninstall, status-check, dry-run, sandbox-test, and list local package availability. |
| `scripts/sync.mjs` | Export live satellite components back into a package; `--mirror` makes the package a restorable backup. |
| `scripts/remote.mjs` | Register with the Ai1 Platform Hub, pull config, heartbeat, resolve GitHub tokens, and download registered packages. |
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

Services and projects are skipped in sandbox mode because nginx and PM2 are live host resources. Use `--dry-run` first for any web-app package; a real service install mutates nginx, PM2, and `$SERVICES_BASE_DIR/<service>`, while a real project install mutates nginx, PM2, and `/opt/projects/user/<project>`.
