import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.mjs';

test('Ledger keeps copies and sums the balance', () => {
  const entry = { date: '2024-05-02', description: 'Bakery', category: 'food', amountCents: -320 };
  const ledger = new Ledger([entry]).add({ ...entry, amountCents: 1000 });
  entry.amountCents = 0;
  assert.equal(ledger.balance(), 680);
  assert.throws(() => ledger.add({ amountCents: 1.5 }));
});
