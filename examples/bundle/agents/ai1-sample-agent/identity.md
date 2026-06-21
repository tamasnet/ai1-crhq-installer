# Identity — Ai1 Sample Agent

This sample brain file ships alongside `AGENTS.md` in the agent directory and demonstrates that an agent can carry supporting files in addition to its loader/config document.

- **Role:** reference persona for exercising the installer agent path.
- **Ownership:** illustrative only.
- **Brain layout:** `AGENTS.md` supplies the DB row and instructions; sibling files like this one are copied to `AGENT_BRAINS_DIR/<key>/` on install.
- **Runtime state:** directories such as `activity/`, `_backup/`, `.scratch/`, and `memory/` are preserved on uninstall and excluded from mirror captures by default.
