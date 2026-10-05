import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLru } from '../src/cache.mjs';

test('get and set refresh recency', () => {
  const lru = createLru(2);
  lru.set('a', 1).set('b', 2);
  lru.get('a');
  lru.set('c', 3);
  assert.deepEqual(lru.keys(), ['a', 'c']);
  lru.set('a', 4).set('d', 5);
  assert.deepEqual(lru.keys(), ['a', 'd']);
});
