# Testing & Sandbox

How `ai1-crhq-installer` gets tested without ever touching the live satellite. Sandboxing is
**built into the utility** (`--sandbox`, D-17) — no external harness. The payoff of the
library design (all DB through `getDb()`, all fs through `INSTALL_BASE_DIR`): the utility can
point those knobs at an isolated schema + temp dir and run a real install into there.

> Supersedes the earlier reliance on the external `installer-sandbox` + `sandbox-install-test`
> skills (dropped — D-16/D-17). We depend only on CRHQ deps (`server/db/knex.js`, the DB,
> `deploy-project`).

## Built-in `--sandbox`

```bash
# Install a package into a throwaway isolated schema + temp dir, report, tear down:
node scripts/install.mjs ./examples/bundle --sandbox

# Keep the sandbox (schema + temp dir) for inspection:
node scripts/install.mjs ./examples/bundle --sandbox --keep

# Full lifecycle assertion suite in the sandbox:
node scripts/install.mjs ./examples/bundle --sandbox --lifecycle
```

What `--sandbox` does (`lib/sandbox.mjs`, see utility-design.md B4):
1. **Provision** — `CREATE SCHEMA sandbox_<ts>`; for each managed table
   `CREATE TABLE sandbox_<ts>.<t> (LIKE public.<t> INCLUDING ALL)` — clones the **live** schema
   (D-18), so the sandbox can never drift from production. Optionally re-create intra-schema FKs;
   **seed** prerequisite `skills` rows copied from live so agent-attach + dependency checks
   mirror the real satellite (OQ-14).
2. **Redirect** — set `INSTALL_SCHEMA=sandbox_<ts>` + `INSTALL_BASE_DIR=<tempdir>`. All DB writes
   land in the sandbox schema; all fs writes under the temp dir.
3. **Run** — the requested op (install by default).
4. **Teardown** — `DROP SCHEMA … CASCADE` + rm tempdir, unless `--keep`.

Prereq confirmed in Phase 0: the DB user can `CREATE`/`DROP SCHEMA` and a schema-qualified
table is fully isolated (integration-reference.md §6).

## `--lifecycle` assertion suite (absorbs the old harness)

With `--sandbox --lifecycle`, the utility runs and asserts:

| Phase | Assert |
|-------|--------|
| Fresh install | completes; skills have content; recipes/agents/jobs created; agent joins populated |
| Status | runs clean |
| Idempotency | second install → **zero** state drift |
| Uninstall | completes; schema left clean (rows + joins + jobs gone) |
| Reinstall | reproduces the original state |

Exit non-zero if any phase fails; `--json` emits a machine-readable verdict (A6).

## Pre-flight: `--dry-run`

`--dry-run` makes **zero** writes (DB/fs; build-only for services per D-2a) and prints the plan
with "would …" lines. This is the fast pre-flight check (replacing the dropped
`sandbox-install-test`). Run it on every change:

```bash
node scripts/install.mjs ./examples/bundle --dry-run
```

## Acceptance criteria (what our installer must satisfy)

- [ ] **C1** knex imported via hardcoded `/opt/.../server/db/knex.js` in ESM (interceptable;
      also lets `getDb()` apply `INSTALL_SCHEMA` searchPath).
- [ ] **C2** every fs op under `INSTALL_BASE_DIR` (legacy fallback `CRHQ_BASE_DIR`).
- [ ] **C7** prints the canon completion strings.
- [ ] **C6** idempotent + clean uninstall + faithful reinstall (the `--lifecycle` asserts).
- [ ] **C5** locked-row handling (seed a locked skill in the sandbox; run with/without `--respect-locks`).
- [ ] `--dry-run` → "would…" output, zero writes (verify sandbox schema + temp dir untouched).
- [ ] Background-job upsert verified (job row present after install, gone after uninstall).
- [ ] Agent join sync verified (agent_skills/agent_recipes correct; stale links removed).
- [ ] **`--sandbox` self-provisions** (clone + seed + teardown) with no external harness/loader hook.

## Local test plan (build phase, before the satellite gate)

1. **Smoke** lib modules with `node --input-type=module -e` (manifest load, frontmatter/yaml parse).
2. **Dry-run** the runner over `examples/bundle/` → "would…" lines per component; no writes.
3. **`--sandbox --lifecycle`** over `examples/bundle/` → all phases green (self-contained).
4. **Negative**: malformed manifest, missing SKILL.md, locked skill, missing dependency
   (expect the C12 halt + exit code).
5. **Services**: `--dry-run` build-only here; a real service test is a separate, explicit,
   non-sandbox exercise (the sandbox models DB + fs, not nginx/PM2).

## Notes

- **Services aren't sandbox-covered** (no nginx/PM2 model). Plan a minimal explicit service
  smoke test outside the sandbox before shipping the service path.
- The sandbox **seeds** prerequisite skills from live; if a sample agent references a skill not
  present on the satellite, attach is skipped (by design) — keep sample agents' skills within the
  installed/seeded set or have the package install them first.
- Cloning via `LIKE INCLUDING ALL` tracks production automatically — but **omits foreign keys**;
  decide per OQ-14 whether the lifecycle assertions need intra-schema FKs re-created.
