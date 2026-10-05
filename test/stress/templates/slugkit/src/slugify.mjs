export function slugify(text, { maxLength = 60 } = {}) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, maxLength);
}
