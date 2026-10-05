import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/cart.mjs';

test('sums prices times quantities', () => {
  assert.equal(total([{ sku: 'apple', quantity: 2 }, { sku: 'bread', quantity: 1 }]), 490);
  assert.equal(total([]), 0);
});
