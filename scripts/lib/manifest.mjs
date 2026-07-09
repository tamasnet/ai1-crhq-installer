// manifest.mjs — load + validate ai1-package.yaml and resolve it to an ordered install plan.
// Component sources are parsed into the def shapes consumed by lib/core/*.
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname, isAbsolute, resolve, basename, extname } from 'path';
import { loadYaml, parseFrontmatter, normalizeTextBody, normalizeDescription, normalizeInstructions } from './parse.mjs';
import { STANDARD_FLAG_NAMES } from './flags.mjs';
import { assertSafeSegment, assertDnsLabel } from './validate.mjs';

export class ManifestError extends Error {
  constructor(message) { super(message); this.name = 'ManifestError'; }
}

const TYPE_ORDER = ['skills', 'recipes', 'agents', 'jobs', 'services', 'projects'];

// Per-component `handling` (optional, applies to EVERY component type) — how the installer treats a
// manifest entry. The actual install/uninstall/skip decision lives in run.mjs (resolveHandling); the
// manifest layer only validates the value and shapes the def.
//   normal   — default; install on install, remove on uninstall.
//   removed  — a tombstone for a component that no longer ships in the package.
//              Inert by default; with the --removed flag it removes the component on BOTH install and
//              uninstall. Its files may be gone, so a 'removed' entry is never loaded from disk.
//   optional — not installed unless the --optional flag is given; uninstall (and status) behave
//              exactly like a normal component, with no flag required.
//   strict   — install lifecycle matches normal; file-tree components prune extras on install
//              (same as CLI --strict) without requiring --include.
export const HANDLING_VALUES = new Set(['normal', 'removed', 'optional', 'strict']);

// Component types whose manifest path is a single FILE (recipe/job .md/.yaml; skill/agent .md).
// Used when deriving a tombstone's name from its path.
const FILE_TYPES = new Set(['recipes', 'jobs', 'skills', 'agents']);

// Manifest v2: skill/agent content lives at skills/<key>.md / agents/<key>.md; optional asset
// trees live at skills/<key>/ / agents/<key>/ (sibling paths, basename without .md).
export function assetDirForContentPath(contentPath) {
  return join(dirname(contentPath), basename(contentPath, extname(contentPath)));
}

// The installer's own integer version. A package's optional `installer` field is the minimum
// version it requires — a plain positive integer with an implicit ">=" — and a package that needs a
// newer installer than this one is rejected at manifest load.
export const INSTALLER_VERSION = 2;

// varchar limits mirrored from the live CRHQ schema — validated here so a too-long
// value fails fast with a clear message instead of a Postgres error mid-install.
const LIMITS = {
  skillName: 100, recipeName: 200, agentName: 50, agentMode: 10, agentModel: 20, agentType: 20,
  jobName: 255, jobSchedule: 100, jobTimezone: 50, serviceName: 255, projectName: 255,
};

export function loadManifest(pathOrDir) {
  const manifestPath = resolveManifestPath(pathOrDir);
  if (!existsSync(manifestPath)) throw new ManifestError(`Manifest not found: ${manifestPath}`);
  const packageRoot = dirname(manifestPath);
  const meta = loadYaml(readFileSync(manifestPath, 'utf8'));
  validateManifest(meta);
  const plan = buildPlan(meta, packageRoot);
  return { meta, plan, packageRoot };
}

function resolveManifestPath(pathOrDir) {
  const abs = isAbsolute(pathOrDir) ? pathOrDir : resolve(process.cwd(), pathOrDir);
  if (existsSync(abs) && statSync(abs).isDirectory()) return join(abs, 'ai1-package.yaml');
  return abs;
}

