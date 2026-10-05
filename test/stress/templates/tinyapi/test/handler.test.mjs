import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.mjs';

test('routes a request', () => {
  const handle = createHandler({ now: () => 42 });
  assert.deepEqual(handle({ method: 'GET', path: '/time', ip: '10.0.0.1' }).body, { now: 42 });
  assert.equal(handle({ method: 'GET', path: '/health', ip: '10.0.0.1' }).status, 200);
});

test('unknown routes are 404', () => {
  assert.equal(createHandler()({ method: 'GET', path: '/nope', ip: '10.0.0.1' }).status, 404);
});
