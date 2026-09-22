import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeJson } from '../lib/state-files.mjs';

const root = fs.mkdtempSync(join(tmpdir(), 'forja-state-atomic-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

for (const code of ['EBUSY', 'EIO']) test(`failed atomic replacement (${code}) preserves the previous complete state`, () => {
  const path = join(root, code + '.json');
  const previous = '{"pid":123,"run_id":"previous"}\n';
  fs.writeFileSync(path, previous);
  const rename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    if (to !== path) return rename(from, to);
    calls++;
    throw Object.assign(new Error('Injected replacement failure'), { code });
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => writeJson(path, { pid: 456, run_id: 'replacement' }), { code });
    assert.equal(fs.readFileSync(path, 'utf8'), previous);
    assert.equal(calls, code === 'EBUSY' ? 21 : 1, 'Only transient errors get bounded retries');
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
});

test('a transient replacement failure retries and eventually publishes complete state', () => {
  const path = join(root, 'transient.json');
  fs.writeFileSync(path, '{"version":1}\n');
  const rename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (from, to) => {
    if (to === path && ++calls <= 2) throw Object.assign(new Error('Temporarily busy'), { code: 'EBUSY' });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    writeJson(path, { version: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path)), { version: 2 });
    assert.equal(calls, 3);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
});
