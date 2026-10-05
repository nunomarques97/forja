import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topWords } from '../src/wordfreq.mjs';

test('whitespace, case, punctuation and ties', () => {
  assert.deepEqual(topWords('The end.\nthe  END,\tdon\'t', 3), [['end', 2], ['the', 2], ["don't", 1]]);
  assert.deepEqual(topWords(''), []);
});
