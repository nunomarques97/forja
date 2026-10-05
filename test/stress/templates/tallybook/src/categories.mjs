export const UNCATEGORIZED = 'uncategorized';

// " Food  & Drink " -> "food & drink"; empty -> "uncategorized".
export function normalizeCategory(name) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return clean || UNCATEGORIZED;
}
