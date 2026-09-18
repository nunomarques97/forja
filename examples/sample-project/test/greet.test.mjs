import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet, greetAll } from '../lib/greet.mjs';

test('greet names the person and ends with an exclamation mark', () => {
  assert.equal(greet('Rita'), 'Olá, Rita!');
  assert.equal(greet('  Ana '), 'Olá, Ana!');
});

test('greet without a name still greets', () => {
  assert.equal(greet(''), 'Olá!');
  assert.equal(greet(undefined), 'Olá!');
});

test('greetAll greets everyone in order', () => {
  assert.deepEqual(greetAll(['A', 'B']), ['Olá, A!', 'Olá, B!']);
  assert.deepEqual(greetAll([]), []);
});
