import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRun, drive, current, recoverRun, readChecksFile, replacementChecks } from '../lib/core/engine.mjs';
import { recoveryInfo } from '../lib/core/recovery.mjs';

const cli = fileURLToPath(new URL('../bin/forja.mjs', import.meta.url));
const check = code => ({ command: 'node', args: ['-e', code] });
const valueCheck = check("if(require('fs').readFileSync('value.txt','utf8')!=='2')process.exit(1)");
// Regenerates "screenshots" into the project, like the check of issue #24.
const screens = n => check(`const fs=require('fs');fs.mkdirSync('docs/screens',{recursive:true});for(let i=0;i<${n};i++)fs.writeFileSync('docs/screens/s'+String(i).padStart(2,'0')+'.png','x'+Date.now())`);
const task = (id, checks, extra = {}) => ({
  id, title: 'Produce the accepted value', criteria: ['value is two'],
  files: ['value.txt'], risks: [], complexity: 'easy', after: [], checks, ...extra,
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-check-writes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.txt'), '1');
  for (const args of [['init', '-q'], ['add', '--', '.gitignore', 'value.txt'],
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']])
    execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}
function worker(root, phases = []) {
  return async (_, options) => {
    const ctx = JSON.parse(options.text);
    phases.push(`${ctx.phase}:${ctx.task.id}`);
    if (ctx.phase === 'develop') {
      if (ctx.task.id === 'T1') writeFileSync(join(root, 'value.txt'), '2');
      else writeFileSync(join(root, 'second.txt'), 'Accepted second task');
    }
    return { code: 0, result: { status: ctx.phase === 'review' ? 'approve' : 'ready_for_validation', summary: 'Synthetic worker', findings: [], technology: [] } };
  };
}
const state = root => JSON.parse(readFileSync(current(root), 'utf8'));
const recoveryLog = (root, run) => join(root, '.forja', 'runs', run.run_id, 'recovery.jsonl');
const writeJson = (root, name, value) => {
  const path = join(root, '.forja', name);
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};

async function blockedOnWriter(t, n = 2) {
  const root = fixture(t);
  createRun(root, { goal: 'Accept the value', plan: { decisions: [], tasks: [task('T1', [valueCheck, screens(n)])] } });
  const run = await drive(root, { log: () => {}, providerCall: worker(root) });
  assert.equal(run.status, 'blocked');
  return { root, run };
}

test('the planner is told that checks are read-only verifiers', async t => {
  const root = fixture(t);
  createRun(root, { goal: 'Accept the value' });
  let prompt = '';
  await drive(root, { log: () => {}, providerCall: async (_, options) => {
    prompt = options.prompt;
    return { code: 0, result: { status: 'blocked', summary: 'stop', findings: [] } };
  } });
  assert.match(prompt, /Checks must be read-only verifiers/);
  assert.match(prompt, /artifact, screenshot or report generators/);
  assert.match(prompt, /creates or modifies non-ignored files inside the project/);
});

test('a writing task check blocks with the task, check, command and changed paths', async t => {
  const { root, run } = await blockedOnWriter(t);
  assert.equal(run.stopCode, 'check_writes');
  assert.match(run.failure, /^Deterministic validation modified project files; changes preserved\./);
  assert.match(run.failure, /Task T1 checks\[1\] ran \["node","-e","const fs=require/);
  assert.match(run.failure, /changed 2 path\(s\): docs\/screens\/s00\.png, docs\/screens\/s01\.png\./);
  assert.match(run.failure, /core retry --task T1 --checks-file <file\.json> --validate-only/);
  const entry = run.tasks[0].validation[1];
  assert.equal(entry.passed, false);
  assert.deepEqual(entry.changed_paths, ['docs/screens/s00.png', 'docs/screens/s01.png']);
  assert.equal(entry.changed_total, 2);
  assert.equal(run.tasks[0].validation[0].changed_paths, undefined);
  assert.equal(run.tasks[0].status, 'validate');
  assert.equal(run.tasks[0].attempts, 1);
  const recovery = recoveryInfo(state(root));
  assert.equal(recovery.code, 'check_writes');
  assert.match(recovery.guidance, /read-only verifier/);
  assert.match(recovery.guidance, /Writing check: task T1 checks\[1\], 2 changed path\(s\)\. Replace with: core retry --task T1 --checks-file/);
});

test('the changed path list is bounded and keeps the total count', async t => {
  const { run } = await blockedOnWriter(t, 25);
  const entry = run.tasks[0].validation[1];
  assert.equal(entry.changed_paths.length, 20);
  assert.equal(entry.changed_total, 25);
  assert.match(run.failure, /changed 25 path\(s\): .*docs\/screens\/s19\.png, and 5 more\./);
  assert.doesNotMatch(run.failure, /s20\.png/);
});

test('a writing check in the final regression names the done task and how to reopen it', async t => {
  const root = fixture(t);
  const writesOnRepeat = check("const fs=require('fs');if(fs.existsSync('.forja/ran')){fs.writeFileSync('report.md','generated')}fs.writeFileSync('.forja/ran','1')");
  const second = task('T2', [check("if(!require('fs').existsSync('second.txt'))process.exit(1)")], { files: ['second.txt'], after: ['T1'] });
  createRun(root, { goal: 'Accept both', plan: { decisions: [], tasks: [task('T1', [valueCheck, writesOnRepeat]), second] } });
  const run = await drive(root, { log: () => {}, providerCall: worker(root) });
  assert.equal(run.status, 'blocked');
  assert.equal(run.stopCode, 'check_writes');
  assert.match(run.failure, /^Final validation modified project files; changes preserved\./);
  assert.match(run.failure, /Task T1 checks\[1\] ran .* and changed 1 path\(s\): report\.md\./);
  assert.match(run.failure, /reopen T1 \(core retry --task T1 --reopen/);
  const entry = run.tasks[0].finalValidation.at(-1);
  assert.deepEqual(entry.changed_paths, ['report.md']);
  assert.equal(entry.changed_total, 1);
});

test('a writing final check is named as a final check that retry cannot replace', async t => {
  const root = fixture(t);
  createRun(root, { goal: 'Accept the value', config: { finalChecks: [check("require('fs').writeFileSync('report.md','generated')")] },
    plan: { decisions: [], tasks: [task('T1', [valueCheck])] } });
  const run = await drive(root, { log: () => {}, providerCall: worker(root) });
  assert.equal(run.stopCode, 'check_writes');
  assert.match(run.failure, /Task T1 finalChecks\[0\] ran .* changed 1 path\(s\): report\.md\./);
  assert.match(run.failure, /Final checks are fixed for the run/);
  assert.match(recoveryInfo(state(root)).guidance, /It is a final check, so it cannot be replaced by retry\./);
});

test('replacing the checks of the blocked task lets the resumed validation pass', async t => {
  const { root, run } = await blockedOnWriter(t);
  rmSync(join(root, 'docs'), { recursive: true, force: true });
  const replacement = [valueCheck, check("if(require('fs').existsSync('docs/screens'))process.exit(1)")];
  // PowerShell 5.1 Set-Content -Encoding utf8 writes a BOM.
  const file = writeJson(root, 'checks.json', String.fromCharCode(0xfeff) + JSON.stringify(replacement));
  recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'The check regenerated screenshots', validateOnly: true, checks: readChecksFile(file) });
  const retried = state(root);
  assert.deepEqual(retried.tasks[0].checks, replacement);
  assert.equal(retried.tasks[0].status, 'validate');
  const record = JSON.parse(readFileSync(recoveryLog(root, run), 'utf8').trim().split('\n').at(-1));
  assert.equal(record.task, 'T1');
  assert.equal(record.validateOnly, true);
  assert.deepEqual(record.checks.old, [valueCheck, screens(2)]);
  assert.deepEqual(record.checks.new, replacement);
  const phases = [];
  const done = await drive(root, { log: () => {}, providerCall: worker(root, phases) });
  assert.equal(done.status, 'done');
  assert.deepEqual(phases, ['review:T1']);
  assert.equal(done.tasks[0].attempts, 1);
  assert.equal(done.tasks[0].validation.length, 2);
  assert.ok(done.tasks[0].validation.every(v => v.passed));
});

test('a replacement without --validate-only goes through a new implementation', async t => {
  const { root } = await blockedOnWriter(t);
  rmSync(join(root, 'docs'), { recursive: true, force: true });
  recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'Read-only checks', limits: { attempts: 2 }, checks: { checks: [valueCheck] } });
  const phases = [];
  const done = await drive(root, { log: () => {}, providerCall: worker(root, phases) });
  assert.equal(done.status, 'done');
  assert.deepEqual(phases, ['develop:T1', 'review:T1']);
  assert.equal(done.tasks[0].attempts, 2);
});

test('checks replacement refusals leave the run state unchanged', async t => {
  const { root, run } = await blockedOnWriter(t);
  const before = readFileSync(current(root), 'utf8');
  const log = recoveryLog(root, run);
  const logBefore = existsSync(log) ? readFileSync(log, 'utf8') : null;
  const unchanged = () => {
    assert.equal(readFileSync(current(root), 'utf8'), before);
    assert.equal(existsSync(log) ? readFileSync(log, 'utf8') : null, logBefore);
  };
  const retry = (checks, extra = {}) => recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'Replace', validateOnly: true, checks, ...extra });
  const refused = [
    [() => retry([valueCheck], { taskId: 'T9' }), /--task ID of this run/],
    [() => retry([valueCheck], { reason: undefined }), /--why/],
    [() => retry([valueCheck], { reason: '  ' }), /--why/],
    [() => retry([]), /1–20 checks/],
    [() => retry({}), /JSON array/],
    [() => retry(null), /JSON array/],
    [() => retry('node'), /JSON array/],
    [() => retry({ checks: [valueCheck], finalChecks: [] }), /final checks cannot be replaced/],
    [() => retry({ finalChecks: [valueCheck] }), /final checks cannot be replaced/],
    [() => retry([{ command: 'node' }]), /checks\[0\] must be/],
    [() => retry([{ command: '', args: [] }]), /checks\[0\] must be/],
    [() => retry([valueCheck, { command: 'node', args: [1] }]), /checks\[1\] must be/],
    [() => retry([{ command: 'node', args: [], protectedFiles: ['x'] }]), /checks\[0\] must be/],
    [() => retry(Array.from({ length: 21 }, () => valueCheck)), /1–20 checks/],
    [() => retry([{ command: 'node', args: ['--port=<port>'] }]), /unresolved target placeholder.*Nothing was changed/],
    [() => retry([{ command: 'forja-missing-tool-' + process.pid, args: [] }]), /was not found on PATH.*Nothing was changed/],
    [() => recoverRun(root, { action: 'resume', reason: 'Replace', checks: [valueCheck] }), /only by core retry/],
  ];
  if (process.platform === 'win32') refused.push([() => retry([{ command: 'npx.cmd', args: ['tsc'] }]), /\.cmd\/\.bat shim/]);
  for (const [attempt, message] of refused) {
    assert.throws(attempt, message);
    unchanged();
  }
});

