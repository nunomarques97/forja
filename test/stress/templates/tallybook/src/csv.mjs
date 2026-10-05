// Minimal CSV reader for bank exports: one record per line, comma separated.
export function parseCsv(text) {
  return String(text)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => line.split(',').map(cell => cell.trim()));
}
