import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRouting } from '../lib/core/routing.mjs';
import { coreBudgets } from '../lib/core/budgets.mjs';
import { validatePlan } from '../lib/core/engine.mjs';
import {
  REPO, candidateModel, cleanupPlan, gpuVerdict, loadTasks, parseArgs, pickFinalists, profileFor, roleOutcomes, summarize, validateConfig, variantName,
} from '../tools/local-bakeoff.mjs';

const read = path => JSON.parse(readFileSync(join(REPO, path), 'utf8'));
const local = read('config/core-local.json');
const bakeoff = read('test/bakeoff/config.json');

test('config/core-local.json is a valid local-only profile with strict budgets and no escalation', () => {
  assert.doesNotThrow(() => validateRouting(local, 'kilo'));
  assert.equal(local.maxCloudSessions, 0);
  assert.equal(local.escalation, undefined);
  for (const phase of ['plan', 'develop', 'review']) {
    const route = local.routes[phase];
    assert.equal(route.provider, 'kilo', phase);
    assert.equal(route.localProvider, 'ollama', phase);
    assert.ok(route.model && !/cloud/i.test(route.model), phase);
    assert.ok(Number.isInteger(route.maxMinutes) && route.maxMinutes <= 20, `${phase} has a short per-call timeout`);
  }
  for (const key of Object.keys(local.routes)) assert.equal(local.routes[key].localProvider, 'ollama', `${key} is local`);
  const budgets = coreBudgets(local);
  assert.ok(budgets.sessions <= 12 && budgets.attempts <= 2 && budgets.minutes <= 20 && budgets.rotations <= 1 && budgets.checkMinutes <= 10);
  // Every recommended model was measured by the bake-off and is named in its report.
  const report = readFileSync(join(REPO, 'docs/research/local-models-2026-10-04.md'), 'utf8');
  const measured = new Set(bakeoff.candidates.map(c => candidateModel(c, bakeoff)));
  for (const { model } of Object.values(local.routes)) {
    assert.ok(measured.has(model), `${model} is a bake-off candidate`);
    assert.ok(report.includes(model), `${model} is in the report`);
  }
});

test('the bake-off config is bounded and local only', () => {
  assert.doesNotThrow(() => validateConfig(bakeoff));
  assert.ok(bakeoff.wallClockMinutes <= 180);
  for (const c of bakeoff.candidates.filter(c => c.pull)) assert.ok(c.sizeGB <= 16 && c.license, c.base);
  const bad = (change, pattern) => assert.throws(() => validateConfig({ ...structuredClone(bakeoff), ...change }), pattern);
  bad({ wallClockMinutes: 240 }, /wallClockMinutes/);
  bad({ profile: { ...bakeoff.profile, maxCloudSessions: 1 } }, /local only/);
  bad({ candidates: [{ base: 'big:70b', pull: true, sizeGB: 40, license: 'MIT' }] }, /sizeGB/);
  bad({ candidates: [{ base: 'x:1b', pull: true, sizeGB: 1 }] }, /license/);
  bad({ candidates: [{ model: 'gpt-oss:120b-cloud' }] }, /cloud/);
  bad({ candidates: [{ model: 'a:1b', pull: true, sizeGB: 1, license: 'MIT' }] }, /only a base/);
});

test('each model profile is all-local, valid and passes per-call caps', () => {
  const profile = profileFor('qwen3:8b', bakeoff);
  assert.doesNotThrow(() => validateRouting(profile, 'kilo'));
  assert.equal(profile.maxCloudSessions, 0);
  assert.deepEqual(Object.values(profile.routes).map(r => [r.provider, r.localProvider, r.model]), Array(3).fill(['kilo', 'ollama', 'qwen3:8b']));
  assert.deepEqual(Object.values(profile.routes).map(r => r.maxMinutes), [6, 10, 6]);
  assert.equal(profile.routeMinutes, undefined);
  assert.equal(variantName('llama3.2:latest', 32768), 'forja-bk-llama3.2:32k');
  assert.equal(variantName('devstral-small-2:24b', 32768), 'forja-bk-devstral-small-2-24b:32k');
});

