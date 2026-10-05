export function topWords(text, n = 10) {
  const counts = {};
  for (const word of String(text).split(' ')) counts[word] = (counts[word] || 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}
