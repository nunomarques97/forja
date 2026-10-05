import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeText, readConfigFile } from '../src/config.mjs';

test('reads the encodings Windows tools write', () => {
  const text = '{"a":1}';
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])), text);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])), text);
  const file = join(mkdtempSync(join(tmpdir(), 'confload-')), 'bad.json');
  writeFileSync(file, '{');
  assert.throws(() => readConfigFile(file), /bad\.json/);
});
