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
  SKIPPED: 'SKIPPED',        // handling: removed/optional entry not acted on this run (exit-neutral)
  // Export verdicts — returned by the core export* fns and consumed by sync (incl. --mirror).
  BACKUP_OK: 'BACKUP-OK',    // export: component written to the package
  BACKUP_SKIP: 'BACKUP-SKIP',// export: component not representable in the manifest — skipped (D-28)
  BACKUP_FAIL: 'BACKUP-FAIL',// export: component export failed
};

// Severity → exit-code contribution (api-design §13). 0 = success/already; 1 = failure class.
export const SEVERITY = {
  [VERDICT.OK]: 0,
  [VERDICT.ALREADY]: 0,
  [VERDICT.STATUS]: 0,
  [VERDICT.ABSENT]: 0,
  [VERDICT.SKIPPED]: 0,       // a deliberately-skipped optional/tombstone entry is not a failure
  [VERDICT.LOCKED]: 1,
  [VERDICT.PREREQ]: 1,
  [VERDICT.PARTIAL]: 1,
  [VERDICT.FAIL]: 1,
  [VERDICT.BACKUP_OK]: 0,
  [VERDICT.BACKUP_SKIP]: 0,   // "can't be expressed in the format" is not a failure — it is warned
  [VERDICT.BACKUP_FAIL]: 1,
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
