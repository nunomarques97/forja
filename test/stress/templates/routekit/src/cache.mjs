// Least-recently-used cache. A Map iterates in insertion order, so the first
// key is the next one to evict.
export function createLru(capacity) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
  const map = new Map();
  return {
    get(key) {
      return map.get(key);
    },
    set(key, value) {
      if (!map.has(key) && map.size >= capacity) map.delete(map.keys().next().value);
      map.set(key, value);
      return this;
    },
    has: key => map.has(key),
    delete: key => map.delete(key),
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
    keys: () => [...map.keys()],
  };
}
