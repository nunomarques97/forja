import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('nested environment overrides keep defaults', () => {
  assert.deepEqual(loadConfig({ env: { APP_LOG__LEVEL: 'debug' } }).log, { level: 'debug', pretty: false });
});
