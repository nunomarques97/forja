// Hidden acceptance check: never copied into the scenario project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, load } from './_helpers.mjs';

const { topWords } = await load('src/wordfreq.mjs');

test('any whitespace separates words', () => {
  assert.deepEqual(topWords('a  b\tc\nb\r\n', 10), [['b', 2], ['a', 1], ['c', 1]]);
  assert.deepEqual(topWords('', 5), []);
  assert.deepEqual(topWords('  \n\t ', 5), []);
});

test('case-insensitive, returned in lower case', () => {
  assert.deepEqual(topWords('The cat saw the dog. THE end', 1), [['the', 3]]);
});

test('punctuation does not stick to words', () => {
  assert.deepEqual(topWords('end. end, (end)! "end"', 5), [['end', 4]]);
});

test('apostrophes inside words, accented letters and digits', () => {
  assert.deepEqual(topWords("don't stop, it's don't", 10), [["don't", 2], ["it's", 1], ['stop', 1]]);
  assert.deepEqual(topWords('Café café CAFÉ naïve', 2), [['café', 3], ['naïve', 1]]);
  assert.deepEqual(topWords('route 66 and 66', 1), [['66', 2]]);
});

test('ties are alphabetical and n limits the result', () => {
  assert.deepEqual(topWords('b a c b a c d', 3), [['a', 2], ['b', 2], ['c', 2]]);
  assert.equal(topWords('one two three four five six seven eight nine ten eleven twelve').length, 10);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 2));
