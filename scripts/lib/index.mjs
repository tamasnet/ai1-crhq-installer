// index.mjs — public API barrel. The stable import surface for the CLI runner, package
// install_entry scripts, and standalone installers. Canonical absolute import (OQ-U1):
//   import { createContext, upsertSkill, … } from
//     '/opt/projects/crhq-satellite/user-skills/ai1-crhq-installer/scripts/lib/index.mjs';
export { createContext, parseFlags, resolveBase, resolveSchema, resolveBackupBase } from './context.mjs';
export { getDb, getAdminDb, closeDb } from './db.mjs';
export { parseFrontmatter, loadYaml, dumpYaml } from './parse.mjs';
export { copyTree, writeIfChanged, removeTree, safeName } from './fs.mjs';
export { makeLogger, VERDICT, SEVERITY } from './log.mjs';
export { requireSkills, requireFiles, PrereqError } from './prereq.mjs';
export { preflight, PreflightError } from './preflight.mjs';
export { resolvePackagesDir, installLogPath, readInstallLog, updateInstallLog, sortInstalled, formatInstalledList } from './install-log.mjs';
export { currentVersion, recordVersion, removeVersions, versionTable } from './version-history.mjs';
export { loadManifest, validateManifest, ManifestError, INSTALLER_VERSION } from './manifest.mjs';
export { makeFilter, compileMatcher, hasFilter, FilterError } from './filter.mjs';
export { validateFlags, usage, wantsHelp, declaredFlagNames, UsageError, STANDARD_FLAG_NAMES, FLAG_SPEC } from './flags.mjs';
export { runPlan, ORDER } from './run.mjs';
export { runBackup, resolveBackupName, dateVersion, BACKUP_TYPES } from './backup.mjs';
export * as sandbox from './sandbox.mjs';
export { upsertSkill, removeSkill, statusSkill, exportSkill } from './core/skill.mjs';
export { upsertRecipe, removeRecipe, statusRecipe, exportRecipe } from './core/recipe.mjs';
export { upsertAgent, removeAgent, statusAgent, exportAgent } from './core/agent.mjs';
export { upsertJob, removeJob, statusJob, exportJob } from './core/job.mjs';
export { installService, removeService, statusService } from './core/service.mjs';
