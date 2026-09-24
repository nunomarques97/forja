import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { modelEvidence } from '../lib/core/model-evidence.mjs';
import { createRun, drive } from '../lib/core/engine.mjs';
import { evaluationPlan } from '../lib/core/evaluation-plan.mjs';

const row = { id: 1, phase: 'develop', provider: 'claude', model: 'example-v1', reported_model: 'example-v1', effort: 'high', result: 'returned', duration_ms: 20,
  usage: { input_tokens: 2, cache_creation_input_tokens: 3, cached_input_tokens: 5, output_tokens: 7 } };
function fixture(t, rows = [row], state = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forja-model-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.forja/runs/F-test');
  mkdirSync(dir, { recursive: true });
  const run = { version: 1, run_id: 'F-test', status: 'done', invocations: 1, tasks: [{ status: 'done', validation: [{ passed: true }] }], ...state };
  writeFileSync(join(root, '.forja/current.json'), JSON.stringify(run));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(run));
  writeFileSync(join(dir, 'usage.jsonl'), rows.map(JSON.stringify).join('\n'));
  writeFileSync(join(dir, 'call-1-result.json'), JSON.stringify({ status: 'ready_for_validation', summary: 'PRIVATE_TEXT', findings: ['PRIVATE_FINDING'] }));
  return { root, dir };
}
const snapshot = root => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true }).filter(e => e.isFile()).map(e => {
  const file = join(e.parentPath, e.name); return [file, readFileSync(file).toString('base64')];
}));

test('model evidence separates phase, effort, requested/reported identity and measurements without raw content', t => {
  const rows = [row, { ...row, id: 2, effort: 'medium', reported_model: null },
    { ...row, id: 3, phase: 'review', usage: null, duration_ms: null }];
  const { root, dir } = fixture(t, rows, { invocations: 3, goal: 'PRIVATE_GOAL', failure: 'PRIVATE_FAILURE' });
  writeFileSync(join(dir, 'call-2-result.json'), JSON.stringify({ status: 'done', summary: 'PRIVATE_TEXT' }));
  writeFileSync(join(dir, 'call-3-result.json'), JSON.stringify({ status: 'reject', findings: ['PRIVATE_FINDING'] }));
  // These files must not be read; invalid JSON would make stream parsing fail.
  writeFileSync(join(dir, 'call-1-stream.json'), 'PRIVATE_NATIVE_INVALID');
  writeFileSync(join(dir, 'call-1-events.jsonl'), 'PRIVATE_EVENTS_INVALID');
  const before = snapshot(root), report = modelEvidence(root);
  assert.equal(report.groups.length, 3);
  assert.equal(report.groups[0].measurements.input_tokens_including_cache, 10);
  assert.equal(report.groups[1].reported_model, null);
  assert.equal(report.groups[1].effort, 'medium');
  assert.equal(report.groups[2].measurements.duration_ms, null);
  assert.deepEqual(report.groups[2].recorded_responses, { reject: 1 });
  assert.ok(report.signals.includes('inspect_review_findings'));
  assert.ok(report.signals.includes('measurement_gaps'));
  assert.equal(report.tasks.latest_checks.passed, 1);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|source code|\\\\Users/);
  assert.deepEqual(snapshot(root), before);
});

test('provider limits, timeouts, interruptions and errors remain execution observations, not review verdicts', t => {
  const rows = [
    { ...row, id: 1, rate_limited: true, result: 'error' },
    { ...row, id: 2, timed_out: true, result: 'error' },
    { ...row, id: 3, result: 'interrupted' },
    { ...row, id: 4, result: 'error', error: 'PRIVATE_AUTH' },
    { ...row, id: 5, context_limit_reached: true, result: 'error' },
  ];
  const { root, dir } = fixture(t, rows, { invocations: 5, status: 'blocked' });
  writeFileSync(join(dir, 'call-5-result.json'), JSON.stringify({ status: 'checkpoint' }));
  const r = modelEvidence(root);
  assert.deepEqual(r.groups[0].outcomes, { provider_limit: 1, timeout: 1, interrupted: 1, provider_error: 1, context_limit: 1 });
  assert.deepEqual(r.groups[0].recorded_responses, { checkpoint: 1 });
  assert.ok(r.signals.includes('inspect_execution_failures'));
  assert.ok(!r.signals.includes('inspect_review_findings'));
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_AUTH|success_rate|quality_score/);
});

