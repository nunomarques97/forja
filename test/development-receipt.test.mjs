import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRun, current, drive, recoverRun, validateState } from '../lib/core/engine.mjs';

const task = () => ({ id: 'T1', title: 'Return two', criteria: ['value equals two'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [], checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }] });
const result = status => ({ code: 0, result: { status, summary: 'Synthetic worker', findings: [] } });
function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forja-receipt-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  for (const args of [['init', '-q'], ['add', '--', 'value.mjs', '.gitignore'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  createRun(root, { provider: 'custom', goal: 'Return two', plan: { decisions: [], tasks: [task()] }, config: { maxAttempts: 1, ...config } });
  return root;
}
function crash(root, status = 'ready_for_validation', { point = 'result', technology, replay = false } = {}) {
  // Abrupt exit after call() publishes the final result, before its awaiting
  // scheduler continuation can publish the task transition. No catch/finally.
  const src = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.renameSync;fs.renameSync=function(from,to,...args){const r=original.call(this,from,to,...args);if(${JSON.stringify(point)}==='receipt'&&String(to).endsWith('current.json')&&JSON.parse(fs.readFileSync(to)).developmentReceipt)process.exit(77);if(${JSON.stringify(point)}==='result'&&String(to).endsWith('call-1-result.json'))queueMicrotask(()=>process.exit(77));return r;};syncBuiltinESMExports();
const {drive}=await import(${JSON.stringify(pathToFileURL(resolve('lib/core/engine.mjs')).href)});
await drive(${JSON.stringify(root)},{log:()=>{},providerCall:async()=>{if(${JSON.stringify(replay)})process.exit(79);fs.writeFileSync(${JSON.stringify(join(root, 'value.mjs'))},'export const value = 2;\\n');return ${JSON.stringify({ ...result(status), result: { ...result(status).result, ...(technology ? { technology } : {}) } })};}});process.exit(78);`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', src], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 77, child.stderr);
  const state = JSON.parse(readFileSync(current(root), 'utf8'));
  assert.equal(state.status, 'running');
  assert.equal(state.tasks[0].status, 'develop');
  assert.equal(state.tasks[0].attempts, 1);
  assert.equal(state.invocations, 1);
  return state;
}

for (const status of ['ready_for_validation', 'done']) test(`abrupt death after ${status} replays the handoff without another developer`, async t => {
  const root = fixture(t); crash(root, status); let reviews = 0;
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => { assert.equal(options.readOnly, true); reviews++; return result('approve'); } });
  assert.equal(done.status, 'done', done.failure);
  assert.equal(done.invocations, 2);
  assert.equal(done.tasks[0].attempts, 1);
  assert.equal(done.tasks[0].validation[0].passed, true);
  assert.equal(reviews, 1);
  assert.equal(done.developmentReceipt, undefined);
});

test('receipt survives death before the result artifact and recreates it for review', async t => {
  const root = fixture(t), state = crash(root, 'done', { point: 'receipt' });
  const path = join(root, '.forja/runs', state.run_id, 'call-1-result.json');
  assert.equal(existsSync(path), false);
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    assert.equal(options.readOnly, true);
    assert.equal(JSON.parse(readFileSync(path)).status, 'done');
    return result('approve');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.equal(done.invocations, 2);
});

test('a second death during replay preserves the handoff and counters', async t => {
  const root = fixture(t); crash(root); crash(root, 'ready_for_validation', { replay: true });
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    assert.equal(options.readOnly, true); return result('approve');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.equal(done.invocations, 2); assert.equal(done.tasks[0].attempts, 1);
});

for (const change of ['source', 'head']) test(`changed ${change} blocks replay without another provider`, async t => {
  const root = fixture(t); crash(root);
  if (change === 'source') writeFileSync(join(root, 'value.mjs'), 'export const value = 3;\n');
  else execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'Changed HEAD'], { cwd: root, windowsHide: true });
  let calls = 0;
  const stopped = await drive(root, { log: () => {}, providerCall: async () => { calls++; return result('approve'); } });
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.failure, /receipt no longer matches/);
  assert.equal(calls, 0);
  assert.equal(stopped.invocations, 1);
  assert.ok(stopped.developmentReceipt);
  assert.equal(readFileSync(join(root, 'value.mjs'), 'utf8'), `export const value = ${change === 'source' ? 3 : 2};\n`);
});

for (const validateOnly of [true, false]) test(`explicit retry discards receipt (validateOnly=${validateOnly})`, async t => {
  const root = fixture(t); crash(root);
  const recovered = recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'Inspect preserved work', validateOnly, limits: { attempts: 2 } });
  assert.equal(recovered.developmentReceipt, undefined);
  const phases = [];
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    phases.push(options.readOnly ? 'review' : 'develop');
    return result(options.readOnly ? 'approve' : 'done');
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.deepEqual(phases, validateOnly ? ['review'] : ['develop', 'review']);
  assert.equal(done.tasks[0].attempts, validateOnly ? 1 : 2);
});

test('replayed handoff still respects the session budget for independent review', async t => {
  const root = fixture(t, { maxSessions: 1 }); crash(root);
  let calls = 0;
  const stopped = await drive(root, { log: () => {}, providerCall: async () => { calls++; return result('approve'); } });
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.failure, /Session budget exhausted/);
  assert.equal(stopped.tasks[0].status, 'review');
  assert.equal(stopped.tasks[0].validation[0].passed, true);
  assert.equal(stopped.invocations, 1); assert.equal(calls, 0);
  assert.equal(stopped.developmentReceipt, undefined);
});

test('malformed or mismatched receipt is rejected; legacy state remains accepted', t => {
  const root = fixture(t), state = crash(root);
  for (const mutate of [r => r.version++, r => r.task = 'missing', r => r.attempt++, r => r.invocation++, r => r.tree = 'invalid', r => r.head = '', r => r.result.status = 'approve', r => r.result.findings = ['x'.repeat(12001)]]) {
    const invalid = structuredClone(state); mutate(invalid.developmentReceipt);
    assert.throws(() => validateState(invalid, root));
  }
  delete state.developmentReceipt;
  assert.doesNotThrow(() => validateState(state, root));
});

test('legacy raw result alone does not authorize replay', async t => {
  const root = fixture(t), state = crash(root); delete state.developmentReceipt;
  writeFileSync(current(root), JSON.stringify(state));
  const stopped = await drive(root, { log: () => {}, providerCall: () => assert.fail('Unexpected provider') });
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.failure, /exhausted 1 implementation attempts/);
  assert.equal(stopped.invocations, 1);
});

test('a paid option in the replayed handoff pauses for Sponsor exactly once', async t => {
  const root = fixture(t);
  const technology = [{ capability: 'Formatting', constraints: 'Local output', options: [
    { id: 'free', name: 'Built-in formatter', cost: 'free', cost_basis: 'Included', tradeoffs: 'Local maintenance', evidence: ['value.mjs'] },
    { id: 'paid', name: 'Commercial formatter', cost: 'paid', cost_basis: 'Subscription', tradeoffs: 'Vendor dependency', evidence: ['https://example.invalid/catalog'] },
  ], recommended: 'free', rationale: 'Meets requirements' }];
  crash(root, 'ready_for_validation', { technology });
  for (const validateOnly of [true, false]) assert.throws(() => recoverRun(root, {
    action: 'retry', taskId: 'T1', reason: 'Inspect preserved work', validateOnly, limits: { attempts: 2 },
  }), /process technology choices/);
  let notices = 0, calls = 0;
  const options = { log: () => {}, notifySponsor: async () => { notices++; return { ok: true }; }, providerCall: async () => { calls++; return result('approve'); } };
  const stopped = await drive(root, options);
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.failure, /Sponsor/);
  assert.equal(stopped.technology[0].selection, null);
  assert.equal(stopped.developmentReceipt, undefined);
  await drive(root, options);
  assert.equal(notices, 1); assert.equal(calls, 0);
});
