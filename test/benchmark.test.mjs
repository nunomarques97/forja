import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { benchmarkConfig, benchmarkSchedule, benchmarkDecision, runBenchmark, loadBenchmarkConfig, benchmarkOracle } from '../lib/core/benchmark.mjs';
import { benchmarkTelemetry } from '../lib/core/benchmark-provider.mjs';
import { invocation } from '../lib/core/providers.mjs';
import { reference, reviewCases, tasks } from '../lib/core/benchmark-fixtures.mjs';

const config = { version: 1, baseline: { model: 'claude-fixture', effort: 'high' }, candidate: { model: 'claude-fixture', effort: 'medium' },
  tasks: ['review'], repetitions: 3, maxCalls: 6, maxDurationMs: 600000, timeoutMs: 30000,
  checkIsolation: { backend: 'bubblewrap', ...(process.platform === 'win32' ? { distribution: 'Ubuntu' } : {}) } };
const response = task => task === 'implement' ? { source: reference, explanation: 'fixture' } : task === 'review' ?
  { verdicts: reviewCases.map(c => ({ id: c.id, approve: c.valid, reason: 'fixture' })) } :
  { directions: Array.from({ length: 3 }, () => Object.fromEntries(Object.keys(tasks.plan.schema.properties.directions.items.properties).map(k => [k, 'fixture']))),
    decision: Object.fromEntries(Object.keys(tasks.plan.schema.properties.decision.properties).map(k => [k, 'fixture'])) };
function harness(t, changes = {}) {
  return {
    accessCheck: async () => ({ command: 'fixture', version: 'fixture-v1' }), isolationCheck: async () => {},
    check: async (command, args, { cwd }) => {
      const source = readFileSync(join(cwd, 'candidate.py'), 'utf8');
      const valid = reviewCases.some(c => c.valid && c.source === source);
      return { code: valid ? 0 : 1, stdout: valid ? 'FORJA_ORACLE_PASS_V1\n' : '', timedOut: false, overflow: false };
    },
    providerCall: async options => {
      const task = options.input.startsWith('Blind') ? 'review' : options.input.startsWith('Creative') ? 'plan' : 'implement';
      return { code: 0, result: response(task), reported_model: options.model, duration_ms: 10,
        usage: { input_tokens: 1, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
        benchmark: { quota_observed: true }, ...changes.value };
    },
    onProgress: event => assert.ok(Number.isSafeInteger(event.id)),
    ...changes.deps,
  };
}
async function run(t, value = config, changes = {}) {
  const r = await runBenchmark(value, harness(t, changes));
  t.after(() => rmSync(r.directory, { recursive: true, force: true }));
  return r;
}

test('benchmark rejects weak budgets, implicit profiles, arbitrary provider settings and sparse selections before calls', async t => {
  for (const patch of [{ repetitions: 1 }, { maxCalls: 5 }, { tasks: new Array(1) }, { tasks: ['review', 'review'] }, { tasks: ['__proto__'] },
    { timeoutMs: 0 }, { checkIsolation: undefined }, { candidate: config.baseline }, { version: 2 }, { fullAccess: true }, { baseline: { ...config.baseline, args: ['--unsafe'] } }]) {
    let called = false;
    await assert.rejects(runBenchmark({ ...config, ...patch }, { accessCheck: async () => { called = true; } }), /Invalid benchmark configuration/);
    assert.equal(called, false);
  }
  assert.deepEqual(benchmarkConfig(config), config);
});

test('schedule alternates paired candidates, preserves all repeats and separates task roles', () => {
  const slots = benchmarkSchedule({ ...config, tasks: ['review', 'implement'] });
  assert.equal(slots.length, 12);
  assert.deepEqual(slots.slice(0, 6).map(s => [s.repeat, s.task, s.profile]), [
    [1, 'review', 'baseline'], [1, 'review', 'candidate'], [1, 'implement', 'baseline'], [1, 'implement', 'candidate'], [2, 'review', 'candidate'], [2, 'review', 'baseline'],
  ]);
});

test('simulated end-to-end battery freezes inputs, validates controls and cannot recommend a native profile change', async t => {
  const r = await run(t, { ...config, tasks: ['implement', 'review', 'plan'], maxCalls: 18 });
  assert.equal(r.mode, 'simulated');
  assert.equal(r.status, 'complete');
  assert.equal(r.attempts.length, 18);
  assert.equal(r.controls.length, 8);
  assert.ok(r.controls.every(c => c.passed === c.expected_pass));
  assert.equal(r.decision.reason, 'simulated_execution');
  assert.ok(r.attempts.filter(a => a.task === 'plan').every(a => a.grade.status === 'manual_review_required'));
  assert.ok(r.attempts.filter(a => a.task !== 'plan').every(a => a.grade.status === 'pass'));
  const protocol = JSON.parse(readFileSync(join(r.directory, 'protocol.json')));
  assert.equal(protocol.source_hashes['benchmark-fixtures.mjs'].length, 64);
  assert.equal(protocol.schedule.length, 18);
  assert.equal(readFileSync(join(r.directory, 'attempts.jsonl'), 'utf8').trim().split('\n').length, 18);
  assert.deepEqual(JSON.parse(readFileSync(join(r.directory, 'report.json'))), r);
});

test('a broken oracle control aborts before any model call, without host fallback', async t => {
  let calls = 0;
  const r = await run(t, config, { deps: { check: async () => ({ code: 0, stdout: 'FORJA_ORACLE_PASS_V1', timedOut: false, overflow: false }), providerCall: async () => { calls++; } } });
  assert.equal(calls, 0);
  assert.equal(r.stop_reason, 'oracle_controls_failed');
  assert.equal(r.decision.recommendation, 'insufficient_evidence');
});

test('incorrect or malformed responses remain failures and do not cause retries or selective early stopping', async t => {
  const value = response('review'); value.verdicts.find(v => v.id === 'B').approve = true;
  const r = await run(t, config, { value: { result: value } });
  assert.equal(r.status, 'complete');
  assert.equal(r.attempts.length, 6);
  assert.ok(r.attempts.every(a => a.grade.status === 'fail' && a.grade.false_approvals === 1));
  const malformed = await run(t, config, { value: { result: { verdicts: Array(8).fill({ id: 'A', approve: true, reason: 'fixture' }) } } });
  assert.ok(malformed.attempts.every(a => a.grade.reason === 'invalid_response'));
});

test('access, quota, unauthorized tools and model identity errors stop after the first recorded attempt', async t => {
  for (const [value, reason] of [
    [{ code: 1, error: 'PRIVATE_ERROR' }, 'provider_error'], [{ timedOut: true }, 'timeout'],
    [{ benchmark: { stop_for_quota: true } }, 'quota_guard'], [{ benchmark: { unauthorized_tools: true } }, 'unauthorized_tools'],
    [{ reported_model: 'different-model' }, 'unconfirmed_model_identity'],
  ]) {
    const r = await run(t, config, { value });
    assert.equal(r.stop_reason, reason);
    assert.equal(r.attempts.length, 1);
    assert.equal(r.decision.recommendation, 'insufficient_evidence');
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE_ERROR/);
  }
});

