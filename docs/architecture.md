# Architecture & Design

> Revised after studying the canon installers + sandbox. The earlier REST/JSON-manifest
> draft is superseded: installs are **DB-direct** and must be **sandbox-compatible**
> (see `canon-conventions.md`).

## 1. Goal

`ai1-crhq-installer` installs a bundle of resources into a CRHQ satellite:
**skills, recipes, agents, scheduled jobs** (DB-resident) and **services**
(nginx + PM2, not in the DB). It must be **idempotent**, **dry-runnable**, and
**testable in the installer sandbox** without touching the live satellite.

## 2. The central design decision (product shape)

The canon ecosystem has two facts in tension with the original scaffold:

- **Canon installers are bespoke**: each `install.mjs` hardcodes its component arrays;
  `manifest.yaml`/`skill.json` are *publishing* metadata, not installer input.
- **Our brief wants a generic installer** that installs "skills, agents, recipes, services."

Three shapes (decision **D-8**, see decisions doc):

| Shape | What it is | Pros | Cons |
|-------|-----------|------|------|
| **A. Generic engine** | One `install.mjs` reads a declarative manifest of resources + data files and performs upserts | Matches the brief; DRYs the 4 near-identical installers; one thing to sandbox-test | Diverges from "hardcoded per bundle" canon; manifest schema is new surface |
| **B. Scaffolder** | Generates a canon-compliant bespoke `install.mjs` + layout for a new bundle | Outputs are 100% canon; each bundle independently testable | It's a codegen tool, not an installer; more indirection |
| **C. Hybrid (recommended)** | Shared **core library** (`lib/core/*`, exposed via `lib/index.mjs`) of upsert primitives + a **generic manifest-driven `install.mjs`** on top; optional scaffolder later | Bundles can be pure manifest *or* a 10-line bespoke installer that imports the lib; library is reused by both; canon-compliant and sandbox-testable | Slightly more upfront design |

**Recommendation: C.** Build the core library first (the primitives every canon installer
re-implements by hand), expose a generic manifest runner over it, and keep the door open
for a scaffolder. Everything below assumes C.

## 3. Resource types

| Type | Store | Sandbox-testable? | Mechanism |
|------|-------|-------------------|-----------|
| Skill | `skills` table + `INSTALL_BASE_DIR/<key>/` fs | ✅ | upsert row + copy assets |
| Recipe | `recipes` table | ✅ | upsert row (uuid PK) |
| Agent | `agents` + `agent_skills` + `agent_recipes` | ✅ | upsert + sync joins |
| Job | `background_jobs` table | ✅ (table is in sandbox DDL) | upsert job row |
| Service | nginx vhost + PM2 process | ❌ (not DB/fs-in-BASE) | deploy-project conventions; dry-run only in sandbox |

Jobs were not in the original scaffold but every canon installer registers them — adding a
`jobs` resource type rounds out the system (confirm via D-9).

## 4. Layout (target, ESM)

```
ai1-crhq-installer/
├── SKILL.md                      # skill doc (frontmatter name/description)
├── manifest.yaml                 # publishing metadata (scope, classification, version…)
├── package.json                  # type: module
├── scripts/
│   ├── install.mjs               # generic entry: load manifest → drive core; flags
│   └── lib/                      # AUTHORITATIVE module map: utility-design.md Part C
│       ├── index.mjs            # public API barrel (the stable import surface)
│       ├── context.mjs          # createContext: flag parse → bound {db,BASE,DRY_RUN,mode,…}
│       ├── db.mjs               # getDb/closeDb — STATIC hardcoded knex import + INSTALL_SCHEMA (C1)
│       ├── manifest.mjs         # load + validate ai1-package.yaml → ordered plan
│       ├── parse.mjs            # parseFrontmatter, loadYaml (C11)
│       ├── fs.mjs               # copyTree/writeIfChanged/removeTree — INSTALL_BASE_DIR-rooted (C2)
│       ├── log.mjs              # logging + dry-run markers + completion strings + VERDICT
│       ├── prereq.mjs           # requireSkills, requireFiles (C12)
│       ├── sandbox.mjs          # --sandbox: provision (LIKE-clone) + seed + teardown (D-17/18)
│       └── core/                # per-type primitives (the former monolithic "installer-core")
│           ├── skill.mjs        # upsertSkill / removeSkill / statusSkill
│           ├── recipe.mjs       #   "        (dry-run, lock, idempotency baked in)
│           ├── agent.mjs        # + agent_skills / agent_recipes join sync
│           ├── job.mjs
│           └── service.mjs      # deploy-project emit (D-2)
└── examples/
    └── bundle/                   # a complete runnable sample (skill+recipe+agent+job+service)
```

