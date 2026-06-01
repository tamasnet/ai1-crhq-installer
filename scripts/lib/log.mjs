// log.mjs — prefixed logging, dry-run markers, canon completion strings (C7), verdict taxonomy.

const PREFIX = '[ai1]';

export const VERDICT = {
  OK: 'INSTALL-OK',
  ALREADY: 'ALREADY-INSTALLED',
  PARTIAL: 'INSTALL-PARTIAL',
  FAIL: 'INSTALL-FAIL',
  PREREQ: 'PREREQ-MISSING',
  LOCKED: 'LOCKED-ROW',
  STATUS: 'STATUS',          // informational (status mode); never affects exit code
  ABSENT: 'NOT-INSTALLED',   // status: component not present
};

// Severity → exit-code contribution (api-design §13). 0 = success/already; 1 = failure class.
export const SEVERITY = {
  [VERDICT.OK]: 0,
  [VERDICT.ALREADY]: 0,
  [VERDICT.STATUS]: 0,
  [VERDICT.ABSENT]: 0,
  [VERDICT.LOCKED]: 1,
  [VERDICT.PREREQ]: 1,
  [VERDICT.PARTIAL]: 1,
  [VERDICT.FAIL]: 1,
};

export function makeLogger({ dryRun = false } = {}) {
  const out = (s) => console.log(s);
  return {
    dryRun,
    info: (m) => out(`${PREFIX} ${m}`),
    ok: (m) => out(`${PREFIX} ✓ ${m}`),
    warn: (m) => out(`${PREFIX} ⚠ ${m}`),
    error: (m) => out(`${PREFIX} ❌ ${m}`),
    // C7: dry-run output must contain "would" / "dry".
    dry: (m) => out(`${PREFIX} [dry-run] would ${m}`),
    // C7: completion strings the harness greps — do not paraphrase.
    installComplete: () => out('✅ Package installed successfully.'),
    uninstallComplete: () => out('Uninstall complete.'),
    summary(results) {
      out(`${PREFIX} ── summary ──`);
      for (const r of results) {
        const extra = r.action ? ` (${r.action})` : '';
        out(`${PREFIX}   ${String(r.type).padEnd(8)} ${String(r.name).padEnd(28)} ${r.verdict}${extra}`);
      }
    },
  };
}
