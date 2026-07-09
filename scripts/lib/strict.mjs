// strict.mjs — per-component install strictness: CLI --strict OR manifest handling: strict.
export function isInstallStrict(ctx, def) {
  return !!(ctx.STRICT || def?.handling === 'strict');
}
