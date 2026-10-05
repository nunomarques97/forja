// Hidden acceptance check: never copied into the scenario project.
// The goal leaves keying, window shape and defaults open; required is what
// any reasonable reading gives: per client, 429 with Retry-After, recovery
// after the window, limiting on by default, documented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertOwnSuite, header, load, projectPath } from './_helpers.mjs';

const { createHandler } = await load('src/handler.mjs');
const request = ip => ({ method: 'GET', path: '/health', ip, headers: {} });

test('over the limit a client gets 429 with Retry-After; others are not affected', () => {
  let t = 1_000_000;
  const handle = createHandler({ now: () => t, rateLimit: { limit: 3, windowMs: 10_000 } });
  for (let i = 0; i < 3; i++) assert.equal(handle(request('10.0.0.1')).status, 200);
  const rejected = handle(request('10.0.0.1'));
  assert.equal(rejected.status, 429);
  const retry = Number(header(rejected.headers, 'retry-after'));
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 10, `Retry-After ${header(rejected.headers, 'retry-after')}`);
  assert.equal(handle(request('10.0.0.2')).status, 200);
  t += 10_001;
  assert.equal(handle(request('10.0.0.1')).status, 200);
});

test('limiting is on by default without blocking normal use', () => {
  const handle = createHandler({ now: () => 5_000_000 });
  for (let i = 0; i < 5; i++) assert.equal(handle(request('10.0.0.9')).status, 200);
  let limited = false;
  for (let i = 0; i < 100_000 && !limited; i++) limited = handle(request('10.0.0.9')).status === 429;
  assert.ok(limited, 'no default limit');
});

test('README documents it', () => {
  const readme = readFileSync(projectPath('README.md'), 'utf8');
  assert.match(readme, /rate.?limit/i);
  assert.match(readme, /429|retry-after/i);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 2));
