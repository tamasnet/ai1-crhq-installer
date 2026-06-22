// filter.mjs — component selection for `--include` / `--exclude` (run.mjs). Each value is treated
// as a regular expression, with one special case: if it contains NO regex metacharacters it is an
// exact, anchored match (as if written `^value$`). Matching is case-sensitive. The name a filter is
// tested against is the component's canonical identifier — the same value shown in the run summary
// (skill/recipe/job/service/project → `name`; agent → `key`).

// The metacharacters whose presence flips a pattern from "literal exact match" to "regex". A literal
// like `my-skill` (hyphens are NOT metacharacters) stays an exact match; to substring/partial-match
// you must include a metacharacter, e.g. `^my-` or `skill$` or `foo|bar`.
const META = /[.^$*+?()[\]{}|\\]/;

export class FilterError extends Error {
  constructor(message) { super(message); this.name = 'FilterError'; }
}

// Compile one pattern into a predicate (name) => boolean. `label` names the flag for error text.
export function compileMatcher(pattern, label = 'filter') {
  if (!META.test(pattern)) return (name) => name === pattern;   // exact, anchored match
  let re;
  try { re = new RegExp(pattern); } catch (e) {
    throw new FilterError(`invalid ${label} pattern '${pattern}': ${e.message}`);
  }
  return (name) => re.test(name);
}

// True when at least one filter flag was supplied.
export const hasFilter = ({ include, exclude } = {}) => include != null || exclude != null;

// Build a combined predicate from the (nullable) include/exclude patterns. A component is selected
// iff it matches --include (or none was given) AND does not match --exclude. Both compile eagerly so
// an invalid pattern fails fast (→ FilterError, mapped to a usage exit by the CLI) before any write.
export function makeFilter({ include, exclude } = {}) {
  const inc = include != null ? compileMatcher(include, '--include') : null;
  const exc = exclude != null ? compileMatcher(exclude, '--exclude') : null;
  return (name) => {
    if (inc && !inc(name)) return false;
    if (exc && exc(name)) return false;
    return true;
  };
}
