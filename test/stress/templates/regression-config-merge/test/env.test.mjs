import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envOverrides, loadConfig } from '../src/config.mjs';

test('envOverrides nests double underscores and parses JSON values', () => {
  assert.deepEqual(envOverrides({ APP_SERVER__PORT: '8080', APP_DEBUG: 'true', HOME: '/x', APP_NAME: 'shop' }), {
    server: { port: 8080 },
    debug: true,
    name: 'shop',
  });
});

test('environment values win', () => {
  assert.equal(loadConfig({ defaults: { debug: false }, env: { APP_DEBUG: 'true' } }).debug, true);
});
