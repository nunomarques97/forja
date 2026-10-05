import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

// A nav entry as people write it, also on Windows ("guide\install.md",
// ".\faq.md"), as the site-relative path docpack uses everywhere.
export const normalizeEntry = rel => posix.normalize(String(rel).replace(/\\/g, '/'));

// <src>/docpack.json -> { title, nav }; every nav page must exist.
export function readSiteConfig(src) {
  const file = join(src, 'docpack.json');
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(config.nav) || !config.nav.length) throw new Error('docpack.json: nav must list the pages');
  const nav = config.nav.map(rel => {
    if (typeof rel !== 'string' || !rel.endsWith('.md')) throw new Error(`docpack.json: not a Markdown page: ${JSON.stringify(rel)}`);
    const entry = normalizeEntry(rel);
    if (!existsSync(join(src, entry))) throw new Error(`docpack.json: page not found: ${rel}`);
    return entry;
  });
  return { title: String(config.title ?? 'Docs'), nav };
}
