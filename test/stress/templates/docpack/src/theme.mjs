import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THEME_DIR = fileURLToPath(new URL('../theme/', import.meta.url));

export const loadTheme = () => readFileSync(join(THEME_DIR, 'page.html'), 'utf8');
export const themeFile = name => join(THEME_DIR, name);

// Fills {{name}} placeholders; unknown names become empty.
export function renderPage(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) => values[name] ?? '');
}
