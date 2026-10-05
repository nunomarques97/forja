// Hidden acceptance check: never copied into the scenario project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, load } from './_helpers.mjs';

const { createLru } = await load('src/cache.mjs');
const { createApp } = await load('src/app.mjs');

test('reading an entry makes it recently used', () => {
  const lru = createLru(2);
  lru.set('a', 1).set('b', 2);
  assert.equal(lru.get('a'), 1);
  lru.set('c', 3);
  assert.equal(lru.has('a'), true);
  assert.equal(lru.has('b'), false);
  assert.equal(lru.size, 2);
});

test('writing an entry again makes it recently used', () => {
  const lru = createLru(2);
  lru.set('a', 1).set('b', 2).set('a', 10).set('c', 3);
  assert.equal(lru.get('a'), 10);
  assert.equal(lru.has('b'), false);
});

test('a miss changes nothing', () => {
  const lru = createLru(2);
  lru.set('a', 1).set('b', 2);
  assert.equal(lru.get('zz'), undefined);
  lru.set('c', 3);
  assert.equal(lru.has('a'), false);
  assert.equal(lru.has('b'), true);
});

test('the hottest URL stays cached', async () => {
  const calls = {};
  const app = createApp({ cacheSize: 2 }).route('GET', '/:name', ctx => {
    calls[ctx.params.name] = (calls[ctx.params.name] ?? 0) + 1;
    return { body: ctx.params.name, cache: true };
  });
  for (const url of ['/hot', '/a', '/hot', '/b', '/hot', '/c', '/hot']) await app.handle({ url });
  assert.equal(calls.hot, 1);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 13));
