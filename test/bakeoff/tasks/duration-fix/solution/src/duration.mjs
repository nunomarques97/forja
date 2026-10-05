// Parses durations such as "1h30m" or "45s" into seconds.
const UNITS = { h: 3600, m: 60, s: 1 };

export function parseDuration(text) {
  if (typeof text !== 'string' || !/^(\d+[hms])+$/.test(text)) throw new RangeError(`Invalid duration: ${text}`);
  let seconds = 0;
  for (const [, value, unit] of text.matchAll(/(\d+)([hms])/g)) seconds += Number(value) * UNITS[unit];
  return seconds;
}
