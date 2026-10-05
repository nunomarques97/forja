// Hidden acceptance check: never copied into the scenario project.
// Only what any search box does is required: case-insensitive partial match
// on the description, surrounding spaces ignored, order kept, input untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwnSuite, load } from './_helpers.mjs';

const { searchEntries } = await load('src/search.mjs');
const { main } = await load('src/cli.mjs');

const entries = [
  { date: '2024-05-01', description: 'Coffee beans', category: 'food', amountCents: -1200 },
  { date: '2024-05-02', description: 'Bus ticket', category: 'transport', amountCents: -200 },
  { date: '2024-05-03', description: 'Morning COFFEE', category: 'food', amountCents: -350 },
  { date: '2024-05-04', description: 'Rent', category: 'home', amountCents: -90000 },
];

test('case-insensitive partial match on the description, in ledger order', () => {
  const before = structuredClone(entries);
  for (const query of ['coffee', 'COFF', '  coffee  '])
    assert.deepEqual(searchEntries(entries, query).map(e => e.description), ['Coffee beans', 'Morning COFFEE'], query);
  assert.deepEqual(searchEntries(entries, 'zzz'), []);
  assert.deepEqual(entries, before);
});

test('the CLI search command prints only the matches', () => {
  const storePath = join(mkdtempSync(join(tmpdir(), 'stress-tally-')), 'tally.json');
  writeFileSync(storePath, JSON.stringify({ version: 1, entries }));
  const lines = [];
  const code = main(['search', 'coffee'], { storePath, write: line => lines.push(String(line)) });
  const output = lines.join('\n');
  assert.equal(code, 0);
  assert.match(output, /Coffee beans/);
  assert.match(output, /Morning COFFEE/);
  assert.doesNotMatch(output, /Bus ticket|Rent/);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 10));