test('arguments are closed', () => {
  assert.deepEqual(parseArgs(['run', '--detach']), { command: 'run', detach: true });
  assert.deepEqual(parseArgs(['cleanup', '--confirm', '--lab', 'x']), { command: 'cleanup', confirm: true, lab: 'x' });
  assert.throws(() => parseArgs(['run', '--confirm']), /Unknown/);
  assert.throws(() => parseArgs(['launch']), /Unknown command/);
});

test('GPU verdict waits for other processes and other Ollama models only', () => {
  const limits = bakeoff.gpu;
  assert.equal(gpuVerdict({ utilization: 5, memoryUsedMiB: 15000, ollamaMiB: 14000 }, limits).busy, false);
  assert.equal(gpuVerdict({ utilization: 5, memoryUsedMiB: 9000, ollamaMiB: 0 }, limits).busy, true);
  assert.equal(gpuVerdict({ utilization: 90, memoryUsedMiB: 2000 }, limits).busy, true);
  assert.equal(gpuVerdict({ utilization: 0, memoryUsedMiB: 1000, foreignModels: ['other:7b'] }, limits).busy, true);
  assert.deepEqual(gpuVerdict({ utilization: null, memoryUsedMiB: null }, limits), { busy: false, reason: 'nvidia-smi unavailable' });
});

const row = (id, phase, status, extra = {}) => ({ id, phase, status, result: 'returned', duration_ms: 10_000, output_tokens: 500, input_tokens: 9000, timed_out: false, follow_up: false, ...extra });

test('role outcomes judge the last review against the hidden acceptance result', () => {
  const rows = [row(1, 'plan', null), row(2, 'develop', 'done'), row(3, 'review', 'reject'), row(4, 'develop', 'done'), row(5, 'review', 'approve')];
  const state = { tasks: [{ checks: [{}] }] };
  const good = roleOutcomes({ rows, state, fixedPlan: false, acceptance: { passed: true, ownTests: true } });
  assert.equal(good.plan.ok, true);
  assert.equal(good.plan.checks, 1);
  assert.equal(good.develop.sessions, 2);
  assert.equal(good.develop.tokens_per_s, 50);
  assert.deepEqual(good.review.verdicts, ['reject', 'approve']);
  assert.equal(good.review.correct, true);
  assert.equal(roleOutcomes({ rows, state, fixedPlan: false, acceptance: { passed: false } }).review.correct, false);
  const invalid = roleOutcomes({ rows: [row(1, 'develop', 'done'), row(2, 'review', 'done')], state, fixedPlan: true, acceptance: { passed: true } });
  assert.deepEqual(invalid.plan, { fixed: true });
  assert.equal(invalid.review.valid, false);
  assert.equal(invalid.review.correct, null);
  const noPlan = roleOutcomes({ rows: [row(1, 'plan', null, { result: 'timeout', timed_out: true })], state: { tasks: [] }, fixedPlan: false, acceptance: { passed: false } });
  assert.equal(noPlan.plan.ok, false);
  assert.equal(noPlan.plan.timeouts, 1);
});

