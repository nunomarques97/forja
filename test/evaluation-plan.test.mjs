import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluationPlan, cliEvaluationRuns } from '../lib/core/evaluation-plan.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-evaluation-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function archive(root, id, { rejection = false, failedCheck = false, state = {}, row = {} } = {}) {
  const dir = join(root, '.forja/runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, run_id: id, status: 'done', invocations: 1,
    tasks: [{ status: 'done', validation: [{ passed: !failedCheck }] }], goal: 'PRIVATE_GOAL', ...state }));
  writeFileSync(join(dir, 'usage.jsonl'), JSON.stringify({ id: 1, phase: 'review', provider: 'claude', model: 'fixture', reported_model: 'fixture',
    effort: 'high', result: 'returned', duration_ms: 10,
    usage: { input_tokens: 1, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, ...row }));
  writeFileSync(join(dir, 'call-1-result.json'), JSON.stringify({ status: rejection ? 'reject' : 'approve', findings: ['PRIVATE_FINDING'] }));
  return dir;
}
const snapshot = root => Object.fromEntries(readdirSync(root, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile()).map(e => { const file = join(e.parentPath, e.name); return [file, readFileSync(file).toString('base64')]; }));

test('healthy observations do not propose a model change or fabricate a comparison result', t => {
  const root = fixture(t), ids = ['F-a', 'F-b', 'F-c'];
  ids.forEach(id => archive(root, id));
  const r = evaluationPlan(root, ids);
  assert.deepEqual(r.actions, ['continue_observing']);
  assert.equal(r.comparison, null);
  assert.deepEqual(r.coverage, { selected: 3, available: 3, eligible: 3, concerning: 0 });
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|winner|quality_score|success_rate/);
});

test('a run counts once even with both rejection and failed checks; three distinct runs request investigation only', t => {
  const root = fixture(t), ids = ['F-a', 'F-b', 'F-c'];
  ids.forEach(id => archive(root, id, { rejection: true, failedCheck: true }));
  assert.equal(evaluationPlan(root, ids.slice(0, 2)).comparison, null);
  const r = evaluationPlan(root, ids);
  assert.equal(r.coverage.concerning, 3);
  assert.deepEqual(r.actions, ['investigate_quality']);
  assert.equal(r.comparison.status, 'draft_requires_investigation');
  assert.deepEqual(r.comparison.source_runs, ids);
  assert.ok(r.comparison.prerequisites.some(s => s.includes('correct reference') && s.includes('known defects')));
  assert.ok(r.comparison.prerequisites.some(s => s.includes('creative planning')));
  assert.ok(r.comparison.prerequisites.some(s => s.includes('content hashes')));
  assert.ok(r.comparison.decision_rules.some(s => s.includes('Never migrate active runs')));
  assert.equal(r.winner, undefined);
});

test('provider failures, incomplete records and active runs cannot contribute to the quality trigger', t => {
  const root = fixture(t);
  archive(root, 'F-good', { rejection: true });
  archive(root, 'F-limit', { row: { result: 'error', rate_limited: true } });
  archive(root, 'F-missing', { rejection: true, row: { reported_model: null } });
  archive(root, 'F-active', { rejection: true, state: { status: 'running' } });
  archive(root, 'F-blocked', { rejection: true, state: { status: 'blocked' } });
  const r = evaluationPlan(root, ['F-good', 'F-limit', 'F-missing', 'F-active', 'F-blocked']);
  assert.equal(r.coverage.eligible, 1);
  assert.equal(r.coverage.concerning, 1);
  assert.equal(r.comparison, null);
  assert.deepEqual(r.actions, ['finish_run', 'inspect_execution', 'repair_evidence', 'continue_observing']);
});

test('missing, corrupt and oversized archives remain visible without exposing raw errors', t => {
  const root = fixture(t);
  const broken = archive(root, 'F-broken');
  writeFileSync(join(broken, 'state.json'), 'PRIVATE_INVALID');
  const oversized = archive(root, 'F-large');
  writeFileSync(join(oversized, 'state.json'), 'x'.repeat(4 * 1024 * 1024 + 1));
  const r = evaluationPlan(root, ['F-absent', 'F-broken', 'F-large']);
  assert.deepEqual(r.coverage, { selected: 3, available: 0, eligible: 0, concerning: 0 });
  assert.ok(r.runs.every(run => run.status === 'unavailable'));
  assert.ok(r.actions.includes('repair_evidence'));
  assert.equal(r.comparison, null);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|ENOENT|SyntaxError/);
});

