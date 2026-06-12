# ai1-crhq-installer

A DB-direct, manifest-driven CRHQ skill that installs a versioned **package** — skills, recipes,
agents, background jobs, and standalone services (nginx + PM2) — into a CRHQ satellite. Idempotent
and sandbox-testable.

See [`SKILL.md`](./SKILL.md) for full usage and [`docs/`](./docs/) for the design + manifest spec.

## Quick start

No `npm install` needed — zero runtime dependencies (`yaml` is vendored; knex/pg come from the satellite).

```bash
node scripts/install.mjs examples/bundle --sandbox --lifecycle   # isolated full-lifecycle self-test
node scripts/install.mjs examples/bundle --dry-run               # preview, zero writes
```

## Status

v1 — complete and live. ESM core library, all component types (skill / recipe / agent / job /
service), the generic runner (`install.mjs` — preflight + `install_entry`), and the built-in
`--sandbox`. Verified via `npm test` (sandbox-backed); the live service apply/remove paths are
smoke-tested. Deployed and registered as a skill on the satellite.

## Layout

```
ai1-crhq-installer/
├── SKILL.md          # skill instructions (canonical doc)
├── README.md         # this file
├── scripts/          # install.mjs (CLI) + lib/ (core library)
├── examples/bundle/  # complete sample package
├── tests/            # sandbox-backed test suites
└── docs/             # design + manifest spec
```
