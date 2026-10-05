import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';

test('responses for credentialed requests are never shared', async () => {
  const app = createApp().route('GET', '/me', ctx => ({ body: ctx.headers.authorization ?? ctx.headers.cookie ?? null, cache: true }));
  assert.equal((await app.handle({ url: '/me', headers: { authorization: 'Bearer a' } })).body, 'Bearer a');
  assert.equal((await app.handle({ url: '/me', headers: { authorization: 'Bearer b' } })).body, 'Bearer b');
  assert.equal((await app.handle({ url: '/me', headers: { cookie: 'session=c' } })).body, 'session=c');
  assert.equal((await app.handle({ url: '/me' })).body, null);
});