test('missing or corrupt records keep unknown coverage and pending state without fabricated totals', t => {
  const { root, dir } = fixture(t, [{ ...row, usage: null, duration_ms: null }], {
    invocations: 3, status: 'running', pending: { id: 2, phase: 'review', provider: 'codex', model: 'candidate', effort: 'high' }, tasks: [],
  });
  writeFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ ...row, usage: null, duration_ms: null }) + '\n{PRIVATE_BROKEN\n');
  const r = modelEvidence(root);
  assert.deepEqual(r.coverage, { expected_invocations: 3, recorded_invocations: 1, represented_invocations: 2 });
  assert.equal(r.groups[0].measurements.input_tokens_including_cache, null);
  assert.deepEqual(r.groups[1].outcomes, { pending: 1 });
  assert.ok(r.warnings.includes('invalid_ledger_records'));
  assert.ok(r.warnings.includes('missing_invocation_records'));
});

test('recovery duplicates do not double count, conflicting terminal rows lose attribution', t => {
  const { root } = fixture(t, [row, { ...row, result: 'interrupted' }, row]);
  assert.equal(modelEvidence(root).groups[0].measurements.duration_ms, 20);
  const conflict = fixture(t, [row, { ...row, model: 'different' }]);
  const r = modelEvidence(conflict.root);
  assert.ok(r.warnings.includes('conflicting_invocation_records'));
  assert.equal(r.groups[0].requested_model, null);
  assert.equal(r.groups[0].measurements.duration_ms, null);
  assert.deepEqual(r.groups[0].outcomes, { unknown: 1 });
});

test('responses are read only from fixed invocation paths, with bounded sizes and phase-specific statuses', t => {
  const { root, dir } = fixture(t, [{ ...row, output_log: '../PRIVATE', result_path: '../PRIVATE' }, { ...row, id: 2, phase: 'review' }], { invocations: 2 });
  writeFileSync(join(dir, 'call-1-result.json'), 'x'.repeat(65537));
  writeFileSync(join(dir, 'call-2-result.json'), JSON.stringify({ status: 'done', summary: 'PRIVATE' }));
  const r = modelEvidence(root);
  assert.ok(r.warnings.includes('response_file_limit'));
  assert.ok(r.warnings.includes('response_invalid_record'));
  assert.ok(r.groups.every(g => g.missing_responses === 1));
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
});

test('archive selection is explicit, exact, and rejects path injection before accessing a project', t => {
  const { root } = fixture(t);
  assert.deepEqual(modelEvidence(root, { runId: 'F-test' }), modelEvidence(root));
  for (const bad of [true, null, '', '../F-test', 'F-test/extra', 'F-test\n', 'F-test\r', 'F-' + 'a'.repeat(99)]) {
    assert.throws(() => modelEvidence(join(root, 'missing'), { runId: bad }), { message: 'Invalid model evidence options.' });
  }
  const archive = join(root, '.forja/runs/F-test/state.json');
  const value = JSON.parse(readFileSync(archive)); value.run_id = 'F-other';
  writeFileSync(archive, JSON.stringify(value));
  assert.throws(() => modelEvidence(root, { runId: 'F-test' }), { message: 'Invalid Core model evidence state.' });
});

