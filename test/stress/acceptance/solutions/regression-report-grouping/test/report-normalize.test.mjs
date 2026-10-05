import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyReport } from '../src/report.mjs';

test('hand-edited category spellings share a row, rows sorted by category', () => {
  const rows = monthlyReport([
    { date: '2024-05-02', description: 'a', category: 'transport', amountCents: -1 },
    { date: '2024-05-02', description: 'b', category: 'Food', amountCents: -2 },
    { date: '2024-05-03', description: 'c', category: 'food ', amountCents: -3 },
  ]);
  assert.deepEqual(rows.map(r => [r.category, r.totalCents]), [['food', -5], ['transport', -1]]);
});
