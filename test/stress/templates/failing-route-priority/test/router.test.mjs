import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/router.mjs';

test('matches static and parameter segments', () => {
  const router = createRouter();
  const list = () => 'list';
  const show = () => 'show';
  router.add('GET', '/users', list);
  router.add('GET', '/users/:id', show);
  assert.equal(router.match('GET', '/users').handler, list);
  assert.deepEqual(router.match('GET', '/users/42'), { handler: show, params: { id: '42' } });
  assert.equal(router.match('GET', '/posts'), null);
});

test('reports a known path with another method', () => {
  const router = createRouter();
  router.add('POST', '/users', () => {});
  assert.deepEqual(router.match('GET', '/users'), { methodNotAllowed: true });
});

test('a trailing star captures the rest of the path', () => {
  const router = createRouter();
  router.add('GET', '/files/*', () => {});
  assert.equal(router.match('GET', '/files/a/b.txt').params.rest, 'a/b.txt');
});

test('a static segment wins over a parameter, whatever the order of add()', () => {
  const router = createRouter();
  const show = () => 'show';
  const me = () => 'me';
  router.add('GET', '/users/:id', show);
  router.add('GET', '/users/me', me);
  assert.equal(router.match('GET', '/users/me').handler, me);
  assert.deepEqual(router.match('GET', '/users/9'), { handler: show, params: { id: '9' } });
});

test('a trailing slash matches the same route', () => {
  const router = createRouter();
  const list = () => 'list';
  router.add('GET', '/users', list);
  assert.equal(router.match('GET', '/users/').handler, list);
});
