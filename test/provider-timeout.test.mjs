import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRun, drive, recoverRun, current } from '../lib/core/engine.mjs';
import { recoveryInfo } from '../lib/core/recovery.mjs';

const cli = resolve('bin/forja.mjs');
const reply = status => ({ code: 0, result: { status, summary: 'Outcome', findings: [] } });
const timeout = () => ({ code: 1, timedOut: true });
const overflow = () => ({ code: 1, overflow: true });

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function repo(t) {
  const root = tempDir(t, 'forja-timeout-');
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
  createRun(root, { goal: 'Return two', provider: 'custom', config: { maxAttempts: 1, maxRotations: 0, maxMinutes: 30, ...config }, plan: withPlan ? plan : null });
  return root;
}

const ledger = root => {
  const run = JSON.parse(readFileSync(current(root), 'utf8'));
  return readFileSync(join(root, '.forja', 'runs', run.run_id, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
};

test('a develop timeout gets one fresh session for the same attempt that names the minutes, and the run completes', async t => {
  const root = fixture(t);
  const calls = [];
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    calls.push(options);
    if (options.readOnly) return reply('approve');
    if (calls.length === 1) {
      writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
      return { ...timeout(), progressNotes: 'Edited value.mjs; only the checks remain.' };
    }
    // Work on disk and the progress notes of the timed-out session are kept.
    assert.match(readFileSync(join(root, 'value.mjs'), 'utf8'), /value = 2/);
    assert.equal(options.progressNotes, 'Edited value.mjs; only the checks remain.');
    return reply('ready_for_validation');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.deepEqual(calls.map(c => c.readOnly ? 'review' : 'develop'), ['develop', 'develop', 'review']);
  assert.equal(calls[0].timeoutMs, 30 * 60000);
  assert.match(calls[1].prompt, /Automatic fresh session for the same implementation attempt/);
  assert.match(calls[1].prompt, /call-1\) reached the per-call provider timeout of 30 minutes\./);
  assert.doesNotMatch(calls[1].prompt, /ended on the provider output budget/);
  const task = done.tasks[0];
  assert.equal(task.attempts, 1);
  assert.deepEqual(task.provider_retries, { attempt: 1, used: 1, total: 1, last: { reason: 'timeout', after_invocation: 1, minutes: 30 } });
  assert.deepEqual(done.lastProviderTimeout, { phase: 'develop', task: 'T1', invocation: 1, minutes: 30, run_minutes: 30, route: 'default', route_minutes: null });
  const rows = ledger(root);
  assert.deepEqual(rows.map(r => [r.id, r.phase, r.result, r.timed_out, r.automatic_retry ?? null]), [
    [1, 'develop', 'error', true, null],
    [2, 'develop', 'returned', false, { reason: 'timeout', after_invocation: 1, minutes: 30 }],
    [3, 'review', 'returned', false, null],
  ]);
});

test('a second timeout in the same attempt blocks with the timeout code and the minutes reached', async t => {
  const root = fixture(t);
  let calls = 0;
  const blocked = await drive(root, { log: () => {}, providerCall: async () => { calls++; return timeout(); } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stopCode, 'timeout');
  assert.equal(calls, 2);
  assert.equal(blocked.tasks[0].attempts, 1);
  assert.equal(blocked.tasks[0].status, 'develop');
  assert.equal(blocked.failure,
    'Provider develop failed (timeout after 30 minutes per call); see call-2-stream.json. The automatic retry of implementation attempt 1 of T1 was already used.' +
    ' Per-call provider timeout reached: 30 minutes (develop T1 call-2). Raise it with core resume --max-minutes N (N from 31 to 180; now 30).' +
    ' T1 has used 1 of 1 implementation attempts, so add --max-attempts 2 to the same resume.');
  const info = recoveryInfo(blocked);
  assert.equal(info.code, 'timeout');
  assert.equal(info.minutes_per_call, 30);
  assert.match(info.guidance, /providerRetries/);
  assert.match(info.guidance, /Per-call provider timeout reached: 30 minutes \(develop T1 call-2\)\. Raise it with core resume --max-minutes N \(N from 31 to 180; now 30\)\. T1 has used 1 of 1 implementation attempts, so add --max-attempts 2 to the same resume\.$/);

  // Raising the limit on resume continues the same attempt with the new limit.
  recoverRun(root, { reason: 'Long suite', limits: { minutes: 60, attempts: 2 } });
  const seen = [];
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    seen.push(options.timeoutMs);
    if (options.readOnly) return reply('approve');
    writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return reply('ready_for_validation');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.deepEqual(seen, [60 * 60000, 60 * 60000]);
  assert.equal(done.tasks[0].attempts, 2);
});

test('an output-budget failure and then a timeout in one attempt block: one automatic retry in total', async t => {
  const root = fixture(t);
  let calls = 0;
  const blocked = await drive(root, { log: () => {}, providerCall: async () => ++calls === 1 ? overflow() : timeout() });
  assert.equal(calls, 2);
  assert.equal(blocked.stopCode, 'timeout');
  assert.equal(blocked.tasks[0].attempts, 1);
  assert.deepEqual(blocked.tasks[0].provider_retries, { attempt: 1, used: 1, total: 1, last: { reason: 'output', after_invocation: 1 } });
  assert.match(blocked.failure, /timeout after 30 minutes per call.*The automatic retry of implementation attempt 1 of T1 was already used\./);

  // And the other way round: a timeout first, then an overflow.
  const other = fixture(t);
  let n = 0;
  const stopped = await drive(other, { log: () => {}, providerCall: async () => ++n === 1 ? timeout() : overflow() });
  assert.equal(n, 2);
  assert.equal(stopped.stopCode, 'output');
  assert.match(stopped.failure, /already used/);
});

test('providerRetries 0, plan and review timeouts block on the first timeout with the minutes', async t => {
  const disabled = fixture(t, { providerRetries: '0' });
  let calls = 0;
  const off = await drive(disabled, { log: () => {}, providerCall: async () => { calls++; return timeout(); } });
  assert.equal(calls, 1);
  assert.equal(off.stopCode, 'timeout');
  assert.match(off.failure, /Automatic provider retries are disabled \(providerRetries 0\)\. Per-call provider timeout reached: 30 minutes \(develop T1 call-1\)\./);
  assert.equal(off.tasks[0].provider_retries, undefined);

  const planned = fixture(t, { maxMinutes: 180 }, false);
  const planStop = await drive(planned, { log: () => {}, providerCall: async () => timeout() });
  assert.equal(planStop.stopCode, 'timeout');
  assert.match(planStop.failure, /^Provider plan failed \(timeout after 180 minutes per call\); see call-1-stream\.json\. No automatic retry of plan provider failures\. Per-call provider timeout reached: 180 minutes \(plan call-1\)\. The run limit is already the maximum of 180 minutes/);
  assert.equal(recoveryInfo(planStop).code, 'timeout');

  const reviewed = fixture(t);
  const phases = [];
  const reviewStop = await drive(reviewed, { log: () => {}, providerCall: async (_, options) => {
    phases.push(options.readOnly ? 'review' : 'develop');
    if (options.readOnly) return timeout();
    writeFileSync(join(reviewed, 'value.mjs'), 'export const value = 2;\n');
    return reply('ready_for_validation');
  } });
  assert.deepEqual(phases, ['develop', 'review']);
  assert.equal(reviewStop.stopCode, 'timeout');
  assert.match(reviewStop.failure, /No automatic retry of review provider failures\. Per-call provider timeout reached: 30 minutes \(review T1 call-2\)\./);
});

test('a route maxMinutes below the run limit is named, because --max-minutes cannot raise it', async t => {
  const root = fixture(t, { routes: { develop: { provider: 'custom', maxMinutes: 5 } } });
  const limits = [];
  const blocked = await drive(root, { log: () => {}, providerCall: async (_, options) => { limits.push(options.timeoutMs); return timeout(); } });
  assert.deepEqual(limits, [5 * 60000, 5 * 60000]);
  assert.equal(blocked.stopCode, 'timeout');
  assert.match(blocked.failure, /timeout after 5 minutes per call/);
  assert.match(blocked.failure, /Per-call provider timeout reached: 5 minutes \(develop T1 call-2\)\. Route develop sets maxMinutes 5, below the run limit of 30; --max-minutes does not raise a route limit, which is fixed for this run\. T1 has used 1 of 1 implementation attempts/);
  assert.doesNotMatch(blocked.failure, /N from 31/);
  assert.match(recoveryInfo(blocked).guidance, /Route develop sets maxMinutes 5/);
  assert.deepEqual(blocked.tasks[0].provider_retries.last, { reason: 'timeout', after_invocation: 1, minutes: 5 });
});

function forja(t, cwd, args) {
  const data = tempDir(t, 'forja-timeout-data-');
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('core status shows the per-call provider timeout and, after a timeout, the limit reached and its invocation', async t => {
  const root = fixture(t, { routes: { review: { provider: 'custom', maxMinutes: 10 } } });
  const before = forja(t, root, ['core', 'status', '--project', root]);
  assert.equal(before.code, 0, before.err);
  assert.deepEqual(JSON.parse(before.out).provider_timeout, { minutes_per_call: 30, lower_route_limits: [{ route: 'review', minutes: 10 }], last_reached: null });

  await drive(root, { log: () => {}, providerCall: async () => timeout() });
  const after = forja(t, root, ['core', 'status', '--project', root]);
  assert.equal(after.code, 0, after.err);
  const report = JSON.parse(after.out);
  assert.equal(report.recovery.code, 'timeout');
  assert.equal(report.recovery.minutes_per_call, 30);
  assert.match(report.recovery.guidance, /Per-call provider timeout reached: 30 minutes \(develop T1 call-2\)/);
  assert.deepEqual(report.provider_timeout, {
    minutes_per_call: 30, lower_route_limits: [{ route: 'review', minutes: 10 }],
    last_reached: { invocation: 2, phase: 'develop', task: 'T1', minutes: 30, route: 'default' },
  });
});
