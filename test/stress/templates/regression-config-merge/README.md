# confload

Configuration loader for our small services.

`loadConfig({ defaults, file, env })` returns the defaults with the JSON file's
values merged over them, then environment overrides over both. Nested objects
merge key by key; arrays and other values replace the default. Neither input is
modified.

Environment overrides use the `APP_` prefix and `__` for nesting:
`APP_SERVER__PORT=8080` sets `server.port` to `8080`. Values are parsed as JSON
when possible (`8080`, `true`, `["a"]`), otherwise kept as text.
