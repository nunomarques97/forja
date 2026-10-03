import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRun, drive } from '../lib/core/engine.mjs';
import { planningContract, PACKET_LIMIT, TASK_PACKET_BUDGET } from '../lib/core/plan-warnings.mjs';
import { recoveryInfo } from '../lib/core/recovery.mjs';
import { requestStop } from '../lib/core/stop.mjs';
import { coreAlive } from '../lib/core/observe.mjs';

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-plan-packet-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test']])
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}
const check = { command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] };
const task = (over = {}) => ({ id: 'T1', title: 'Return two', criteria: ['value equals 2'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [], checks: [check], ...over });
// Each criterion is valid on its own; together they fill the develop packet.
const oversized = () => task({ id: 'review0', title: 'Review all scenarios', criteria: ['a', 'b', 'c', 'd', 'e', 'f'].map(c => c.repeat(7000)) });
const compliant = () => ({ decisions: [], tasks: [task()] });
const stopAtDevelop = { code: 0, result: { status: 'blocked', summary: 'Stop here', findings: [] } };

function planner(plans) {
  const seen = [];
  const providerCall = async (_, options) => {
    const ctx = JSON.parse(options.text);
    seen.push({ phase: ctx.phase, ctx, input: options.input });
    if (ctx.phase !== 'plan') return stopAtDevelop;
    return { code: 0, result: plans.shift() };
  };
  return { seen, providerCall, plans: () => seen.filter(s => s.phase === 'plan') };
}

test('the planner is told the per-task packet budget in planning_contract and in its instruction', async (t) => {
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'custom' });
  const p = planner([compliant()]);
  await drive(root, { log: () => {}, providerCall: p.providerCall });
  const [plan] = p.plans();
  assert.equal(TASK_PACKET_BUDGET, 40000);
  assert.equal(PACKET_LIMIT, 48000);
  assert.equal(plan.ctx.planning_contract.task_packet_budget_characters, TASK_PACKET_BUDGET);
  assert.equal(plan.ctx.planning_contract.task_packet_limit_characters, PACKET_LIMIT);
  assert.match(plan.ctx.planning_contract.task_packet_note, /8000 characters stay reserved/);
  assert.equal(planningContract({ limits: {}, config: {} }).task_packet_budget_characters, 40000);
  assert.match(plan.input, /must fit planning_contract\.task_packet_budget_characters/);
  assert.equal(plan.ctx.feedback, null);
});

test('an oversized plan is planned again once with the task sizes and the compliant plan is accepted', async (t) => {
  const root = repo(t);
  createRun(root, { goal: 'Review scenarios', provider: 'custom' });
  const p = planner([{ decisions: [], tasks: [oversized(), task({ after: ['review0'] })] }, compliant()]);
  const lines = [];
  const run = await drive(root, { log: line => lines.push(line), providerCall: p.providerCall });
  const plans = p.plans();
  assert.equal(plans.length, 2);
  const feedback = plans[1].ctx.feedback;
  assert.equal(feedback.status, 'plan_refused');
  assert.match(feedback.summary, /task_packet_budget_characters \(40000 characters\)/);
  // T1 shares a file with review0, but task_scope caps review0's criteria in
  // T1's packet, so only the task that causes the size is named.
  assert.deepEqual(feedback.findings.map(f => f.split(':')[0]), ['review0']);
  const finding = id => /^\w+: (\d+) characters, budget 40000; its own task entry has (\d+) characters/.exec(feedback.findings.find(f => f.startsWith(`${id}:`))).slice(1).map(Number);
  const [reviewSize, reviewOwn] = finding('review0');
  assert.ok(reviewSize > TASK_PACKET_BUDGET && reviewOwn > 42000);
  assert.ok(lines.some(line => /^FORJA plan refused: the develop packet of .*review0 \(\d{2},\d{3} characters; own entry 42,\d{3}\).* exceeds the planning budget of 40,000 characters/.test(line)));
  // The re-plan is a counted session; the compliant tasks are stored and run.
  assert.deepEqual(run.tasks.map(x => x.id), ['T1']);
  assert.equal(run.invocations, 3);
  assert.equal(p.seen[2].phase, 'develop');
  assert.notEqual(run.stopCode, 'plan_packet');
  assert.equal(run.stopDetail, undefined);
});

test('the automatic re-plan counts against the session budget', async (t) => {
  const root = repo(t);
  createRun(root, { goal: 'Review scenarios', provider: 'custom', config: { maxSessions: 1 } });
  const p = planner([{ decisions: [], tasks: [oversized()] }, compliant()]);
  const run = await drive(root, { log: () => {}, providerCall: p.providerCall });
  assert.equal(p.plans().length, 1);
  assert.equal(run.status, 'blocked');
  assert.equal(run.stopCode, 'sessions');
  assert.deepEqual(run.tasks, []);
});

