// Hidden acceptance check: never copied into the scenario project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, assertUnchanged, load } from './_helpers.mjs';

const { createRouter } = await load('src/router.mjs');
const { createApp } = await load('src/app.mjs');

test('the router tests were not changed', () => assertUnchanged(assert, 'test/router.test.mjs', 'failing-route-priority'));

test("the project's own tests pass", () => assertOwnSuite(assert, 14));

test('the root route and parameters still match, with or without a trailing slash', () => {
  const router = createRouter();
  const root = () => 'root';
  const show = () => 'show';
  const me = () => 'me';
  router.add('GET', '/', root);
  router.add('GET', '/users/:id', show);
  router.add('GET', '/users/me', me);
  assert.equal(router.match('GET', '/').handler, root);
  assert.deepEqual(router.match('GET', '/users/7/'), { handler: show, params: { id: '7' } });
  assert.equal(router.match('GET', '/users/me/').handler, me);
});

test('static wins at any depth, and 405 survives the trailing slash', () => {
  const router = createRouter();
  const param = () => 'param';
  const fixed = () => 'fixed';
  router.add('GET', '/a/:x', param);
  router.add('GET', '/a/b', fixed);
  router.add('POST', '/items', () => {});
  assert.equal(router.match('GET', '/a/b').handler, fixed);
  assert.equal(router.match('GET', '/a/c').handler, param);
  assert.deepEqual(router.match('GET', '/items/'), { methodNotAllowed: true });
});

test('the app routes through the same priority', async () => {
  const app = createApp()
    .route('GET', '/users/:id', ctx => ({ body: `user ${ctx.params.id}` }))
    .route('GET', '/users/me', () => ({ body: 'me' }));
  assert.equal((await app.handle({ url: '/users/me' })).body, 'me');
  assert.equal((await app.handle({ url: '/users/3' })).body, 'user 3');
});
