# slugkit

URL slugs for blog titles.

- `slugify(text, { maxLength = 60 })`: lower-case ASCII words joined by `-`.
- `uniqueSlug(text, taken)`: a slug not in the `taken` set (`title`, `title-2`, ...).
