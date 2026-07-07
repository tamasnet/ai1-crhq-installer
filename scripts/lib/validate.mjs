// validate.mjs — shared reject-at-load validators for component names, DNS labels, and .env values.
// Install names are validated here (reject); fs.mjs safeName sanitizes for other uses — do not conflate.

export function assertSafeSegment(label, val) {
  if (val === '.' || val === '..' || !/^[A-Za-z0-9._-]+$/.test(val)) {
    throw new Error(
      `invalid ${label} '${val}' — only letters, digits, '.', '_' and '-' are allowed`);
  }
}

// DNS hostname label (no dots/underscores) — used for service/project app_name in nginx vhosts.
export function assertDnsLabel(label, val) {
  if (!/^[A-Za-z0-9-]+$/.test(val)) {
    throw new Error(
      `invalid ${label} '${val}' — DNS labels allow only letters, digits, and '-'`);
  }
}

export function assertSafeEnvValue(key, val) {
  const s = String(val);
  if (/[\n\r]/.test(s)) {
    throw new Error(`env.${key}: value must not contain newline characters`);
  }
}

// Dotenv-safe quoting: wrap values containing spaces, '#', or '=' in double quotes.
export function formatEnvValue(val) {
  const s = String(val);
  if (/[ #=]/.test(s)) return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return s;
}
