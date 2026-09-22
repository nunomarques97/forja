import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRun, drive, current, recoverRun } from '../lib/core/engine.mjs';
import { execute } from '../lib/core/providers.mjs';

const roots = [];
after(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture(config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forja-handoff-'));
  roots.push(root);
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'], ['add', '--', '.gitignore', 'value.mjs'], ['commit', '-qm', 'fixture']])
    execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  const check = { command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] };
  createRun(root, { goal: 'Return two', plan: { decisions: [], tasks: [{ id: 'T1', title: 'Return two', criteria: ['value equals 2'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [], checks: [check] }] }, config: { maxAttempts: 1, ...config } });
  return root;
}
const result = status => ({ code: 0, result: { status, summary: 'Implementation prepared; scheduled checks delegated to controller.', findings: [] }, duration_ms: 1 });
const implement = root => writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');

test('validation handoff runs task and caller checks before independent approval', async () => {
  const root = fixture({ finalChecks: [{ command: 'node', args: ['-e', "if(!require('fs').readFileSync('value.mjs','utf8').includes('2'))process.exit(1)"] }] });
  const order = [];
  const run = await drive(root, { log: () => {}, runCheck: async (...args) => { order.push('check'); return execute(...args); }, providerCall: async (_, options) => {
    if (!options.readOnly) { order.push('develop'); implement(root); return result('ready_for_validation'); }
    order.push('review');
    const ctx = JSON.parse(options.text), state = JSON.parse(readFileSync(current(root)));
    assert.equal(state.status, 'running');
    assert.equal(state.tasks[0].status, 'review');
    assert.equal(ctx.changes.validation.length, 2);
    assert.ok(ctx.changes.validation.every(v => v.passed && readFileSync(v.log, 'utf8') !== undefined));
    assert.equal(JSON.parse(readFileSync(ctx.feedback.developer_result)).status, 'ready_for_validation');
    return result('approve');
  } });
  assert.equal(run.status, 'done');
  assert.deepEqual(order, ['develop', 'check', 'check', 'review']);
  assert.equal(run.invocations, 2);
  assert.equal(run.tasks[0].attempts, 1);
  assert.equal(run.tasks[0].rotations, 0);
});

test('validation handoff cannot bypass failing checks or grant another attempt', async () => {
  const root = fixture(); let calls = 0;
  const run = await drive(root, { log: () => {}, providerCall: async () => { calls++; return result('ready_for_validation'); } });
  assert.equal(run.status, 'blocked');
  assert.equal(run.tasks[0].validation[0].passed, false);
  assert.match(run.failure, /exhausted 1 implementation attempts/);
  assert.equal(calls, 1);
  assert.equal(run.tasks[0].attempts, 1);
});

test('validation handoff preserves the source-integrity gate', async () => {
  const root = fixture(); let calls = 0;
  const run = await drive(root, { log: () => {}, providerCall: async () => { calls++; implement(root); return result('ready_for_validation'); }, runCheck: async () => {
    writeFileSync(join(root, 'value.mjs'), 'export const value = 3;\n');
    return { code: 0, stdout: 'claimed pass', duration_ms: 1 };
  } });
  assert.equal(run.status, 'blocked');
  assert.match(run.failure, /validation modified project files/);
  assert.equal(run.tasks[0].validation[0].passed, false);
  assert.match(readFileSync(join(root, 'value.mjs'), 'utf8'), /3/);
  assert.equal(calls, 1);
});

test('reviewer handoff is not approval even after passing checks', async () => {
  const root = fixture();
  const run = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    if (!options.readOnly) implement(root);
    return result('ready_for_validation');
  } });
  assert.equal(run.status, 'blocked');
  assert.match(run.failure, /review did not approve or reject/);
  assert.equal(run.tasks[0].validation[0].passed, true);
  assert.equal(run.tasks[0].status, 'blocked');
});

test('interrupted controller validation resumes without another developer', async () => {
  const root = fixture(); let developers = 0, reviewers = 0;
  const providerCall = async (_, options) => {
    if (!options.readOnly) { developers++; implement(root); return result('ready_for_validation'); }
    reviewers++; return result('approve');
  };
  const first = await drive(root, { log: () => {}, providerCall, runCheck: async () => { throw new Error('fixture interruption'); } });
  assert.equal(first.status, 'blocked');
  assert.equal(first.tasks[0].status, 'validate');
  recoverRun(root, { action: 'resume', reason: 'Resume interrupted validation' });
  const resumed = await drive(root, { log: () => {}, providerCall });
  assert.equal(resumed.status, 'done');
  assert.equal(developers, 1);
  assert.equal(reviewers, 1);
  assert.equal(resumed.invocations, 2);
});
