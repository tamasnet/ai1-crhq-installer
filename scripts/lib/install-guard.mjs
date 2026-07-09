// install-guard.mjs — refuse installing from a git checkout (may deploy uncommitted work).
// Mirror of sync's git-safety guard, inverted: sync requires git; install distrusts it.
// Exception: ${REPOS_BASE_DIR}/<repo>/platform is the supported Client Repository platform path.
import { resolve, basename, dirname } from 'path';
import { isInsideGitRepo } from './sync.mjs';
import { resolveReposBase } from './polaris.mjs';
import { UsageError } from './flags.mjs';

export function isReposPlatformPackage(dir) {
  const root = resolve(dir);
  if (basename(root) !== 'platform') return false;
  const repoDir = resolve(dirname(root));
  return dirname(repoDir) === resolve(resolveReposBase());
}

// Checked after manifest load, before sandbox/DB. --sandbox is exempt (isolated test installs).
export function validateInstallSource(packageRoot, flags) {
  if (flags.SANDBOX || flags.FORCE) return;
  if (!isInsideGitRepo(packageRoot)) return;
  if (isReposPlatformPackage(packageRoot)) return;
  const dir = resolve(packageRoot);
  throw new UsageError(
    `package source is inside a git repository: ${dir}\n` +
    `  Installing from a checkout may deploy uncommitted work. Use a built package under\n` +
    `  PACKAGE_BASE_DIR, install from ${resolveReposBase()}/<repo>/platform, or re-run with\n` +
    `  --force to proceed anyway.`,
  );
}
