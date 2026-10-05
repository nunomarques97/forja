// Operator endpoints; the handler only calls them for an authorized request.
export const adminRoutes = {
  'GET /admin/stats': (request, { now, started }) => ({ uptimeMs: now - started }),
  'POST /admin/flush': () => ({ flushed: true }),
};
