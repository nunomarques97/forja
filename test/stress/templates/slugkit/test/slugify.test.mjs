import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.mjs';

test('joins lower-case words with dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('Node 24 is out'), 'node-24-is-out');
});

test('turns accented letters into plain ones', () => {
  assert.equal(slugify('Açaí com Pão'), 'acai-com-pao');
  assert.equal(slugify('Crème brûlée'), 'creme-brulee');
});

test('never starts or ends with a dash', () => {
  assert.equal(slugify('  --Hello--  '), 'hello');
  assert.equal(slugify('¿Qué?'), 'que');
});

test('cuts long slugs at a word boundary', () => {
  assert.equal(slugify('the quick brown fox', { maxLength: 12 }), 'the-quick');
  assert.equal(slugify('the quick brown fox', { maxLength: 9 }), 'the-quick');
});

test('empty input gives an empty slug', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('!!!'), '');
});
