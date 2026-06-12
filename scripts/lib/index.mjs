// index.mjs — public API barrel. The stable import surface for the CLI runner, package
// install_entry scripts, and standalone installers. Canonical absolute import (OQ-U1):
//   import { createContext, upsertSkill, … } from
//     '/opt/projects/crhq-satellite/user-skills/ai1-crhq-installer/scripts/lib/index.mjs';
export { createContext, parseFlags, resolveBase, resolveSchema } from './context.mjs';
export { getDb, getAdminDb, closeDb } from './db.mjs';
export { parseFrontmatter, loadYaml } from './parse.mjs';
export { copyTree, writeIfChanged, removeTree } from './fs.mjs';
export { makeLogger, VERDICT, SEVERITY } from './log.mjs';
export { requireSkills, requireFiles, PrereqError } from './prereq.mjs';
export { preflight, PreflightError } from './preflight.mjs';
export { loadManifest, validateManifest, ManifestError } from './manifest.mjs';
export { makeFilter, compileMatcher, hasFilter, FilterError } from './filter.mjs';
export { runPlan, ORDER } from './run.mjs';
export * as sandbox from './sandbox.mjs';
export { upsertSkill, removeSkill, statusSkill } from './core/skill.mjs';
export { upsertRecipe, removeRecipe, statusRecipe } from './core/recipe.mjs';
export { upsertAgent, removeAgent, statusAgent } from './core/agent.mjs';
export { upsertJob, removeJob, statusJob } from './core/job.mjs';
export { installService, removeService, statusService } from './core/service.mjs';
