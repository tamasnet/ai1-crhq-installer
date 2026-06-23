// component-types.mjs — user-facing component type names and internal manifest collection keys.
// CLI `--type` values are singular (`skill`, `job`, …); internals keep using the plural manifest
// collection keys (`skills`, `jobs`, …).

export const CLI_TYPE_TO_COLLECTION = Object.freeze({
  skill: 'skills',
  recipe: 'recipes',
  agent: 'agents',
  job: 'jobs',
  service: 'services',
  project: 'projects',
});

export const COLLECTION_TO_CLI_TYPE = Object.freeze(Object.fromEntries(
  Object.entries(CLI_TYPE_TO_COLLECTION).map(([cli, collection]) => [collection, cli]),
));

export const CLI_TYPE_VALUES = Object.freeze(Object.keys(CLI_TYPE_TO_COLLECTION));
export const COLLECTION_TYPE_VALUES = Object.freeze(Object.values(CLI_TYPE_TO_COLLECTION));

export function splitCliTypeValues(rawValues) {
  const values = Array.isArray(rawValues) ? rawValues : (rawValues == null ? [] : [rawValues]);
  return values
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeCliTypeScope(rawValues) {
  const types = [];
  const invalid = [];
  for (const value of splitCliTypeValues(rawValues)) {
    const collection = CLI_TYPE_TO_COLLECTION[value];
    if (collection) types.push(collection);
    else invalid.push(value);
  }
  return { types, invalid };
}

export function formatCliTypeError(invalid, option = '--type') {
  const pluralHints = invalid
    .filter((value) => COLLECTION_TO_CLI_TYPE[value])
    .map((value) => `${value}→${COLLECTION_TO_CLI_TYPE[value]}`);
  const valid = CLI_TYPE_VALUES.join(', ');
  if (pluralHints.length === invalid.length) {
    return `${option} expects singular component type values (${pluralHints.join(', ')}; valid: ${valid})`;
  }
  return `${option}: unknown component type(s): ${invalid.join(', ')} (valid: ${valid})`;
}
