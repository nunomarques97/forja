export const routes = {
  'GET /health': () => ({ ok: true }),
  'GET /time': (request, { now }) => ({ now }),
  'GET /echo': request => ({ ip: request.ip, agent: request.headers?.['user-agent'] ?? null }),
};
