// manifest.mjs — load + validate ai1-package.yaml and resolve it to an ordered install plan (A1).
// Component sources are parsed into the def shapes consumed by lib/core/* (api-design §7).
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname, isAbsolute, resolve } from 'path';
import { loadYaml, parseFrontmatter } from './parse.mjs';
import { STANDARD_FLAG_NAMES } from './flags.mjs';

export class ManifestError extends Error {
  constructor(message) { super(message); this.name = 'ManifestError'; }
}

const TYPE_ORDER = ['skills', 'recipes', 'agents', 'jobs', 'services'];

// varchar limits from the live schema (integration-reference §6) — validated here so a too-long
// value fails fast with a clear message instead of a Postgres error mid-install.
const LIMITS = {
  skillName: 100, recipeName: 200, agentName: 50, agentMode: 10, agentModel: 20,
  jobName: 255, jobSchedule: 100, jobTimezone: 50, serviceName: 255,
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
      if ((type === 'skills' || type === 'services') && !entry.version) {
        throw new ManifestError(`components.${type}[${entry.path}] requires a version pin`);
      }
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
  // installs it unlocked as a user skill. Either way assets land in INSTALL_BASE_DIR.
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
  const srcFile = join(root, entry.path);
  if (!existsSync(srcFile)) throw new ManifestError(`Agent not found: ${entry.path}`);
  // Agents are a content-bearing component (like skills/recipes): YAML frontmatter for the
  // scalar/list fields + a Markdown body that becomes the agent's `instructions` (D-32).
  const { meta: a, body } = parseFrontmatter(readFileSync(srcFile, 'utf8'));
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
    srcFile, ...(version != null ? { version } : {}),
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
  const srcDir = join(root, entry.path);
  const yPath = join(srcDir, 'service.yaml');
  if (!existsSync(yPath)) throw new ManifestError(`Service missing service.yaml: ${entry.path}`);
  const s = loadYaml(readFileSync(yPath, 'utf8'));
  if (!s.name) throw new ManifestError(`service.yaml missing 'name': ${entry.path}`);
  if (s.version == null) throw new ManifestError(`service.yaml missing 'version': ${entry.path}`);
  const version = intVersion(`Service ${s.name} version`, s.version);
  const pin = intVersion(`Service ${entry.path} manifest version`, entry.version);
  if (version !== pin) {
    throw new ManifestError(`Service ${s.name}: service.yaml version ${version} != manifest pin ${pin}`);
  }
  if (!s.start) throw new ManifestError(`service.yaml missing 'start': ${entry.path}`);
  checkLen('service name', s.name, LIMITS.serviceName);
  return {
    name: s.name, version, start: s.start, port: s.port, cwd: s.cwd || './',
    build: s.build, env: s.env || {}, nginx: s.nginx || {}, srcDir,
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
