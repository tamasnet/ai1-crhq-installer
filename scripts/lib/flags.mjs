// flags.mjs — the install CLI option contract: the supported flag set, strict validation, and
// `--help` usage text. Kept DEPENDENCY-FREE (no db/log imports) so manifest.mjs can reuse the
// standard-flag set without pulling in the knex layer. Parsing of accepted flags into a context
// lives in context.mjs (parseFlags); this module only decides what is/ isn't a legal option.
// (The `sync` CLI — including its --mirror backup mode — owns its own flag spec in scripts/sync.mjs.)
//
// Two flag kinds:
//   • boolean — present or absent; supplying `=value` is an error.
//   • value   — require `--flag=<value>`; a bare `--flag` or empty `--flag=` is an error.
// A package may declare extra package-specific flags via `install_flags` in its manifest; those are
// accepted in `install` mode (and forwarded to the package's install_entry). Anything else is
// rejected with a UsageError → usage exit (2), so a typo never silently does the wrong thing.

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}

// Standard, installer-owned flags by mode. `--help` is handled separately (valid everywhere).
export const FLAG_SPEC = {
  install: {
    bool: ['--dry-run', '--status', '--uninstall', '--respect-locks', '--install-skills-as-user',
      '--sandbox', '--keep', '--lifecycle', '--json', '--list-installed', '--list-available',
      '--copy-projects'],
    value: ['--type', '--include', '--exclude'],
  },
};

// Every standard flag name (+ --help). Used to (a) give a "not supported by <mode>" message when a
// real flag is used in the wrong mode, and (b) forbid a manifest's install_flags from shadowing a
// standard flag.
export const STANDARD_FLAG_NAMES = new Set([
  '--help',
  ...FLAG_SPEC.install.bool, ...FLAG_SPEC.install.value,
]);

export function wantsHelp(argv) {
  return argv.some((a) => a === '--help');
}

// Package-specific flag names a manifest permits (install mode), e.g. ['--no-ingest'].
export function declaredFlagNames(meta) {
  return Array.isArray(meta?.install_flags)
    ? meta.install_flags.map((f) => f && f.name).filter(Boolean)
    : [];
}

const flagName = (token) => {
  const i = token.indexOf('=');
  return i === -1 ? token : token.slice(0, i);
};

// Validate argv for a mode against the supported set; throw UsageError on the FIRST violation (the
// CLI maps it to an exit-2 usage error and prints the message). `declared` = package-specific flag
// names the active package permits (install mode only). Non-`--` tokens are positionals and ignored
// here. `--help` is assumed handled before this runs and is skipped.
export function validateFlags(argv, { mode = 'install', declared = [] } = {}) {
  const spec = FLAG_SPEC[mode] || FLAG_SPEC.install;
  const bool = new Set(spec.bool);
  const value = new Set(spec.value);
  const pkg = new Set(declared);
  for (const token of argv) {
    if (!token.startsWith('--')) continue;          // positional (package path / backup base dir)
    if (token === '--help') continue;               // handled before validation
    const name = flagName(token);
    const hasEq = token.includes('=');
    if (value.has(name)) {
      const val = hasEq ? token.slice(token.indexOf('=') + 1).trim() : '';
      if (!hasEq || val === '') throw new UsageError(`option ${name} requires a value (use ${name}=<value>)`);
    } else if (bool.has(name)) {
      if (hasEq) throw new UsageError(`option ${name} does not take a value`);
    } else if (pkg.has(name)) {
      // package-specific flag declared in the manifest's install_flags — forwarded to install_entry.
    } else if (STANDARD_FLAG_NAMES.has(name)) {
      throw new UsageError(`option ${name} is not supported by ${mode} (see --help)`);
    } else {
      throw new UsageError(`unknown option: ${token} (see --help)`);
    }
  }
}

const INSTALL_USAGE = `ai1-satellite-tools — install a package of satellite resources

Usage: node scripts/install.mjs [<package>] [options]

  <package>  directory containing ai1-package.yaml (or the file itself); default '.'

Options:
  --dry-run                  preview only; zero DB/fs writes (services/projects: build only)
  --status                   report per-component install state
  --uninstall                remove the package's components (reverse order)
  --list-installed           print the install log (sorted by type, then name) and exit; standalone
                             — needs no package; combine with --json for the raw sorted array
  --list-available           scan the local package stores (PACKAGE_BASE_DIR + REPOS_BASE_DIR),
                             cross-reference the install log, and print every component with a STATUS
                             (available | installed | missing) + where its package lives, then exit;
                             standalone — needs no package or DB; combine with --json for the rows array
  --respect-locks            skip locked skills instead of auto-unlocking them
  --install-skills-as-user   register all skills as unlocked user skills (default: org, locked)
  --copy-projects            for project components, copy source into /opt/projects/user/<name>
                             instead of symlinking to the package directory
  --type=<types>             restrict to component types: skills,recipes,agents,jobs,services,projects
                             (comma-separated and/or the flag repeated)
  --include=<pat>            process only components whose name matches <pat>
                             (regex; a value with no regex metacharacter is an exact ^pat$ match)
  --exclude=<pat>            skip components whose name matches <pat> (applied after --include)
  --sandbox                  install into a throwaway isolated schema + temp dir, then tear down
  --keep                     with --sandbox: keep the schema + temp dir for inspection
  --lifecycle                with --sandbox: run install→status→idempotency→uninstall→reinstall
  --json                     machine-readable result output
  --help                     show this help and exit

A package may declare additional package-specific flags via 'install_flags' in its manifest;
those are accepted and forwarded to its install_entry hook. Any other option is rejected.`;

export function usage() {
  return INSTALL_USAGE;
}
