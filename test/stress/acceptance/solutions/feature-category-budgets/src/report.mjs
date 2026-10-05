import { monthOf } from './dates.mjs';
import { normalizeCategory } from './categories.mjs';
import { formatCents } from './money.mjs';

// [{ month, category, totalCents, count }] sorted by month, then category.
export function monthlyReport(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const month = monthOf(entry.date);
    const category = normalizeCategory(entry.category);
    const key = `${month}|${category}`;
    const group = groups.get(key) ?? { month, category, totalCents: 0, count: 0 };
    group.totalCents += entry.amountCents;
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.month.localeCompare(b.month) || a.category.localeCompare(b.category));
}

// `budgets` maps a category to its monthly limit in cents; a row whose
// spending (negative total) exceeds it is flagged.
export function formatReport(rows, budgets = {}) {
  return rows.map(r => {
    const line = `${r.month}  ${r.category.padEnd(16)} ${formatCents(r.totalCents).padStart(10)}  (${r.count})`;
    const budget = budgets[r.category];
    return budget && -r.totalCents > budget ? `${line}  OVER BUDGET by ${formatCents(-r.totalCents - budget)}` : line;
  }).join('\n');
}