test('unreadable/missing ledger and state limits produce bounded privacy-safe diagnostics', t => {
  const { root, dir } = fixture(t);
  rmSync(join(dir, 'usage.jsonl'));
  assert.ok(modelEvidence(root).warnings.includes('ledger_missing_file'));
  writeFileSync(join(dir, 'usage.jsonl'), 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.ok(modelEvidence(root).warnings.includes('ledger_file_limit'));
  writeFileSync(join(root, '.forja/current.json'), 'x'.repeat(4 * 1024 * 1024 + 1));
  assert.throws(() => modelEvidence(root), { message: 'Invalid Core model evidence state.' });
});

test('outside junctions are not followed and arbitrary model labels are not echoed', t => {
  const { root, dir } = fixture(t, [{ ...row, model: 'C:\\PRIVATE\\model', reported_model: 'model\nPRIVATE', effort: 'PRIVATE' }]);
  const outside = mkdtempSync(join(tmpdir(), 'forja-evidence-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'state.json'), '{"PRIVATE":true}');
  symlinkSync(outside, join(root, '.forja/runs/F-outside'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => modelEvidence(root, { runId: 'F-outside' }), { message: 'Invalid Core model evidence state.' });
  assert.doesNotMatch(JSON.stringify(modelEvidence(root)), /PRIVATE/);
  assert.ok(existsSync(join(outside, 'state.json')));
});

test('latest checks stay at run level and incomplete task validation is explicit', t => {
  const { root } = fixture(t, [row], { tasks: [
    { status: 'done', validation: [{ passed: true }, { passed: false }, {}] },
    { status: 'blocked' },
  ] });
  const r = modelEvidence(root);
  assert.deepEqual(r.tasks.latest_checks, { passed: 1, failed: 1, unknown: 1, tasks_without_records: 1 });
  assert.ok(r.signals.includes('inspect_check_failures'));
  assert.ok(r.warnings.includes('incomplete_check_evidence'));
  assert.equal(r.groups[0].checks, undefined);
});

const attemptTask = attempts => ({ status: 'done', attempts, validation: [{ passed: true }] });
const unknownAttempts = { recorded_tasks: 0, unknown_tasks: 1, total_attempts: null, retried_tasks: null, extra_attempts: null };

test('valid task attempts are summed within the 0..5 budget, including boundaries', t => {
  const { root } = fixture(t, [row], { tasks: [0, 1, 2, 5].map(attemptTask) });
  const r = modelEvidence(root);
  assert.deepEqual(r.tasks, { total: 4, done: 4, blocked: 0, other: 0, latest_checks: { passed: 4, failed: 0, unknown: 0, tasks_without_records: 0 },
    attempts: { recorded_tasks: 4, unknown_tasks: 0, total_attempts: 8, retried_tasks: 2, extra_attempts: 5 } });
  assert.deepEqual(r.warnings, []);
  assert.ok(!r.signals.includes('measurement_gaps'));
  for (const [value, expected] of [[0, [0, 0, 0]], [5, [5, 1, 4]]]) {
    const one = fixture(t, [row], { tasks: [attemptTask(value)] });
    const [total_attempts, retried_tasks, extra_attempts] = expected;
    assert.deepEqual(modelEvidence(one.root).tasks.attempts, { recorded_tasks: 1, unknown_tasks: 0, total_attempts, retried_tasks, extra_attempts });
  }
});

test('invalid attempts and malformed tasks are unknown and never coerced', t => {
  const invalid = [undefined, null, '2', '0', true, false, -1, 1.5, 6, 2 ** 53, {}, [], [2], { value: 2 }];
  for (const value of invalid) {
    const { root } = fixture(t, [row], { tasks: [attemptTask(value)] });
    const r = modelEvidence(root);
    assert.deepEqual(r.tasks.attempts, unknownAttempts, JSON.stringify(value));
    assert.ok(r.warnings.includes('incomplete_attempt_evidence'));
  }
  for (const task of [null, 'task', 3, [], true]) {
    const { root } = fixture(t, [row], { tasks: [task] });
    const r = modelEvidence(root);
    assert.deepEqual(r.tasks.attempts, unknownAttempts, JSON.stringify(task));
    assert.equal(r.tasks.other, 1);
    assert.equal(r.tasks.latest_checks.tasks_without_records, 1);
  }
});

test('empty task list has zero attempt counts without an attempt warning', t => {
  const { root } = fixture(t, [row], { tasks: [] });
  const r = modelEvidence(root);
  assert.deepEqual(r.tasks.attempts, { recorded_tasks: 0, unknown_tasks: 0, total_attempts: 0, retried_tasks: 0, extra_attempts: 0 });
  assert.ok(!r.warnings.includes('incomplete_attempt_evidence'));
  assert.deepEqual(r.warnings, []);
});

test('all-unknown attempts report null sums instead of zeros', t => {
  const { root } = fixture(t, [row], { tasks: [attemptTask(null), attemptTask('3'), { status: 'blocked' }] });
  const r = modelEvidence(root);
  assert.deepEqual(r.tasks.attempts, { recorded_tasks: 0, unknown_tasks: 3, total_attempts: null, retried_tasks: null, extra_attempts: null });
  assert.ok(r.warnings.includes('incomplete_attempt_evidence'));
});

test('partial attempts report observed sums, explicit unknowns and count tasks without validation records', t => {
  const { root } = fixture(t, [row], { tasks: [
    attemptTask(3),
    { status: 'todo', attempts: 1 },
    attemptTask(null),
    { status: 'blocked', attempts: 2, validation: [{ passed: false }] },
  ] });
  const r = modelEvidence(root);
  assert.deepEqual(r.tasks.attempts, { recorded_tasks: 3, unknown_tasks: 1, total_attempts: 6, retried_tasks: 2, extra_attempts: 3 });
  assert.deepEqual(r.tasks.latest_checks, { passed: 2, failed: 1, unknown: 0, tasks_without_records: 1 });
  assert.deepEqual([r.tasks.total, r.tasks.done, r.tasks.blocked, r.tasks.other], [4, 2, 1, 1]);
  assert.ok(r.warnings.includes('incomplete_attempt_evidence'));
  assert.ok(r.warnings.includes('incomplete_check_evidence'));
  assert.ok(r.signals.includes('inspect_check_failures'));
});

test('missing attempts alone do not add measurement gaps, retry signals or change historical triage', t => {
  const legacy = fixture(t);
  const r = modelEvidence(legacy.root);
  assert.deepEqual(r.warnings, ['incomplete_attempt_evidence']);
  assert.deepEqual(r.signals, []);
  assert.deepEqual(evaluationPlan(legacy.root, ['F-test']).runs[0].blockers, []);
  const retried = fixture(t, [row], { tasks: [attemptTask(5)] });
  const known = modelEvidence(retried.root);
  assert.deepEqual(known.warnings, []);
  assert.deepEqual(known.signals, []);
  assert.deepEqual({ ...known, tasks: null, interpretation: null }, { ...r, tasks: null, warnings: [], interpretation: null });
  // Other warnings still produce measurement gaps alongside the attempt warning.
  const gaps = fixture(t, [{ ...row, reported_model: null }]);
  assert.ok(modelEvidence(gaps.root).signals.includes('measurement_gaps'));
});

test('missing, non-array or oversized task state still returns tasks:null without attempt accounting', t => {
  for (const tasks of [undefined, null, 'PRIVATE', {}, { length: 1 }, Array.from({ length: 31 }, () => attemptTask(1))]) {
    const { root } = fixture(t, [row], { tasks });
    const r = modelEvidence(root);
    assert.equal(r.tasks, null);
    assert.ok(r.warnings.includes('task_state_unavailable'));
    assert.ok(!r.warnings.includes('incomplete_attempt_evidence'));
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  }
  const { root } = fixture(t, [row], { tasks: Array.from({ length: 30 }, () => attemptTask(1)) });
  assert.equal(modelEvidence(root).tasks.attempts.recorded_tasks, 30);
});

test('attempt accounting exports only counts, never raw task content, and leaves files unchanged', t => {
  const { root } = fixture(t, [row], { tasks: [
    { ...attemptTask(2), id: 'PRIVATE_SENTINEL_ID', title: 'PRIVATE_SENTINEL_TITLE', review: { summary: 'PRIVATE_SENTINEL_REVIEW', findings: ['PRIVATE_SENTINEL'] },
      feedback: { summary: 'PRIVATE_SENTINEL_FEEDBACK' }, criteria: ['PRIVATE_SENTINEL'], files: ['PRIVATE_SENTINEL.mjs'] },
    attemptTask('PRIVATE_SENTINEL_ATTEMPTS'),
    attemptTask({ PRIVATE_SENTINEL: 1 }),
  ] });
  const before = snapshot(root), r = modelEvidence(root);
  assert.deepEqual(r.tasks.attempts, { recorded_tasks: 1, unknown_tasks: 2, total_attempts: 2, retried_tasks: 1, extra_attempts: 1 });
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  assert.match(r.interpretation, /attempts are latest per-task counters, not proof of bugs, autonomous fixes or model blame/);
  assert.match(r.interpretation, /Latest checks are not a check history/);
  assert.match(r.interpretation, /not a benchmark or model ranking/);
  assert.deepEqual(snapshot(root), before);
});

test('CLI reports current/archive evidence without invoking native providers or changing files', t => {
  const { root } = fixture(t), shims = join(root, 'shims'), marker = join(shims, 'called');
  mkdirSync(shims);
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(shims, name + '.cmd'), '@echo called> "' + marker + '"\r\n');
    writeFileSync(join(shims, name), '#!/bin/sh\necho called > "' + marker + '"\n');
    chmodSync(join(shims, name), 0o755);
  }
  const env = Object.fromEntries(Object.entries({ ...process.env, PATH: shims + delimiter + (process.env.PATH || process.env.Path || ''), Path: undefined }).filter(([, v]) => v !== undefined));
  const before = snapshot(root);
  for (const args of [[], ['--run', 'F-test']]) {
    const r = spawnSync(process.execPath, [resolve('bin/forja.mjs'), 'core', 'evidence', '--project', root, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), modelEvidence(root));
  }
  const bad = spawnSync(process.execPath, [resolve('bin/forja.mjs'), 'core', 'evidence', '--project', root, '--run'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim(), 'forja: Invalid model evidence options.');
  assert.equal(existsSync(marker), false);
  assert.deepEqual(snapshot(root), before);
});

test('real scheduler rejection and repair remain separate review responses after successful completion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forja-evidence-integration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fixture']]) {
    assert.equal(spawnSync('git', args, { cwd: root, windowsHide: true }).status, 0);
  }
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value=1;\n');
  assert.equal(spawnSync('git', ['add', '.gitignore', 'value.mjs'], { cwd: root, windowsHide: true }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root, windowsHide: true }).status, 0);
  const initial = createRun(root, { goal: 'Synthetic evidence test', provider: 'claude',
    config: { maxAttempts: 2, routes: {
      develop: { provider: 'claude', model: 'fixture-model', effort: 'high' },
      'develop.fast': { provider: 'claude', model: 'fixture-model', effort: 'medium' },
      review: { provider: 'claude', model: 'fixture-reviewer', effort: 'high' },
    } },
    plan: { decisions: [], tasks: [{ id: 'T1', title: 'Update value', criteria: ['value is 2'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [], checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] }] },
  });
  let reviews = 0;
  const done = await drive(root, { log: () => {},
    providerCall: async (provider, options) => {
      const review = options.readOnly;
      if (!review) writeFileSync(join(root, 'value.mjs'), 'export const value=2;\n');
      return { code: 0, duration_ms: 10, reported_model: options.model, usage: row.usage,
        result: { status: review ? (++reviews === 1 ? 'reject' : 'approve') : 'ready_for_validation', summary: 'Synthetic response', findings: [] } };
    },
    runCheck: async () => ({ code: 0, duration_ms: 1, stdout: '', stderr: '' }),
  });
  assert.equal(done.status, 'done');
  const before = snapshot(join(root, '.forja')), r = modelEvidence(root);
  assert.equal(r.coverage.recorded_invocations, 4);
  const review = r.groups.find(g => g.phase === 'review');
  assert.deepEqual(review.recorded_responses, { reject: 1, approve: 1 });
  assert.deepEqual(r.groups.filter(g => g.phase === 'develop').map(g => g.effort), ['medium', 'high']);
  assert.equal(r.tasks.done, 1);
  assert.equal(r.tasks.latest_checks.failed, 0);
  // One rejection led to a second implementation attempt; the counter is not a defect attribution.
  assert.deepEqual(r.tasks.attempts, { recorded_tasks: 1, unknown_tasks: 0, total_attempts: 2, retried_tasks: 1, extra_attempts: 1 });
  assert.ok(!r.warnings.includes('incomplete_attempt_evidence'));
  assert.ok(r.signals.includes('inspect_review_findings'));
  assert.deepEqual(modelEvidence(root, { runId: initial.run_id }), r);
  assert.deepEqual(snapshot(join(root, '.forja')), before);
});

test('whole-request budget leaves unavailable response evidence explicit', t => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ ...row, id: i + 1 }));
  const { root, dir } = fixture(t, rows, { invocations: 200, padding: 'x'.repeat(3 * 1024 * 1024) });
  writeFileSync(join(dir, 'usage.jsonl'), rows.map(JSON.stringify).join('\n') + '\n' + JSON.stringify({ id: 201, padding: 'x'.repeat(3 * 1024 * 1024) }));
  const response = JSON.stringify({ status: 'ready_for_validation', padding: 'x'.repeat(60000) });
  for (let id = 1; id <= 200; id++) writeFileSync(join(dir, 'call-' + id + '-result.json'), response);
  const r = modelEvidence(root);
  assert.ok(r.warnings.includes('response_read_budget'));
  assert.ok(r.warnings.includes('unexpected_invocation_id'));
  assert.ok(r.groups[0].missing_responses > 0);
  assert.ok(r.groups[0].recorded_responses.ready_for_validation < 200);
});
