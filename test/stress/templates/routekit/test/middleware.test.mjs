import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../src/middleware.mjs';

test('middlewares run in onion order', async () => {
  const seen = [];
  const run = compose([
    async (ctx, next) => { seen.push('a1'); await next(); seen.push('a2'); },
    async (ctx, next) => { seen.push('b1'); await next(); seen.push('b2'); },
  ]);
  await run({}, async () => seen.push('end'));
  assert.deepEqual(seen, ['a1', 'b1', 'end', 'b2', 'a2']);
});

test('next() twice is an error', async () => {
  const run = compose([async (ctx, next) => { await next(); await next(); }]);
  await assert.rejects(run({}), /more than once/);
});