test('the checks of a done task cannot be replaced, and final checks stay in force', async t => {
  const root = fixture(t);
  const finalCheck = check("if(!require('fs').existsSync('second.txt'))process.exit(1)");
  const second = task('T2', [check("process.exit(1)")], { files: ['second.txt'], after: ['T1'] });
  createRun(root, { goal: 'Accept both', config: { finalChecks: [finalCheck] }, plan: { decisions: [], tasks: [task('T1', [valueCheck]), second] } });
  const run = await drive(root, { log: () => {}, providerCall: worker(root) });
  assert.equal(run.status, 'blocked');
  assert.equal(run.tasks[0].status, 'done');
  const before = readFileSync(current(root), 'utf8');
  assert.throws(() => recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'Replace', validateOnly: true, checks: [valueCheck] }), /T1 is done; checks are replaced only on an unfinished task/);
  assert.throws(() => recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'Replace', reopen: true, checks: [valueCheck] }), /T1 is done/);
  assert.equal(readFileSync(current(root), 'utf8'), before);
  // T2's failing check is replaced; the final check still runs and must pass.
  recoverRun(root, { action: 'retry', taskId: 'T2', reason: 'Wrong check', validateOnly: true, checks: [check('process.exit(0)')] });
  const stored = state(root);
  assert.deepEqual(stored.config.finalChecks, [finalCheck]);
  assert.deepEqual(stored.protectedFiles, JSON.parse(before).protectedFiles);
  rmSync(join(root, 'second.txt'), { force: true });
  const failed = await drive(root, { log: () => {}, providerCall: worker(root) });
  const t2 = failed.tasks[1];
  assert.equal(t2.validation.length, 2);
  assert.deepEqual({ command: t2.validation[1].command, args: t2.validation[1].args }, finalCheck);
  assert.equal(t2.validation[1].passed, false);
});

