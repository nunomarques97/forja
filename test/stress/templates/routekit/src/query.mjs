// "?a=1&tag=x&tag=y&q=hello+world" -> { a: '1', tag: ['x', 'y'], q: 'hello world' }
export function parseQuery(search) {
  const out = {};
  const text = String(search ?? '').replace(/^\?/, '');
  if (!text) return out;
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decode(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : decode(pair.slice(eq + 1));
    if (!Object.hasOwn(out, key)) out[key] = value;
    else if (Array.isArray(out[key])) out[key].push(value);
    else out[key] = [out[key], value];
  }
  return out;
}

export function stringifyQuery(object) {
  const pairs = [];
  for (const [key, value] of Object.entries(object))
    for (const item of Array.isArray(value) ? value : [value]) pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
  return pairs.join('&');
}

function decode(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}
