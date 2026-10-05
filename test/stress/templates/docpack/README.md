# docpack

Turns a folder of Markdown pages into a small static documentation site.

```
node src/cli.mjs build <docs-folder> <output-folder>
npm run docs        # builds site/ into dist/
```

## Docs folder

- `docpack.json`: `{ "title": "Site title", "nav": ["index.md", "guide/install.md"] }`.
  `nav` lists the pages in navigation order, relative to the docs folder.
- Pages may start with a front matter block:

  ```
  ---
  title: Installing
  draft: true
  ---
  ```

  `title` defaults to the first `# heading`; `draft: true` pages are skipped.

## Output

One `.html` file per page at the same relative path (`guide/install.md` ->
`guide/install.html`), `style.css` from `theme/`, and `sitemap.txt` with one
site-relative URL per line. Generated links are relative, so the site works
from any folder or sub-path.

## Layout

| Path | Role |
|---|---|
| `src/cli.mjs` | command line |
| `src/build.mjs` | `build({ src, out })` |
| `src/config.mjs` | reads `docpack.json` |
| `src/pages.mjs` | page loading, URLs and relative links |
| `src/markdown.mjs` | the Markdown subset we use |
| `src/theme.mjs` | page template from `theme/` |
| `vendor/frontmatter/` | vendored front matter parser (do not edit; upgrade as a whole) |
