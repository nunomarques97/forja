import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSiteConfig } from './config.mjs';
import { escapeHtml } from './markdown.mjs';
import { loadPage, relativeUrl } from './pages.mjs';
import { loadTheme, renderPage, themeFile } from './theme.mjs';

// Renders every page of <src>/docpack.json except drafts into `out`, plus
// style.css and sitemap.txt. Returns the site-relative URLs of the pages.
export function build({ src, out }) {
  const config = readSiteConfig(src);
  const template = loadTheme();
  const pages = config.nav.map(rel => loadPage(src, rel)).filter(page => !page.draft);
  mkdirSync(out, { recursive: true });
  for (const page of pages) {
    const nav = pages.map(other => `<a href="${relativeUrl(page.url, other.url)}"${other === page ? ' aria-current="page"' : ''}>${escapeHtml(other.title)}</a>`).join('\n');
    const html = renderPage(template, { site: escapeHtml(config.title), title: escapeHtml(page.title), root: relativeUrl(page.url, ''), nav, content: page.html });
    const file = join(out, page.url);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
  }
  copyFileSync(themeFile('style.css'), join(out, 'style.css'));
  writeFileSync(join(out, 'sitemap.txt'), pages.map(page => page.url).join('\n') + '\n');
  return pages.map(page => page.url);
}