export function validateManifest(meta) {
  if (!meta || typeof meta !== 'object') throw new ManifestError('Manifest is empty or not an object');
  for (const f of ['name', 'version', 'description', 'components']) {
    if (meta[f] == null) throw new ManifestError(`Manifest missing required field: ${f}`);
  }
  assertManifestSegment('package name', meta.name);
  if (typeof meta.components !== 'object' || Array.isArray(meta.components)) {
    throw new ManifestError('components must be a mapping of type → list');
  }
  for (const type of Object.keys(meta.components)) {
    if (!TYPE_ORDER.includes(type)) throw new ManifestError(`Unknown component type: ${type}`);
    const list = meta.components[type];
    if (!Array.isArray(list)) throw new ManifestError(`components.${type} must be a list`);
    for (const entry of list) {
      if (!entry || !entry.path) throw new ManifestError(`components.${type}[] entry missing 'path'`);
      // handling (optional): normal (default) | removed (tombstone) | optional | strict — any type.
      if (entry.handling != null && !HANDLING_VALUES.has(entry.handling)) {
        throw new ManifestError(`components.${type}[${entry.path}] handling must be one of ${[...HANDLING_VALUES].join(', ')} (got ${JSON.stringify(entry.handling)})`);
      }
      // protect (optional): glob patterns extending DEFAULT_PROTECT ('!pattern' opts out of a
      // default). Shape-checked only; pattern semantics live in protect.mjs.
      if (entry.protect != null && (!Array.isArray(entry.protect)
        || entry.protect.some((p) => typeof p !== 'string' || p.trim() === ''))) {
        throw new ManifestError(`components.${type}[${entry.path}] protect must be a list of non-empty strings`);
      }
      // A version pin is required for real skills/services/projects. A 'removed' tombstone is exempt:
      // its component files are gone, so there is nothing left to version-check.
      if (entry.handling !== 'removed' && (type === 'skills' || type === 'services' || type === 'projects') && !entry.version) {
        throw new ManifestError(`components.${type}[${entry.path}] requires a version pin`);
      }
      if (entry.handling !== 'removed' && (type === 'skills' || type === 'agents') && !entry.path.endsWith('.md')) {
        throw new ManifestError(`components.${type}[${entry.path}] path must be a .md file (manifest v2)`);
      }
    }
  }
  // installer (optional): the minimum installer version the package needs — a plain positive
  // integer, implicitly ">=". A package that requires a newer installer than this one is rejected.
  if (meta.installer != null) {
    const need = intVersion('installer (minimum installer version)', meta.installer);
    if (need > INSTALLER_VERSION) {
      throw new ManifestError(`package requires installer version >= ${need}, but this installer is ${INSTALLER_VERSION}`);
    }
  }
  // install_flags (optional): package-specific CLI flags the installer accepts and forwards to
  // install_entry. Each must be a `--`-prefixed name and must NOT shadow a standard flag.
  if (meta.install_flags != null) {
    if (!Array.isArray(meta.install_flags)) throw new ManifestError('install_flags must be a list');
    for (const f of meta.install_flags) {
      if (!f || typeof f.name !== 'string' || !f.name.startsWith('--')) {
        throw new ManifestError("install_flags[] entry needs a string 'name' starting with '--'");
      }
      if (STANDARD_FLAG_NAMES.has(f.name)) {
        throw new ManifestError(`install_flags cannot re-declare a standard flag: ${f.name}`);
      }
    }
  }
}

function buildPlan(meta, root) {
  const c = meta.components || {};
  const load = (type, loader) => (c[type] || []).map((e) => resolveEntry(type, e, root, loader));
  return {
    skills: load('skills', loadSkillDef),
    recipes: load('recipes', loadRecipeDef),
    agents: load('agents', loadAgentDef),
    jobs: load('jobs', loadJobDef),
    services: load('services', loadServiceDef),
    projects: load('projects', loadProjectDef),
  };
}

// Resolve a single manifest entry into an install-plan def, tagging it with its `handling` mode
// (default 'normal'). A 'removed' tombstone is deliberately NOT loaded from disk — its component
// files may no longer exist (that is the whole point) — so it resolves to a minimal def carrying just
// the canonical name needed to delete the component. 'normal' and 'optional' entries load the real
// component exactly as before.
function resolveEntry(type, entry, root, loader) {
  const handling = entry.handling || 'normal';
  if (handling === 'removed') return loadRemovedDef(type, entry, root);
  // protect rides the def for every type so core/* consumers (strict prune, sync export) share it.
  return { ...loader(entry, root), handling, ...(entry.protect != null ? { protect: entry.protect } : {}) };
}

