import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRun, drive, recoverRun, current, CORE_FLAGS } from '../lib/core/engine.mjs';
import * as recovery from '../lib/core/recovery.mjs';

const { recoveryInfo } = recovery;

const cli = resolve('bin/forja.mjs');
const HINT = /Never print binary or base64 to the terminal; inspect images with the image read tool; keep command output short\./;
const reply = status => ({ code: 0, result: { status, summary: 'Outcome', findings: [] } });
const overflow = () => ({ code: 1, overflow: true });

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function repo(t) {
  const root = tempDir(t, 'forja-retry-');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}

const plan = { decisions: [], tasks: [{
  id: 'T1', title: 'Return two', criteria: ['value equals two'], files: ['value.mjs'], complexity: 'easy', risks: [], after: [],
  checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }],
}] };

// One implementation attempt only: a retry that spent an attempt would block
// with `attempts` instead of reaching review.
function fixture(t, config = {}, withPlan = true) {
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'custom', config: { maxAttempts: 1, maxRotations: 0, ...config }, plan: withPlan ? plan : null });
  return root;
}

const ledger = root => {
  const run = JSON.parse(readFileSync(current(root), 'utf8'));
  return readFileSync(join(root, '.forja', 'runs', run.run_id, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
};

test('a develop output-budget failure gets one fresh session for the same attempt and the run completes', async t => {
  const root = fixture(t);
  const calls = [];
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    calls.push(options);
    if (options.readOnly) return reply('approve');
    if (calls.length === 1) {
      writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
      return { ...overflow(), progressNotes: 'Edited value.mjs; only the checks remain.' };
    }
    // Work on disk and the progress notes of the failed session are kept.
    assert.match(readFileSync(join(root, 'value.mjs'), 'utf8'), /value = 2/);
    assert.equal(options.progressNotes, 'Edited value.mjs; only the checks remain.');
    return reply('ready_for_validation');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.deepEqual(calls.map(c => c.readOnly ? 'review' : 'develop'), ['develop', 'develop', 'review']);
  assert.doesNotMatch(calls[0].prompt, /Automatic fresh session/);
  assert.match(calls[1].prompt, /Automatic fresh session for the same implementation attempt/);
  assert.match(calls[1].prompt, HINT);
  assert.match(calls[1].prompt, /call-1\) ended on the provider output budget/);
  const task = done.tasks[0];
  assert.equal(task.attempts, 1);
  assert.equal(task.rotations, 0);
  assert.deepEqual(task.provider_retries, { attempt: 1, used: 1, total: 1, last: { reason: 'output', after_invocation: 1 } });
  assert.equal(done.invocations, 3);
  assert.equal(done.cloudInvocations, 3);
  const rows = ledger(root);
  assert.deepEqual(rows.map(r => [r.id, r.phase, r.result, r.automatic_retry ?? null]), [
    [1, 'develop', 'error', null],
    [2, 'develop', 'returned', { reason: 'output', after_invocation: 1 }],
    [3, 'review', 'returned', null],
  ]);
  assert.equal(rows[1].attempt, 1);
});

test('the retry hint keeps the earlier feedback of the attempt', async t => {
  const root = fixture(t, { maxAttempts: 2 });
  let develop = 0, review = 0, retryPrompt = null;
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    if (options.readOnly) return ++review === 1 ? { code: 0, result: { status: 'reject', summary: 'Handle the zero case', findings: ['value.mjs:1 misses zero'] } } : reply('approve');
    develop++;
    if (develop === 1) { writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n'); return reply('ready_for_validation'); }
    if (develop === 2) return overflow();
    retryPrompt = options.prompt;
    return reply('ready_for_validation');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.match(retryPrompt, HINT);
  assert.match(retryPrompt, /Earlier feedback of this attempt: Handle the zero case/);
  assert.match(retryPrompt, /value\.mjs:1 misses zero/);
  assert.equal(done.tasks[0].attempts, 2);
  assert.deepEqual(done.tasks[0].provider_retries, { attempt: 2, used: 1, total: 1, last: { reason: 'output', after_invocation: 3 } });
});

test('a second output-budget failure in the same attempt blocks with the output code', async t => {
  const root = fixture(t);
  let calls = 0;
  const blocked = await drive(root, { log: () => {}, providerCall: async () => { calls++; return overflow(); } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stopCode, 'output');
  assert.equal(calls, 2);
  assert.equal(blocked.invocations, 2);
  assert.equal(blocked.tasks[0].attempts, 1);
  assert.equal(blocked.tasks[0].status, 'develop');
  assert.equal(blocked.tasks[0].provider_retries.total, 1);
  assert.match(blocked.failure, /^Provider develop failed \(output budget\); see call-2-stream\.json\. The automatic retry of implementation attempt 1 of T1 was already used\.$/);
  assert.equal(recoveryInfo(blocked).code, 'output');
  assert.match(recoveryInfo(blocked).guidance, /providerRetries/);
  assert.deepEqual(ledger(root).map(r => r.automatic_retry ?? null), [null, { reason: 'output', after_invocation: 1 }]);
});

test('providerRetries 0 blocks on the first output-budget failure', async t => {
  const root = fixture(t, { providerRetries: '0' });
  let calls = 0;
  const blocked = await drive(root, { log: () => {}, providerCall: async () => { calls++; return overflow(); } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stopCode, 'output');
  assert.equal(calls, 1);
  assert.equal(blocked.limits.providerRetries, 0);
  assert.equal(blocked.tasks[0].attempts, 1);
  assert.equal(blocked.tasks[0].provider_retries, undefined);
  assert.match(blocked.failure, /Automatic provider retries are disabled \(providerRetries 0\)\./);
});

test('plan and review output-budget failures are not retried', async t => {
  const planned = fixture(t, {}, false);
  let calls = 0;
  const planStop = await drive(planned, { log: () => {}, providerCall: async () => { calls++; return overflow(); } });
  assert.equal(planStop.stopCode, 'output');
  assert.equal(calls, 1);
  assert.match(planStop.failure, /No automatic retry of plan provider failures\./);

  const reviewed = fixture(t);
  const phases = [];
  const reviewStop = await drive(reviewed, { log: () => {}, providerCall: async (_, options) => {
    phases.push(options.readOnly ? 'review' : 'develop');
    if (options.readOnly) return overflow();
    writeFileSync(join(reviewed, 'value.mjs'), 'export const value = 2;\n');
    return reply('ready_for_validation');
  } });
  assert.equal(reviewStop.stopCode, 'output');
  assert.deepEqual(phases, ['develop', 'review']);
  assert.match(reviewStop.failure, /No automatic retry of review provider failures\./);
  assert.equal(reviewStop.tasks[0].provider_retries, undefined);
});

test('the automatic retry counts against the session budget and blocks as before when it is exhausted', async t => {
  const root = fixture(t, { maxSessions: 1 });
  let calls = 0;
  const blocked = await drive(root, { log: () => {}, providerCall: async () => { calls++; return overflow(); } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stopCode, 'sessions');
  assert.equal(calls, 1);
  assert.equal(blocked.invocations, 1);
  assert.equal(blocked.tasks[0].attempts, 1);
  assert.match(blocked.failure, /The automatic retry after call-1 did not start\./);

  const cloud = fixture(t, { maxCloudSessions: 1 });
  const cloudStop = await drive(cloud, { log: () => {}, providerCall: async () => overflow() });
  assert.equal(cloudStop.stopCode, 'cloud_sessions');
  assert.equal(cloudStop.invocations, 1);
});

test('providerRetries is bounded, raise-only on recovery and readable from older runs', async t => {
  const root = repo(t);
  assert.throws(() => createRun(root, { goal: 'Return two', provider: 'custom', config: { providerRetries: 2 }, plan }), /0\.\.1/);
  assert.equal(existsSync(current(root)), false);
  for (const command of ['start', 'resume', 'retry', 'abandon']) assert.ok(CORE_FLAGS[command].includes('provider-retries'), command);
  assert.equal(createRun(root, { goal: 'Return two', provider: 'custom', config: { providerRetries: '0' }, plan }).limits.providerRetries, 0);
  assert.throws(() => recoverRun(root, { reason: 'Too many', limits: { providerRetries: 2 } }), /0\.\.1/);
  recoverRun(root, { reason: 'Allow the automatic retry', limits: { providerRetries: 1 } });
  assert.throws(() => recoverRun(root, { reason: 'Lower', limits: { providerRetries: 0 } }), /only raise/);
  // A run created before the setting existed defaults to one retry.
  const state = JSON.parse(readFileSync(current(root), 'utf8'));
  delete state.limits.providerRetries;
  writeFileSync(current(root), JSON.stringify(state));
  const { providerRetryDecision } = recovery;
  assert.equal(typeof providerRetryDecision, 'function');
  assert.equal(providerRetryDecision(state, { id: 'T1', attempts: 1 }, 'develop', 'output').retry, true);
  assert.equal(providerRetryDecision(state, { id: 'T1', attempts: 1 }, 'develop', 'provider').retry, false);
});

function forja(t, cwd, args) {
  const data = tempDir(t, 'forja-retry-data-');
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('core status shows providerRetries and the automatic retries of each task', async t => {
  const root = fixture(t);
  await drive(root, { log: () => {}, providerCall: async () => overflow() });
  const status = forja(t, root, ['core', 'status', '--project', root]);
  assert.equal(status.code, 0, status.err);
  const report = JSON.parse(status.out);
  assert.equal(report.limits.providerRetries, 1);
  assert.equal(report.tasks[0].provider_retries, 1);
  assert.equal(report.recovery.code, 'output');

  const legacy = fixture(t);
  const state = JSON.parse(readFileSync(current(legacy), 'utf8'));
  delete state.limits.providerRetries;
  writeFileSync(current(legacy), JSON.stringify(state));
  const old = JSON.parse(forja(t, legacy, ['core', 'status', '--project', legacy]).out);
  assert.equal(old.limits.providerRetries, 1);
  assert.equal(old.tasks[0].provider_retries, 0);
});

test('start refuses a --provider-retries value outside 0..1 before writing run state', t => {
  const root = repo(t);
  const r = forja(t, root, ['start', '--goal', 'Return two', '--provider', 'custom', '--provider-retries', '2', '--project', root]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /0\.\.1/);
  assert.equal(existsSync(current(root)), false);
  const missing = forja(t, root, ['start', '--goal', 'Return two', '--provider', 'custom', '--provider-retries', '--project', root]);
  assert.notEqual(missing.code, 0);
  assert.equal(existsSync(current(root)), false);
});
