# Testing & Sandbox

How `ai1-crhq-installer` gets tested without ever touching the live satellite. This is the
payoff of following `canon-conventions.md` (esp. C1 interceptable knex + C2 `INSTALL_BASE_DIR`).

## Two harnesses (both already exist — we reuse, don't build)

### 1. `installer-sandbox` — full lifecycle against an isolated schema

```bash
node /opt/projects/crhq-satellite/user-skills/installer-sandbox/scripts/test.mjs \
  --installer <path-to-our-install.mjs> [--keep] [--verbose] [--skip-lifecycle]
```

What it does:
1. `CREATE SCHEMA sandbox_<ts>` with prod-matching DDL for **7 tables** (skills,
   skill_versions, recipes, agents, agent_skills, agent_recipes, background_jobs).
2. Seeds placeholder utility skills (so agent skill-attach succeeds).
3. Creates a temp FS root and runs our installer with
   `node --loader sandbox-hooks.mjs … SANDBOX_SCHEMA=… CRHQ_BASE_DIR=<tmp>`.
   (The harness sets the **legacy** names; our utility reads `INSTALL_SCHEMA`/`INSTALL_BASE_DIR`
   first and falls back to these — D-15 — so it runs correctly under this harness unchanged.)
4. Runs the **lifecycle** and asserts:
   - **Fresh install** completes (matches install completion regex), skills have content,
     recipe(s)/agent(s) created, agent has skills + recipe(s) attached.
   - **Status** runs clean.
   - **Idempotency**: 2nd install → state diff is empty.
   - **Uninstall** completes and leaves a clean schema.
   - **Reinstall** reproduces the original state.
5. `DROP SCHEMA CASCADE` + removes temp dir (unless `--keep`).

This is our **primary acceptance test**. Target: all phases green.

### 2. `sandbox-install-test` — fast pre-push dry-run check

```bash
node /opt/projects/crhq-satellite/user-skills/sandbox-install-test/scripts/test.mjs \
  --dir <bundle>/scripts [--json]
```
Runs `install.mjs --dry-run` and fails on: non-zero exit, error lines
(`^(error:|❌|fatal:|uncaught|throw)`), <200 bytes output, or no "would…" actions.
Cheap gate to run on every change.

## What our installer must satisfy (acceptance criteria)

- [ ] **C1** knex imported via hardcoded `/opt/.../server/db/knex.js` in ESM → interception works.
- [ ] **C2** every fs op under `INSTALL_BASE_DIR` (legacy fallback `CRHQ_BASE_DIR`).
- [ ] **C7** prints the exact completion strings the harness greps.
- [ ] **C6** idempotent + clean uninstall + faithful reinstall (the 4 lifecycle asserts).
- [ ] **C5** locked-row handling verified (seed a locked skill, run with/without `--respect-locks`).
- [ ] `--dry-run` produces "would…" output and zero writes (verify schema + temp dir untouched).
- [ ] Background job upsert verified (job row present after install, gone after uninstall).
- [ ] Agent join sync verified (agent_skills/agent_recipes correct, stale links removed).

## Local test plan (during build, before the satellite gate)

1. **Smoke** lib modules with `node --input-type=module -e` (manifest load, frontmatter parse).
2. **Dry-run** the generic runner over `examples/bundle/` → assert "would…" lines for each
   resource type; assert no schema/file changes.
3. **Full lifecycle** via `installer-sandbox --installer scripts/install.mjs` → all green.
4. **Negative**: malformed manifest, missing SKILL.md, locked skill, missing dependency skill
   (expect the C12 halt + exit code).
5. **Services**: dry-run only here (sandbox doesn't model nginx/PM2); real service test is a
   separate, explicit, non-sandbox exercise.

## Gaps / notes

- **Services aren't covered** by either harness (no nginx/PM2 model). Plan a minimal,
  explicit service smoke test outside the sandbox before shipping the service path.
- The sandbox seeds a fixed utility-skill list; if our sample agent references a skill not in
  that list, attach is skipped (by design). Keep the sample agent's skills within the seeded
  set or have the bundle install those skills first.
- `installer-sandbox` greps completion strings — keep our success/uninstall lines matching C7
  even as we reword logs.
