// Returns one page of items; pages are numbered from 1.
export function paginate(items, page, size) {
  const start = page * size;
  return { items: items.slice(start, start + size), page, pages: Math.floor(items.length / size) };
}