test('frozen protocol changes stop subsequent calls and preserve the existing attempt', async t => {
  let folder;
  const base = harness(t);
  const r = await run(t, config, { deps: { providerCall: async options => {
    folder = resolve(options.cwd, '..', '..');
    const v = await base.providerCall(options);
    writeFileSync(join(folder, 'protocol.json'), '{}');
    return v;
  } } });
  assert.equal(r.stop_reason, 'frozen_input_changed');
  assert.equal(r.attempts.length, 1);
});

test('native decision needs complete matched evidence and never prefers speed over failed correctness', () => {
  const attempts = benchmarkSchedule(config).map(s => ({ ...s, execution: 'returned', identity_confirmed: true, duration_ms: 10, input_tokens: 1, output_tokens: 2, grade: { status: 'pass' } }));
  const decide = (rows, extra = {}) => benchmarkDecision(config, rows, { complete: true, mode: 'native', ...extra });
  assert.equal(decide(attempts).recommendation, 'retain_baseline');
  const failCandidate = attempts.map(a => ({ ...a, duration_ms: a.profile === 'candidate' ? 1 : 100, grade: { status: a.profile === 'candidate' ? 'fail' : 'pass' } }));
  assert.equal(decide(failCandidate).recommendation, 'retain_baseline');
  assert.equal(decide(attempts.map(a => ({ ...a, grade: { status: a.profile === 'baseline' ? 'fail' : 'pass' } }))).recommendation, 'propose_profile_change');
  assert.equal(decide(attempts.map(a => ({ ...a, grade: { status: 'fail' } }))).recommendation, 'insufficient_evidence');
  for (const bad of [attempts.slice(1), [...attempts].reverse(), attempts.map(a => ({ ...a, input_tokens: null })), attempts.map(a => ({ ...a, identity_confirmed: false }))])
    assert.equal(decide(bad).recommendation, 'insufficient_evidence');
  const creativeConfig = { ...config, tasks: ['plan'] };
  const creative = attempts.map(a => ({ ...a, task: 'plan' }));
  assert.equal(benchmarkDecision(creativeConfig, creative, { complete: true, mode: 'native' }).reason, 'creative_assessment_required');
});

