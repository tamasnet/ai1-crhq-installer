// manifest.mjs — load + validate ai1-package.yaml and resolve it to an ordered install plan (A1).
// Component sources are parsed into the def shapes consumed by lib/core/* (api-design §7).
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname, isAbsolute, resolve } from 'path';
import { loadYaml, parseFrontmatter } from './parse.mjs';
import { STANDARD_FLAG_NAMES } from './flags.mjs';

export class ManifestError extends Error {
  constructor(message) { super(message); this.name = 'ManifestError'; }
}

const TYPE_ORDER = ['skills', 'recipes', 'agents', 'jobs', 'services', 'projects'];

// The installer's own integer version (D-35). A package's optional `installer` field is the minimum
// version it requires — a plain positive integer with an implicit ">=" — and a package that needs a
// newer installer than this one is rejected at manifest load.
export const INSTALLER_VERSION = 1;

// varchar limits from the live schema (integration-reference §6) — validated here so a too-long
// value fails fast with a clear message instead of a Postgres error mid-install.
const LIMITS = {
  skillName: 100, recipeName: 200, agentName: 50, agentMode: 10, agentModel: 20,
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
  if (typeof meta.components !== 'object' || Array.isArray(meta.components)) {
    throw new ManifestError('components must be a mapping of type → list');
  }
  for (const type of Object.keys(meta.components)) {
    if (!TYPE_ORDER.includes(type)) throw new ManifestError(`Unknown component type: ${type}`);
    const list = meta.components[type];
    if (!Array.isArray(list)) throw new ManifestError(`components.${type} must be a list`);
    for (const entry of list) {
      if (!entry || !entry.path) throw new ManifestError(`components.${type}[] entry missing 'path'`);
      if ((type === 'skills' || type === 'services' || type === 'projects') && !entry.version) {
        throw new ManifestError(`components.${type}[${entry.path}] requires a version pin`);
      }
    }
  }
  // installer (optional, D-35): the minimum installer version the package needs — a plain positive
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
  return {
    skills: (c.skills || []).map((e) => loadSkillDef(e, root)),
    recipes: (c.recipes || []).map((e) => loadRecipeDef(e, root)),
    agents: (c.agents || []).map((e) => loadAgentDef(e, root)),
    jobs: (c.jobs || []).map((e) => loadJobDef(e, root)),
    services: (c.services || []).map((e) => loadServiceDef(e, root)),
    projects: (c.projects || []).map((e) => loadProjectDef(e, root)),
  };
}

function loadSkillDef(entry, root) {
  const srcDir = join(root, entry.path);
  const mdPath = join(srcDir, 'SKILL.md');
  if (!existsSync(mdPath)) throw new ManifestError(`Skill missing SKILL.md: ${entry.path}`);
  const { meta, body } = parseFrontmatter(readFileSync(mdPath, 'utf8'));
  if (!meta.name) throw new ManifestError(`SKILL.md missing 'name': ${entry.path}`);
  if (meta.version == null) throw new ManifestError(`SKILL.md missing 'version': ${entry.path}`);
  const version = intVersion(`Skill ${meta.name} version`, meta.version);
  const pin = intVersion(`Skill ${entry.path} manifest version`, entry.version);
  if (version !== pin) {
    throw new ManifestError(`Skill ${meta.name}: SKILL.md version ${version} != manifest pin ${pin}`);
  }
  checkLen('skill name', meta.name, LIMITS.skillName);
  // install_type (manifest entry, D-22): how the skill registers. Default 'org' (locked); 'user'
  // installs it unlocked as a user skill. Either way assets land in SKILLS_BASE_DIR.
  const installType = entry.install_type;
  if (installType != null && installType !== 'user' && installType !== 'org') {
    throw new ManifestError(`Skill ${meta.name}: install_type must be 'user' or 'org' (got '${installType}')`);
  }
  // content = SKILL.md body (frontmatter stripped) — matches the live CRHQ skills.content convention.
  return { key: meta.name, name: meta.name, description: meta.description || '', version, srcDir, content: body, installType };
}

function loadRecipeDef(entry, root) {
  const srcFile = join(root, entry.path);
  if (!existsSync(srcFile)) throw new ManifestError(`Recipe not found: ${entry.path}`);
  const { meta, body } = parseFrontmatter(readFileSync(srcFile, 'utf8'));
  if (!meta.name) throw new ManifestError(`Recipe missing 'name': ${entry.path}`);
  checkLen('recipe name', meta.name, LIMITS.recipeName);
  // Version is optional for recipes; when present (frontmatter and/or manifest pin) it's an integer
  // and the two must agree.
  const version = resolveOptionalVersion(`Recipe ${meta.name}`, meta.version, entry.version, entry.path);
  return { name: meta.name, description: meta.description || '', content: body, srcFile, ...(version != null ? { version } : {}) };
}

