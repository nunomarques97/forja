import { routes as defaultRoutes } from './routes.mjs';

const JSON_TYPE = { 'content-type': 'application/json' };

// Fixed window per client IP: `limit` requests per `windowMs`.
export function createHandler({ routes = defaultRoutes, now = Date.now, rateLimit = {} } = {}) {
  const { limit = 60, windowMs = 60_000 } = rateLimit;
  const windows = new Map();

  return function handle(request) {
    const t = now();
    const key = request.ip ?? 'unknown';
    let window = windows.get(key);
    if (!window || t - window.start >= windowMs) windows.set(key, (window = { start: t, count: 0 }));
    if (++window.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((window.start + windowMs - t) / 1000));
      return { status: 429, headers: { ...JSON_TYPE, 'retry-after': String(retryAfter) }, body: { error: 'too many requests' } };
    }
    const route = routes[`${request.method} ${request.path}`];
    if (!route) return { status: 404, headers: JSON_TYPE, body: { error: 'not found' } };
    return { status: 200, headers: JSON_TYPE, body: route(request, { now: t }) };
  };
}