test('check infrastructure failure retains the completed provider call and does not become a quality failure', async t => {
  const base = harness(t);
  const r = await run(t, { ...config, tasks: ['implement'] }, { deps: { check: async (...args) => {
    if (args[2].cwd.includes('call-')) throw Error('PRIVATE_FAILURE');
    return base.check(...args);
  } } });
  assert.equal(r.stop_reason, 'check_infrastructure_failure');
  assert.equal(r.attempts.length, 1);
  assert.equal(r.attempts[0].grade.status, 'unavailable');
  assert.equal(r.decision.recommendation, 'insufficient_evidence');
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_FAILURE/);
});

test('the last provider call cannot change the frozen protocol and still complete successfully', async t => {
  const base = harness(t); let calls = 0;
  const r = await run(t, config, { deps: { providerCall: async options => {
    const result = await base.providerCall(options);
    if (++calls === 6) writeFileSync(resolve(options.cwd, '../../protocol.json'), '{}');
    return result;
  } } });
  assert.equal(r.attempts.length, 6);
  assert.equal(r.status, 'incomplete');
  assert.equal(r.stop_reason, 'frozen_input_changed');
});

test('response-only adapter removes external tools and rejects incompatible provider policies', t => {
  const root = mkdtempSync(join(tmpdir(), 'forja-benchmark-adapter-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'schema.json'), '{}'); writeFileSync(join(root, 'mcp.json'), '{"mcpServers":{}}');
  const options = { readOnly: true, responseOnly: true, scratchPath: root, schemaPath: join(root, 'schema.json'), mcpPath: join(root, 'mcp.json'), config: { command: 'fixture', writePolicy: 'restricted' } };
  const spec = invocation('claude', options);
  assert.equal(spec.args[spec.args.indexOf('--tools') + 1], '');
  assert.ok(!spec.args.includes('--allowedTools'));
  assert.ok(spec.args.includes('--safe-mode'));
  assert.throws(() => invocation('claude', { ...options, readOnly: false }), /Response-only/);
  assert.throws(() => invocation('claude', { ...options, config: { command: 'fixture' } }), /Response-only/);
  assert.deepEqual(benchmarkTelemetry('null\n{broken\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })), { stop_for_quota: false, quota_observed: false, unauthorized_tools: true });
  assert.equal(benchmarkTelemetry(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: .96 } } } })).stop_for_quota, true);
});

test('CLI refuses missing/oversized/unsafe config before native calls and leaves the selected project intact', t => {
  const root = mkdtempSync(join(tmpdir(), 'forja-benchmark-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.forja')); writeFileSync(join(root, '.forja/current.json'), 'PRIVATE_CURRENT');
  const path = join(root, 'config.json'); writeFileSync(path, JSON.stringify({ ...config, fullAccess: true }));
  const r = spawnSync(process.execPath, [resolve('bin/forja.mjs'), 'core', 'benchmark', '--project', root, '--config', path], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /Invalid benchmark configuration/);
  assert.equal(readFileSync(join(root, '.forja/current.json'), 'utf8'), 'PRIVATE_CURRENT');
  assert.deepEqual(readdirSync(root).sort(), ['.forja', 'config.json']);
  writeFileSync(path, 'x'.repeat(65537)); assert.throws(() => loadBenchmarkConfig(path), /Invalid benchmark configuration/);
});

test('real isolated oracle accepts every correct control, rejects every defect and rejects premature exit zero', {
  skip: !process.env.FORJA_TEST_CHECK_ISOLATION && 'Requires the existing opt-in bubblewrap/WSL test environment.',
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'forja-benchmark-oracle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = { ...config, checkIsolation: { backend: 'bubblewrap', ...(process.platform === 'win32' ? { distribution: process.env.FORJA_TEST_CHECK_ISOLATION } : {}) } };
  for (const c of reviewCases) {
    const r = await benchmarkOracle(c.source, join(root, c.id), settings);
    assert.equal(r.passed, c.valid, c.id);
    assert.equal(r.timed_out, false);
  }
  assert.equal((await benchmarkOracle('raise SystemExit(0)', join(root, 'exit'), settings)).passed, false);
});
