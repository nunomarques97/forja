import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRun, drive, current, recoverRun, validateState } from '../lib/core/engine.mjs';
import { execute } from '../lib/core/providers.mjs';

const dirs = [];
after(() => {
  for (const dir of dirs) {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});
const oracle = "import { value } from './value.mjs'; if (value !== 2) process.exit(1);\n";
function repo({ ignored = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forja-protected-'));
  dirs.push(root);
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'acceptance.mjs'), oracle);
  writeFileSync(join(root, '.gitignore'), '.forja/\n' + (ignored ? 'acceptance.mjs\n' : ''));
  for (const args of [
    ['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'],
    ['add', '--', 'value.mjs', '.gitignore', ...(ignored ? [] : ['acceptance.mjs'])], ['commit', '-qm', 'Fixture'],
  ]) assert.equal(spawnSync('git', args, { cwd: root, windowsHide: true }).status, 0);
  return root;
}
const task = () => ({ id: 'T1', title: 'Return two', criteria: ['value equals 2'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [], checks: [{ command: 'node', args: ['acceptance.mjs'] }] });
function start(root, config = {}, plan = { decisions: [], tasks: [task()] }) {
  return createRun(root, { goal: 'Return two without changing the supplied oracle', provider: 'custom', plan, config: { protectedFiles: ['acceptance.mjs'], ...config } });
}
const response = (status = 'ready_for_validation') => ({ code: 0, result: { status, summary: 'Fixture response', findings: [] } });
const driveOptions = { log: () => {} };

test('weakening the supplied oracle cannot turn an incorrect implementation into a pass', async () => {
  const root = repo(); start(root);
  let calls = 0, checks = 0;
  const run = await drive(root, { ...driveOptions, providerCall: async (_, options) => {
    calls++;
    if (!options.readOnly) writeFileSync(join(root, 'acceptance.mjs'), 'process.exit(0);\n');
    return response(options.readOnly ? 'approve' : 'ready_for_validation');
  }, runCheck: async (command, args, options) => { checks++; return execute(command, args, options); } });
  assert.equal(run.status, 'blocked');
  assert.match(run.failure, /Protected file.*acceptance\.mjs/);
  assert.equal(calls, 1); assert.equal(checks, 0);
  assert.equal(readFileSync(join(root, 'acceptance.mjs'), 'utf8'), 'process.exit(0);\n');
  assert.match(readFileSync(join(root, 'value.mjs'), 'utf8'), /value = 1/);
});

test('unchanged protected checks allow real implementation, extra tests and ordinary independent review', async () => {
  const root = repo(); const initial = start(root); let calls = 0;
  const run = await drive(root, { ...driveOptions, providerCall: async (_, options) => {
    calls++;
    const ctx = JSON.parse(options.text);
    assert.deepEqual(ctx.protected_files, ['acceptance.mjs']);
    assert.match(options.prompt, /protected_files.*must not be changed/);
    if (!options.readOnly) {
      writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
      writeFileSync(join(root, 'extra.test.mjs'), '// Additional worker-owned tests are allowed.\n');
    }
    return response(options.readOnly ? 'approve' : 'ready_for_validation');
  } });
  assert.equal(run.status, 'done'); assert.equal(calls, 2);
  assert.deepEqual(run.protectedFiles, initial.protectedFiles);
  assert.equal(readFileSync(join(root, 'acceptance.mjs'), 'utf8'), oracle);
});

test('changes made between start and drive block before any provider or check and can be abandoned', async () => {
  const root = repo(); const initial = start(root);
  writeFileSync(join(root, 'acceptance.mjs'), '// Changed externally.\n');
  const opts = { ...driveOptions, providerCall: async () => { assert.fail('No provider'); }, runCheck: async () => { assert.fail('No check'); } };
  const blocked = await drive(root, opts);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.invocations, 0);
  assert.deepEqual(blocked.protectedFiles, initial.protectedFiles);
  recoverRun(root, { action: 'resume', reason: 'Do not accept a changed baseline' });
  assert.equal((await drive(root, opts)).status, 'blocked');
  assert.equal(recoverRun(root, { action: 'abandon', reason: 'Preserve edits for inspection' }).status, 'failed');
});

for (const outcome of ['checkpoint', 'failure', 'delete']) test(`protected ignored files remain guarded after developer ${outcome}`, async () => {
  const root = repo({ ignored: true }); start(root); let calls = 0;
  const run = await drive(root, { ...driveOptions, providerCall: async () => {
    calls++;
    if (outcome === 'delete') unlinkSync(join(root, 'acceptance.mjs'));
    else writeFileSync(join(root, 'acceptance.mjs'), '// changed\n');
    return outcome === 'failure' ? { code: 1, timedOut: true } : response(outcome === 'checkpoint' ? 'checkpoint' : 'ready_for_validation');
  } });
  assert.equal(run.status, 'blocked'); assert.match(run.failure, /Protected file/); assert.equal(calls, 1);
  assert.equal(run.tasks[0].rotations, 0);
  assert.equal(existsSync(join(root, 'acceptance.mjs')), outcome !== 'delete');
});

