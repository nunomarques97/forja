// Hidden acceptance check: never copied into the scenario project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, load } from './_helpers.mjs';

const { monthlyReport } = await load('src/report.mjs');

const entry = (date, category, amountCents) => ({ date, description: 'x', category, amountCents });

test('categories that differ only in case or spacing share one row', () => {
  const rows = monthlyReport([
    entry('2024-05-02', 'Food', -300),
    entry('2024-05-03', 'food ', -200),
    entry('2024-05-04', '  FOOD', -100),
    entry('2024-05-05', 'Eating  Out', -50),
    entry('2024-05-06', 'eating out', -25),
  ]);
  assert.deepEqual(rows, [
    { month: '2024-05', category: 'eating out', totalCents: -75, count: 2 },
    { month: '2024-05', category: 'food', totalCents: -600, count: 3 },
  ]);
});

test('rows are ordered by month, then category, whatever the input order', () => {
  const rows = monthlyReport([
    entry('2024-06-01', 'transport', -10),
    entry('2024-05-20', 'Transport', -20),
    entry('2024-06-02', 'books', -30),
    entry('2024-05-01', 'Rent', -40),
    entry('2024-06-03', '', -5),
  ]);
  assert.deepEqual(rows.map(r => `${r.month} ${r.category} ${r.totalCents}`), [
    '2024-05 rent -40',
    '2024-05 transport -20',
    '2024-06 books -30',
    '2024-06 transport -10',
    '2024-06 uncategorized -5',
  ]);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 11));
