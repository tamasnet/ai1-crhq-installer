// paths.mjs — filesystem roots for non-DB component deployment.
import { join } from 'path';
import { homedir } from 'os';

export const DEFAULT_USER_PROJECTS_BASE = '/opt/projects/user';

export function expandHome(path) {
  if (!path || typeof path !== 'string') return path;
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function resolveServicesBase(env = process.env) {
  return expandHome(env.SERVICES_BASE_DIR || join(homedir(), 'services'));
}

export function resolveUserProjectsBase(env = process.env) {
  return expandHome(env.USER_PROJECTS_DIR || DEFAULT_USER_PROJECTS_BASE);
}
