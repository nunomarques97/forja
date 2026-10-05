import { slugify } from './slugify.mjs';

export { slugify };

export function uniqueSlug(text, taken = new Set()) {
  const base = slugify(text);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}
