import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.mjs';
import { loadLedger, saveLedger } from '../src/store.mjs';
import { formatReport } from '../src/report.mjs';

test('budgets are kept, saved and flagged in the report', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'tally-')), 'tally.json');
  saveLedger(new Ledger().setBudget('Food', 1000), path);
  assert.deepEqual(loadLedger(path).budgets(), { food: 1000 });
  assert.throws(() => new Ledger().setBudget('food', -1));
  const rows = [{ month: '2026-01', category: 'food', totalCents: -1500, count: 2 }, { month: '2026-02', category: 'food', totalCents: -500, count: 1 }];
  const [over, under] = formatReport(rows, { food: 1000 }).split('\n');
  assert.match(over, /OVER BUDGET by 5\.00$/);
  assert.doesNotMatch(under, /OVER/);
});
