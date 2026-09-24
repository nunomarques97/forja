import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRun, drive, core } from '../lib/core/engine.mjs';
import { recoveryInfo } from '../lib/core/recovery.mjs';
import { requestStop, readStopRequest, stopRequestPath } from '../lib/core/stop.mjs';
import { coreAlive, coreObservation } from '../lib/core/observe.mjs';

const valueCheck = n => [{ command: 'node', args: ['--input-type=module', '-e', `import {value} from './${n}.mjs'; if(value!==2)process.exit(1)`] }];
function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forja-stop-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'a.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'b.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  const task = (id, file, after) => ({ id, title: `Set ${file} to two`, criteria: [`${file} value equals two`], files: [`${file}.mjs`], complexity: 'easy', risks: [], after, checks: valueCheck(file) });
  createRun(root, { goal: 'Set both values to two', provider: 'custom', config: { maxAttempts: 2, maxRotations: 0, ...config }, plan: { decisions: [], tasks: [task('T1', 'a', []), task('T2', 'b', ['T1'])] } });
  return root;
}
const quiet = { log: () => {} };
const alive = root => () => coreAlive(root);
const result = (status) => ({ code: 0, result: { status, summary: 'Worker result', findings: [] } });
// Records "phase task" per invocation; develop writes the task's file.
function worker(root, calls, hooks = {}) {
  return async (_, options) => {
    const phase = options.readOnly ? 'review' : 'develop';
    const id = options.prompt.includes('"task":{"id":"T2"') ? 'T2' : 'T1';
    calls.push(`${phase} ${id}`);
    await hooks[`${phase} ${id}`]?.(calls.filter(c => c === `${phase} ${id}`).length);
    if (phase === 'develop') writeFileSync(join(root, id === 'T1' ? 'a.mjs' : 'b.mjs'), 'export const value = 2;\n');
    return hooks.review?.(phase, id) ?? result(phase === 'review' ? 'approve' : 'ready_for_validation');
  };
}
async function captured(fn) {
  const lines = [];
  const original = console.log;
  console.log = line => lines.push(line);
  try { await fn(); } finally { console.log = original; }
  return JSON.parse(lines.join('\n'));
}

test('stop --after-task lets the current task finish its checks, review and repair, then prevents the next task', async t => {
  const root = fixture(t);
  const calls = [];
  let reviews = 0;
  const stopped = await drive(root, { ...quiet, providerCall: worker(root, calls, {
    'develop T1': async n => {
      if (n !== 1) return;
      const out = await captured(() => core({ pos: ['stop'], opt: { project: root, 'after-task': true } }));
      assert.equal(out.changed, true);
      assert.deepEqual([out.stop_request.mode, out.stop_request.task], ['task', 'T1']);
    },
    review: (phase) => phase === 'review' && ++reviews === 1 ? { code: 0, result: { status: 'reject', summary: 'Repair needed', findings: ['a.mjs'] } } : undefined,
  }) });
  assert.deepEqual(calls, ['develop T1', 'review T1', 'develop T1', 'review T1']);
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.stopCode, 'operator_stop');
  assert.deepEqual(stopped.tasks.map(x => [x.id, x.status, x.attempts, x.rotations]), [['T1', 'done', 2, 0], ['T2', 'todo', 0, 0]]);
  assert.deepEqual([stopped.operatorStop.mode, stopped.operatorStop.task, stopped.operatorStop.next_task], ['task', 'T1', 'T2']);
  assert.equal(stopped.invocations, 4);
  assert.equal(existsSync(stopRequestPath(root)), false);
  const info = recoveryInfo(stopped, { alive: false });
  assert.equal(info.code, 'operator_stop');
  assert.match(info.guidance, /core resume/);

  const resumed = await drive(root, { ...quiet, providerCall: worker(root, calls) });
  assert.equal(resumed.status, 'done', resumed.failure);
  assert.deepEqual(calls.slice(4), ['develop T2', 'review T2']);
  assert.deepEqual(resumed.tasks.map(x => x.attempts), [2, 1]);
  assert.equal(resumed.operatorStop, undefined);
});

