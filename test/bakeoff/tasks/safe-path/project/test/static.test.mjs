import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { resolveInside } from '../src/static.mjs';

test('maps a request to a file under the root', () => {
  const root = resolve('public');
  assert.equal(resolveInside(root, '/index.html'), join(root, 'index.html'));
});
