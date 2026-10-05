import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRun, current, drive, recoverRun } from '../lib/core/engine.mjs';
import { validateRouting } from '../lib/core/routing.mjs';
import { parseUsageLedger } from '../lib/core/metrics.mjs';

// Mock executors only: no test starts Kilo, Ollama or the Claude CLI.
const cli = resolve('bin/forja.mjs');
const local = { provider: 'kilo', localProvider: 'ollama', model: 'qwen3-coder:30b-32k' };
const routes = { develop: local, review: local };
const escalation = { route: { provider: 'claude', model: 'sonnet', effort: 'high' } };
const check = n => ({ command: 'node', args: ['--input-type=module', '-e', `import {value} from './value${n}.mjs'; if(value!==2)process.exit(1)`] });
const task = n => ({ id: `T${n}`, title: `Return two ${n}`, criteria: ['value equals two'], files: [`value${n}.mjs`], risks: [], complexity: 'easy', after: n > 1 ? [`T${n - 1}`] : [], checks: [check(n)] });

function fixture(t, config = {}, tasks = 1) {
  const root = mkdtempSync(join(tmpdir(), 'forja-escalation-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const files = [];
  for (let n = 1; n <= tasks; n++) { writeFileSync(join(root, `value${n}.mjs`), 'export const value = 1;\n'); files.push(`value${n}.mjs`); }
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  for (const args of [['init', '-q'], ['add', '--', ...files, '.gitignore'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  createRun(root, { provider: 'claude', goal: 'Every value returns two', plan: { decisions: [], tasks: Array.from({ length: tasks }, (_, i) => task(i + 1)) },
    config: { maxAttempts: 1, routes, ...config } });
  return root;
}

// local: what a local develop session does ('wrong' edit, 'prose' without a
// result, 'timeout'); cloud: what the escalated Claude session does.
function executor(root, { local: localMode = 'wrong', cloud = 'fix' } = {}) {
  const calls = [];
  const providerCall = async (provider, o) => {
    const isLocal = o.config.localProvider === 'ollama';
    calls.push({ provider, local: isLocal, readOnly: o.readOnly, model: o.model });
    if (o.readOnly) return { code: 0, result: { status: 'approve', summary: 'Inspected', findings: [] } };
    const file = join(root, `value${o.prompt.match(/"task":\{"id":"T(\d+)"/)[1]}.mjs`);
    const mode = isLocal ? localMode : cloud;
    if (mode === 'timeout') return { code: 1, timedOut: true };
    if (mode === 'interrupted') return { code: 1, interrupted: true };
    if (mode === 'prose') return { code: 0, result: undefined };
    writeFileSync(file, mode === 'fix' ? 'export const value = 2;\n' : 'export const value = 3;\n');
    return { code: 0, result: { status: 'ready_for_validation', summary: 'Edited', findings: [] } };
  };
  return { calls, providerCall };
}
const ledger = root => {
  const run = JSON.parse(readFileSync(current(root)));
  return parseUsageLedger(readFileSync(join(root, '.forja', 'runs', run.run_id, 'usage.jsonl'), 'utf8')).rows;
};
const status = (t, root) => {
  const data = mkdtempSync(join(tmpdir(), 'forja-escalation-data-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [cli, 'core', 'status'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const hangGuard = { timeout: 300_000 };

test('without the opt-in a failed local task blocks as before and never calls Claude', hangGuard, async t => {
  for (const mode of ['wrong', 'prose']) {
    const root = fixture(t);
    const { calls, providerCall } = executor(root, { local: mode });
    const run = await drive(root, { log: () => {}, providerCall });
    assert.equal(run.status, 'blocked');
    assert.match(run.failure, mode === 'wrong' ? /^T1 exhausted 1 implementation attempts\.$/ : /^Invalid\/oversize worker result: no result\. The automatic retry of implementation attempt 1 of T1 was already used\.$/);
    assert.equal(run.stopCode, mode === 'wrong' ? 'attempts' : 'inspect');
    assert.ok(calls.every(c => c.local));
    assert.equal(run.escalations, undefined);
    assert.equal(run.tasks[0].escalation, undefined);
    assert.ok(ledger(root).every(row => row.escalation === undefined && row.local === true));
  }
});

test('opt-in: exhausted local attempts continue once on the Claude route, recorded in ledger and status', hangGuard, async t => {
  const root = fixture(t, { escalation });
  const { calls, providerCall } = executor(root, { local: 'wrong', cloud: 'fix' });
  const run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.status, 'done', run.failure);
  assert.deepEqual(calls.map(c => [c.provider, c.local, c.readOnly]), [['kilo', true, false], ['claude', false, false], ['kilo', true, true]]);
  assert.equal(calls[1].model, 'sonnet');
  assert.equal(run.tasks[0].attempts, 2);
  assert.equal(run.cloudInvocations, 1);
  assert.deepEqual(run.escalations.map(e => [e.task, e.reason, e.from_route, e.to_route, e.invocation]), [['T1', 'attempts', 'develop', 'escalation', 2]]);
  const rows = ledger(root);
  assert.deepEqual(rows.filter(r => r.escalation).map(r => [r.id, r.route, r.provider, r.local, r.escalation.task, r.escalation.reason, r.escalation.from_route, r.escalation.from_model, r.escalation.to_route, r.escalation.to_model]),
    [[2, 'escalation', 'claude', false, 'T1', 'attempts', 'develop', 'qwen3-coder:30b-32k', 'escalation', 'sonnet']]);
  const report = status(t, root);
  assert.equal(report.escalation.used, 1); assert.equal(report.escalation.max, 1);
  assert.equal(report.escalation.escalations[0].reason, 'attempts');
  assert.deepEqual(report.tasks[0].escalated, { reason: 'attempts', from_route: 'develop', to_route: 'escalation', attempt_limit: 2, invocation: 2 });
});

test('opt-in: a stuck local session or an invalid result escalates after its automatic retry', hangGuard, async t => {
  for (const [mode, reason, localCalls] of [['timeout', 'timeout', 2], ['prose', 'invalid_result', 2]]) {
    const root = fixture(t, { escalation, maxAttempts: 2 });
    const { calls, providerCall } = executor(root, { local: mode, cloud: 'fix' });
    const run = await drive(root, { log: () => {}, providerCall });
    assert.equal(run.status, 'done', run.failure);
    const develop = calls.filter(c => !c.readOnly);
    assert.deepEqual(develop.map(c => c.local), [...Array(localCalls).fill(true), false]);
    assert.equal(run.escalations[0].reason, reason);
    assert.equal(run.escalations[0].after_invocation, localCalls);
    assert.equal(run.tasks[0].escalation.attempt_limit, 2);
    const row = ledger(root).find(r => r.escalation);
    assert.equal(row.id, localCalls + 1);
    assert.match(readFileSync(join(root, '.forja', 'runs', run.run_id, `call-${row.id}-prompt.txt`), 'utf8'), /Escalated from the local route/);
  }
});

test('an early stuck escalation gets exactly escalation.attempts, whatever attempts the run had left', hangGuard, async t => {
  const root = fixture(t, { escalation: { ...escalation, attempts: 1 }, maxAttempts: 3 });
  let { calls, providerCall } = executor(root, { local: 'prose', cloud: 'wrong' });
  let run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.status, 'blocked');
  assert.equal(run.stopCode, 'attempts');
  assert.match(run.failure, /^T1 exhausted 2 implementation attempts\.$/);
  assert.deepEqual(calls.filter(c => !c.readOnly).map(c => c.provider), ['kilo', 'kilo', 'claude']);
  assert.equal(run.tasks[0].escalation.attempt_limit, 2);
  assert.equal(status(t, root).tasks[0].escalated.attempt_limit, 2);
  // A retry at the run limit gives nothing more; only a later increase adds to it.
  assert.throws(() => recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'Again', limits: { attempts: 3 } }),
    /T1 is escalated: it has 2 attempts, and only the part of --max-attempts above 3 adds to them\./);
  recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'One more on Claude', limits: { attempts: 4 } });
  ({ calls, providerCall } = executor(root, { local: 'prose', cloud: 'fix' }));
  run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.status, 'done', run.failure);
  assert.deepEqual(calls.map(c => [c.provider, c.readOnly]), [['claude', false], ['kilo', true]]);
  assert.equal(run.escalations.length, 1);
  assert.equal(status(t, root).tasks[0].escalated.attempt_limit, 3);
});

test('escalation budget: one per maxEscalations, cloud and session budgets, no API override', hangGuard, async t => {
  // Two failing tasks, one escalation allowed: the second blocks as before, with the reason.
  let root = fixture(t, { escalation }, 2);
  let { calls, providerCall } = executor(root);
  let run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.status, 'blocked');
  assert.equal(run.stopCode, 'attempts');
  assert.match(run.failure, /^T2 exhausted 1 implementation attempts\. Escalation to the Claude route was not started: the escalation budget of 1 is used\.$/);
  assert.equal(calls.filter(c => !c.local).length, 1);
  assert.equal(run.escalations.length, 1);

  root = fixture(t, { escalation: { ...escalation, maxEscalations: 2 }, maxCloudSessions: 1 }, 2);
  ({ calls, providerCall } = executor(root));
  run = await drive(root, { log: () => {}, providerCall });
  assert.match(run.failure, /^T2 exhausted 1 implementation attempts\. Escalation to the Claude route was not started: the cloud session budget is exhausted\.$/);
  assert.equal(calls.filter(c => !c.local).length, 1);

  root = fixture(t, { escalation, maxSessions: 1 });
  ({ calls, providerCall } = executor(root));
  run = await drive(root, { log: () => {}, providerCall });
  assert.match(run.failure, /Escalation to the Claude route was not started: the session budget is exhausted\.$/);
  assert.ok(calls.every(c => c.local));

  root = fixture(t, { escalation });
  ({ calls, providerCall } = executor(root));
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-placeholder';
  try { run = await drive(root, { log: () => {}, providerCall }); }
  finally { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
  assert.match(run.failure, /not started: ANTHROPIC_API_KEY is set, and escalation uses only the subscription Claude CLI\.$/);
  assert.doesNotMatch(run.failure, /test-placeholder/);
  assert.ok(calls.every(c => c.local));
  assert.equal(run.escalations, undefined);
});

test('escalation is validated in the profile', t => {
  const valid = { routes, escalation };
  assert.doesNotThrow(() => validateRouting(valid));
  assert.doesNotThrow(() => validateRouting({ ...valid, escalation: { ...escalation, maxEscalations: 3, attempts: 2 }, maxCloudSessions: 3 }, 'kilo'));
  for (const [config, message] of [
    [{ routes, escalation: { route: { provider: 'codex' } } }, /provider "claude"/],
    [{ routes, escalation: { route: { ...local, provider: 'claude' } } }, /cannot be local/],
    [{ routes, escalation: { route: { provider: 'claude', command: 'x' } } }, /Unknown escalation route field/],
    [{ routes, escalation: { ...escalation, extra: true } }, /escalation must be an object/],
    [{ routes, escalation: true }, /escalation must be an object/],
    [{ routes, escalation: { ...escalation, maxEscalations: 0 } }, /maxEscalations must be in 1\.\.10/],
    [{ routes, escalation: { ...escalation, maxEscalations: 11 } }, /maxEscalations must be in 1\.\.10/],
    [{ routes, escalation: { ...escalation, attempts: 6 } }, /attempts must be in 1\.\.5/],
    [{ routes, escalation: { route: { provider: 'claude', effort: 'huge' } } }, /Invalid escalation effort/],
    [{ routes, escalation, maxCloudSessions: 0 }, /maxCloudSessions 0 forbids it/],
    [{ routes: { review: local }, escalation }, /local develop routes only/],
    [{ escalation }, /local develop routes only/],
  ]) assert.throws(() => validateRouting(config), message);
  const root = mkdtempSync(join(tmpdir(), 'forja-escalation-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  assert.throws(() => createRun(root, { goal: 'x', config: { routes, escalation, maxCloudSessions: 0 } }), /maxCloudSessions 0 forbids it/);
});

test('resume after escalation keeps the Claude route and does not escalate again', hangGuard, async t => {
  const root = fixture(t, { escalation });
  let { calls, providerCall } = executor(root, { local: 'wrong', cloud: 'interrupted' });
  let run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.stopCode, 'interrupted');
  assert.equal(run.escalations.length, 1);
  assert.equal(run.tasks[0].escalation.invocation, 2);
  // The state round-trips through validation, and retry reads the escalated
  // attempt limit (2) instead of the run limit (1).
  assert.equal(run.tasks[0].attempts, 1);
  recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'Continue on the Claude route' });
  ({ calls, providerCall } = executor(root, { local: 'wrong', cloud: 'fix' }));
  run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.status, 'done', run.failure);
  assert.deepEqual(calls.map(c => [c.provider, c.readOnly]), [['claude', false], ['kilo', true]]);
  assert.equal(run.escalations.length, 1);
  assert.equal(run.cloudInvocations, 2);
  const rows = ledger(root).filter(r => r.escalation);
  assert.deepEqual(rows.map(r => [r.id, r.result]), [[2, 'interrupted']]);
  assert.equal(ledger(root).find(r => r.id === 3).route, 'escalation');
});