> **Migration note:** the current scaffold is CommonJS `scripts/install.js` +
> `install-skill.js` … `install-service.js` with `require`. These must become **ESM `.mjs`**
> because (a) `server/db/knex.js` is ESM and (b) only ESM `import` is interceptable by the
> sandbox loader hook (C1). The per-type `install-*.js` collapse into `lib/core/*` primitives
> (exposed via `lib/index.mjs`); they can still be exposed as thin CLI wrappers if we want
> per-type commands.

## 5. Manifest (installer input)

The generic runner consumes **`ai1-package.yaml`** at the package root — a declarative
`components` inventory (skills/recipes/agents/jobs/services) plus an optional `install_entry`
hook for package-specific steps. **The full, finalized format is `package-manifest-spec.md`
(v0.2)** — that doc is the contract; this section just situates it. (D-10 resolved.)

Paths in `components` resolve relative to the package root. Install order:
**skills → recipes → agents → jobs → services** (within a type, array order; agents reference
skills+recipes; jobs reference skill scripts; services independent). Uninstall reverses (C13).

## 6. Core primitives (`lib/core/*`, exposed via `lib/index.mjs`)

Each is `async (ctx, def) => result`, where `ctx` is the object from `createContext`
(`{ db, BASE, DRY_RUN, RESPECT_LOCKS, mode, log, results }` — see utility-design.md B3):

- `upsertSkill(def)` — unlock-if-needed (C5) → insert|update row → copy `${INSTALL_BASE_DIR}/<key>/`.
- `upsertRecipe(def)` — insert|update by name (uuid auto).
- `upsertAgent(def)` — insert|update by key → sync `agent_skills` (existing+active only) →
  resolve recipe ids → sync `agent_recipes`.
- `upsertJob(def)` — insert|update `background_jobs` by name; `id = job-<ts>-<rand>`.
- `installService(def)` — deploy-project emit (separate, non-DB; see §8).
- `remove*` mirrors for `--uninstall`.
- `status*` for `--status`.

All write helpers honor `DRY_RUN` (print "would …", zero side effects) and emit the
canon completion strings via `log` (C7).

## 7. CLI surface

```
install.mjs [<manifest>] [flags]
  --dry-run        plan only, no writes (DB/fs; build-only for services)
  --status         report install state for the manifest
  --uninstall      remove everything in the manifest (reverse order)
  --respect-locks  skip locked skill rows instead of unlocking
  --no-agent       install skills/recipes/jobs only
  --no-job         skip background_jobs registration
  --only=<type>    restrict to skills|recipes|agents|jobs|services
  --sandbox        run into a throwaway isolated schema + temp dir (self-contained; D-17)
    --keep         preserve the sandbox (schema + temp dir) for inspection
    --lifecycle    run install→status→idempotency→uninstall→reinstall assertions
```
If `<manifest>` is omitted, default to `./ai1-package.yaml`.

## 8. Services (reuse deploy-project — D-2)

Services are **not** DB-resident and **not** covered by the sandbox. The installer:
- copies source → `/opt/projects/user/<name>/`,
- writes `.env` from `service.yaml `env`` (never logs secrets),
- writes `ecosystem.config.cjs` and nginx vhost in `/etc/nginx/projects.d/`,
- allocates a free port, starts/reloads PM2 `<name>` + nginx.

**Dry-run (D-2a):** the **build step is performed** (validate source/config, surface build
errors) but the **deploy-project apply is skipped** — no nginx/PM2/port/reload, no live
changes. This differs from DB resources (whose dry-run is pure preview): services get
exercised up to, but not including, the live wiring.

Templates/port rules are owned by `deploy-project`; we reference them. In sandbox/dry-run,
service steps only **print the plan**. **Open (D-2a):** shell out to deploy-project scripts
vs template inline.

## 9. Safety boundaries (MANDATORY)

- Hardcode the knex import path (C1) — never derive from env — but **never modify** any core
  file. Importing `server/db/knex.js` at runtime is the sanctioned canon mechanism; reading/
  editing/printing its contents is not.
- All skill fs writes go under `${INSTALL_BASE_DIR}` (C2; the skill-parent dir) and
  `/opt/projects/user/<svc>` for services.
- Never run PM2 against `crhq-satellite`; service process names are the bundle's own.
- `--dry-run` = zero side effects. Locked rows respected per `--respect-locks` (C5).
- Secrets from `service.yaml `env`` → service `.env` only; never echoed to logs.
- Prereq checks before writes (C12); halt with actionable message + exit code.

## 10. What we reuse vs build

- **Reuse (CRHQ deps only):** `server/db/knex.js` (DB accessor), the live DB (schema cloned for
  sandbox), `deploy-project` (services).
- **Build:** `lib/core/*` (the DRY primitives) + `lib/index.mjs` barrel, the generic manifest
  runner, the manifest schema + validator, **`lib/sandbox.mjs` (built-in `--sandbox`, absorbing
  the external `installer-sandbox`)**, the sample bundle.
- **Dropped:** external `installer-sandbox` + `sandbox-install-test` dependencies (D-16/D-17) —
  the utility is self-contained except for the CRHQ deps above.
