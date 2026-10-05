import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRun, drive, recoverRun, assertCoreArguments, CORE_FLAGS } from '../lib/core/engine.mjs';

const cli = resolve('bin/forja.mjs');

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function repo(t) {
  const root = tempDir(t, 'forja-help-');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'a.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}

// A project whose Core run is blocked after two worker sessions and one
// recovery, so current.json, usage.jsonl and recovery.jsonl all exist.
async function blockedProject(t) {
  const root = repo(t);
  const check = [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './a.mjs'; if(value!==2)process.exit(1)"] }];
  createRun(root, { goal: 'Set the value to two', provider: 'custom', config: { maxAttempts: 3, maxRotations: 0 }, plan: { decisions: [], tasks: [{ id: 'T1', title: 'Set a to two', criteria: ['a.mjs value equals two'], files: ['a.mjs'], complexity: 'easy', risks: [], after: [], checks: check }] } });
  const blocked = async () => ({ code: 0, result: { status: 'blocked', summary: 'Need an operator decision', findings: [] } });
  await drive(root, { log: () => {}, providerCall: blocked });
  recoverRun(root, { action: 'retry', taskId: 'T1', reason: 'Try once more' });
  const result = await drive(root, { log: () => {}, providerCall: blocked });
  assert.equal(result.status, 'blocked');
  return root;
}

function tree(dir) {
  const files = {};
  const walk = rel => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = join(rel, name);
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else files[path] = readFileSync(join(dir, path)).toString('base64');
    }
  };
  if (existsSync(dir)) walk('');
  return files;
}

function forja(t, cwd, args) {
  const data = tempDir(t, 'forja-help-data-');
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr, data: readdirSync(data) };
}

const subcommands = ['resume', 'retry', 'abandon', 'start', 'stop', 'deliver', 'decide', 'init', 'status', 'usage', 'doctor', 'context', 'evidence', 'diagnose', 'evaluation-plan', 'benchmark', 'queue'];

test('--help and -h on start and every core subcommand print usage and leave a blocked run untouched', async t => {
  const root = await blockedProject(t);
  const forjaDir = join(root, '.forja');
  const run = JSON.parse(readFileSync(join(forjaDir, 'current.json'), 'utf8'));
  const runDir = join(forjaDir, 'runs', run.run_id);
  for (const file of ['usage.jsonl', 'recovery.jsonl']) assert.ok(existsSync(join(runDir, file)), file);
  const before = tree(forjaDir);
  const invocations = [
    ...subcommands.flatMap(sub => [['core', sub, '--help'], ['core', sub, '-h']]),
    ['start', '--help'], ['start', '-h'], ['core', '--help'], ['core', '-h'],
    ['core', 'resume', '--help', 'now'], ['core', 'retry', '--task', 'T1', '--why', 'x', '-h'], ['start', '--goal', 'Anything', '--provider', 'custom', '--help'],
    // -h after a flag that takes no value is parsed as that flag's value.
    ['core', 'stop', '--after-task', '-h'], ['core', 'deliver', '--retry', '-h'],
    ['core', 'retry', '--task', 'T1', '--why', 'x', '--validate-only', '-h'], ['core', 'retry', '--task', 'T1', '--why', 'x', '--reopen', '-h'],
    ['core', 'resume', '--expected-run', '-h'], ['start', '--goal', 'g', '--provider', 'custom', '--allow-dirty', '-h'],
    ['core', 'queue', 'add', '--goal-file', 'goal.txt', '--help'], ['core', 'queue', 'list', '-h'], ['core', 'queue', 'remove', 'Q-1-abcdef', '-h'],
    ['core', 'queue', 'start', '--expected-run', '-h'],
    ['core', 'status', '--all', '--help'], ['core', 'status', '--all', '--json', '-h'],
  ];
  for (const args of invocations) {
    const r = forja(t, root, args);
    const shown = args.join(' ');
    assert.equal(r.code, 0, `${shown}: ${r.err}`);
    assert.match(r.out, /FORJA core/, shown);
    assert.match(r.out, /core resume/, shown);
    assert.match(r.out, /core queue add --goal-file/, shown);
    assert.match(r.out, /core status --all \[--json\]/, shown);
    assert.equal(r.err, '', shown);
    assert.deepEqual(r.data, [], `${shown} wrote FORJA data`);
    assert.equal(existsSync(join(forjaDir, 'lock.json')), false, `${shown} left a lock`);
    assert.deepEqual(tree(forjaDir), before, `${shown} changed run state`);
  }
  assert.equal(JSON.parse(readFileSync(join(forjaDir, 'current.json'), 'utf8')).status, 'blocked');
});

