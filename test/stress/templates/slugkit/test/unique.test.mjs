import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uniqueSlug } from '../src/index.mjs';

test('appends a counter to taken slugs', () => {
  assert.equal(uniqueSlug('Hello World'), 'hello-world');
  assert.equal(uniqueSlug('Hello World', new Set(['hello-world', 'hello-world-2'])), 'hello-world-3');
});
