// frontmatter 2.0.0: "key: value" header between --- lines.
//   parse(text, { coerce = false }) -> { attributes, content }
// Values are strings (quotes removed). With coerce: true, true/false become
// booleans and numeric text becomes numbers, as in 1.x.
export const VERSION = '2.0.0';

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const unquote = value => (/^(["']).*\1$/.test(value) ? value.slice(1, -1) : value);

function coerceValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

export function parse(text, { coerce = false } = {}) {
  const source = String(text).replace(/^\uFEFF/, '');
  const match = FENCE.exec(source);
  if (!match) return { attributes: {}, content: source };
  const attributes = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1 || line.trimStart().startsWith('#')) continue;
    const raw = line.slice(colon + 1).trim();
    const quoted = /^["']/.test(raw);
    attributes[line.slice(0, colon).trim()] = quoted ? unquote(raw) : coerce ? coerceValue(raw) : raw;
  }
  return { attributes, content: source.slice(match[0].length) };
}
