// URL-friendly slugs (decision D2 in docs/forja/DECISIONS.md):
// String(text ?? "") → lower case → NFD + strip combining marks →
// any run outside [a-z0-9] becomes a single hyphen → no leading/trailing hyphens.
export function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
