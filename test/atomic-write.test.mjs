// #29: on Windows a concurrent reader (guard, up, viewer, forja-office) makes
// the rename over a Core state file fail briefly with EPERM/EBUSY. Every Core
// writer must retry like the legacy state files instead of stopping the
// controller, and must never leave a tmp file or a truncated target behind.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomic, RENAME_RETRIES } from '../lib/atomic-write.mjs';
import { write } from '../lib/core/engine.mjs';
import { repoMap } from '../lib/core/context.mjs';
import { requestStop, stopRequestPath } from '../lib/core/stop.mjs';
import { writeJson } from '../lib/state-files.mjs';

const root = fs.mkdtempSync(join(tmpdir(), 'forja-atomic-write-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// Replaces fs.renameSync for renames onto target: fail(n) returns the error
// code for the nth attempt, or null to let the real rename run.
function failRenames(target, fail) {
  const rename = fs.renameSync;
  const state = { calls: 0 };
  fs.renameSync = (from, to) => {
    if (to !== target) return rename(from, to);
    const code = fail(++state.calls);
    if (code) throw Object.assign(new Error(`Injected rename failure ${code}`), { code });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  state.restore = () => { fs.renameSync = rename; syncBuiltinESMExports(); };
  return state;
}
const tmpLeft = dir => fs.readdirSync(dir).filter(n => n.endsWith('.tmp'));

let n = 0;
function project() {
  const dir = join(root, `p${++n}`);
  fs.mkdirSync(join(dir, '.forja'), { recursive: true });
  return dir;
}

// Each Core writer: a function that replaces target with new content.
const writers = {
  'shared helper': dir => {
    const target = join(dir, '.forja', 'file.json');
    return { target, run: () => writeFileAtomic(target, '{"version":2}\n') };
  },
  'engine write()': dir => {
    const target = join(dir, '.forja', 'current.json');
    return { target, run: () => write(target, { version: 2 }) };
  },
  'repository index writer': dir => {
    fs.writeFileSync(join(dir, '.gitignore'), '.forja/\n');
    fs.writeFileSync(join(dir, 'a.mjs'), 'export const value = 2;\n');
    execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
    const target = join(dir, '.forja', 'index.json');
    return { target, run: () => repoMap(dir, 'value') };
  },
  'stop request writer': dir => {
    fs.writeFileSync(join(dir, '.forja', 'current.json'), JSON.stringify({ run_id: 'F-1', status: 'running', tasks: [] }));
    const target = stopRequestPath(dir);
    return { target, run: () => requestStop(dir, { controllerAlive: () => true }) };
  },
};

for (const [name, setup] of Object.entries(writers)) {
  for (const code of ['EPERM', 'EBUSY']) test(`${name}: transient ${code} rename is retried and publishes the new content`, () => {
    const dir = project();
    const { target, run } = setup(dir);
    fs.writeFileSync(target, '{"version":1}\n');
    const renames = failRenames(target, i => (i <= 3 ? code : null));
    try { run(); } finally { renames.restore(); }
    assert.equal(renames.calls, 4);
    assert.notEqual(fs.readFileSync(target, 'utf8'), '{"version":1}\n');
    JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.deepEqual(tmpLeft(join(dir, '.forja')), []);
  });

  test(`${name}: a permanent EBUSY rethrows, keeps the previous file and removes the tmp`, () => {
    const dir = project();
    const { target, run } = setup(dir);
    const previous = '{"version":1,"complete":true}\n';
    fs.writeFileSync(target, previous);
    const renames = failRenames(target, () => 'EBUSY');
    try { assert.throws(run, { code: 'EBUSY' }); } finally { renames.restore(); }
    assert.equal(renames.calls, RENAME_RETRIES + 1, 'bounded retries');
    assert.equal(fs.readFileSync(target, 'utf8'), previous);
    assert.deepEqual(tmpLeft(join(dir, '.forja')), []);
  });

  test(`${name}: a non-retryable rename error is rethrown without retry`, () => {
    const dir = project();
    const { target, run } = setup(dir);
    const previous = '{"version":1}\n';
    fs.writeFileSync(target, previous);
    const renames = failRenames(target, () => 'EIO');
    try { assert.throws(run, { code: 'EIO' }); } finally { renames.restore(); }
    assert.equal(renames.calls, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), previous);
    assert.deepEqual(tmpLeft(join(dir, '.forja')), []);
  });
}

test('the shared helper gives each call a unique tmp created with wx', () => {
  const dir = project();
  const target = join(dir, '.forja', 'unique.json');
  const seen = [];
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { seen.push(from); return rename(from, to); };
  syncBuiltinESMExports();
  try { writeFileAtomic(target, 'a'); writeFileAtomic(target, 'b'); } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.ok(seen.every(p => p.startsWith(`${target}.${process.pid}.`) && p.endsWith('.tmp')));
  assert.equal(fs.readFileSync(target, 'utf8'), 'b');
  // An explicit tmp (the legacy per-process name) may replace a stale one.
  const explicit = `${target}.fixed.tmp`;
  fs.writeFileSync(explicit, 'stale');
  writeFileAtomic(target, 'c', { tmp: explicit });
  assert.equal(fs.readFileSync(target, 'utf8'), 'c');
  assert.equal(fs.existsSync(explicit), false);
});

test('legacy writeJson uses the same shared retry', () => {
  const dir = project();
  const target = join(dir, 'RUN.json');
  fs.writeFileSync(target, '{"version":1}\n');
  const renames = failRenames(target, i => (i <= 2 ? 'EACCES' : null));
  try { writeJson(target, { version: 2 }); } finally { renames.restore(); }
  assert.equal(renames.calls, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 2 });
  assert.deepEqual(tmpLeft(dir), []);
});