test('replacement checks under check isolation follow the sandbox argv contract, not host launch rules', { skip: !['linux', 'win32'].includes(process.platform) }, () => {
  const run = { tasks: [task('T1', [valueCheck])], config: { checkIsolation: { backend: 'bubblewrap', ...(process.platform === 'win32' ? { distribution: 'Ubuntu' } : {}) } } };
  assert.deepEqual(replacementChecks(process.cwd(), run, run.tasks[0], [{ command: '/usr/bin/python3', args: ['-B', 'check.py'] }]), [{ command: '/usr/bin/python3', args: ['-B', 'check.py'] }]);
  assert.throws(() => replacementChecks(process.cwd(), run, run.tasks[0], [{ command: 'node', args: ['<target>'] }]), /placeholder/);
});

function cliRun(t, cwd, args) {
  const data = mkdtempSync(join(tmpdir(), 'forja-check-writes-data-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, err: r.stderr };
}

test('core retry --checks-file refuses bad files and arguments before any state change', async t => {
  const { root } = await blockedOnWriter(t);
  mkdirSync(join(root, '.forja', 'in'), { recursive: true });
  const before = readFileSync(current(root), 'utf8');
  const files = {
    empty: writeJson(root, 'in/empty.json', ''),
    blank: writeJson(root, 'in/blank.json', '  \n'),
    invalid: writeJson(root, 'in/invalid.json', '[{"command":"node",'),
    none: writeJson(root, 'in/none.json', []),
    good: writeJson(root, 'in/good.json', [valueCheck]),
  };
  const refused = [
    [['--task', 'T1', '--why', 'x', '--checks-file', files.empty], /is empty/],
    [['--task', 'T1', '--why', 'x', '--checks-file', files.blank], /is empty/],
    [['--task', 'T1', '--why', 'x', '--checks-file', files.invalid], /not valid JSON/],
    [['--task', 'T1', '--why', 'x', '--checks-file', files.none], /1–20 checks/],
    [['--task', 'T1', '--why', 'x', '--checks-file', join(root, '.forja', 'in', 'missing.json')], /Cannot read the checks file/],
    [['--task', 'T1', '--why', 'x', '--checks-file'], /Provide a path after --checks-file/],
    [['--task', 'T1', '--checks-file', files.good], /--why/],
    [['--task', 'T9', '--why', 'x', '--checks-file', files.good], /--task ID of this run/],
  ];
  for (const [args, message] of refused) {
    const r = cliRun(t, root, ['core', 'retry', ...args]);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, message);
    assert.equal(readFileSync(current(root), 'utf8'), before);
  }
  const resume = cliRun(t, root, ['core', 'resume', '--checks-file', files.good]);
  assert.notEqual(resume.code, 0);
  assert.match(resume.err, /Unknown flag --checks-file for core resume/);
  assert.equal(readFileSync(current(root), 'utf8'), before);
});
