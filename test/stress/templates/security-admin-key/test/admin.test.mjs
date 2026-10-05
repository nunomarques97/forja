import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.mjs';

const stats = key => ({ method: 'GET', path: '/admin/stats', ip: '10.0.0.1', headers: key === undefined ? {} : { 'x-admin-key': key } });

test('admin routes need the admin key', () => {
  let t = 1000;
  const handle = createHandler({ now: () => t, adminKey: 'k-123' });
  t = 1500;
  assert.deepEqual(handle(stats('k-123')).body, { uptimeMs: 500 });
  assert.equal(handle(stats('wrong')).status, 401);
});
