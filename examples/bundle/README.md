# ai1-sample-bundle

Minimal example package for `ai1-crhq-installer`. Declares one of each DB-resident component type
(skill, recipe, agent, job) so the installer can be exercised end-to-end without touching the live
satellite.

```bash
# From the installer root:
node scripts/install.mjs examples/bundle --sandbox --lifecycle   # full assertion suite
node scripts/install.mjs examples/bundle --sandbox --dry-run     # preview, zero writes
```

A service component is intentionally omitted — services (nginx + PM2) are not modelled by the
sandbox and arrive in Phase 6.
