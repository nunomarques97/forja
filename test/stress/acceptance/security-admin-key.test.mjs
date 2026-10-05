// Hidden acceptance check: never copied into the scenario project.
// Negative cases: without a configured key (absent or empty) every admin
// request is refused, as are missing, empty, wrong, prefix, longer and
// case-changed keys; a refusal never echoes the key. Public routes stay open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, load } from './_helpers.mjs';

delete process.env.ADMIN_KEY;
const { createHandler } = await load('src/handler.mjs');

const KEY = 'example-admin-key-4f2a';
const call = (handle, path, headers = {}, method = 'GET') => handle({ method, path, ip: '10.0.0.7', headers });
const refused = (res, label) => {
  assert.ok([401, 403, 503].includes(res.status), `${label}: status ${res.status}`);
  assert.doesNotMatch(JSON.stringify(res.body ?? ''), /uptimeMs|flushed|example-admin-key/, label);
};
const withEnv = (value, fn) => {
  process.env.ADMIN_KEY = value;
  try { fn(); } finally { delete process.env.ADMIN_KEY; }
};

test('with no key configured, admin endpoints refuse everyone', () => {
  const handle = createHandler({ now: () => 1 });
  refused(call(handle, '/admin/stats'), 'no header');
  refused(call(handle, '/admin/stats', { 'x-admin-key': '' }), 'empty header');
  refused(call(handle, '/admin/stats', { 'x-admin-key': 'undefined' }), 'the text undefined');
  refused(call(handle, '/admin/flush', {}, 'POST'), 'flush');
});

test('an empty configured key counts as no key', () => {
  refused(call(createHandler({ adminKey: '' }), '/admin/stats', { 'x-admin-key': '' }), 'empty option');
  withEnv('', () => refused(call(createHandler(), '/admin/stats', { 'x-admin-key': '' }), 'empty ADMIN_KEY'));
});

test('only the exact configured key opens admin endpoints', () => {
  const handle = createHandler({ now: () => 5, adminKey: KEY });
  const wrong = { missing: {}, empty: { 'x-admin-key': '' }, wrong: { 'x-admin-key': 'nope' }, prefix: { 'x-admin-key': KEY.slice(0, 10) }, longer: { 'x-admin-key': `${KEY}x` }, upper: { 'x-admin-key': KEY.toUpperCase() } };
  for (const [label, headers] of Object.entries(wrong)) refused(call(handle, '/admin/stats', headers), label);
  const ok = call(handle, '/admin/stats', { 'x-admin-key': KEY });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.uptimeMs, 0);
  assert.equal(call(handle, '/admin/flush', { 'x-admin-key': KEY }, 'POST').status, 200);
});

test('the ADMIN_KEY environment variable still works', () => {
  withEnv(KEY, () => {
    const handle = createHandler();
    assert.equal(call(handle, '/admin/stats', { 'x-admin-key': KEY }).status, 200);
    refused(call(handle, '/admin/stats'), 'no header');
  });
});

test('public routes need no key', () => {
  const handle = createHandler({ now: () => 42 });
  assert.equal(call(handle, '/health').status, 200);
  assert.deepEqual(call(handle, '/time').body, { now: 42 });
  assert.equal(call(handle, '/nope').status, 404);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 4));
