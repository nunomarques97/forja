// Routes are tried in the order they were added.
export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    routes.push({ method: method.toUpperCase(), segments: split(pattern), handler });
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
  return path.split('/').slice(1);
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
