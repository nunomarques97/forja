// Hidden acceptance check: never copied into the scenario project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, load } from './_helpers.mjs';

const { parseCsv } = await load('src/csv.mjs');
const { importCsv } = await load('src/importer.mjs');

test('quoted fields keep commas and doubled quotes', () => {
  assert.deepEqual(parseCsv('a,"b, c",d\n'), [['a', 'b, c', 'd']]);
  assert.deepEqual(parseCsv('"Joe ""The Plumber""",x\n'), [['Joe "The Plumber"', 'x']]);
  assert.deepEqual(parseCsv('"",y\n'), [['', 'y']]);
});

test('Windows line endings', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('simple files read as before', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('\nx, y \n\n'), [['x', 'y']]);
});

test('a quoted bank export imports', () => {
  const text = 'date,description,category,amount\r\n2024-05-02,"Coffee, beans",Food,"-1,234.50"\r\n2024-05-03,"Joe ""The Plumber""",Home,-80\r\n';
  assert.deepEqual(importCsv(text), [
    { date: '2024-05-02', description: 'Coffee, beans', category: 'food', amountCents: -123450 },
    { date: '2024-05-03', description: 'Joe "The Plumber"', category: 'home', amountCents: -8000 },
  ]);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 11));
