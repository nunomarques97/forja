// Hidden acceptance check: never copied into the scenario project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, load } from './_helpers.mjs';

const { parseQuery } = await load('src/query.mjs');
const { createApp } = await load('src/app.mjs');

test('repeated keys collect every value in order', () => {
  assert.deepEqual(parseQuery('?tag=a&tag=b&tag=c'), { tag: ['a', 'b', 'c'] });
  assert.deepEqual(parseQuery('x=1&tag=a&tag=b'), { x: '1', tag: ['a', 'b'] });
});

test('plus is a space, an encoded plus stays a plus', () => {
  assert.deepEqual(parseQuery('q=hello+world&p=1%2B1'), { q: 'hello world', p: '1+1' });
});

test('everything the old parser handled', () => {
  assert.deepEqual(parseQuery('expr=a=b'), { expr: 'a=b' });
  assert.deepEqual(parseQuery('bad=%E0%A4%A'), { bad: '%E0%A4%A' });
  assert.deepEqual(parseQuery('a=1&&b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseQuery('flag'), { flag: '' });
  assert.deepEqual(parseQuery(''), {});
});

test('the app sees repeated keys', async () => {
  const app = createApp().route('GET', '/search', ctx => ({ body: ctx.query }));
  assert.deepEqual((await app.handle({ url: '/search?tag=a&tag=b&q=red+shoes' })).body, { tag: ['a', 'b'], q: 'red shoes' });
});

test('simple query strings stay fast', () => {
  const started = performance.now();
  for (let i = 0; i < 20_000; i++) parseQuery('a=1&b=2&c=3&d=4&e=5&f=6&g=7&h=8&i=9&j=10');
  assert.ok(performance.now() - started < 5_000);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 13));
