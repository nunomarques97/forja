import { routes as defaultRoutes } from './routes.mjs';
import { adminRoutes } from './admin.mjs';

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body });

export function createHandler({ routes = defaultRoutes, now = Date.now, adminKey = process.env.ADMIN_KEY } = {}) {
  const started = now();
  return function handle(request) {
    const name = `${request.method} ${request.path}`;
    const admin = adminRoutes[name];
    if (admin) {
      if (request.headers?.['x-admin-key'] !== adminKey) return json(401, { error: 'unauthorized' });
      return json(200, admin(request, { now: now(), started }));
    }
    const route = routes[name];
    if (!route) return json(404, { error: 'not found' });
    return json(200, route(request, { now: now() }));
  };
}
