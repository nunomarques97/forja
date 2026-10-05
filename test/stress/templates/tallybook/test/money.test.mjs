import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, parseAmount, sumCents } from '../src/money.mjs';

test('parseAmount reads decimals, signs and thousands separators', () => {
  assert.equal(parseAmount('12.34'), 1234);
  assert.equal(parseAmount('-5'), -500);
  assert.equal(parseAmount('1,234.5'), 123450);
  assert.throws(() => parseAmount('12.345'));
  assert.throws(() => parseAmount('abc'));
});

test('formatCents and sumCents', () => {
  assert.equal(formatCents(1234), '12.34');
  assert.equal(formatCents(-5), '-0.05');
  assert.equal(sumCents([100, -30, 5]), 75);
});
