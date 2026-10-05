import { readFileSync } from 'node:fs';

// Theme files sit next to the package; resolve them from this module's URL.
export const THEME_DIR = new URL('../theme/', import.meta.url).pathname;

export const loadTheme = () => readFileSync(THEME_DIR + 'page.html', 'utf8');
export const themeFile = name => THEME_DIR + name;

// Fills {{name}} placeholders; unknown names become empty.
export function renderPage(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name) => values[name] ?? '');
}
