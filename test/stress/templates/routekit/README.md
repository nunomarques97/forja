# routekit

A dependency-free request toolkit: routing, query parsing, middleware and a
small response cache. It does not open sockets; `app.handle(request)` takes a
plain object and returns a plain response, so an adapter for `node:http` (not
in this repository) stays tiny.

```js
import { createApp } from 'routekit';

const app = createApp();
app.route('GET', '/users/:id', ctx => ({ body: { id: ctx.params.id } }));
const res = await app.handle({ method: 'GET', url: '/users/7?fields=name' });
```

## Modules

| Module | Role |
|---|---|
| `src/router.mjs` | `createRouter()`: `add(method, pattern, handler)`, `match(method, path)` |
| `src/query.mjs` | `parseQuery(search)` / `stringifyQuery(object)` |
| `src/middleware.mjs` | `compose(middlewares)`: onion-style `(ctx, next)` |
| `src/cache.mjs` | `createLru(capacity)`: least-recently-used cache |
| `src/app.mjs` | `createApp(options)`: wires the above together |
| `src/http-error.mjs` | `HttpError(status, message)` |
| `src/headers.mjs` | header name normalization |

Patterns use `:name` for one path segment and a trailing `*` for the rest of
the path (`ctx.params.rest`).
