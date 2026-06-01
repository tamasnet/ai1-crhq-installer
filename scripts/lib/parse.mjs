// parse.mjs — frontmatter splitting (hand-rolled, D-6) + YAML parsing (the single allowed dep).
import { parse as parseYaml } from 'yaml';

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