// Build a 'removed' tombstone def. We never read the component's files; we only need its canonical DB
// name to remove it (plus a `key` for the skill asset-dir fallback). The name comes from the entry's
// explicit `name` when given, else the path basename (minus extension for single-file types).
function loadRemovedDef(type, entry, root) {
  const name = removedName(type, entry);
  if (!name) throw new ManifestError(`components.${type}[${entry.path}] handling 'removed' has no derivable name — set 'name:' on the entry`);
  const srcDir = join(root, entry.path);
  return { name, key: name, handling: 'removed', srcDir, srcFile: srcDir };
}

function removedName(type, entry) {
  const name = entry.name != null && String(entry.name).trim() !== ''
    ? String(entry.name).trim()
    : (FILE_TYPES.has(type) ? basename(entry.path, extname(entry.path)) : basename(entry.path));
  assertManifestSegment(`${type} removed name`, name);
  return name;
}

function loadSkillDef(entry, root) {
  const srcFile = join(root, entry.path);
  if (!existsSync(srcFile)) throw new ManifestError(`Skill not found: ${entry.path}`);
  const { meta, body } = parseFrontmatter(readFileSync(srcFile, 'utf8'));
  if (!meta.name) throw new ManifestError(`Skill missing 'name': ${entry.path}`);
  assertManifestSegment('skill name', meta.name);
  if (meta.version == null) throw new ManifestError(`Skill missing 'version': ${entry.path}`);
  const version = intVersion(`Skill ${meta.name} version`, meta.version);
  const pin = intVersion(`Skill ${entry.path} manifest version`, entry.version);
  if (version !== pin) {
    throw new ManifestError(`Skill ${meta.name}: version ${version} != manifest pin ${pin}`);
  }
  checkLen('skill name', meta.name, LIMITS.skillName);
  const installType = entry.install_type;
  if (installType != null && installType !== 'user' && installType !== 'org') {
    throw new ManifestError(`Skill ${meta.name}: install_type must be 'user' or 'org' (got '${installType}')`);
  }
  const srcDir = join(root, assetDirForContentPath(entry.path));
  return {
    key: meta.name, name: meta.name, description: normalizeDescription(meta.description), version,
    srcDir, srcFile, content: normalizeTextBody(body), installType,
  };
}

function loadRecipeDef(entry, root) {
  const srcFile = join(root, entry.path);
  if (!existsSync(srcFile)) throw new ManifestError(`Recipe not found: ${entry.path}`);
  const { meta, body } = parseFrontmatter(readFileSync(srcFile, 'utf8'));
  if (!meta.name) throw new ManifestError(`Recipe missing 'name': ${entry.path}`);
  assertManifestSegment('recipe name', meta.name);
  checkLen('recipe name', meta.name, LIMITS.recipeName);
  // Version is optional for recipes; when present (frontmatter and/or manifest pin) it's an integer
  // and the two must agree.
  const version = resolveOptionalVersion(`Recipe ${meta.name}`, meta.version, entry.version, entry.path);
  return {
    name: meta.name, description: normalizeDescription(meta.description),
    content: normalizeTextBody(body), srcFile, ...(version != null ? { version } : {}),
  };
}

