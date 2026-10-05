const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

// docs/STYLE.md: "1h 2m 3s", zero units left out, rounded down, "<1s".
export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  if (total < 1) return '<1s';
  const parts = [[Math.floor(total / 3600), 'h'], [Math.floor((total % 3600) / 60), 'm'], [total % 60, 's']];
  return parts.filter(([n]) => n > 0).map(([n, unit]) => `${n}${unit}`).join(' ');
}
