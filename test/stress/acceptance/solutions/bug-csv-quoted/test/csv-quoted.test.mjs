import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';

test('quoted fields, doubled quotes and CRLF', () => {
  assert.deepEqual(parseCsv('a,"b, c"\r\n"say ""hi""",2\r\n'), [['a', 'b, c'], ['say "hi"', '2']]);
});
