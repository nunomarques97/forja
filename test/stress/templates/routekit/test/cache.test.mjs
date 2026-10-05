import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLru } from '../src/cache.mjs';

test('evicts the oldest entry when full', () => {
  const lru = createLru(2);
  lru.set('a', 1).set('b', 2).set('c', 3);
  assert.equal(lru.has('a'), false);
  assert.deepEqual(lru.keys(), ['b', 'c']);
  assert.equal(lru.size, 2);
});

test('rejects a bad capacity', () => {
  assert.throws(() => createLru(0), RangeError);
});
