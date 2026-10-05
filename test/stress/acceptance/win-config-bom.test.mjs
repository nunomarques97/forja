// Hidden acceptance check: never copied into the scenario project.
// Files as Windows tools write them: UTF-8 with a BOM (Windows PowerShell
// Set-Content -Encoding UTF8) and UTF-16 LE with a BOM (Out-File), CRLF line
// endings. Negative case: broken JSON still fails, naming the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwnSuite, load } from './_helpers.mjs';

const { loadConfig } = await load('src/config.mjs');

const dir = mkdtempSync(join(tmpdir(), 'stress-bom-'));
const JSON_TEXT = '{\r\n  "server": { "port": 8080 },\r\n  "log": { "level": "debug" }\r\n}\r\n';
const write = (name, bytes) => {
  const file = join(dir, name);
  writeFileSync(file, bytes);
  return file;
};
const expectLoaded = file => {
  const config = loadConfig({ file });
  assert.deepEqual(config.server, { host: '127.0.0.1', port: 8080 });
  assert.deepEqual(config.log, { level: 'debug', pretty: false });
};

test('UTF-8 with a byte order mark loads', () => {
  expectLoaded(write('utf8-bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON_TEXT, 'utf8')])));
});

test('UTF-16 LE with a byte order mark loads', () => {
  expectLoaded(write('utf16le.json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON_TEXT, 'utf16le')])));
});

test('plain UTF-8 still loads, including non-ASCII text', () => {
  expectLoaded(write('plain.json', Buffer.from(JSON_TEXT, 'utf8')));
  const config = loadConfig({ file: write('accents.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{ "name": "Café Ñandú" }', 'utf8')])) });
  assert.equal(config.name, 'Café Ñandú');
});

test('a broken file still fails and the error names it', () => {
  for (const [name, bytes] of [['broken.json', Buffer.from('{ "server": ', 'utf8')], ['broken-bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{ nope }', 'utf8')])]]) {
    const file = write(name, bytes);
    assert.throws(() => loadConfig({ file }), error => error.message.includes(name), name);
  }
});

test("the project's own tests pass", () => assertOwnSuite(assert, 3));
