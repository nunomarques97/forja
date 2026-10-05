import { createRouter } from './router.mjs';
import { parseQuery } from './query.mjs';
import { compose } from './middleware.mjs';
import { createLru } from './cache.mjs';
import { HttpError } from './http-error.mjs';
import { normalizeHeaders } from './headers.mjs';

// Allow header of a path: its routes' methods, HEAD when GET is there (HEAD
// is answered by the GET route without a body) and OPTIONS (answered with 204).
function allowHeader(methods) {
  const all = new Set(methods);
  if (all.has('GET')) all.add('HEAD');
  all.add('OPTIONS');
  return [...all].join(', ');
}

// createApp({ cacheSize }) -> { use, route, handle }.
// GET responses with `cache: true` are kept in an LRU keyed by URL.
export function createApp({ cacheSize = 100 } = {}) {
  const router = createRouter();
  const middlewares = [];
  const cache = createLru(cacheSize);

  async function handle(request) {
    const url = String(request.url ?? '/');
    const [path, search = ''] = url.split('?');
    const ctx = { method: String(request.method ?? 'GET').toUpperCase(), path, query: parseQuery(search), headers: normalizeHeaders(request.headers), body: request.body, params: {}, state: {} };
    if (ctx.method === 'GET' && cache.has(url)) return cache.get(url);
    let response;
    try {
      await compose(middlewares)(ctx, async () => {
        let found = router.match(ctx.method, path);
        if (found?.methodNotAllowed && ctx.method === 'HEAD') found = router.match('GET', path);
        if (!found) throw new HttpError(404);
        if (found.methodNotAllowed) {
          const allow = allowHeader(router.allowed(path));
          if (ctx.method === 'OPTIONS') {
            response = { status: 204, headers: { allow } };
            return;
          }
          throw new HttpError(405, undefined, { allow });
        }
        ctx.params = found.params;
        response = (await found.handler(ctx)) ?? {};
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return { status: error.status, headers: normalizeHeaders(error.headers), body: { error: error.message } };
    }
    const result = { status: response.status ?? 200, headers: normalizeHeaders(response.headers), body: ctx.method === 'HEAD' ? null : response.body ?? null };
    if (ctx.method === 'GET' && response.cache) cache.set(url, result);
    return result;
  }

  return {
    use(middleware) {
      middlewares.push(middleware);
      return this;
    },
    route(method, pattern, handler) {
      router.add(method, pattern, handler);
      return this;
    },
    handle,
  };
}
