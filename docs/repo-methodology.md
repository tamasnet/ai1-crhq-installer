# GitHub Client Repository model

`polaris.mjs` supports a repository model where each satellite has a GitHub Client Repository with two Ai1 Packages:

```text
client-repo/
├── platform/   # shared platform package
└── user/       # satellite/customer-specific package
```

Both directories are installable packages with their own `ai1-package.yaml`.

## Responsibilities

| Area | Owner | Purpose |
|------|-------|---------|
| `platform/` | Shared platform process | Common skills, recipes, agents, jobs, and services distributed to many satellites. |
| `user/` | Satellite/customer process | Local customer content, git-managed projects, and live edits mirrored back from the satellite. |

The satellite typically installs both packages:

```bash
node scripts/install.mjs ~/repos/<repo>/platform
node scripts/install.mjs ~/repos/<repo>/user
```

Live customer edits are synced back to `user/`:

```bash
node scripts/sync.mjs ~/repos/<repo>/user --mirror
```

Projects under `/opt/projects/user/<name>` have a special user-package lifecycle: add one with
`node scripts/sync.mjs ~/repos/<repo>/user --add-project=<name>`, which moves it into the package
and leaves the live path symlinked back to git. Sync/mirror do not auto-refresh project content
after that initial move; git is the source of truth.

## `polaris init`

`polaris.mjs init` clones the Client Repository into `${REPOS_BASE_DIR:-~/repos}/<repo>`.

```bash
node scripts/polaris.mjs init
node scripts/polaris.mjs init --owner=MyZone-AI --repo=ai1-example
node scripts/polaris.mjs init --json
```

Input resolution:

| Value | Resolution order |
|-------|------------------|
| Owner | `--owner` -> `AI1_GITHUB_OWNER` -> `MyZone-AI` |
| Repo | `--repo` -> satellite package name, e.g. `myzone-tamas` -> `ai1-tamas` |
| Destination base | `REPOS_BASE_DIR` -> `~/repos` |

Authentication uses the per-remote GitHub token resolved by `remote.mjs github-token`; therefore the satellite must be registered with the Ai1 Platform Hub first. The token is injected into git through environment configuration and is not written to argv or `.git/config`.

`init` refuses to overwrite an existing checkout.

## Operating workflow

```bash
# one-time satellite enrollment
node scripts/remote.mjs register --hub=<hub-url> --token=<bootstrap-token>

# clone packages
node scripts/polaris.mjs init

# install current platform and user packages
node scripts/install.mjs ~/repos/<repo>/platform --dry-run
node scripts/install.mjs ~/repos/<repo>/platform
node scripts/install.mjs ~/repos/<repo>/user --dry-run
node scripts/install.mjs ~/repos/<repo>/user

# later, capture live user edits back to the repo
node scripts/sync.mjs ~/repos/<repo>/user --mirror --dry-run
node scripts/sync.mjs ~/repos/<repo>/user --mirror
git -C ~/repos/<repo> diff
git -C ~/repos/<repo> add user
git -C ~/repos/<repo> commit -m "Sync user package"
```

## Repository rules

- Keep shared content in `platform/`.
- Keep satellite/customer-owned content in `user/`.
- Do not make customer-specific edits directly inside `platform/` unless the platform process explicitly supports that carry-forward.
- Run sync inside a git work tree so in-place mirror changes are recoverable.
- Store GitHub and hub credentials only in the hub/remote credential flow; do not paste tokens into commands, docs, or repo files.
