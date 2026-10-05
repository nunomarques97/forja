import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import parseFrontmatter from '../vendor/frontmatter/index.mjs';
import { renderMarkdown } from './markdown.mjs';

// "guide/install.md" -> "guide/install.html"; URLs are site-relative.
export const pageUrl = rel => rel.replace(/\.md$/, '.html');

// Relative link from the page at `fromUrl` to `toUrl` (both site-relative).
export function relativeUrl(fromUrl, toUrl) {
  const depth = fromUrl.split('/').length - 1;
  return '../'.repeat(depth) + toUrl;
}

export function loadPage(src, rel) {
  const { data, body } = parseFrontmatter(readFileSync(join(src, rel), 'utf8'));
  const title = data.title ?? /^#\s+(.+)$/m.exec(body)?.[1] ?? rel;
  return { rel, url: pageUrl(rel), title: String(title).trim(), draft: data.draft === true, html: renderMarkdown(body) };
}
