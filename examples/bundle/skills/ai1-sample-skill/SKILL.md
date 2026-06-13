---
name: ai1-sample-skill
version: 1
description: "Sample skill used by the ai1-crhq-installer test bundle. Does nothing useful; exists to exercise skill install/uninstall/status and asset copy."
---

# Ai1 Sample Skill

A no-op skill for installer testing. Its body becomes `skills.content`; its `scripts/` tree is
copied to `${INSTALL_BASE_DIR}/ai1-sample-skill/`.

## Usage

```bash
node ai1-sample-skill/scripts/hello.js
```
