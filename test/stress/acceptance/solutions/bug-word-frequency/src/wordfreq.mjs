// Letters, digits, and apostrophes between them (don't, it's).
const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

export function topWords(text, n = 10) {
  const counts = new Map();
  for (const [word] of String(text).toLowerCase().matchAll(WORD)) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n);
}
