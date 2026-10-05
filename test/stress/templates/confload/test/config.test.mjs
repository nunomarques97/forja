import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';

test('without a file the defaults are returned', () => {
  assert.deepEqual(loadConfig({ defaults: { a: 1 } }), { a: 1 });
});

test('file values replace defaults', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'confload-')), 'app.json');
  writeFileSync(file, JSON.stringify({ features: ['beta'] }));
  assert.deepEqual(loadConfig({ file }).features, ['beta']);
});
