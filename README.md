# ai1-satellite-tools

A DB-direct, manifest-driven CRHQ skill for managing a satellite's resources. Three CLIs:

- **install** — deploy a versioned **package** (skills, recipes, agents, background jobs, standalone
  nginx + PM2 services) into a CRHQ satellite.
- **backup** — snapshot the satellite's current resources back into an installable package.
- **remote** — the satellite's client for the **Ai1 Platform Hub** (register, pull config, heartbeat,
  fetch a GitHub token, download registered packages).

Idempotent and sandbox-testable.

See [`SKILL.md`](./SKILL.md) for full usage and [`docs/`](./docs/) for the design + manifest spec.

## Quick start

No `npm install` needed — zero runtime dependencies (`yaml` is vendored; knex/pg come from the satellite).

```bash
node scripts/install.mjs examples/bundle --sandbox --lifecycle   # isolated full-lifecycle self-test
node scripts/install.mjs examples/bundle --dry-run               # preview, zero writes
node scripts/backup.mjs                                          # backup: DB state → installable package in ~/backups
node scripts/remote.mjs register --hub=<url> --token=<tok>       # enroll this satellite with the Ai1 Platform Hub
```

## Status

v1 — complete and live. ESM core library, all component types (skill / recipe / agent / job /
service), the generic runner (`install.mjs` — preflight + `install_entry`), the built-in `--sandbox`,
a `backup` command (reverse of install), and a `remote` client for the Ai1 Platform Hub. Verified
via `npm test` (sandbox-backed); the live service apply/remove paths are smoke-tested. Deployed and
registered as a skill on the satellite.

## Layout

```
ai1-satellite-tools/
├── SKILL.md          # skill instructions (canonical doc)
├── README.md         # this file
├── build-installer.sh # build a self-extracting installer of this package
├── scripts/          # install.mjs / backup.mjs / remote.mjs (CLIs) + lib/ (core library)
├── examples/bundle/  # complete sample package
├── tests/            # sandbox-backed test suites
└── docs/             # design + manifest spec
```
