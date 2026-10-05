// Hidden acceptance check: never copied into the scenario project.
// The order of the methods in Allow is free; its content is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, header, load } from './_helpers.mjs';

const { createApp } = await load('src/app.mjs');

const methods = res => new Set(String(header(res.headers, 'allow') ?? '').split(',').map(m => m.trim()).filter(Boolean));
const assertAllow = (res, required, optional = ['OPTIONS']) => {
  const got = methods(res);
  for (const m of required) assert.ok(got.has(m), `Allow lacks ${m}: ${header(res.headers, 'allow')}`);
  for (const m of got) assert.ok(required.includes(m) || optional.includes(m), `Allow has unexpected ${m}`);
};

function shop() {
  const calls = { list: 0 };
  const app = createApp()
    .route('GET', '/items', () => { calls.list++; return { headers: { 'X-Total': '2' }, body: [1, 2], cache: true }; })
    .route('POST', '/items', () => ({ status: 201, body: { id: 3 } }))
    .route('GET', '/users/:id', ctx => ({ body: { id: ctx.params.id } }))
    .route('POST', '/upload', () => ({ status: 202 }))
    .route('GET', '/custom', () => ({ body: 'x' }))
    .route('OPTIONS', '/custom', () => ({ status: 200, headers: { 'X-Custom': 'yes' }, body: 'mine' }));
  return { app, calls };
}

test('405 carries an Allow header with the path\'s methods', async () => {
  const { app } = shop();
  const res = await app.handle({ method: 'DELETE', url: '/items' });
  assert.equal(res.status, 405);
  assertAllow(res, ['GET', 'HEAD', 'POST']);
  const param = await app.handle({ method: 'PUT', url: '/users/7' });
  assert.equal(param.status, 405);
  assertAllow(param, ['GET', 'HEAD']);
});

test('OPTIONS on a known path answers 204 with Allow; unknown paths stay 404', async () => {
  const { app } = shop();
  const res = await app.handle({ method: 'OPTIONS', url: '/items' });
  assert.equal(res.status, 204);
  assertAllow(res, ['GET', 'HEAD', 'POST']);
  assert.ok(res.body === null || res.body === undefined || res.body === '', `body ${JSON.stringify(res.body)}`);
  assert.equal((await app.handle({ method: 'OPTIONS', url: '/nope' })).status, 404);
  assert.equal((await app.handle({ method: 'DELETE', url: '/nope' })).status, 404);
});

test('an explicit OPTIONS route wins', async () => {
  const res = await shop().app.handle({ method: 'OPTIONS', url: '/custom' });
  assert.equal(res.status, 200);
  assert.equal(res.body, 'mine');
  assert.equal(header(res.headers, 'x-custom'), 'yes');
});

test('HEAD is answered by the GET route without a body, also after caching', async () => {
  const { app } = shop();
  const head = await app.handle({ method: 'HEAD', url: '/items' });
  assert.equal(head.status, 200);
  assert.equal(header(head.headers, 'x-total'), '2');
  assert.ok(head.body === null || head.body === undefined || head.body === '', `HEAD body ${JSON.stringify(head.body)}`);
  assert.deepEqual((await app.handle({ method: 'GET', url: '/items' })).body, [1, 2]);
  const again = await app.handle({ method: 'HEAD', url: '/items' });
  assert.ok(again.body === null || again.body === undefined || again.body === '', 'HEAD served a cached body');
  const posted = await app.handle({ method: 'HEAD', url: '/upload' });
  assert.equal(posted.status, 405);
  assertAllow(posted, ['POST']);
});

test('routing that worked before still works', async () => {
  const { app } = shop();
  assert.deepEqual(await app.handle({ method: 'GET', url: '/users/9' }), { status: 200, headers: {}, body: { id: '9' } });
  assert.equal((await app.handle({ method: 'POST', url: '/items' })).status, 201);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 13));