function loadAgentDef(entry, root) {
  const srcDir = join(root, entry.path);
  // Agents are now a DIRECTORY with an AGENTS.md (the agent's "brain"), exactly like a skill's
  // <key>/SKILL.md (D-50). Clean break (D-50): a flat agents/<name>.md is no longer accepted —
  // point the author at the directory form.
  if (entry.path.endsWith('.md') || (existsSync(srcDir) && statSync(srcDir).isFile())) {
    throw new ManifestError(`Agent '${entry.path}': agents are now a directory with an AGENTS.md — use agents/<key>/ (a folder), not a flat .md file`);
  }
  const mdPath = join(srcDir, 'AGENTS.md');
  if (!existsSync(mdPath)) throw new ManifestError(`Agent missing AGENTS.md: ${entry.path}`);
  // Content-bearing component (like skills/recipes): YAML frontmatter for the scalar/list fields +
  // a Markdown body that becomes the agent's `instructions` (D-32). The rest of the directory is the
  // brain — copied to AGENT_BRAINS_DIR/<key> on install (D-50).
  const { meta: a, body } = parseFrontmatter(readFileSync(mdPath, 'utf8'));
  // Agents follow the same name/description pattern as every other component type: `name` is the
  // canonical identifier (stored as CRHQ agents.key), `display_name` the human label (stored as
  // agents.name) — D-23.
  if (a.key) throw new ManifestError(`Agent '${entry.path}': 'key' was renamed — use 'name' (the agent identifier) and 'display_name' (the human label)`);
  if (!a.name) throw new ManifestError(`Agent missing 'name': ${entry.path}`);
  if (!a.display_name) throw new ManifestError(`Agent missing 'display_name': ${entry.path}`);
  checkLen('agent name', a.name, LIMITS.agentName);
  if (a.mode) checkLen('agent mode', a.mode, LIMITS.agentMode);
  if (a.default_model) checkLen('agent default_model', a.default_model, LIMITS.agentModel);
  // Body → instructions (leading blank lines trimmed); an empty body rides the DB default.
  const instructions = body && body.trim() ? body.replace(/^\n+/, '') : undefined;
  // Version is optional for agents; when present it round-trips through agent_versions (D-34).
  const version = resolveOptionalVersion(`Agent ${a.name}`, a.version, entry.version, entry.path);
  return {
    name: a.name, display_name: a.display_name, description: a.description || '', mode: a.mode || 'cli',
    default_model: a.default_model, icon: a.icon, skills: a.skills || [], recipes: a.recipes || [],
    instructions, system_prompt_path: a.system_prompt_path, capabilities: a.capabilities, provider: a.provider,
    // srcDir = the agent/brain directory (copied to AGENT_BRAINS_DIR/<key> on install); srcFile = its
    // AGENTS.md (the install log's `source`, mirroring a skill's SKILL.md).
    srcDir, srcFile: mdPath, ...(version != null ? { version } : {}),
  };
}

function loadJobDef(entry, root) {
  const srcFile = join(root, entry.path);
  if (!existsSync(srcFile)) throw new ManifestError(`Job not found: ${entry.path}`);
  const j = loadYaml(readFileSync(srcFile, 'utf8'));
  if (!j.name) throw new ManifestError(`Job missing 'name': ${entry.path}`);
  if (!j.schedule) throw new ManifestError(`Job missing 'schedule': ${entry.path}`);
  if (!j.script) throw new ManifestError(`Job missing 'script': ${entry.path}`);
  checkLen('job name', j.name, LIMITS.jobName);
  return {
    name: j.name, description: j.description || '', schedule: j.schedule, timezone: j.timezone,
    script: j.script, args: j.args, timeout_minutes: j.timeout_minutes, max_concurrent: j.max_concurrent,
    skip_if_running: j.skip_if_running, enabled: j.enabled, requires: j.requires || [], srcFile,
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
  const names = kind === 'project' ? ['project.yaml', 'service.yaml'] : ['service.yaml'];
  const yPath = names.map((n) => join(srcDir, n)).find((p) => existsSync(p));
  if (!yPath) {
    const want = kind === 'project' ? 'project.yaml (or legacy service.yaml)' : 'service.yaml';
    throw new ManifestError(`${cap} missing ${want}: ${pathLabel}`);
  }
  const s = loadYaml(readFileSync(yPath, 'utf8'));
  if (!s.name) throw new ManifestError(`${yPath.endsWith('project.yaml') ? 'project.yaml' : 'service.yaml'} missing 'name': ${pathLabel}`);
  if (s.version == null) throw new ManifestError(`${yPath.endsWith('project.yaml') ? 'project.yaml' : 'service.yaml'} missing 'version': ${pathLabel}`);
  const version = intVersion(`${cap} ${s.name} version`, s.version);
  if (!s.start) throw new ManifestError(`${yPath.endsWith('project.yaml') ? 'project.yaml' : 'service.yaml'} missing 'start': ${pathLabel}`);
  checkLen(`${kind} name`, s.name, kind === 'project' ? LIMITS.projectName : LIMITS.serviceName);
  return { config: s, version, srcFile: yPath };
}

function loadWebAppDef(entry, root, kind) {
  const srcDir = join(root, entry.path);
  const { config: s, version, srcFile } = readWebAppConfig(srcDir, { kind, pathLabel: entry.path });
  const cap = kind === 'project' ? 'Project' : 'Service';
  const pin = intVersion(`${cap} ${entry.path} manifest version`, entry.version);
  if (version !== pin) {
    throw new ManifestError(`${cap} ${s.name}: ${srcFile.endsWith('project.yaml') ? 'project.yaml' : 'service.yaml'} version ${version} != manifest pin ${pin}`);
  }
  return {
    name: s.name, version, start: s.start, port: s.port, cwd: s.cwd || './',
    build: s.build, env: s.env || {}, nginx: s.nginx || {}, srcDir, srcFile,
  };
}

function checkLen(label, val, max) {
  if (String(val).length > max) throw new ManifestError(`${label} exceeds ${max} chars: ${val}`);
}

// Component versions are positive integers (D-34) — they round-trip through CRHQ's *_versions
// tables (skill_versions/recipe_versions/agent_versions). Accept a YAML number or a numeric string;
// reject anything else (incl. the old semver form like 0.1.0). The package-level `version` is a
// separate free-form label (backup mints a date) and is NOT constrained here.
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
