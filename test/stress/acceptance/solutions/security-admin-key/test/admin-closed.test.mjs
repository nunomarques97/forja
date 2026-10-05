import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../src/handler.mjs';

test('admin endpoints stay closed without a configured key', () => {
  const previous = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  try {
    const request = headers => ({ method: 'GET', path: '/admin/stats', ip: '10.0.0.1', headers });
    assert.equal(createHandler()(request({})).status, 401);
    assert.equal(createHandler({ adminKey: '' })(request({ 'x-admin-key': '' })).status, 401);
    assert.equal(createHandler({ adminKey: 'abc' })(request({ 'x-admin-key': 'ab' })).status, 401);
  } finally {
    if (previous !== undefined) process.env.ADMIN_KEY = previous;
  }
});
