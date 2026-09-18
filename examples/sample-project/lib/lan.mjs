// Local-network IPv4 addresses this computer has, so the person who started the server (with
// GREET_HOST=0.0.0.0) can tell their colleagues which one to open (T10; finding 2 in
// docs/forja/reports/QA-close-1.md). Only node:os — a Node built-in, covered by D15/S0 in
// docs/forja/TECHNOLOGY.md; no Scout decision needed.
import os from 'node:os';

/**
 * External (non-internal) IPv4 addresses from `os.networkInterfaces()`, in the order they appear,
 * without duplicates. IPv6 entries, loopback/internal entries and malformed entries are ignored.
 * Called with no argument at all (the normal, production way — see server.mjs), it reads this
 * computer's real interfaces. Called explicitly with `undefined` or `{}` (as the tests do, so the
 * result never depends on whether this particular machine happens to have a network address), it
 * returns `[]` without touching `os.networkInterfaces()`.
 *
 * @param {ReturnType<typeof os.networkInterfaces>} [interfaces]
 * @returns {string[]}
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  // `arguments.length` reflects what the caller actually passed, unaffected by the default value
  // above: 0 when `lanAddresses()` is called with nothing (interfaces is already the live data by
  // now), 1 when `lanAddresses(undefined)` is called explicitly — the case the tests use to get a
  // deterministic [] regardless of this machine's real network state.
  if (arguments.length > 0 && arguments[0] === undefined) return [];

  const seen = new Set();
  const result = [];
  if (interfaces == null || typeof interfaces !== 'object') return result;

  for (const entries of Object.values(interfaces)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry == null || typeof entry !== 'object') continue;
      const { family, internal, address } = entry;
      const isIPv4 = family === 'IPv4' || family === 4;
      if (!isIPv4) continue;
      if (internal !== false) continue;
      if (typeof address !== 'string' || address === '') continue;
      if (seen.has(address)) continue;
      seen.add(address);
      result.push(address);
    }
  }
  return result;
}
