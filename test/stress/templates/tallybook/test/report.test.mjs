import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyReport } from '../src/report.mjs';

test('monthlyReport groups by month and category', () => {
  const rows = monthlyReport([
    { date: '2024-05-02', description: 'Bakery', category: 'food', amountCents: -320 },
    { date: '2024-05-09', description: 'Market', category: 'food', amountCents: -1500 },
    { date: '2024-04-30', description: 'Bus', category: 'transport', amountCents: -200 },
  ]);
  assert.deepEqual(rows, [
    { month: '2024-04', category: 'transport', totalCents: -200, count: 1 },
    { month: '2024-05', category: 'food', totalCents: -1820, count: 2 },
  ]);
});
