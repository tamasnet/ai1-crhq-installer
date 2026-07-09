# Identity — Ai1 Sample Agent

This sample brain file lives in the agent's asset directory and demonstrates that an agent can carry
supporting files in addition to its content document (`agents/ai1-sample-agent.md`).

- **Role:** reference persona for exercising the installer agent path.
- **Ownership:** illustrative only.
- **Brain layout:** `agents/<key>.md` supplies the DB row and instructions; sibling files under
  `agents/<key>/` are copied to `AGENT_BRAINS_DIR/<key>/` on install.
- **Runtime state:** directories such as `activity/`, `_backup/`, `.scratch/`, and `memory/` are
  preserved on uninstall and excluded from mirror captures by default.