test('finalists come from screening scores; the summary ranks each role', () => {
  const run = (model, stage, task, passed, planOk, reviewCorrect, ms = 60_000) => ({ kind: 'run', status: 'done', stage, model, task, duration_ms: ms, acceptance: { passed },
    roles: { plan: { ok: planOk, sessions: 1, duration_ms: ms / 3, output_tokens: 300 }, develop: { sessions: 1, acceptance: passed, own_tests: passed, duration_ms: ms / 3, output_tokens: 600 },
      review: { sessions: 1, valid: true, correct: reviewCorrect, duration_ms: ms / 3, output_tokens: 100 } } });
  const steps = [run('a', 'screening', 't', true, true, true, 90_000), run('b', 'screening', 't', true, true, true, 30_000), run('c', 'screening', 't', false, true, false), run('d', 'screening', 't', false, false, false),
    run('b', 'full', 'u', false, true, true)];
  assert.deepEqual(pickFinalists(steps, ['a', 'b', 'c', 'd', 'e'], 2), ['b', 'a']);
  assert.deepEqual(pickFinalists(steps, ['a', 'b', 'c', 'd'], 5), ['b', 'a', 'c']);
  const summary = summarize({ steps: [...steps, { kind: 'probe', model: 'a', status: 'done', probe: { tokens_per_s: 40 } }] });
  assert.equal(summary.models.b.develop.runs, 2);
  assert.equal(summary.models.b.develop.accepted, 1);
  assert.equal(summary.models.a.probe.tokens_per_s, 40);
  assert.deepEqual(summary.ranking.develop.slice(0, 2), ['a', 'b']);
  assert.equal(summary.ranking.plan.at(-1), 'd');
});

test('cleanup removes only models the harness pulled or created, never kept or pre-installed ones', () => {
  const state = { steps: [{ kind: 'pull', model: 'pulled:1b', pulled: true }, { kind: 'pull', model: 'already:2b', pulled: false }, { kind: 'pull', model: 'kept:3b', pulled: true }],
    models: { 'forja-bk-x:32k': { created: true }, 'forja-bk-kept:32k': { created: true }, 'installed:7b': {} } };
  assert.deepEqual(cleanupPlan(state, ['kept:3b', 'forja-bk-kept:32k']), { remove: ['pulled:1b', 'forja-bk-x:32k'], keep: ['kept:3b', 'forja-bk-kept:32k'] });
  // The recommended profile and the documented alternative survive the real cleanup even if the harness had created them.
  const kept = [...Object.values(local.routes).map(r => r.model), ...bakeoff.keep];
  const all = { steps: kept.map(model => ({ kind: 'pull', model, pulled: true })), models: Object.fromEntries(kept.map(name => [name, { created: true }])) };
  assert.deepEqual(cleanupPlan(all, kept).remove, []);
  assert.throws(() => validateConfig({ ...bakeoff, keep: 'devstral' }), /keep must be a list/);
});

test('every task oracle fails on the template and passes on the reference solution', () => {
  const tasks = loadTasks();
  assert.ok(tasks.length >= 4 && tasks.some(t => t.stage === 'screening'));
  const scratch = mkdtempSync(join(tmpdir(), 'bakeoff-oracle-'));
  // A nested node --test inherits NODE_TEST_CONTEXT and would report to this runner instead of exiting non-zero.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  try {
    for (const task of tasks) {
      const acceptance = project => spawnSync(process.execPath, ['--test', join(task.dir, 'acceptance.test.mjs')],
        { cwd: scratch, env: { ...env, BAKEOFF_PROJECT: project }, encoding: 'utf8', windowsHide: true, timeout: 60_000 }).status;
      const template = join(scratch, task.id, 'template'), solved = join(scratch, task.id, 'solved');
      cpSync(join(task.dir, 'project'), template, { recursive: true });
      cpSync(join(task.dir, 'project'), solved, { recursive: true });
      cpSync(join(task.dir, 'solution'), solved, { recursive: true });
      assert.notEqual(acceptance(template), 0, `${task.id}: the untouched template must fail`);
      assert.equal(acceptance(solved), 0, `${task.id}: the reference solution must pass`);
      assert.equal(spawnSync(process.execPath, ['--test'], { cwd: solved, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 }).status, 0, `${task.id}: own tests pass on the solution`);
      assert.equal(task.plan.tasks.length, 1);
      assert.doesNotThrow(() => validatePlan(task.plan, template), `${task.id}: the fixed plan is a valid Core plan`);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
