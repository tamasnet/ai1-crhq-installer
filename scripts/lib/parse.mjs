// parse.mjs — frontmatter splitting (hand-rolled) + YAML parsing. YAML uses a vendored
// single-file bundle of `yaml` (scripts/lib/vendor/yaml.mjs) so the skill installs with ZERO
// `npm install` — no runtime dependencies. knex/pg are resolved from the satellite at runtime.
import { parse as parseYaml } from './vendor/yaml.mjs';

export function loadYaml(text) {
  const v = parseYaml(text);
  return v == null ? {} : v;
}

// Group 1 = frontmatter YAML, group 2 = body. (Leading BOM is stripped before matching.)
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(md) {
  const text = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md;
  const m = FRONTMATTER.exec(text);
  if (!m) return { meta: {}, body: text };
  return { meta: loadYaml(m[1]) || {}, body: m[2] };
}

// ── YAML emission (the backup path) ──────────────────────────────────────────────────────────
// Hand-rolled like parseFrontmatter: the vendored bundle only exports `parse`.
// Correct by construction: a scalar is emitted plain only when it provably can't be misread;
// everything else becomes a JSON double-quoted string, which is valid YAML (JSON escapes are a
// subset of YAML double-quote escapes). Round-trip safety is asserted in tests against the
// vendored (real) YAML parser.

const PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9 _./-]*$/;             // no ':', '#', quotes, leading symbol
const PLAIN_AMBIGUOUS = /^(true|false|yes|no|on|off|null|~)$/i;  // YAML booleans/null
const PLAIN_NUMERIC = /^[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?$/; // would parse as a number

function scalarStr(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (PLAIN_SAFE.test(s) && !PLAIN_AMBIGUOUS.test(s) && !PLAIN_NUMERIC.test(s) && s === s.trim()) return s;
  return JSON.stringify(s);
}

// Serialize a plain object (maps, arrays, scalars — the shapes the manifest/component files use)
// to a YAML document string. `undefined` values are omitted; empty collections emit as [] / {}.
export function dumpYaml(obj) {
  const lines = emitMap(obj, 0);
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function emitMap(obj, ind) {
  const pad = ' '.repeat(ind);
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const key = scalarStr(k);
    if (Array.isArray(v)) {
      if (!v.length) { out.push(`${pad}${key}: []`); continue; }
      out.push(`${pad}${key}:`);
      out.push(...emitSeq(v, ind + 2));
    } else if (v !== null && typeof v === 'object') {
      const inner = emitMap(v, ind + 2);
      if (!inner.length) { out.push(`${pad}${key}: {}`); continue; }
      out.push(`${pad}${key}:`, ...inner);
    } else {
      out.push(`${pad}${key}: ${scalarStr(v)}`);
    }
  }
  return out;
}

function emitSeq(arr, ind) {
  const pad = ' '.repeat(ind);
  const out = [];
  for (const item of arr) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const lines = emitMap(item, ind + 2);   // keys align under "- " (ind + 2)
      if (!lines.length) { out.push(`${pad}- {}`); continue; }
      out.push(`${pad}- ${lines[0].slice(ind + 2)}`, ...lines.slice(1));
    } else if (Array.isArray(item)) {
      out.push(`${pad}- [${item.map(scalarStr).join(', ')}]`);   // flow seq (not used by current shapes)
    } else {
      out.push(`${pad}- ${scalarStr(item)}`);
    }
  }
  return out;
}
