# Changelog

## 2.0.0

Breaking changes:

- The default export is gone; import the named `parse` function.
- The result is `{ attributes, content }` (was `{ data, body }`).
- Values are no longer coerced by default: `draft: true` gives the string
  `"true"`. Pass `{ coerce: true }` for the 1.x behaviour.

Other changes:

- A UTF-8 byte order mark before the header is ignored.
- `VERSION` is exported.

## 1.4.0

- Comment lines (`# ...`) inside the header are ignored.
- CRLF line endings are accepted.

## 1.3.0

- Quoted values keep their text without the quotes.
