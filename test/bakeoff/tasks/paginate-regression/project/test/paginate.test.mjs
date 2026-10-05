import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.mjs';

const five = [1, 2, 3, 4, 5];

test('first page', () => {
  assert.deepEqual(paginate(five, 1, 2), { items: [1, 2], page: 1, pages: 3 });
});

test('last partial page', () => {
  assert.deepEqual(paginate(five, 3, 2), { items: [5], page: 3, pages: 3 });
});
