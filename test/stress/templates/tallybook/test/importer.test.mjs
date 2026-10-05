import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCsv } from '../src/importer.mjs';
import { ParseError } from '../src/errors.mjs';

test('importCsv builds entries in cents with normalized categories', () => {
  const entries = importCsv('date,description,category,amount\n2024-05-02,Bakery,Food ,-3.20\n2024-05-03,Salary,Income,1500\n');
  assert.deepEqual(entries, [
    { date: '2024-05-02', description: 'Bakery', category: 'food', amountCents: -320 },
    { date: '2024-05-03', description: 'Salary', category: 'income', amountCents: 150000 },
  ]);
});

test('importCsv reports the failing line', () => {
  assert.throws(() => importCsv('date,description,category,amount\n2024-13-01,X,Y,1\n'), err => err instanceof ParseError && err.line === 2);
});
