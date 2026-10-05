import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/query.mjs';

test('repeated keys and plus signs', () => {
  assert.deepEqual(parseQuery('?tag=a&tag=b&q=hello+world'), { tag: ['a', 'b'], q: 'hello world' });
});
