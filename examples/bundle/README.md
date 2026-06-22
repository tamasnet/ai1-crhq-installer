# ai1-sample-bundle

Reference Ai1 Package for `ai1-satellite-tools`. It includes each DB component type plus a service.

| Component | Path | Notes |
|-----------|------|-------|
| Skill | `skills/ai1-sample-skill/` | `SKILL.md` plus `scripts/hello.js`. |
| Recipe | `recipes/ai1-sample-recipe.md` | Markdown frontmatter + body. |
| Agent | `agents/ai1-sample-agent/` | Directory-form agent with `AGENTS.md` and a sample brain file. |
| Job | `jobs/ai1-sample-job.yaml` | Hourly job requiring the sample skill. |
| Service | `services/ai1-sample-svc/` | Minimal HTTP service deployed via nginx + PM2 on real install. |
| Install entry | `scripts/install.mjs` | Package-specific hook used to demonstrate flag forwarding. |

Run from the repository root:

```bash
node scripts/install.mjs examples/bundle --dry-run
node scripts/install.mjs examples/bundle --sandbox --lifecycle
```

Sandbox mode skips the service because nginx and PM2 are live host resources. A real non-sandbox install deploys the service live; use it only on a satellite where that service should run.
