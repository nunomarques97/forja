import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

const app = () => createApp().route('GET', '/items', () => ({ headers: { 'X-Total': '2' }, body: [1, 2] })).route('POST', '/items', () => ({ status: 201 }));

test('405 lists the allowed methods', async () => {
  const res = await app().handle({ method: 'DELETE', url: '/items' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET, POST, HEAD, OPTIONS');
});

test('OPTIONS answers 204 with Allow and HEAD has no body', async () => {
  assert.deepEqual(await app().handle({ method: 'OPTIONS', url: '/items' }), { status: 204, headers: { allow: 'GET, POST, HEAD, OPTIONS' }, body: null });
  assert.deepEqual(await app().handle({ method: 'HEAD', url: '/items' }), { status: 200, headers: { 'x-total': '2' }, body: null });
});
