import { monthOf } from './dates.mjs';
import { formatCents } from './money.mjs';

// [{ month, category, totalCents, count }] by month.
export function monthlyReport(entries) {
  const totals = {};
  for (const { date, category, amountCents } of entries) {
    const month = monthOf(date);
    const key = `${month}|${category}`;
    totals[key] ??= { month, category, totalCents: 0, count: 0 };
    totals[key].totalCents += amountCents;
    totals[key].count++;
  }
  return Object.values(totals).sort((a, b) => a.month.localeCompare(b.month));
}

export function formatReport(rows) {
  return rows.map(r => `${r.month}  ${r.category.padEnd(16)} ${formatCents(r.totalCents).padStart(10)}  (${r.count})`).join('\n');
}
