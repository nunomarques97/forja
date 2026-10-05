// Hidden acceptance check: never copied into the scenario project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwnSuite, load } from './_helpers.mjs';

const { loadConfig } = await load('src/config.mjs');

const configFile = content => {
  const file = join(mkdtempSync(join(tmpdir(), 'stress-config-')), 'app.json');
  writeFileSync(file, JSON.stringify(content));
  return file;
};

test('a file that sets one nested key keeps the other defaults', () => {
  const config = loadConfig({ file: configFile({ server: { port: 8080 } }), env: {} });
  assert.deepEqual(config.server, { host: '127.0.0.1', port: 8080 });
  assert.deepEqual(config.log, { level: 'info', pretty: false });
});

test('a nested environment override keeps its siblings', () => {
  assert.deepEqual(loadConfig({ env: { APP_LOG__LEVEL: 'debug' } }).log, { level: 'debug', pretty: false });
});

test('environment over file over defaults, key by key', () => {
  const config = loadConfig({ file: configFile({ server: { port: 8080 }, log: { level: 'warn' } }), env: { APP_SERVER__HOST: '0.0.0.0', APP_LOG__LEVEL: 'error', PATH: 'x' } });
  assert.deepEqual(config.server, { host: '0.0.0.0', port: 8080 });
  assert.deepEqual(config.log, { level: 'error', pretty: false });
});

test('arrays are replaced, inputs are not modified', () => {
  const defaults = { features: ['a'], nested: { list: [1], keep: true } };
  const before = structuredClone(defaults);
  const config = loadConfig({ defaults, file: configFile({ nested: { list: [2] } }), env: { APP_FEATURES: '["b"]' } });
  assert.deepEqual(config, { features: ['b'], nested: { list: [2], keep: true } });
  assert.deepEqual(defaults, before);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 5));
