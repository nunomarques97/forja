// Case-insensitive partial match on the description; surrounding spaces in the
// query are ignored and an empty query matches everything. Ledger order kept.
export function searchEntries(entries, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  return entries.filter(entry => String(entry.description ?? '').toLowerCase().includes(needle));
}
