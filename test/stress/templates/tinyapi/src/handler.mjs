import { routes as defaultRoutes } from './routes.mjs';

export function createHandler({ routes = defaultRoutes, now = Date.now } = {}) {
  return function handle(request) {
    const route = routes[`${request.method} ${request.path}`];
    if (!route) return { status: 404, headers: { 'content-type': 'application/json' }, body: { error: 'not found' } };
    return { status: 200, headers: { 'content-type': 'application/json' }, body: route(request, { now: now() }) };
  };
}
