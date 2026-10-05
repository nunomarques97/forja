// A static segment wins over a parameter, and both over a trailing star;
// among equally specific routes the first one added wins. A trailing slash is
// ignored (except for the root path).
export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    routes.push({ method: method.toUpperCase(), segments: split(pattern), handler, order: routes.length });
    routes.sort((a, b) => compare(a.segments, b.segments) || a.order - b.order);
  }

  function match(method, path) {
    const parts = split(path);
    let pathMatched = false;
    for (const route of routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method === method.toUpperCase() || route.method === '*') return { handler: route.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }

  return { add, match };
}

function split(path) {
  const parts = path.split('/').slice(1);
  if (parts.length > 1 && parts.at(-1) === '') parts.pop();
  return parts;
}

const rank = segment => (segment === '*' ? 2 : segment.startsWith(':') ? 1 : 0);

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = rank(a[i] ?? '') - rank(b[i] ?? '');
    if (diff) return diff;
  }
  return 0;
}

function matchSegments(segments, parts) {
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '*' && i === segments.length - 1) {
      params.rest = parts.slice(i).join('/');
      return params;
    }
    if (i >= parts.length) return null;
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(parts[i]);
    else if (segment !== parts[i]) return null;
  }
  return segments.length === parts.length ? params : null;
}
