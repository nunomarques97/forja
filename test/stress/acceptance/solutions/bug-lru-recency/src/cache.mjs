// Least-recently-used cache. A Map iterates in insertion order, so every use
// moves the key to the end and the first key is the next one to evict.
export function createLru(capacity) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      else if (map.size >= capacity) map.delete(map.keys().next().value);
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
