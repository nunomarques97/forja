// Header names are case-insensitive; routekit stores them lower-case.
export function normalizeHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  return out;
}
