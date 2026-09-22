import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRun, drive, current } from '../lib/core/engine.mjs';

const check = code => ({ command: 'node', args: ['-e', code] });
const valueCheck = check("if(require('fs').readFileSync('value.txt','utf8')!=='2')process.exit(1)");
const task = (id = 'T1', checks = [valueCheck]) => ({
  id, title: 'Produce the accepted value', criteria: ['value is two'],
  files: ['value.txt'], risks: [], complexity: 'easy', after: [], checks,
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-check-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.gitignore'), '.forja/\nartifacts/\n');
  writeFileSync(join(root, 'value.txt'), '1');
  for (const args of [['init', '-q'], ['add', '--', '.gitignore', 'value.txt'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']])
    execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}
function worker(root, phases) {
  return async (_, options) => {
    const ctx = JSON.parse(options.text);
    phases.push(`${ctx.phase}:${ctx.task.id}`);
    if (ctx.phase === 'develop') {
      if (ctx.task.id === 'T1') writeFileSync(join(root, 'value.txt'), '2');
      else writeFileSync(join(root, 'second.txt'), 'Accepted second task');
    }
    return { code: 0, result: { status: ctx.phase === 'review' ? 'approve' : 'done', summary: 'Synthetic worker', findings: [], technology: [] } };
  };
}

for (const exitCode of [0, 1]) test(`a check changing source with exit ${exitCode} stops before review or automatic repair`, async t => {
  const root = fixture(t), phases = [];
  const mutate = check(`require('fs').writeFileSync('value.txt','9'); console.log('mutation preserved'); process.exit(${exitCode})`);
  const restore = check("require('fs').writeFileSync('value.txt','2')");
  createRun(root, { goal: 'Validate one unchanged source version', plan: { decisions: [], tasks: [task('T1', [valueCheck, mutate, restore])] } });
  const stopped = await drive(root, { log: () => {}, providerCall: worker(root, phases) });
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.failure, /validation modified project files/i);
  assert.deepEqual(phases, ['develop:T1']);
  assert.equal(readFileSync(join(root, 'value.txt'), 'utf8'), '9');
  assert.equal(stopped.tasks[0].status, 'validate');
  assert.equal(stopped.tasks[0].validation.length, 2);
  assert.equal(stopped.tasks[0].validation[1].passed, false);
  assert.match(readFileSync(stopped.tasks[0].validation[1].log, 'utf8'), /mutation preserved/);
  assert.equal(stopped.tasks[0].validated_tree, undefined);
  assert.equal(JSON.parse(readFileSync(current(root))).status, 'blocked');
});

for (const exitCode of [0, 1]) test(`final regression changing source with exit ${exitCode} stops before another check or paid repair`, async t => {
  const root = fixture(t), phases = [];
  // First invocation validates T1. The second, after T2, changes the source.
  const mutateOnRepeat = check(`const fs=require('fs'); const repeated=fs.existsSync('.forja/check-ran'); fs.writeFileSync('.forja/check-ran','yes'); if(repeated){fs.writeFileSync('value.txt','9'); console.log('final mutation preserved'); process.exit(${exitCode});}`);
  const restoreOnRepeat = check("const fs=require('fs'); if(fs.readFileSync('value.txt','utf8')==='9'){fs.writeFileSync('value.txt','2'); fs.writeFileSync('.forja/restore-ran','yes');}");
  const second = { ...task('T2', [check("if(!require('fs').existsSync('second.txt'))process.exit(1)")]), files: ['second.txt'], after: ['T1'] };
  createRun(root, { goal: 'Preserve final acceptance evidence', plan: { decisions: [], tasks: [task('T1', [valueCheck, mutateOnRepeat, restoreOnRepeat]), second] } });
  const stopped = await drive(root, { log: () => {}, providerCall: worker(root, phases) });
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.failure, /final validation modified project files/i);
  assert.deepEqual(phases, ['develop:T1', 'review:T1', 'develop:T2', 'review:T2']);
  assert.equal(readFileSync(join(root, 'value.txt'), 'utf8'), '9');
  assert.equal(existsSync(join(root, '.forja/restore-ran')), false);
  assert.match(readFileSync(join(root, '.forja/runs', stopped.run_id, 'T1-final-check-1.log'), 'utf8'), /final mutation preserved/);
});

test('ignored check artifacts remain allowed without changing source evidence', async t => {
  const root = fixture(t), phases = [];
  const artifact = check("const fs=require('fs');fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/result.txt','pass')");
  createRun(root, { goal: 'Allow generated validation output', plan: { decisions: [], tasks: [task('T1', [valueCheck, artifact])] } });
  const done = await drive(root, { log: () => {}, providerCall: worker(root, phases) });
  assert.equal(done.status, 'done');
  assert.deepEqual(phases, ['develop:T1', 'review:T1']);
  assert.equal(done.tasks[0].validation.every(v => v.passed), true);
  assert.equal(readFileSync(join(root, 'artifacts/result.txt'), 'utf8'), 'pass');
});

test('new non-ignored files from a check invalidate acceptance too', async t => {
  const root = fixture(t), phases = [];
  const generatedSource = check("require('fs').writeFileSync('generated.mjs','export const value = 9;')");
  createRun(root, { goal: 'Validate the complete source surface', plan: { decisions: [], tasks: [task('T1', [valueCheck, generatedSource])] } });
  const stopped = await drive(root, { log: () => {}, providerCall: worker(root, phases) });
  assert.equal(stopped.status, 'blocked');
  assert.match(stopped.failure, /validation modified project files/i);
  assert.deepEqual(phases, ['develop:T1']);
  assert.equal(readFileSync(join(root, 'generated.mjs'), 'utf8'), 'export const value = 9;');
});
