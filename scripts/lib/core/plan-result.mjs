// plan-result.mjs — shared shape for plan* comparison results (install dry-run + drift).
import { VERDICT } from '../log.mjs';

const DIMENSION_LABELS = {
  db: 'fields',
  files: 'files',
  links: 'links',
  brain: 'brain',
  nginx: 'nginx',
  pm2: 'pm2',
  prereq: 'missing prerequisite',
};

export function planResult(type, name, { verdict, dimensions = {}, action, detail } = {}) {
  const parts = detail != null ? [detail] : [];
  if (!parts.length) {
    for (const [key, on] of Object.entries(dimensions)) {
      if (on && DIMENSION_LABELS[key]) parts.push(DIMENSION_LABELS[key]);
    }
  }
  return {
    type,
    name,
    verdict,
    dimensions,
    detail: parts.filter(Boolean).join(', '),
    action: action ?? (verdict === VERDICT.ABSENT ? 'absent' : verdict === VERDICT.ALREADY ? 'updated' : 'created'),
  };
}
