// frontmatter 1.4.0: "key: value" header between --- lines.
//   parse(text) -> { data, body }
// Values are coerced: true/false to booleans, numeric text to numbers; quoted
// values stay strings without their quotes.
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const unquote = value => (/^(["']).*\1$/.test(value) ? value.slice(1, -1) : value);

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

export default function parse(text) {
  const source = String(text);
  const match = FENCE.exec(source);
  if (!match) return { data: {}, body: source };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1 || line.trimStart().startsWith('#')) continue;
    const raw = line.slice(colon + 1).trim();
    data[line.slice(0, colon).trim()] = /^["']/.test(raw) ? unquote(raw) : coerce(raw);
  }
  return { data, body: source.slice(match[0].length) };
}