test('complete concerns can trigger a draft while unrelated unavailable runs stay explicit', t => {
  const root = fixture(t), ids = ['F-a', 'F-b', 'F-c'];
  ids.forEach(id => archive(root, id, { failedCheck: true }));
  const r = evaluationPlan(root, [...ids, 'F-missing']);
  assert.deepEqual(r.actions, ['repair_evidence', 'investigate_quality']);
  assert.deepEqual(r.comparison.source_runs, ids);
  assert.equal(r.coverage.selected, 4);
  assert.equal(r.coverage.eligible, 3);
});

test('selection rejects duplicates, traversal, whitespace, non-text, and unbounded lists before reading', () => {
  for (const ids of [undefined, null, {}, [], new Array(1), ['F-a', 'F-a'], ['../private'], ['F-a\n'], [' F-a'], [true],
    Array.from({ length: 11 }, (_, i) => 'F-' + i), ['F-' + 'x'.repeat(99)]]) {
    assert.throws(() => evaluationPlan('missing-project', ids), { message: 'Invalid evaluation run selection.' });
  }
  for (const value of [undefined, true, '', 'F-a,', 'F-a,F-a', 'F-a, F-b', 'x'.repeat(1010)]) {
    assert.throws(() => cliEvaluationRuns(value), { message: 'Invalid evaluation run selection.' });
  }
  assert.deepEqual(cliEvaluationRuns('F-b,F-a'), ['F-a', 'F-b']);
});

test('digest binds sanitized observations, stays stable under selection order, and never freezes raw findings', t => {
  const root = fixture(t);
  const dir = archive(root, 'F-a'); archive(root, 'F-b');
  const initial = evaluationPlan(root, ['F-a', 'F-b']);
  assert.deepEqual(evaluationPlan(root, ['F-b', 'F-a']), initial);
  writeFileSync(join(dir, 'call-1-result.json'), JSON.stringify({ status: 'approve', findings: ['CHANGED_PRIVATE'] }));
  assert.equal(evaluationPlan(root, ['F-a', 'F-b']).evidence_sha256, initial.evidence_sha256);
  writeFileSync(join(dir, 'call-1-result.json'), JSON.stringify({ status: 'reject', findings: ['CHANGED_PRIVATE'] }));
  assert.notEqual(evaluationPlan(root, ['F-a', 'F-b']).evidence_sha256, initial.evidence_sha256);
});

test('empty invocations or missing measurements do not look like healthy eligible evidence', t => {
  const root = fixture(t);
  archive(root, 'F-empty', { state: { invocations: 0 } });
  archive(root, 'F-tokens', { row: { usage: null } });
  archive(root, 'F-time', { row: { duration_ms: null } });
  const r = evaluationPlan(root, ['F-empty', 'F-tokens', 'F-time']);
  assert.equal(r.coverage.eligible, 0);
  assert.ok(r.runs.every(run => run.blockers.includes('repair_evidence')));
});

test('failed runs without a recorded cause request inspection rather than counting as healthy', t => {
  const root = fixture(t);
  archive(root, 'F-failed', { state: { status: 'failed' } });
  const r = evaluationPlan(root, ['F-failed']);
  assert.equal(r.coverage.eligible, 0);
  assert.deepEqual(r.actions, ['inspect_run_failure', 'continue_observing']);
  assert.equal(r.comparison, null);
});

test('CLI only reads selected archives and never invokes providers or writes project files', t => {
  const root = fixture(t), ids = ['F-a', 'F-b', 'F-c'];
  ids.forEach(id => archive(root, id, { rejection: true }));
  writeFileSync(join(root, '.forja/current.json'), 'PRIVATE_BAD_CURRENT');
  const shims = join(root, 'shims'), marker = join(shims, 'called'); mkdirSync(shims);
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(shims, name + '.cmd'), '@echo called> "' + marker + '"\r\n');
    writeFileSync(join(shims, name), '#!/bin/sh\necho called > "' + marker + '"\n');
    chmodSync(join(shims, name), 0o755);
  }
  const env = Object.fromEntries(Object.entries({ ...process.env, PATH: shims + delimiter + (process.env.PATH || process.env.Path || ''), Path: undefined }).filter(([, v]) => v !== undefined));
  const before = snapshot(root);
  const call = args => spawnSync(process.execPath, [resolve('bin/forja.mjs'), 'core', 'evaluation-plan', '--project', root, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const result = call(['--runs', ids.join(',')]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), evaluationPlan(root, ids));
  for (const args of [[], ['--runs'], ['--runs', 'F-a,F-a']]) {
    const bad = call(args);
    assert.equal(bad.status, 1);
    assert.equal(bad.stderr.trim(), 'forja: Invalid evaluation run selection.');
  }
  assert.equal(existsSync(marker), false);
  assert.deepEqual(snapshot(root), before);
});
