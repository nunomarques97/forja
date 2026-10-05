// Hidden acceptance check: never copied into the scenario project.
// Spans the ledger, the store, the report and the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwnSuite, load } from './_helpers.mjs';

const { Ledger } = await load('src/ledger.mjs');
const { loadLedger, saveLedger } = await load('src/store.mjs');
const { main } = await load('src/cli.mjs');

const ENTRIES = [
  { date: '2026-03-02', description: 'Market', category: 'food', amountCents: -9000 },
  { date: '2026-03-20', description: 'Bakery', category: 'food', amountCents: -6000 },
  { date: '2026-03-01', description: 'Rent', category: 'rent', amountCents: -80000 },
  { date: '2026-04-03', description: 'Market', category: 'food', amountCents: -5000 },
  { date: '2026-04-05', description: 'Salary', category: 'income', amountCents: 250000 },
];
const store = (content = { version: 1, entries: ENTRIES }) => {
  const path = join(mkdtempSync(join(tmpdir(), 'stress-budget-')), 'tally.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
};
const run = (argv, storePath) => {
  const lines = [];
  let code;
  try {
    code = main(argv, { storePath, write: line => lines.push(String(line)) });
  } catch (error) {
    code = error;
  }
  return { code, out: lines.join('\n') };
};

test('the ledger keeps budgets per normalized category and refuses invalid ones', () => {
  const ledger = new Ledger();
  ledger.setBudget(' Food ', 25000);
  assert.deepEqual(ledger.budgets(), { food: 25000 });
  for (const bad of [-500, 0, 12.5, '100', NaN]) assert.throws(() => ledger.setBudget('food', bad), undefined, String(bad));
  assert.deepEqual(ledger.budgets(), { food: 25000 });
});

test('budgets survive save and load; files without budgets still load', () => {
  const path = store();
  const ledger = loadLedger(path);
  assert.deepEqual(ledger.budgets(), {});
  assert.equal(ledger.entries().length, ENTRIES.length);
  ledger.setBudget('food', 10000);
  saveLedger(ledger, path);
  const again = loadLedger(path);
  assert.deepEqual(again.budgets(), { food: 10000 });
  assert.equal(again.entries().length, ENTRIES.length);
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).entries.length === ENTRIES.length);
});

test('the CLI sets a budget and the report flags only categories over it', () => {
  const path = store();
  assert.equal(run(['budget', 'Food', '100.00'], path).code, 0);
  assert.equal(run(['budget', 'rent', '900'], path).code, 0);
  assert.deepEqual(loadLedger(path).budgets(), { food: 10000, rent: 90000 });
  const { code, out } = run(['report'], path);
  assert.equal(code, 0);
  const line = (month, category) => out.split('\n').find(l => l.includes(month) && l.includes(category)) ?? '';
  assert.match(line('2026-03', 'food'), /OVER BUDGET/);
  assert.doesNotMatch(line('2026-03', 'rent'), /OVER BUDGET/);
  assert.doesNotMatch(line('2026-04', 'food'), /OVER BUDGET/);
  assert.doesNotMatch(line('2026-04', 'income'), /OVER BUDGET/);
  assert.match(line('2026-03', 'food'), /-150\.00/);
});

test('invalid budget amounts are refused and change nothing', () => {
  const path = store();
  run(['budget', 'food', '100'], path);
  for (const argv of [['budget', 'food', 'abc'], ['budget', 'food', '-5'], ['budget', 'food']]) {
    const { code } = run(argv, path);
    assert.notEqual(code, 0, argv.join(' '));
  }
  assert.deepEqual(loadLedger(path).budgets(), { food: 10000 });
});

test('balance and the report without budgets are unchanged', () => {
  const path = store();
  assert.equal(run(['balance'], path).out, '1500.00');
  assert.doesNotMatch(run(['report'], path).out, /OVER BUDGET/);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 11));
