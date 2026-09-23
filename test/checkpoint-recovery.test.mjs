import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRun, drive, recoverRun, current } from '../lib/core/engine.mjs';

const result = status => ({ code: 0, result: { status, summary: 'Continue preserved work', findings: [] } });
function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forja-checkpoint-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  createRun(root, { goal: 'Return two', provider: 'custom', config: { maxAttempts: 1, maxRotations: 0, ...config }, plan: { decisions: [], tasks: [{
    id: 'T1', title: 'Return two', criteria: ['value equals two'], files: ['value.mjs'], complexity: 'easy', risks: [], after: [],
    checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }],
  }] } });
  return root;
}

for (const forced of [false, true]) test(`exhausted checkpoint can resume after raising only rotations (forced=${forced})`, async t => {
  const root = fixture(t);
  const blocked = await drive(root, { log: () => {}, providerCall: async () => {
    writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return forced ? { code: 1, contextExceeded: true, lastContextTokens: 120001 } : result('checkpoint');
  } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.tasks[0].attempts, 0);
  assert.equal(blocked.tasks[0].rotations, 1);
  let unexpected = 0;
  const still = await drive(root, { log: () => {}, providerCall: async () => { unexpected++; return result('done'); } });
  assert.equal(still.status, 'blocked');
  assert.equal(unexpected, 0);
  assert.equal(still.invocations, 1);
  recoverRun(root, { reason: 'Allow one continuation', limits: { rotations: 1 } });
  const phases = [];
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    phases.push(options.readOnly ? 'review' : 'develop');
    assert.match(readFileSync(join(root, 'value.mjs'), 'utf8'), /value = 2/);
    return result(options.readOnly ? 'approve' : 'ready_for_validation');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.deepEqual(phases, ['develop', 'review']);
  assert.equal(done.tasks[0].attempts, 1);
  assert.equal(done.tasks[0].rotations, 1);
  assert.equal(done.tasks[0].validation[0].passed, true);
});

test('a session budget refusal before launch does not consume an implementation attempt', async t => {
  const root = fixture(t, { maxSessions: 1, maxRotations: 2 });
  const blocked = await drive(root, { log: () => {}, providerCall: async () => result('checkpoint') });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.invocations, 1);
  assert.equal(blocked.tasks[0].attempts, 0);
  recoverRun(root, { reason: 'Allow continuation and review', limits: { sessions: 3 } });
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    if (!options.readOnly) writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return result(options.readOnly ? 'approve' : 'ready_for_validation');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.equal(done.tasks[0].attempts, 1);
});

test('timeout preserves edits and explicit validate-only recovery still requires checks and review', async t => {
  const root = fixture(t);
  const blocked = await drive(root, { log: () => {}, providerCall: async () => {
    writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return { code: 1, timedOut: true };
  } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stopCode, 'timeout');
  assert.equal(blocked.tasks[0].attempts, 1);
  const original = readFileSync(join(root, 'value.mjs'), 'utf8');
  recoverRun(root, { action: 'retry', taskId: 'T1', validateOnly: true, reason: 'Inspect and validate preserved implementation' });
  const phases = [];
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    phases.push(options.readOnly ? 'review' : 'develop');
    return result('approve');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.deepEqual(phases, ['review']);
  assert.equal(done.tasks[0].validation[0].passed, true);
  assert.equal(readFileSync(join(root, 'value.mjs'), 'utf8'), original);
  assert.equal(JSON.parse(readFileSync(current(root))).tasks[0].attempts, 1);
});

test('explicit provider quota rejection blocks even with a successful exit code', async t => {
  const root = fixture(t);
  let calls = 0;
  const blocked = await drive(root, { log: () => {}, providerCall: async () => {
    calls++;
    return { ...result('ready_for_validation'), rate_limited: true };
  } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stopCode, 'provider_limit');
  assert.equal(calls, 1);
});

test('cloud limit can be raised explicitly without modifying provider routes or losing attempts', async t => {
  const root = fixture(t, { maxCloudSessions: 0 });
  let calls = 0;
  const blocked = await drive(root, { log: () => {}, providerCall: async () => { calls++; return result('done'); } });
  assert.equal(blocked.stopCode, 'cloud_sessions');
  assert.equal(blocked.tasks[0].attempts, 0);
  assert.equal(calls, 0);
  recoverRun(root, { reason: 'Allow development and review', limits: { cloudSessions: 2 } });
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    if (!options.readOnly) writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return result(options.readOnly ? 'approve' : 'ready_for_validation');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.equal(done.config.maxCloudSessions, 2);
  assert.equal(done.cloudInvocations, 2);
  assert.equal(done.stopCode, undefined);
});

for (const point of ['receipt', 'result']) test(`checkpoint survives controller death at ${point} without double accounting`, async t => {
  const root = fixture(t, { maxRotations: 1 });
  const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.renameSync;fs.renameSync=function(from,to,...args){const r=original.call(this,from,to,...args);if(${JSON.stringify(point)}==='receipt'&&String(to).endsWith('current.json')&&JSON.parse(fs.readFileSync(to)).developmentReceipt)process.exit(77);if(${JSON.stringify(point)}==='result'&&String(to).endsWith('call-1-result.json'))queueMicrotask(()=>process.exit(77));return r;};syncBuiltinESMExports();
const {drive}=await import(${JSON.stringify(pathToFileURL(resolve('lib/core/engine.mjs')).href)});
await drive(${JSON.stringify(root)},{log:()=>{},providerCall:async()=>{fs.writeFileSync(${JSON.stringify(join(root,'value.mjs'))},'export const value = 2;\\n');return ${JSON.stringify(result('checkpoint'))};}});process.exit(78);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(child.status, 77, child.stderr);
  assert.equal(JSON.parse(readFileSync(current(root))).developmentReceipt.result.status, 'checkpoint');
  const phases = [];
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    phases.push(options.readOnly ? 'review' : 'develop');
    assert.match(readFileSync(join(root, 'value.mjs'), 'utf8'), /value = 2/);
    return result(options.readOnly ? 'approve' : 'ready_for_validation');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.deepEqual(phases, ['develop', 'review']);
  assert.equal(done.tasks[0].rotations, 1);
  assert.equal(done.tasks[0].attempts, 1);
  assert.equal(done.invocations, 3);
});
