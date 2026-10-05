import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

test('routes a request with params and query', async () => {
  const app = createApp();
  app.route('GET', '/users/:id', ctx => ({ body: { id: ctx.params.id, fields: ctx.query.fields } }));
  const res = await app.handle({ method: 'GET', url: '/users/7?fields=name' });
  assert.deepEqual(res, { status: 200, headers: {}, body: { id: '7', fields: 'name' } });
});

test('404 and 405', async () => {
  const app = createApp().route('POST', '/items', () => ({ status: 201 }));
  assert.equal((await app.handle({ method: 'GET', url: '/nope' })).status, 404);
  assert.equal((await app.handle({ method: 'GET', url: '/items' })).status, 405);
});

test('caches GET responses that ask for it', async () => {
  let calls = 0;
  const app = createApp().route('GET', '/n', () => ({ body: ++calls, cache: true }));
  await app.handle({ url: '/n' });
  assert.equal((await app.handle({ url: '/n' })).body, 1);
});
