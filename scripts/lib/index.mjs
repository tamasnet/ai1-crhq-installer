// index.mjs — public API barrel. The stable import surface for the CLI runner, package
// install_entry scripts, and standalone installers. Canonical absolute import:
//   import { createContext, upsertSkill, … } from
//     '/opt/projects/crhq-satellite/user-skills/ai1-satellite-tools/scripts/lib/index.mjs';
export { createContext, parseFlags, resolveSkillsBase, resolveBrains, resolveSchema } from './context.mjs';
export { resolveServicesBase, resolveUserProjectsBase } from './paths.mjs';
export { resolveSatelliteId, satellitePackageName } from './identity.mjs';
export { getDb, getAdminDb, closeDb } from './db.mjs';
export { parseFrontmatter, loadYaml, dumpYaml } from './parse.mjs';
export { copyTree, writeIfChanged, removeTree, moveTree, ensureSymlink, pathExistsOrLink, safeName } from './fs.mjs';
export { makeLogger, VERDICT, SEVERITY } from './log.mjs';
export { requireSkills, requireFiles, PrereqError } from './prereq.mjs';
export { preflight, PreflightError } from './preflight.mjs';
export { resolvePackagesDir, installLogPath, readInstallState, readInstallLog, updateInstallLog, updateInstallLogForMirror, pruneInstallLog, sortInstalled, formatInstalledList, COMPONENT_TYPES } from './install-log.mjs';
export { discoverPackages, collectAvailable, sortAvailable, formatAvailableList, buildAvailableReport } from './list-available.mjs';
export { currentVersion, recordVersion, removeVersions, versionTable } from './version-history.mjs';
export { assertSafeSegment, assertDnsLabel, assertSafeEnvValue, formatEnvValue } from './validate.mjs';
export { loadManifest, validateManifest, ManifestError, INSTALLER_VERSION, HANDLING_VALUES } from './manifest.mjs';
export { makeFilter, compileMatcher, hasFilter, FilterError } from './filter.mjs';
export { CLI_TYPE_TO_COLLECTION, COLLECTION_TO_CLI_TYPE, CLI_TYPE_VALUES, COLLECTION_TYPE_VALUES, splitCliTypeValues, normalizeCliTypeScope, formatCliTypeError } from './component-types.mjs';
export { validateFlags, usage, wantsHelp, declaredFlagNames, UsageError, STANDARD_FLAG_NAMES, FLAG_SPEC } from './flags.mjs';
export { runPlan, ORDER, resolveHandling } from './run.mjs';
export { runSync, SyncError, SYNC_TYPES, discoverLiveComponents } from './sync.mjs';
export { runPruneInstalled, formatPruneReport } from './prune-installed.mjs';
export { runDrift, formatDriftReport, indexPackageStores, DRIFT_STATES } from './drift.mjs';
export { runActions, ActionError } from './action.mjs';
export * as sandbox from './sandbox.mjs';
export { upsertSkill, removeSkill, statusSkill, exportSkill, planSkill } from './core/skill.mjs';
export { upsertRecipe, removeRecipe, statusRecipe, exportRecipe, planRecipe } from './core/recipe.mjs';
export { upsertAgent, removeAgent, statusAgent, exportAgent, planAgent } from './core/agent.mjs';
export { upsertJob, removeJob, statusJob, exportJob, planJob } from './core/job.mjs';
export { installService, removeService, statusService, installProject, removeProject, statusProject, planService, planProject } from './core/service.mjs';