test('two oversized plans block with plan_packet, store no task and resume plans again with the sizes', async (t) => {
  const root = repo(t);
  createRun(root, { goal: 'Review scenarios', provider: 'custom' });
  const big = () => ({ decisions: [], tasks: [task({ id: 'small' }), oversized(), { ...oversized(), id: 'review1' }] });
  const p = planner([big(), big(), big()]);
  const blocked = await drive(root, { log: () => {}, providerCall: p.providerCall });
  assert.equal(p.plans().length, 2, 'no third planner call');
  assert.equal(p.seen.length, 2);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stopCode, 'plan_packet');
  assert.deepEqual(blocked.tasks, []);
  assert.equal(blocked.invocations, 2);
  assert.match(blocked.failure, /^Plan refused again: the develop packet of (review0|review1) \(\d{2},\d{3} characters; own entry [\d,]+\), (review0|review1) \(\d{2},\d{3} characters; own entry [\d,]+\) exceeds the planning budget of 40,000 characters \(limit 48,000\)/);
  assert.match(blocked.failure, /review0 \(\d{2},\d{3} characters; own entry 42,\d{3}\)/);
  const info = recoveryInfo(blocked);
  assert.equal(info.code, 'plan_packet');
  assert.match(info.guidance, /core resume plans again/);
  assert.match(info.guidance, /Measured: .*task review0: \d{2},\d{3} characters \(own entry 42,\d{3}\)/);
  assert.match(info.guidance, /task review1: \d{2},\d{3} characters \(own entry 42,\d{3}\)/);
  // small shares a file with both, but their criteria are capped in its scope.
  assert.doesNotMatch(info.guidance, /task small:/);
  assert.match(info.guidance, /; planning budget 40,000 characters, limit 48,000 characters\.$/);
  // Status reports the same named guidance.
  const status = spawnSync(process.execPath, [resolve('bin/forja.mjs'), 'core', 'status', '--project', root], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(status.status, 0, status.stderr);
  assert.match(JSON.parse(status.stdout).recovery.guidance, /task review0: \d{2},\d{3} characters/);

  const again = planner([compliant()]);
  const resumed = await drive(root, { log: () => {}, providerCall: again.providerCall });
  const [plan] = again.plans();
  assert.equal(plan.ctx.feedback.status, 'plan_refused');
  assert.ok(plan.ctx.feedback.findings.some(f => /^review0: \d+ characters, budget 40000; its own task entry has 42\d{3} characters/.test(f)));
  assert.deepEqual(resumed.tasks.map(x => x.id), ['T1']);
  assert.equal(resumed.invocations, 4);
  assert.notEqual(resumed.stopCode, 'plan_packet');
});

test('a stop requested during an oversized plan launches no re-plan and resume keeps the sizes as feedback', async (t) => {
  const root = repo(t);
  createRun(root, { goal: 'Review scenarios', provider: 'custom' });
  const p = planner([{ decisions: [], tasks: [oversized()] }]);
  const providerCall = async (cmd, options) => {
    requestStop(root, { controllerAlive: () => coreAlive(root) });
    return p.providerCall(cmd, options);
  };
  const stopped = await drive(root, { log: () => {}, providerCall });
  assert.equal(p.plans().length, 1, 'no second plan session after the stop request');
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.stopCode, 'operator_stop');
  assert.deepEqual(stopped.tasks, []);
  assert.equal(stopped.invocations, 1);
  assert.equal(stopped.stopDetail.tasks[0].task, 'review0');

  const again = planner([compliant()]);
  const resumed = await drive(root, { log: () => {}, providerCall: again.providerCall });
  const [plan] = again.plans();
  assert.equal(plan.ctx.feedback.status, 'plan_refused');
  assert.ok(plan.ctx.feedback.findings.some(f => /^review0: \d+ characters, budget 40000; its own task entry has 42\d{3} characters/.test(f)));
  assert.deepEqual(resumed.tasks.map(x => x.id), ['T1']);
});

test('a develop-time packet overflow names the task, its size and the limit and spends no attempt', async (t) => {
  const root = repo(t);
  // T1's own criteria are mandatory: trimming optional context cannot make them fit.
  const criteria = ['x', 'y', 'z', 'w', 'v', 'u', 't'].map(c => c.repeat(7000));
  createRun(root, { goal: 'Oversized task', provider: 'custom', plan: { decisions: [], tasks: [task({ criteria }), task({ id: 'T2', after: ['T1'] })] } });
  let calls = 0;
  const run = await drive(root, { log: () => {}, providerCall: async () => { calls++; return stopAtDevelop; } });
  assert.equal(calls, 0);
  assert.equal(run.status, 'blocked');
  assert.equal(run.stopCode, 'task_packet');
  assert.match(run.failure, /^Task packet for T1 \(develop\) has \d{2},\d{3} characters, over the limit of 48,000 characters after trimming optional context \(task_scope\.remaining_tasks criteria, repository_map\); its mandatory parts alone exceed the limit/);
  assert.match(run.failure, /No session or implementation attempt was spent/);
  assert.deepEqual([run.tasks[0].status, run.tasks[0].attempts, run.invocations], ['todo', 0, 0]);
  const size = /has (\d{2},\d{3}) characters/.exec(run.failure)[1];
  const info = recoveryInfo(run);
  assert.equal(info.code, 'task_packet');
  assert.ok(info.guidance.includes(`Measured: task T1: ${size} characters; limit 48,000 characters.`), info.guidance);
});

test('packet guidance uses structured sizes only and drops malformed entries', () => {
  const base = { status: 'blocked', stopCode: 'plan_packet', tasks: [], limits: {}, config: {} };
  const info = recoveryInfo({ ...base, stopDetail: { limit: 48000, budget: 40000, tasks: [{ task: '<b>x</b>', characters: 1 }, { task: 'ok', characters: -1 }, { task: 'T9', characters: 41000 }] } });
  assert.match(info.guidance, /Measured: task T9: 41,000 characters; planning budget 40,000 characters, limit 48,000 characters\.$/);
  assert.doesNotMatch(info.guidance, /<b>|task ok/);
  assert.doesNotMatch(recoveryInfo({ ...base, stopDetail: { tasks: 'PRIVATE' } }).guidance, /PRIVATE|Measured/);
  assert.doesNotMatch(recoveryInfo({ ...base, stopCode: 'timeout', stopDetail: { limit: 48000, tasks: [{ task: 'T9', characters: 1 }] } }).guidance, /Measured/);
});
