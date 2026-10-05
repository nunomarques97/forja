import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';

test('parseCsv splits lines and cells', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv('\nx, y \n\n'), [['x', 'y']]);
});