test('validation cannot mutate an ignored protected file and hide it with a later command', async () => {
  const root = repo({ ignored: true }); const plan = { decisions: [], tasks: [{ ...task(), checks: [{ command: 'node', args: ['one'] }, { command: 'node', args: ['two'] }] }] };
  start(root, {}, plan); let checks = 0, calls = 0;
  const run = await drive(root, { ...driveOptions, providerCall: async () => { calls++; return response(); }, runCheck: async () => {
    checks++; writeFileSync(join(root, 'acceptance.mjs'), checks === 1 ? '// changed\n' : oracle); return { code: 0, stdout: '', stderr: '' };
  } });
  assert.equal(run.status, 'blocked'); assert.match(run.failure, /Protected file/);
  assert.equal(checks, 1); assert.equal(calls, 1);
  assert.equal(run.tasks[0].validation[0].passed, false);
  assert.equal(readFileSync(join(root, 'acceptance.mjs'), 'utf8'), '// changed\n');
});

test('review cannot approve after mutating an ignored protected file', async () => {
  const root = repo({ ignored: true }); start(root); let calls = 0;
  const run = await drive(root, { ...driveOptions, providerCall: async (_, options) => {
    calls++;
    if (options.readOnly) writeFileSync(join(root, 'acceptance.mjs'), '// changed during review\n');
    else writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return response(options.readOnly ? 'approve' : 'ready_for_validation');
  } });
  assert.equal(run.status, 'blocked'); assert.match(run.failure, /Protected file/); assert.equal(calls, 2);
});

test('final regression checks also preserve protected files after later tasks', async () => {
  const root = repo({ ignored: true });
  const second = { ...task(), id: 'T2', title: 'Add another file', files: ['extra.mjs'], after: ['T1'] };
  start(root, {}, { decisions: [], tasks: [task(), second] }); let calls = 0, checks = 0;
  const run = await drive(root, { ...driveOptions, providerCall: async (_, options) => {
    calls++;
    if (!options.readOnly) {
      if (JSON.parse(options.text).task.id === 'T1') writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
      else writeFileSync(join(root, 'extra.mjs'), 'export const extra = true;\n');
    }
    return response(options.readOnly ? 'approve' : 'ready_for_validation');
  }, runCheck: async () => {
    if (++checks === 3) writeFileSync(join(root, 'acceptance.mjs'), '// final check changed the oracle\n');
    return { code: 0, stdout: '', stderr: '' };
  } });
  assert.equal(run.status, 'blocked'); assert.match(run.failure, /Protected file/);
  assert.equal(checks, 3); assert.equal(calls, 4);
});

test('protected files have bounded individual and total read sizes', () => {
  for (const sizes of [[8 * 1024 * 1024 + 1], [8 * 1024 * 1024, 8 * 1024 * 1024, 1]]) {
    const root = repo(), paths = sizes.map((size, i) => {
      const name = `data-${i}.bin`; writeFileSync(join(root, name), Buffer.alloc(size)); return name;
    });
    assert.throws(() => start(root, { allowDirty: true, protectedFiles: paths }), /Protected file/);
    assert.equal(existsSync(current(root)), false);
  }
});

test('invalid protected file declarations fail before creating run state', () => {
  for (const paths of ['acceptance.mjs', [1], Array(1), [''], ['../outside'], ['C:/outside'], ['/absolute'], ['.forja/state.json'], ['.git/config'], ['.git./config'], ['.forja /state.json'], ['acceptance.mjs '], ['acceptance.mjs', 'ACCEPTANCE.mjs'], ['missing.mjs'], ['folder'], Array(101).fill('acceptance.mjs')]) {
    const root = repo(); mkdirSync(join(root, 'folder'));
    assert.throws(() => start(root, { protectedFiles: paths }), /protected|Protected/i);
    assert.equal(existsSync(current(root)), false);
  }
});

test('protected file manifests cannot be dropped or retargeted during resume', () => {
  const root = repo(); const run = start(root);
  for (const change of [
    r => { delete r.protectedFiles; }, r => { delete r.protectedFilesPolicy; },
    r => { r.protectedFiles[0].sha256 = 'invalid'; }, r => { r.protectedFiles[0].path = 'value.mjs'; },
    r => { r.config.protectedFiles = []; }, r => { r.protectedFilesPolicy = 2; },
  ]) { const broken = structuredClone(run); change(broken); assert.throws(() => validateState(broken, root), /protected|Protected/i); }
});

test('existing symlinks and later symlink substitution are refused', async t => {
  const root = repo(); const link = join(root, 'alias.mjs');
  try { symlinkSync(join(root, 'acceptance.mjs'), link); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Symlink permission unavailable'); return; } throw error; }
  assert.throws(() => start(root, { allowDirty: true, protectedFiles: ['alias.mjs'] }), /protected|Protected/i);
  unlinkSync(link); start(root);
  const run = await drive(root, { ...driveOptions, providerCall: async () => {
    unlinkSync(join(root, 'acceptance.mjs')); symlinkSync(join(root, 'value.mjs'), join(root, 'acceptance.mjs')); return response();
  } });
  assert.equal(run.status, 'blocked'); assert.match(run.failure, /Protected file/);
});

test('legacy runs without protected files keep their existing configuration and packet', async () => {
  const root = repo(); const run = start(root, { protectedFiles: undefined });
  assert.equal(run.protectedFilesPolicy, undefined);
  assert.equal(run.protectedFiles, undefined);
  const done = await drive(root, { ...driveOptions, providerCall: async (_, options) => {
    assert.equal(JSON.parse(options.text).protected_files, undefined);
    if (!options.readOnly) writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return response(options.readOnly ? 'approve' : 'ready_for_validation');
  } });
  assert.equal(done.status, 'done');
});
