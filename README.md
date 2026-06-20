# ai1-satellite-tools

A DB-direct, manifest-driven CRHQ skill for managing a satellite's resources. Three CLIs:

- **install** — deploy a versioned **package** (skills, recipes, agents, background jobs, standalone
  nginx + PM2 services) into a CRHQ satellite.
- **sync** — export live satellite state back into a package repo. Default syncs the components the
  manifest lists (Git workflow); **`--mirror`** backs up the whole satellite (add new, sync existing,
  remove what's gone). Restore = `install`.
- **remote** — the satellite's client for the **Ai1 Platform Hub** (register, pull config, heartbeat,
  fetch a GitHub token, download registered packages).

Idempotent and sandbox-testable.

See [`SKILL.md`](./SKILL.md) for full usage and [`docs/`](./docs/) for the design + manifest spec.

## Quick start

No `npm install` needed — zero runtime dependencies (`yaml` is vendored; knex/pg come from the satellite).

```bash
node scripts/install.mjs examples/bundle --sandbox --lifecycle   # isolated full-lifecycle self-test
node scripts/install.mjs examples/bundle --dry-run               # preview, zero writes
node scripts/sync.mjs ./my-backup --mirror                       # backup: mirror the whole satellite into ./my-backup
node scripts/remote.mjs register --hub=<url> --token=<tok>       # enroll this satellite with the Ai1 Platform Hub
```

## Status

v1 — complete and live. ESM core library, all component types (skill / recipe / agent / job /
service), the generic runner (`install.mjs` — preflight + `install_entry`), the built-in `--sandbox`,
a `sync` command (satellite → package repo; `--mirror` is the full backup, reverse of install), and a
`remote` client for the Ai1 Platform Hub. Verified via `npm test` (sandbox-backed); the live service
apply/remove paths are smoke-tested. Deployed and registered as a skill on the satellite.

## Layout

```
ai1-satellite-tools/
├── SKILL.md          # skill instructions (canonical doc)
├── README.md         # this file
├── build-installer.sh # build a self-extracting installer of this package
├── scripts/          # install.mjs / sync.mjs / remote.mjs (CLIs) + lib/ (core library)
├── examples/bundle/  # complete sample package
├── tests/            # sandbox-backed test suites
└── docs/             # design + manifest spec
```
