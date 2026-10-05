import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createStaticHandler } from '../src/static.mjs';

const handle = createStaticHandler(fileURLToPath(new URL('../public', import.meta.url)));

test('serves index.html for folders', () => {
  const res = handle({ url: '/' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(String(res.body), /Downloads/);
  assert.match(String(handle({ url: '/docs/' }).body), /Documentation/);
});

test('missing files are 404 and other methods 405', () => {
  assert.equal(handle({ url: '/nope.txt' }).status, 404);
  assert.equal(handle({ method: 'POST', url: '/' }).status, 405);
});

test('HEAD has no body', () => {
  const res = handle({ method: 'HEAD', url: '/' });
  assert.equal(res.status, 200);
  assert.equal(res.body, '');
});
