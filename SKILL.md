---
name: ai1-crhq-installer
description: Install CRHQ resources (skills, agents, recipes) and services (nginx + PM2 web apps) into a CRHQ satellite from a manifest or source folder. Use when a user wants to bulk-install or update a packaged set of CRHQ resources, or deploy a service that should run alongside a satellite.
---

# Ai1 CRHQ Installer

Install a bundle of CRHQ resources and/or services into the local CRHQ satellite.

## What this skill installs

| Type | Registered with CRHQ? | Mechanism |
|------|-----------------------|-----------|
| **Skill** | yes | `POST /api/skills` (or `PUT /api/settings/skills/<name>`) |
| **Agent** | yes | CRHQ agents API |
| **Recipe** | yes | CRHQ recipes API |
| **Service** | no | nginx vhost + PM2 process (web app) |

Skills, agents, and recipes are first-class CRHQ resources. **Services** are standalone web applications hosted on the same VPS — configured via nginx and supervised by PM2 — that do **not** appear in the CRHQ UI.

## Quick start

```bash
# Install everything declared in a manifest
node /opt/projects/user/ai1-crhq-installer/scripts/install.js <path-to-manifest.json>

# Install one resource type
node /opt/projects/user/ai1-crhq-installer/scripts/install-skill.js <path-to-skill-folder>
node /opt/projects/user/ai1-crhq-installer/scripts/install-agent.js <path-to-agent.json>
node /opt/projects/user/ai1-crhq-installer/scripts/install-recipe.js <path-to-recipe.json>
node /opt/projects/user/ai1-crhq-installer/scripts/install-service.js <path-to-service-folder>
```

## Manifest format

A manifest is a JSON file that declares the resources to install:

```json
{
  "name": "my-bundle",
  "version": "1.0.0",
  "resources": {
    "skills":   [{ "path": "skills/my-skill" }],
    "agents":   [{ "path": "agents/my-agent.json" }],
    "recipes":  [{ "path": "recipes/my-recipe.json" }],
    "services": [{ "path": "services/my-service" }]
  }
}
```

Paths are resolved relative to the manifest file.

See `examples/manifest.example.json` for a complete sample.

## Resource conventions

### Skills
- Folder containing `SKILL.md` (frontmatter `name`, `description`) and optional `scripts/`
- Skill content (the body of `SKILL.md` minus frontmatter) is registered via the CRHQ skills API
- Scripts are copied to `/opt/projects/crhq-satellite/skills/<name>/scripts/`

### Agents
- JSON file describing the agent: `{ name, description, systemPrompt, model, ... }`
- Registered via CRHQ agents API

### Recipes
- JSON file describing the recipe: `{ name, description, steps, ... }`
- Registered via CRHQ recipes API

### Services
- Folder containing `service.json` plus the application source
- `service.json` schema:
  ```json
  {
    "name": "my-service",
    "port": 4300,
    "start": "node server.js",
    "cwd": "./",
    "env": { "NODE_ENV": "production" },
    "nginx": {
      "subdomain": "my-service",
      "ssl": true
    }
  }
  ```
- Installer copies the source to `/opt/projects/user/<name>/`, writes an nginx vhost in `/etc/nginx/projects.d/`, and starts a PM2 process named `<name>`

## Safety

- The installer **never** modifies core satellite files (`server.js`, `server/`, `providers/`, etc.)
- Each install step is idempotent: re-running with the same input produces the same result
- Use `--dry-run` to preview what would be installed without making changes
- Use `--force` to overwrite existing resources

## Layout

```
ai1-crhq-installer/
├── SKILL.md                  # this file
├── scripts/
│   ├── install.js            # main entry point — reads a manifest
│   ├── install-skill.js
│   ├── install-agent.js
│   ├── install-recipe.js
│   ├── install-service.js
│   └── lib/                  # shared helpers (API client, fs helpers, logging)
└── examples/
    ├── manifest.example.json
    └── service.example.json
```

## Development

This skill lives in `/opt/projects/user/ai1-crhq-installer/`. It is **not** installed into the local satellite yet — install it explicitly when ready:

```bash
node scripts/install-skill.js /opt/projects/user/ai1-crhq-installer
```
