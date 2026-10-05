# tinyapi

A small JSON API. `createHandler(options)` returns `handle(request)`, which
takes `{ method, path, ip, headers }` and returns `{ status, headers, body }`.
`src/server.mjs` adapts it to `node:http`.

Options:

- `routes`: map of `"METHOD /path"` to `(request, { now }) => body`
  (default: `src/routes.mjs`).
- `now`: clock in milliseconds (default `Date.now`), injected for tests.
