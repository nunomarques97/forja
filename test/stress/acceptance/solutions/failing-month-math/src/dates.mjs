import { ParseError } from './errors.mjs';

export function parseDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text).trim());
  if (!m) throw new ParseError(`invalid date ${JSON.stringify(text)}`);
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (date.getUTCMonth() !== Number(m[2]) - 1) throw new ParseError(`invalid date ${JSON.stringify(text)}`);
  return date;
}

export const formatDate = date => date.toISOString().slice(0, 10);
export const monthOf = iso => String(iso).slice(0, 7);

// Same day of the month, `months` later (negative goes back), clamped to the
// last day of a shorter month.
export function addMonths(iso, months) {
  const date = parseDate(iso);
  const target = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(target / 12);
  const month = target - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return formatDate(new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay))));
}
