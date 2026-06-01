// manifest.mjs — load + validate ai1-package.yaml and resolve it to an ordered install plan (A1).
// Component sources are parsed into the def shapes consumed by lib/core/* (api-design §7).
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname, isAbsolute, resolve } from 'path';
import { loadYaml, parseFrontmatter } from './parse.mjs';

export class ManifestError extends Error {
  constructor(message) { super(message); this.name = 'ManifestError'; }
}

const TYPE_ORDER = ['skills', 'recipes', 'agents', 'jobs', 'services'];

// varchar limits from the live schema (integration-reference §6) — validated here so a too-long
// value fails fast with a clear message instead of a Postgres error mid-install.
const LIMITS = {
  skillName: 100, recipeName: 200, agentKey: 50, agentMode: 10, agentModel: 20,
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
  if (!meta.version) throw new ManifestError(`SKILL.md missing 'version': ${entry.path}`);
  if (String(meta.version) !== String(entry.version)) {
    throw new ManifestError(`Skill ${meta.name}: SKILL.md version ${meta.version} != manifest pin ${entry.version}`);
  }
  checkLen('skill name', meta.name, LIMITS.skillName);
  // content = SKILL.md body (frontmatter stripped) — matches the live CRHQ skills.content convention.
  return { key: meta.name, name: meta.name, description: meta.description || '', version: String(meta.version), srcDir, content: body };
}

function loadRecipeDef(entry, root) {
  const srcFile = join(root, entry.path);
  if (!existsSync(srcFile)) throw new ManifestError(`Recipe not found: ${entry.path}`);
  const { meta, body } = parseFrontmatter(readFileSync(srcFile, 'utf8'));
  if (!meta.name) throw new ManifestError(`Recipe missing 'name': ${entry.path}`);
  if (entry.version && meta.version && String(meta.version) !== String(entry.version)) {
    throw new ManifestError(`Recipe ${meta.name}: version ${meta.version} != manifest pin ${entry.version}`);
  }
  checkLen('recipe name', meta.name, LIMITS.recipeName);
  return { name: meta.name, description: meta.description || '', content: body, srcFile };
}

function loadAgentDef(entry, root) {
  const srcFile = join(root, entry.path);
  if (!existsSync(srcFile)) throw new ManifestError(`Agent not found: ${entry.path}`);
  const a = loadYaml(readFileSync(srcFile, 'utf8'));
  if (!a.key) throw new ManifestError(`Agent missing 'key': ${entry.path}`);
  if (!a.name) throw new ManifestError(`Agent missing 'name': ${entry.path}`);
  checkLen('agent key', a.key, LIMITS.agentKey);
  if (a.mode) checkLen('agent mode', a.mode, LIMITS.agentMode);
  if (a.default_model) checkLen('agent default_model', a.default_model, LIMITS.agentModel);
  return {
    key: a.key, name: a.name, description: a.description || '', mode: a.mode || 'cli',
    default_model: a.default_model, icon: a.icon, skills: a.skills || [], recipes: a.recipes || [], srcFile,
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
  if (!s.version) throw new ManifestError(`service.yaml missing 'version': ${entry.path}`);
  if (String(s.version) !== String(entry.version)) {
    throw new ManifestError(`Service ${s.name}: service.yaml version ${s.version} != manifest pin ${entry.version}`);
  }
  if (!s.start) throw new ManifestError(`service.yaml missing 'start': ${entry.path}`);
  checkLen('service name', s.name, LIMITS.serviceName);
  return {
    name: s.name, version: String(s.version), start: s.start, port: s.port, cwd: s.cwd || './',
    build: s.build, env: s.env || {}, nginx: s.nginx || {}, srcDir,
  };
}

function checkLen(label, val, max) {
  if (String(val).length > max) throw new ManifestError(`${label} exceeds ${max} chars: ${val}`);
}
