import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDay, countByDay, newestFirst } from '../lib/stats.mjs';

test('localDay groups a UTC instant into the LOCAL calendar day, not the UTC one', () => {
  // 2026-06-15T23:30:00Z is already 16 June in Lisbon (WEST, UTC+1 in June).
  assert.equal(localDay('2026-06-15T23:30:00Z'), '2026-06-16');
  assert.equal(localDay('2026-06-15T23:30:00Z', 'Europe/Lisbon'), '2026-06-16');
  // The same instant, read in UTC, is still 15 June.
  assert.equal(localDay('2026-06-15T23:30:00Z', 'UTC'), '2026-06-15');
});

// Fixed "today" so the window is deterministic. 2026-06-20T09:00:00Z is 10:00 in Lisbon
// (WEST, UTC+1), so the local day of "today" is 2026-06-20.
const TODAY = new Date('2026-06-20T09:00:00Z');

test('countByDay returns exactly `days` entries, oldest first, today last', () => {
  const rows = countByDay([], { today: TODAY });
  assert.equal(rows.length, 14);
  assert.equal(rows[0].day, '2026-06-07'); // today minus 13 days
  assert.equal(rows[rows.length - 1].day, '2026-06-20'); // today
  // consecutive calendar days, no gaps, no duplicates
  const days = rows.map((r) => r.day);
  assert.deepEqual(days, [...new Set(days)].sort());
});

test('an empty list of records gives 14 days, all at count 0', () => {
  const rows = countByDay([], { today: TODAY });
  assert.equal(rows.length, 14);
  assert.ok(rows.every((r) => r.count === 0));
});

test('records land in the correct local day, and days with no records stay at 0', () => {
  const records = [
    { criado_em: '2026-06-20T09:30:00Z' }, // 10:30 Lisbon -> today, 2026-06-20
    { criado_em: '2026-06-20T22:45:00Z' }, // 23:45 Lisbon -> still 2026-06-20
    { criado_em: '2026-06-14T23:30:00Z' }, // 00:30 Lisbon next day -> 2026-06-15
  ];
  const rows = countByDay(records, { today: TODAY });
  const byDay = Object.fromEntries(rows.map((r) => [r.day, r.count]));

  assert.equal(byDay['2026-06-20'], 2);
  assert.equal(byDay['2026-06-15'], 1);
  // a day with no records at all is present with count 0, not omitted
  assert.equal(byDay['2026-06-10'], 0);
});

test('a record from 20 days ago falls outside the 14-day window and is not counted', () => {
  const records = [
    { criado_em: '2026-05-31T22:30:00Z' }, // 20 days before 2026-06-20, local day 2026-05-31
    { criado_em: '2026-06-20T09:00:00Z' }, // inside the window
  ];
  const rows = countByDay(records, { today: TODAY });
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  assert.equal(total, 1); // only the in-window record was counted
  assert.ok(!rows.some((r) => r.day === '2026-05-31'));
});

test('records with a missing or unparseable criado_em are ignored, not thrown', () => {
  const records = [
    { criado_em: '2026-06-20T09:00:00Z' },
    { criado_em: 'não é uma data' },
    { criado_em: null },
    {}, // no criado_em at all
  ];
  const rows = countByDay(records, { today: TODAY });
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  assert.equal(total, 1);
});

test('countByDay respects a custom `days` and `timeZone`', () => {
  const rows = countByDay([], { today: TODAY, days: 3, timeZone: 'UTC' });
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.day),
    ['2026-06-18', '2026-06-19', '2026-06-20'],
  );
});

test('newestFirst sorts by criado_em descending, stably, without mutating the input', () => {
  const records = [
    { criado_em: '2026-06-10T10:00:00Z', nome: 'A' },
    { criado_em: '2026-06-12T10:00:00Z', nome: 'B' },
    { criado_em: '2026-06-11T10:00:00Z', nome: 'C' },
  ];
  const original = [...records];

  const sorted = newestFirst(records);

  assert.deepEqual(
    sorted.map((r) => r.nome),
    ['B', 'C', 'A'],
  );
  assert.notEqual(sorted, records); // a copy, not the same array
  assert.deepEqual(records, original); // the input was not reordered
});

test('newestFirst is stable: equal timestamps keep their original relative order', () => {
  const records = [
    { criado_em: '2026-06-10T10:00:00Z', nome: 'X' },
    { criado_em: '2026-06-10T10:00:00Z', nome: 'Y' },
    { criado_em: '2026-06-10T10:00:00Z', nome: 'Z' },
  ];
  const sorted = newestFirst(records);
  assert.deepEqual(
    sorted.map((r) => r.nome),
    ['X', 'Y', 'Z'],
  );
});
