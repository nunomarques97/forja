# confload

Configuration loader for our small services.

`loadConfig({ defaults, file })` returns the defaults with the JSON file's
values merged over them. Nested objects merge key by key; arrays and other
values from the file replace the default. Neither input is modified.
