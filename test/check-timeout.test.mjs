import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRun, drive, current, recoverRun, CORE_FLAGS } from '../lib/core/engine.mjs';
import { recoveryInfo } from '../lib/core/recovery.mjs';
import { coreBudgets, checkMinutes } from '../lib/core/budgets.mjs';
import { isolatedCheck } from '../lib/core/check-isolation.mjs';

const cli = fileURLToPath(new URL('../bin/forja.mjs', import.meta.url));
const check = code => ({ command: 'node', args: ['-e', code] });
const slowSuite = check("process.exit(0)");
const task = (id, extra = {}) => ({
  id, title: 'Produce the accepted value', criteria: ['value is two'],
  files: ['value.txt'], risks: [], complexity: 'easy', after: [], checks: [slowSuite], ...extra,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-check-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.txt'), '1');
  for (const args of [['init', '-q'], ['add', '--', '.gitignore', 'value.txt'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']])
    execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}
function worker(root, phases = []) {
  return async (_, options) => {
    const ctx = JSON.parse(options.text);
    phases.push(`${ctx.phase}:${ctx.task.id}`);
    if (ctx.phase === 'develop') writeFileSync(join(root, `${ctx.task.id}.txt`), 'done');
    return { code: 0, result: { status: ctx.phase === 'review' ? 'approve' : 'ready_for_validation', summary: 'Synthetic worker', findings: [], technology: [] } };
  };
}
// An injected check runner: calls listed in `timeouts` (1-based) are killed by the timeout.
function checks(timeouts = []) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push(options.timeoutMs);
    return timeouts.includes(calls.length)
      ? { code: null, timedOut: true, overflow: false, stdout: 'partial suite output', stderr: '', duration_ms: options.timeoutMs }
      : { code: 0, timedOut: false, overflow: false, stdout: 'ok', stderr: '', duration_ms: 5 };
  };
  return { run, calls };
}
const state = root => JSON.parse(readFileSync(current(root), 'utf8'));
function cliRun(t, cwd, args) {
  const data = mkdtempSync(join(tmpdir(), 'forja-check-timeout-data-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('the check timeout is a bounded run setting whose default keeps the earlier value', () => {
  assert.equal(coreBudgets().checkMinutes, undefined);
  assert.equal(checkMinutes(coreBudgets()), 10);
  assert.equal(checkMinutes(coreBudgets({ maxMinutes: 4 })), 4);
  assert.equal(checkMinutes(coreBudgets({ maxMinutes: 60 })), 10);
  assert.equal(coreBudgets({ checkTimeoutMinutes: '30' }).checkMinutes, 30);
  assert.equal(checkMinutes(coreBudgets({ maxMinutes: 5, checkTimeoutMinutes: 180 })), 180);
  for (const value of [0, 181, '12.5', true]) assert.throws(() => coreBudgets({ checkTimeoutMinutes: value }), /Budget must be an integer in 1\.\.180/);
  for (const command of ['start', 'resume', 'retry']) assert.ok(CORE_FLAGS[command].includes('check-timeout-minutes'), command);
});

test('isolatedCheck accepts a configured timeout above 600,000 ms and refuses one above the maximum', async () => {
  const config = {};
  // Above the old 600,000 ms bound: the timeout is accepted and the call goes on to the launcher.
  await assert.rejects(isolatedCheck('node', ['-e', '0'], { cwd: tmpdir(), config, timeoutMs: 600001 }), /requires checkIsolation configuration/);
  await assert.rejects(isolatedCheck('node', ['-e', '0'], { cwd: tmpdir(), config, timeoutMs: 180 * 60000 }), /requires checkIsolation configuration/);
  for (const timeoutMs of [180 * 60000 + 1, 0, 1.5])
    await assert.rejects(isolatedCheck('node', ['-e', '0'], { cwd: tmpdir(), config, timeoutMs }), /Invalid isolated check command or timeout/);
});

test('a task check killed by the timeout blocks without spending an attempt, and a raised limit validates on resume', async t => {
  const root = fixture(t);
  createRun(root, { goal: 'Accept the value', plan: { decisions: [], tasks: [task('T1')] } });
  const phases = [];
  const first = checks([1]);
  const run = await drive(root, { log: () => {}, providerCall: worker(root, phases), runCheck: first.run });
  assert.equal(run.status, 'blocked');
  assert.equal(run.stopCode, 'check_timeout');
  assert.deepEqual(first.calls, [600000]);
  assert.match(run.failure, /^Deterministic validation stopped at the check timeout: task T1 checks\[0\] ran \["node","-e","process\.exit\(0\)"\] and was killed after 10 minutes\./);
  assert.match(run.failure, /no implementation attempt was spent and no reject feedback was recorded/);
  assert.match(run.failure, /core resume --check-timeout-minutes N \(N from 11 to 180\)/);
  assert.deepEqual(run.stopDetail, { task: 'T1', check: 'checks[0]', minutes: 10, final: false });
  const blocked = run.tasks[0];
  assert.equal(blocked.status, 'validate');
  assert.equal(blocked.attempts, 1);
  assert.notEqual(blocked.feedback?.status, 'reject');
  assert.equal(blocked.validation.length, 1);
  assert.equal(blocked.validation[0].timed_out, true);
  assert.equal(blocked.validation[0].timeout_minutes, 10);
  assert.equal(blocked.validation[0].passed, false);
  const recovery = recoveryInfo(state(root));
  assert.equal(recovery.code, 'check_timeout');
  assert.equal(recovery.check_timeout_minutes, 10);
  assert.match(recovery.guidance, /no implementation attempt was spent/);
  assert.match(recovery.guidance, /Timed-out check: task T1 checks\[0\] after 10 minutes\. Raise it with core resume --check-timeout-minutes N \(N from 11 to 180\)\./);

  assert.throws(() => recoverRun(root, { action: 'resume', reason: 'lower', limits: { checkMinutes: 9 } }), /Recovery may only raise budgets/);
  recoverRun(root, { action: 'resume', reason: 'The suite needs about 12 minutes', limits: { checkMinutes: 30 } });
  assert.equal(state(root).limits.checkMinutes, 30);
  const second = checks();
  const done = await drive(root, { log: () => {}, providerCall: worker(root, phases), runCheck: second.run });
  assert.equal(done.status, 'done');
  assert.deepEqual(second.calls, [1800000]);
  assert.equal(done.tasks[0].attempts, 1);
  assert.deepEqual(phases, ['develop:T1', 'review:T1']);
  assert.equal(done.tasks[0].validation[0].timed_out, undefined);
});

test('a final-regression check killed by the timeout blocks without reopening the task', async t => {
  const root = fixture(t);
  createRun(root, { goal: 'Accept both', config: { checkTimeoutMinutes: 15 },
    plan: { decisions: [], tasks: [task('T1'), task('T2', { files: ['T2.txt'], after: ['T1'] })] } });
  const phases = [];
  // T1 validation, T2 validation, then the final regression of T1 times out.
  const first = checks([3]);
  const run = await drive(root, { log: () => {}, providerCall: worker(root, phases), runCheck: first.run });
  assert.equal(run.status, 'blocked');
  assert.equal(run.stopCode, 'check_timeout');
  assert.deepEqual(first.calls, [900000, 900000, 900000]);
  assert.match(run.failure, /^Final validation stopped at the check timeout: task T1 checks\[0\] .* killed after 15 minutes\./);
  const t1 = run.tasks[0];
  assert.equal(t1.status, 'done');
  assert.equal(t1.attempts, 1);
  assert.equal(t1.feedback, null);
  assert.equal(t1.finalValidation.at(-1).timed_out, true);
  assert.match(recoveryInfo(state(root)).guidance, /Timed-out check: task T1 checks\[0\] after 15 minutes\. Raise it with core resume --check-timeout-minutes N \(N from 16 to 180\)\./);

  recoverRun(root, { action: 'resume', reason: 'Slow machine', limits: { checkMinutes: 20 } });
  const second = checks();
  const done = await drive(root, { log: () => {}, providerCall: worker(root, phases), runCheck: second.run });
  assert.equal(done.status, 'done');
  assert.deepEqual(second.calls, [1200000]);
  assert.deepEqual(done.tasks.map(x => x.attempts), [1, 1]);
  assert.deepEqual(phases, ['develop:T1', 'review:T1', 'develop:T2', 'review:T2']);
});

test('a failed check that did not time out still rejects and spends the attempt', async t => {
  const root = fixture(t);
  createRun(root, { goal: 'Accept the value', config: { maxAttempts: 1 }, plan: { decisions: [], tasks: [task('T1')] } });
  const run = await drive(root, { log: () => {}, providerCall: worker(root), runCheck: async () => ({ code: 1, timedOut: false, overflow: false, stdout: '', stderr: 'FAIL' }) });
  assert.equal(run.stopCode, 'attempts');
  assert.equal(run.tasks[0].feedback.status, 'reject');
  assert.equal(run.tasks[0].validation[0].timed_out, undefined);
});

test('core status shows the effective check timeout, and the CLI raises it on a blocked run', async t => {
  const root = fixture(t);
  createRun(root, { goal: 'Accept the value', plan: { decisions: [], tasks: [task('T1')] } });
  // A run created before the setting existed reads with the earlier default.
  const legacy = state(root);
  assert.equal(legacy.limits.checkMinutes, undefined);
  await drive(root, { log: () => {}, providerCall: worker(root), runCheck: checks([1]).run });
  const status = cliRun(t, root, ['core', 'status']);
  assert.equal(status.code, 0, status.err);
  const report = JSON.parse(status.out);
  assert.deepEqual(report.check_timeout, { minutes: 10, source: 'default (smaller of --max-minutes and 10)' });
  assert.equal(report.recovery.code, 'check_timeout');
  const lower = cliRun(t, root, ['core', 'abandon', '--check-timeout-minutes', '5', '--why', 'lower']);
  assert.notEqual(lower.code, 0);
  assert.match(lower.err, /Recovery may only raise budgets/);
  const raised = cliRun(t, root, ['core', 'abandon', '--check-timeout-minutes', '45', '--why', 'done testing']);
  assert.equal(raised.code, 0, raised.err);
  assert.equal(state(root).limits.checkMinutes, 45);
  const after = JSON.parse(cliRun(t, root, ['core', 'status']).out);
  assert.deepEqual(after.check_timeout, { minutes: 45, source: 'checkTimeoutMinutes' });
});