function loadAgentDef(entry, root) {
  const srcFile = join(root, entry.path);
  if (!existsSync(srcFile)) throw new ManifestError(`Agent not found: ${entry.path}`);
  const { meta: a, body } = parseFrontmatter(readFileSync(srcFile, 'utf8'));
  // Agents follow the same name/description pattern as every other component type: `name` is the
  // canonical identifier (stored as CRHQ agents.key), `display_name` the human label (stored as
  // agents.name).
  if (a.key) throw new ManifestError(`Agent '${entry.path}': use 'name' (the agent identifier) and 'display_name' (the human label), not 'key'`);
  if (!a.name) throw new ManifestError(`Agent missing 'name': ${entry.path}`);
  assertManifestSegment('agent name', a.name);
  if (!a.display_name) throw new ManifestError(`Agent missing 'display_name': ${entry.path}`);
  checkLen('agent name', a.name, LIMITS.agentName);
  if (a.mode) checkLen('agent mode', a.mode, LIMITS.agentMode);
  if (a.default_model) checkLen('agent default_model', a.default_model, LIMITS.agentModel);
  if (a.agent_type) checkLen('agent agent_type', a.agent_type, LIMITS.agentType);
  const instructions = normalizeInstructions(body);
  // Version is optional for agents; when present it round-trips through agent_versions.
  const version = resolveOptionalVersion(`Agent ${a.name}`, a.version, entry.version, entry.path);
  return {
    name: a.name, display_name: a.display_name, description: normalizeDescription(a.description), mode: a.mode || 'cli',
    default_model: a.default_model, agent_type: a.agent_type, icon: a.icon, skills: a.skills || [], recipes: a.recipes || [],
    instructions, system_prompt_path: a.system_prompt_path, capabilities: a.capabilities, provider: a.provider,
    srcDir: join(root, assetDirForContentPath(entry.path)), srcFile,
    ...(version != null ? { version } : {}),
  };
}

function loadJobDef(entry, root) {
  const srcFile = join(root, entry.path);
  if (!existsSync(srcFile)) throw new ManifestError(`Job not found: ${entry.path}`);
  const j = loadYaml(readFileSync(srcFile, 'utf8'));
  if (!j.name) throw new ManifestError(`Job missing 'name': ${entry.path}`);
  assertManifestSegment('job name', j.name);
  if (!j.schedule) throw new ManifestError(`Job missing 'schedule': ${entry.path}`);
  checkLen('job name', j.name, LIMITS.jobName);

  const jobType = j.job_type || (j.script ? 'script' : null);
  if (!jobType) throw new ManifestError(`Job missing 'script' or 'job_type': ${entry.path}`);
  if (!['script', 'new_session', 'message_session'].includes(jobType)) {
    throw new ManifestError(`Job ${j.name}: invalid job_type '${j.job_type}'`);
  }
  if (jobType === 'script' && !j.script) throw new ManifestError(`Job missing 'script': ${entry.path}`);
  if (jobType === 'new_session' && !j.agent) {
    throw new ManifestError(`Job ${j.name}: new_session requires 'agent'`);
  }
  if (jobType === 'new_session' && !j.task && !j.recipe_id) {
    throw new ManifestError(`Job ${j.name}: new_session requires 'task' or 'recipe_id'`);
  }
  if (jobType === 'message_session' && (!j.target_session_id || !j.message)) {
    throw new ManifestError(`Job ${j.name}: message_session requires 'target_session_id' and 'message'`);
  }

  return {
    name: j.name,
    job_type: jobType,
    description: j.description || '',
    schedule: j.schedule,
    timezone: j.timezone,
    script: j.script,
    args: j.args,
    agent: j.agent,
    task: j.task,
    recipe_id: j.recipe_id,
    project_id: j.project_id,
    target_session_id: j.target_session_id,
    message: j.message,
    model: j.model,
    max_runs_before_rotate: j.max_runs_before_rotate,
    timeout_minutes: j.timeout_minutes,
    max_concurrent: j.max_concurrent,
    skip_if_running: j.skip_if_running,
    enabled: j.enabled,
    requires: j.requires || [],
    srcFile,
  };
}

function loadServiceDef(entry, root) {
  return loadWebAppDef(entry, root, 'service');
}

function loadProjectDef(entry, root) {
  return loadWebAppDef(entry, root, 'project');
}

