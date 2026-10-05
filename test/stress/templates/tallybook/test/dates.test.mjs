import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, monthOf, parseDate } from '../src/dates.mjs';

test('parseDate accepts ISO dates and rejects impossible ones', () => {
  assert.equal(parseDate('2024-02-29').toISOString(), '2024-02-29T00:00:00.000Z');
  assert.throws(() => parseDate('2023-02-29'));
  assert.throws(() => parseDate('29/02/2024'));
});

test('addMonths keeps the day of the month', () => {
  assert.equal(addMonths('2024-01-15', 1), '2024-02-15');
  assert.equal(addMonths('2024-03-10', -2), '2024-01-10');
  assert.equal(addMonths('2024-11-05', 3), '2025-02-05');
});

test('monthOf', () => assert.equal(monthOf('2024-07-31'), '2024-07'));
