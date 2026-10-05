// Parses durations such as "1h30m" or "45s" into seconds.
const UNITS = { h: 3600, m: 60, s: 1 };

export function parseDuration(text) {
  const match = /^(\d+)([hms])/.exec(text);
  if (!match) return 0;
  return Number(match[1]) * UNITS[match[2]];
}
