# Identity — Ai1 Sample Agent

A sample **brain file** that ships alongside `AGENTS.md` in the agent's directory. It demonstrates
the directory-form agent: an agent is no longer a single `.md` file but a folder whose whole tree is
copied to `AGENT_BRAINS_DIR/<key>/` on install (D-50).

- **Role:** reference persona for exercising the installer's agent path.
- **Ownership:** none — this agent is illustrative only.
- **Brain layout:** `AGENTS.md` (the loader / system prompt → `agents.instructions`) plus any number
  of supporting files like this one. Runtime/transient dirs (`activity/`, `_backup/`, …) an agent
  writes here are preserved on uninstall and excluded from a `sync --mirror` capture.
