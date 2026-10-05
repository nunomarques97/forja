import { ParseError } from './errors.mjs';

// "12.34", "-5", "1,234.50" -> integer cents.
export function parseAmount(text) {
  const clean = String(text).trim().replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) throw new ParseError(`invalid amount ${JSON.stringify(text)}`);
  const cents = Number(m[2]) * 100 + Number((m[3] || '0').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

export function formatCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export const sumCents = list => list.reduce((total, n) => total + n, 0);
