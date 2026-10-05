# filedrop

Serves a folder of static files (default `public/`) over HTTP for our team's
download page.

```
node src/server.mjs [folder]
```

`createStaticHandler(root)` returns `handle({ method, url })`, which resolves
the URL inside `root` and returns `{ status, headers, body }`. A URL that ends
with `/` serves that folder's `index.html`. Only `GET` and `HEAD` are allowed.