test('an escalated session never launches with an API override, also after resume', hangGuard, async t => {
  const root = fixture(t, { escalation });
  let { calls, providerCall } = executor(root, { local: 'wrong', cloud: 'interrupted' });
  let run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.stopCode, 'interrupted');
  assert.equal(run.escalations.length, 1);
  recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'Continue on the Claude route' });
  ({ calls, providerCall } = executor(root, { local: 'wrong', cloud: 'fix' }));
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-placeholder';
  try { run = await drive(root, { log: () => {}, providerCall }); }
  finally { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
  assert.equal(run.status, 'blocked');
  assert.equal(run.stopCode, 'provider');
  assert.match(run.failure, /escalated Claude session was not started: ANTHROPIC_API_KEY is set/);
  assert.doesNotMatch(run.failure, /test-placeholder/);
  assert.equal(calls.length, 0);
  assert.equal(run.tasks[0].attempts, 1);
  assert.equal(run.cloudInvocations, 1);
  // Without the override the same escalated attempt continues.
  recoverRun(root, { action: 'resume', reason: 'API key removed' });
  run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.status, 'done', run.failure);
  assert.deepEqual(calls.map(c => [c.provider, c.readOnly]), [['claude', false], ['kilo', true]]);
  assert.equal(run.escalations.length, 1);
});

test('a tampered escalation record is refused before any call', hangGuard, async t => {
  const root = fixture(t, { escalation });
  const state = JSON.parse(readFileSync(current(root)));
  state.tasks[0].escalation = { reason: 'attempts', attempt_limit: 50 };
  writeFileSync(current(root), JSON.stringify(state));
  const { calls, providerCall } = executor(root);
  await assert.rejects(drive(root, { log: () => {}, providerCall }), /Invalid task escalation/);
  assert.equal(calls.length, 0);
});
