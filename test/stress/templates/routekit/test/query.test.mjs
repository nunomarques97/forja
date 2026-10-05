import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, stringifyQuery } from '../src/query.mjs';

test('parseQuery reads simple pairs', () => {
  assert.deepEqual(parseQuery('?a=1&b=two'), { a: '1', b: 'two' });
  assert.deepEqual(parseQuery(''), {});
  assert.deepEqual(parseQuery('flag'), { flag: '' });
});

test('stringifyQuery encodes values', () => {
  assert.equal(stringifyQuery({ q: 'a b', n: 1 }), 'q=a%20b&n=1');
});