test('default stop waits for the live invocation and stops at the next boundary; resume consumes no attempt', async t => {
  const root = fixture(t);
  const calls = [];
  const stopped = await drive(root, { ...quiet, providerCall: worker(root, calls, {
    'develop T1': () => { requestStop(root, { controllerAlive: alive(root) }); },
  }) });
  // The develop result was recorded and its checks ran; the review invocation never launched.
  assert.deepEqual(calls, ['develop T1']);
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.stopCode, 'operator_stop');
  assert.match(stopped.failure, /next invocation boundary.*core resume/);
  assert.equal(stopped.tasks[0].status, 'review');
  assert.equal(stopped.tasks[0].validation[0].passed, true);
  assert.deepEqual(stopped.tasks.map(x => x.attempts), [1, 0]);
  assert.equal(stopped.invocations, 1);

  // core resume without budget flags is exactly drive() on the stored run.
  const resumed = await drive(root, { ...quiet, providerCall: worker(root, calls) });
  assert.equal(resumed.status, 'done', resumed.failure);
  assert.deepEqual(calls, ['develop T1', 'review T1', 'develop T2', 'review T2']);
  const status = await captured(() => core({ pos: ['status'], opt: { project: root } }));
  assert.equal(status.status, 'done');
  assert.deepEqual(status.tasks.map(x => x.attempts), [1, 1]);
  assert.equal(status.invocations, 4);
  assert.equal(status.stop_request, null);
});

test('a stop request is refused without a live controller and is idempotent while one runs', async t => {
  const root = fixture(t);
  assert.throws(() => requestStop(root, { controllerAlive: alive(root) }), /No active Core run to stop.*not attached to a live controller/);
  await assert.rejects(core({ pos: ['stop'], opt: { project: root } }), /No active Core run to stop/);
  assert.equal(existsSync(stopRequestPath(root)), false);

  const calls = [];
  let status, observed;
  const stopped = await drive(root, { ...quiet, providerCall: worker(root, calls, {
    'develop T1': async () => {
      const first = requestStop(root, { afterTask: true, controllerAlive: alive(root) });
      const again = requestStop(root, { afterTask: true, controllerAlive: alive(root) });
      assert.equal(first.changed, true);
      assert.equal(again.changed, false);
      assert.deepEqual(again.request, first.request);
      // A default request tightens the boundary; a later --after-task never loosens it.
      assert.equal(requestStop(root, { controllerAlive: alive(root) }).request.mode, 'invocation');
      const loosen = requestStop(root, { afterTask: true, controllerAlive: alive(root) });
      assert.deepEqual([loosen.changed, loosen.request.mode], [false, 'invocation']);
      status = await captured(() => core({ pos: ['status'], opt: { project: root } }));
      observed = coreObservation(root, { details: true });
    },
  }) });
  assert.equal(status.status, 'running');
  assert.deepEqual([status.stop_request.mode, status.stop_request.task], ['invocation', null]);
  assert.equal(status.recovery, null);
  assert.deepEqual([observed.stop_request.mode, observed.stop_request.task], ['invocation', null]);
  assert.equal(stopped.stopCode, 'operator_stop');
  assert.deepEqual(calls, ['develop T1']);

  // The run is now blocked: another request is refused, and status explains the stop.
  assert.throws(() => requestStop(root, { controllerAlive: () => true }), /No active Core run to stop.*blocked/);
  const after = await captured(() => core({ pos: ['status'], opt: { project: root } }));
  assert.equal(after.stop_request, null);
  assert.equal(after.recovery.code, 'operator_stop');
});

test('a stop request left from an earlier controller session is cleared by resume', async t => {
  const root = fixture(t);
  const run = await captured(() => core({ pos: ['status'], opt: { project: root } }));
  writeFileSync(stopRequestPath(root), JSON.stringify({ version: 1, run_id: run.run, mode: 'invocation', task: null, requested_at: '2020-01-01T00:00:00.000Z' }));
  assert.equal(readStopRequest(root, run.run).mode, 'invocation');
  const calls = [];
  const done = await drive(root, { ...quiet, providerCall: worker(root, calls) });
  assert.equal(done.status, 'done', done.failure);
  assert.equal(calls.length, 4);
  assert.equal(existsSync(stopRequestPath(root)), false);
});
