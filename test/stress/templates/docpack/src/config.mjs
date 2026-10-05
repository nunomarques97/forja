import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// <src>/docpack.json -> { title, nav }; every nav page must exist.
export function readSiteConfig(src) {
  const file = join(src, 'docpack.json');
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(config.nav) || !config.nav.length) throw new Error('docpack.json: nav must list the pages');
  for (const rel of config.nav) {
    if (typeof rel !== 'string' || !rel.endsWith('.md')) throw new Error(`docpack.json: not a Markdown page: ${JSON.stringify(rel)}`);
    if (!existsSync(join(src, rel))) throw new Error(`docpack.json: page not found: ${rel}`);
  }
  return { title: String(config.title ?? 'Docs'), nav: config.nav };
}