export function readWebAppConfig(srcDir, { kind = 'service', pathLabel = srcDir } = {}) {
  const cap = kind === 'project' ? 'Project' : 'Service';
  const fileName = kind === 'project' ? 'project.yaml' : 'service.yaml';
  const yPath = join(srcDir, fileName);
  if (!existsSync(yPath)) throw new ManifestError(`${cap} missing ${fileName}: ${pathLabel}`);
  const s = loadYaml(readFileSync(yPath, 'utf8'));
  if (!s.name) throw new ManifestError(`${fileName} missing 'name': ${pathLabel}`);
  assertManifestSegment(`${kind} name`, s.name);
  if (s.version == null) throw new ManifestError(`${fileName} missing 'version': ${pathLabel}`);
  const version = intVersion(`${cap} ${s.name} version`, s.version);
  if (!s.start) throw new ManifestError(`${fileName} missing 'start': ${pathLabel}`);
  checkLen(`${kind} name`, s.name, kind === 'project' ? LIMITS.projectName : LIMITS.serviceName);
  let app_name = s.name;
  if (s.app_name != null && String(s.app_name).trim() !== '') {
    app_name = String(s.app_name).trim();
    assertManifestDnsLabel('app_name', app_name);
  }
  return { config: s, version, srcFile: yPath, app_name };
}

function loadWebAppDef(entry, root, kind) {
  const srcDir = join(root, entry.path);
  const { config: s, version, srcFile, app_name } = readWebAppConfig(srcDir, { kind, pathLabel: entry.path });
  const cap = kind === 'project' ? 'Project' : 'Service';
  const fileName = kind === 'project' ? 'project.yaml' : 'service.yaml';
  const pin = intVersion(`${cap} ${entry.path} manifest version`, entry.version);
  if (version !== pin) {
    throw new ManifestError(`${cap} ${s.name}: ${fileName} version ${version} != manifest pin ${pin}`);
  }
  return {
    name: s.name, version, start: s.start, port: s.port, cwd: s.cwd || './',
    build: normalizeBuild(`${cap} ${s.name} build`, s.build), env: s.env || {}, app_name, ssl: s.ssl, srcDir, srcFile,
  };
}

// Normalize the optional `build` field to a list of shell commands run sequentially at install time.
// Accepts a single string or a YAML list of strings; trims and drops empty/whitespace-only entries.
// Returns undefined when nothing remains (no build step). Non-string entries are a manifest error.
export function normalizeBuild(label, build) {
  if (build == null) return undefined;
  const list = Array.isArray(build) ? build : [build];
  const cmds = [];
  for (const c of list) {
    if (typeof c !== 'string') throw new ManifestError(`${label} must be a string or a list of strings`);
    if (c.trim() !== '') cmds.push(c);
  }
  return cmds.length ? cmds : undefined;
}

function checkLen(label, val, max) {
  if (String(val).length > max) throw new ManifestError(`${label} exceeds ${max} chars: ${val}`);
}

function assertManifestSegment(label, val) {
  try {
    assertSafeSegment(label, val);
  } catch (e) {
    throw new ManifestError(e.message);
  }
}

function assertManifestDnsLabel(label, val) {
  try {
    assertDnsLabel(label, val);
  } catch (e) {
    throw new ManifestError(e.message);
  }
}

// Component versions are positive integers — they round-trip through CRHQ's *_versions
// tables (skill_versions/recipe_versions/agent_versions). Accept a YAML number or a numeric string;
// reject anything else (incl. the old semver form like 0.1.0). The package-level `version` is a
// separate free-form label (sync --mirror auto-increments it as an integer) and is NOT constrained here.
function intVersion(label, v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  if (!Number.isInteger(n) || n < 1) throw new ManifestError(`${label} must be a positive integer (got ${JSON.stringify(v)})`);
  return n;
}

// Optional integer version for recipes/agents: validate either source if present and require them to
// agree. Returns the integer version, or null when neither side declares one.
function resolveOptionalVersion(label, fmVersion, pinVersion, path) {
  const fmV = fmVersion != null ? intVersion(`${label} version`, fmVersion) : null;
  const pinV = pinVersion != null ? intVersion(`${label} manifest version (${path})`, pinVersion) : null;
  if (fmV != null && pinV != null && fmV !== pinV) {
    throw new ManifestError(`${label}: version ${fmV} != manifest pin ${pinV}`);
  }
  return fmV ?? pinV ?? null;
}
