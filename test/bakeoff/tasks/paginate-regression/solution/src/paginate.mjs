// Returns one page of items; pages are numbered from 1.
export function paginate(items, page, size) {
  if (!Number.isInteger(page) || page < 1) throw new RangeError(`Invalid page: ${page}`);
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`Invalid size: ${size}`);
  const start = (page - 1) * size;
  return { items: items.slice(start, start + size), page, pages: Math.ceil(items.length / size) };
}
