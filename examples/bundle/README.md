# ai1-sample-bundle

Complete reference package for `ai1-crhq-installer` — one of **every** component type:

| Component | File | Notes |
|-----------|------|-------|
| skill | `skills/ai1-sample-skill/` | SKILL.md + `scripts/hello.js` |
| recipe | `recipes/ai1-sample-recipe.md` | |
| agent | `agents/ai1-sample-agent.md` | frontmatter + instructions body; attaches the bundle's skill + recipe |
| job | `jobs/ai1-sample-job.yaml` | hourly; `requires` the skill |
| service | `services/ai1-sample-svc/` | nginx + PM2 (skipped under `--sandbox`) |
| install_entry | `scripts/install.mjs` | package-specific hook (forwarded mode + flags) |

```bash
# From the installer root:
node scripts/install.mjs examples/bundle --sandbox --lifecycle   # full assertion suite (isolated)
node scripts/install.mjs examples/bundle --sandbox --dry-run     # preview, zero writes
```

Under `--sandbox` the service is skipped (nginx/PM2 aren't modelled). A real (non-sandbox) install
**deploys the service live** via nginx + PM2 — only do that on a satellite you intend to install to.
