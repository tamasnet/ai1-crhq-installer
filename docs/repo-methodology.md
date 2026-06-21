# Parent–Client Repository Model Using Git Subtree and PAT Authentication

This document describes a repository model in which a single parent repository contains the shared platform code, and multiple client repositories consume that platform code under a `platform/` directory using Git subtree. Client-specific code lives separately under a `user/` directory in each client repository.

Authentication is handled with fine-grained personal access tokens (PATs), which are sufficient for the current scale of roughly 40 client repositories and can be restricted to specific repositories and permissions.

## Overview

The parent repository is the source of truth for the shared platform codebase. Its repository root is the platform itself.

Each client repository includes:

- A `platform/` directory that is populated from the parent repository using Git subtree.
- A `user/` directory that contains client-specific code, configuration, and assets.

This creates a clean separation between inherited platform code and client-owned customizations. The relationship is intentionally one-way: the parent publishes platform changes, and each client repository pulls those changes into its local `platform/` directory from a selected parent branch.

Because subtree updates are applied to a specific local prefix, the parent’s code is confined to `platform/` in the client repository. This prevents parent updates from overwriting client-owned areas such as `user/` or the client repository’s own `.github/` configuration.

## Repository structure

### Parent repository

The parent repository contains only platform code and related repository-local metadata.

Example structure:

```text
parent-platform-repo/
├── skills/
├── agents/
├── recipes/
├── .github/
└── ... other platform files ...
```

The parent repository root represents the entire platform codebase that will be imported into client repositories under `platform/`.

### Client repository

Each client repository isolates inherited platform content from client-specific content.

Example structure:

```text
client-repo/
├── platform/
│   └── ... subtree from parent repo branch ...
├── user/
│   └── ... client-specific code and assets ...
├── .github/
│   └── workflows/
│       └── ... child-local sync workflow ...
└── ... other client-owned files ...
```

The `platform/` directory is reserved for subtree-managed platform code. The `user/` directory is reserved for client-specific code and assets. The child repository also keeps its own workflow configuration locally under `.github/workflows/`.

## Parent–client relationship

Each client repository tracks a specific branch in the parent repository.

That branch can represent a release line, a staging stream, a customer cohort, or another platform variant. Git subtree supports pulling from a specific remote branch into a chosen local prefix, which makes it a strong fit for this model.

In practical terms:

- Parent repo branch = authoritative source for platform content.
- Client repo `platform/` = local subtree mirror of that branch.
- Client repo `user/` = local client customization area.

Because the parent repository contains only platform code, the subtree relationship stays simple: the client imports the parent repository root into `platform/`.

## Why Git subtree fits

Git subtree imports an external repository into a subdirectory of another repository and supports subsequent updates from a selected remote branch.

For this architecture, subtree provides several advantages:

- Parent-originated changes remain scoped to `platform/`.
- Client-owned content under `user/` remains separate and unaffected by subtree pulls.
- The parent repository’s `.github` content does not replace the client repository’s `.github` directory, because the imported content lives under the subtree prefix rather than at the client repository root.
- Each client can track a specific parent branch, which supports controlled release management.

## Update model

### Initial setup

Each client repository is initialized so that the parent repository is connected as a subtree source for the local `platform/` directory.

Conceptually, this means:

- A remote reference, typically named `parent`, is configured in the client repository to point to the external parent repository.
- The selected parent branch is added into the client repository under `platform/` using Git subtree.

### Ongoing updates

When the client needs to pick up new platform changes, the client repository updates itself through a child-local GitHub Actions workflow.

That workflow is managed centrally by the **platform hub**, which triggers it from outside the client repository. At a high level, the child workflow performs a subtree pull from the selected parent branch into `platform/`, commits the resulting change if anything was updated, and pushes the new commit back to the client repository.

This keeps the update logic local to the child repository while allowing platform rollout to be coordinated centrally.

## Authentication model

This model uses fine-grained personal access tokens rather than a GitHub App. Fine-grained PATs can be limited to selected repositories and specific repository permissions, which makes them workable for the current scale.

The PAT should have access to:

- The parent platform repository, with read access to repository contents.
- The client repository, with read and write access to repository contents if updates will be committed and pushed back to the client repository.

Because PATs are user-linked credentials, they should be stored securely and treated as an interim authentication model.

## Client repository setup guidance

Each client repository should be prepared in a consistent way so that subtree synchronization remains safe and predictable.

### Required setup

Each client repository should have:

- A `platform/` directory reserved exclusively for subtree-managed content from the parent repository.
- A `user/` directory reserved exclusively for client-specific code and assets.
- A child-local GitHub Actions workflow that performs the subtree synchronization.
- A PAT or equivalent secret configured for that workflow so it can read from the parent repository and push updates back to the client repository.
- A clear, documented choice of which parent branch that client tracks.

### Directory ownership rules

To keep updates low-friction:

- The `platform/` directory should be treated as parent-managed content inside the client repository.
- Client-specific changes should not be made directly inside `platform/` unless there is an explicit policy for carrying local subtree modifications.
- Client-specific logic, configuration, and assets should live under `user/` or another designated client-owned path.
- Client repository metadata and operational configuration should remain local to the client repository.

These boundaries are what keep subtree pulls predictable over time.

### Operational prerequisites

Before enabling regular subtree pulls:

- Confirm the tracked branch exists in the parent repository.
- Confirm the PAT used by the client workflow can read the parent repository and write to the client repository as needed.
- Confirm the subtree layout is initialized correctly before automated pulls are attempted.
- Confirm the platform hub can trigger the child workflow as part of the rollout process.

## Operating model

At the current scale, PATs can be acceptable as long as scope is kept narrow and tokens are rotated deliberately.

Recommended practices include:

- Use fine-grained PATs rather than classic PATs.
- Limit PAT repository access to only the repositories that need to participate.
- Store PATs only in secure secret storage or protected environment configuration.
- Set token expirations and document a rotation process.

In the final operating model:

- The parent repository owns the shared platform.
- Each client repository imports that platform into `platform/` using Git subtree from a selected parent branch.
- Each client repository owns its own `user/` directory for client-specific code.
- Each client repository updates itself through a child-local GitHub Actions workflow.
- The platform hub coordinates rollout by triggering those child workflows externally.
- PAT-based authentication is used for parent reads and client pushes in this phase.

This provides a practical and understandable model for managing a set of client repositories from a common parent platform while keeping client-specific customizations isolated.
