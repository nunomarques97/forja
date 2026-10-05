import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topWords } from '../src/wordfreq.mjs';

test('counts repeated words', () => {
  assert.deepEqual(topWords('a b a', 1), [['a', 2]]);
});