test('state-changing commands refuse unknown flags and stray arguments before any effect', async t => {
  const root = await blockedProject(t);
  const forjaDir = join(root, '.forja');
  const before = tree(forjaDir);
  const refused = [
    [['core', 'resume', '--bogus'], /--bogus/],
    [['core', 'resume', '--max-minutes', '60', '--dry-run'], /--dry-run/],
    [['core', 'resume', '--task', 'T1'], /--task/],
    [['core', 'retry', '--task', 'T1', '--why', 'again', '--force'], /--force/],
    [['core', 'abandon', '--why', 'done', '--yes'], /--yes/],
    [['core', 'stop', '--now'], /--now/],
    [['core', 'deliver', '--push'], /--push/],
    [['core', 'decide', '--decision', 'D1', '--option', 'a', '--why', 'x', '--all'], /--all/],
    [['core', 'init', '--force'], /--force/],
    [['start', '--goal', 'Other goal', '--provider', 'custom', '--bogus', 'x'], /--bogus/],
    [['core', 'resume', 'now'], /"now"/],
    [['core', 'retry', 'T1', '--why', 'again'], /"T1"/],
    [['core', 'abandon', '--why', 'Stop', 'here'], /"here"/],
    [['core', 'stop', 'please'], /"please"/],
    [['core', 'queue'], /core queue add --goal-file/],
    [['core', 'queue', 'bogus'], /core queue add --goal-file/],
    [['core', 'queue', 'add', '--goal-file', 'goal.txt', '--allow-dirty'], /--allow-dirty/],
    [['core', 'queue', 'add', '--goal-file', 'goal.txt', '--bogus', 'x'], /--bogus/],
    [['core', 'queue', 'add', '--goal', 'Inline goal'], /--goal/],
    [['core', 'queue', 'add', '--goal-file', 'goal.txt', 'extra'], /"extra"/],
    [['core', 'queue', 'list', 'extra'], /"extra"/],
    [['core', 'queue', 'list', '--all'], /--all/],
    [['core', 'queue', 'remove'], /queue entry id/],
    [['core', 'queue', 'remove', 'Q-1-abcdef', 'Q-2-abcdef'], /"Q-2-abcdef"/],
    [['core', 'queue', 'remove', '../x'], /queue entry id/],
    [['core', 'queue', 'start'], /internal and needs --expected-run/],
    [['core', 'queue', 'start', '--expected-run', 'F-1-abcdef', '--goal-file', 'goal.txt'], /--goal-file/],
  ];
  for (const [args, message] of refused) {
    const r = forja(t, root, args);
    const shown = args.join(' ');
    assert.notEqual(r.code, 0, shown);
    assert.match(r.err, message, shown);
    assert.match(r.err, /nothing was changed/, shown);
    assert.deepEqual(r.data, [], `${shown} wrote FORJA data`);
    assert.equal(existsSync(join(forjaDir, 'lock.json')), false, `${shown} left a lock`);
    assert.deepEqual(tree(forjaDir), before, `${shown} changed run state`);
  }
});

test('start keeps positionals: a goal split by shell quoting is refused before a run exists', t => {
  for (const args of [
    ['start', '--goal', 'O', 'Sponsor', 'disse', '--provider', 'custom'],
    ['core', 'start', '--goal', 'Goal', '--provider', 'custom', 'tail'],
    ['start', '--goal', 'Goal', '--provider', 'custom', '--unknown-limit', '3'],
  ]) {
    const root = repo(t);
    const r = forja(t, root, args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, /nothing was changed/);
    assert.equal(existsSync(join(root, '.forja')), false, args.join(' '));
    assert.deepEqual(r.data, []);
  }
});

test('the flags of documented invocations and internal launchers stay accepted', () => {
  const ok = (cmd, opt, pos = [cmd]) => assert.doesNotThrow(() => assertCoreArguments(cmd, { pos, opt }), `${cmd} ${JSON.stringify(opt)}`);
  // lib/spawn-runner.mjs launchCore (used by lib/guard.mjs and viewer/core-api.mjs).
  ok('resume', { 'expected-run': 'F-1-abc' });
  ok('resume', { project: 'p', why: 'Raise', 'max-sessions': '40', 'max-cloud-sessions': '10', 'max-attempts': '3', 'max-minutes': '60', 'max-rotations': '2', 'max-context-tokens': '150000' });
  ok('retry', { project: 'p', task: 'T1', why: 'x', 'validate-only': true, 'max-attempts': '3', 'max-sessions': '40' });
  ok('retry', { task: 'T1', reopen: true, why: 'x' });
  ok('abandon', { why: 'x' });
  ok('stop', { 'after-task': true });
  ok('deliver', { retry: true });
  ok('deliver', { 'approve-production': 'abc123' });
  ok('decide', { run: 'F-1', decision: 'D1', option: 'a', why: 'x' });
  ok('init', { project: 'p' });
  ok('start', { project: 'p', goal: 'g', provider: 'claude', config: 'c.json', plan: 'p.json', 'allow-dirty': true, 'max-minutes': '30' });
  // Read-only commands keep their own flag handling.
  ok('status', { anything: true }, ['status', 'extra']);
  assert.deepEqual(Object.keys(CORE_FLAGS).sort(), ['abandon', 'decide', 'deliver', 'init', 'resume', 'retry', 'start', 'stop']);
  assert.throws(() => assertCoreArguments('resume', { pos: ['resume'], opt: { constructor: true } }), /--constructor/);
});

test('an unknown core command is refused without creating state', t => {
  const root = repo(t);
  mkdirSync(join(root, 'sub'));
  const r = forja(t, join(root, 'sub'), ['core', 'bogus-command']);
  assert.notEqual(r.code, 0);
  assert.equal(existsSync(join(root, '.forja')), false);
  assert.equal(existsSync(join(root, 'sub', '.forja')), false);
});
