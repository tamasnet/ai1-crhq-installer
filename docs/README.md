# ai1-satellite-tools documentation

Current v1.0 reference for `ai1-satellite-tools`, a satellite management skill that installs Ai1 Packages, syncs live components back into packages, talks to the Ai1 Platform Hub, and clones GitHub Client Repositories.

## Start here

| Document | Purpose |
|----------|---------|
| [`../SKILL.md`](../SKILL.md) | Canonical agent/operator usage instructions. |
| [`package-manifest-spec.md`](./package-manifest-spec.md) | Ai1 Package layout and `ai1-package.yaml` schema. |
| [`architecture.md`](./architecture.md) | CLI/library structure, install/sync flows, storage model, safety boundaries. |
| [`integration-reference.md`](./integration-reference.md) | satellite DB/file/service mappings used by the installer. |
| [`testing-and-sandbox.md`](./testing-and-sandbox.md) | Sandbox lifecycle and test suite coverage. |
| [`repo-methodology.md`](./repo-methodology.md) | GitHub Client Repository model used by `polaris.mjs`. |

## Resource coverage

| Resource | Store | Managed by | Sandbox behavior |
|----------|-------|------------|------------------|
| Skill | `skills` + skill files under `SKILLS_BASE_DIR/<key>` | `install.mjs`, `sync.mjs` | Full DB/filesystem coverage |
| Recipe | `recipes` | `install.mjs`, `sync.mjs` | Full DB coverage |
| Agent | `agents`, joins, brain files under `AGENT_BRAINS_DIR/<key>` | `install.mjs`, `sync.mjs` | Full DB/filesystem coverage |
| Job | `background_jobs` | `install.mjs`, `sync.mjs` | Full DB coverage |
| Service | `${SERVICES_BASE_DIR:-~/services}/<name>`, nginx, PM2 | `install.mjs` only | Skipped in sandbox; dry-run skips nginx/PM2 apply (build skipped unless `--run-build`) |
| Project | `/opt/projects/user/<name>` symlink/copy, nginx, PM2 | `install.mjs`; initial `sync.mjs --add-project` | Skipped in sandbox; dry-run skips nginx/PM2 apply (build skipped unless `--run-build`) |

## Validation commands

```bash
npm test
node scripts/install.mjs examples/bundle --sandbox --lifecycle
node scripts/install.mjs examples/bundle --dry-run
```

`--dry-run` skips service/project build commands; add `--run-build` to execute them during the preview.
