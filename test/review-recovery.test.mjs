import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRun, current, drive } from '../lib/core/engine.mjs';

function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forja-review-recovery-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  for (const args of [['init', '-q'], ['add', '--', 'value.mjs', '.gitignore'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  createRun(root, { provider: 'custom', goal: 'Return two with reviewed source', plan: { decisions: [], tasks: [{
    id: 'T1', title: 'Return two', criteria: ['value equals two'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [],
    checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }],
  }] }, config: { maxAttempts: 1, ...config } });
  return root;
}
// The crashing controller runs as a child process. The test waits for its
// close event (explicit ordering, any machine speed); the test-level timeout
// is only a hang guard, never the reason a correct run fails.
const hangGuard = { timeout: 600_000 };
async function crashAfterApproval(t, root) {
  const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.renameSync;fs.renameSync=function(from,to,...args){const r=original.call(this,from,to,...args);if(String(to).endsWith('current.json')){const s=JSON.parse(fs.readFileSync(to));if(s.status==='running'&&s.tasks.length&&s.tasks.every(t=>t.status==='done'))process.exit(77);}return r;};syncBuiltinESMExports();
const {drive}=await import(${JSON.stringify(pathToFileURL(resolve('lib/core/engine.mjs')).href)});
await drive(${JSON.stringify(root)},{log:()=>{},providerCall:async(_,o)=>{if(!o.readOnly)fs.writeFileSync(${JSON.stringify(join(root, 'value.mjs'))},'export const value = 2;\\n');return {code:0,result:{status:o.readOnly?'approve':'done',summary:'Synthetic worker',findings:[]}};}});process.exit(78);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', d => { stderr += d; });
  const [code] = await once(child, 'close');
  assert.equal(code, 77, stderr);
  const state = JSON.parse(readFileSync(current(root)));
  assert.equal(state.status, 'running'); assert.equal(state.tasks[0].status, 'done');
  assert.equal(state.invocations, 2);
}

for (const changed of [false, true]) test(`resuming an approved task requires fresh review only for changed source (${changed})`, hangGuard, async t => {
  const root = fixture(t); await crashAfterApproval(t, root);
  if (changed) writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\nexport const additionalBehavior = true;\n');
  let reviews = 0;
  const done = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    assert.equal(options.readOnly, true); reviews++;
    return { code: 0, result: { status: 'approve', summary: 'Inspected current source', findings: [] } };
  } });
  assert.equal(done.status, 'done', done.failure);
  assert.equal(reviews, changed ? 1 : 0);
  assert.equal(done.invocations, changed ? 3 : 2);
  assert.equal(done.tasks[0].attempts, 1);
});

test('passing checks cannot hide rejection of post-approval source changes', hangGuard, async t => {
  const root = fixture(t); await crashAfterApproval(t, root);
  writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\nexport const unapprovedBehavior = true;\n');
  let reviews = 0;
  const stopped = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    assert.equal(options.readOnly, true); reviews++;
    return { code: 0, result: { status: 'reject', summary: 'Unapproved additional behavior', findings: ['value.mjs: additional export'] } };
  } });
  assert.equal(stopped.status, 'blocked');
  assert.equal(reviews, 1);
  assert.match(stopped.failure, /exhausted 1 implementation attempts/);
  assert.equal(stopped.tasks[0].validation[0].passed, true);
});

test('an exhausted session budget cannot reuse approval for changed source', hangGuard, async t => {
  const root = fixture(t, { maxSessions: 2 }); await crashAfterApproval(t, root);
  writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\nexport const additionalBehavior = true;\n');
  let calls = 0;
  const stopped = await drive(root, { log: () => {}, providerCall: async () => { calls++; return { code: 0 }; } });
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.failure, /Session budget exhausted/);
  assert.equal(stopped.tasks[0].status, 'review');
  assert.equal(stopped.invocations, 2); assert.equal(calls, 0);
});
