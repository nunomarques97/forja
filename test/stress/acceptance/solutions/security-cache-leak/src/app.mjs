import { createRouter } from './router.mjs';
import { parseQuery } from './query.mjs';
import { compose } from './middleware.mjs';
import { createLru } from './cache.mjs';
import { HttpError } from './http-error.mjs';
import { normalizeHeaders } from './headers.mjs';

// createApp({ cacheSize }) -> { use, route, handle }.
// GET responses with `cache: true` are kept in an LRU keyed by URL. Requests
// that carry credentials (Authorization or Cookie) never read or fill it: their
// responses belong to one client.
export function createApp({ cacheSize = 100 } = {}) {
  const router = createRouter();
  const middlewares = [];
  const cache = createLru(cacheSize);

  async function handle(request) {
    const url = String(request.url ?? '/');
    const [path, search = ''] = url.split('?');
    const ctx = { method: String(request.method ?? 'GET').toUpperCase(), path, query: parseQuery(search), headers: normalizeHeaders(request.headers), body: request.body, params: {}, state: {} };
    const cacheable = ctx.method === 'GET' && !('authorization' in ctx.headers) && !('cookie' in ctx.headers);
    if (cacheable && cache.has(url)) return cache.get(url);
    let response;
    try {
      await compose(middlewares)(ctx, async () => {
        const found = router.match(ctx.method, path);
        if (!found) throw new HttpError(404);
        if (found.methodNotAllowed) throw new HttpError(405);
        ctx.params = found.params;
        response = (await found.handler(ctx)) ?? {};
      });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return { status: error.status, headers: {}, body: { error: error.message } };
    }
    const result = { status: response.status ?? 200, headers: normalizeHeaders(response.headers), body: response.body ?? null };
    if (cacheable && response.cache) cache.set(url, result);
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
