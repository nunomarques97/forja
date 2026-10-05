import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { statusAll, statusAllLines } from '../lib/core/status-all.mjs';
import { createRun } from '../lib/core/engine.mjs';

const cli = resolve('bin/forja.mjs');

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

const json = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); };
const task = (id, status, attempts = 1) => ({ id, title: `Task ${id}`, status, attempts, checks: [] });
const state = (fields) => ({ version: 1, run_id: 'F-1791000000000-abcdef', goal: 'Fixture goal', provider: 'claude', created_at: '2026-10-04T01:00:00.000Z', updated_at: '2026-10-04T02:30:00.000Z', limits: { sessions: 30, minutes: 30 }, invocations: 3, tasks: [], ...fields });
const queueEntry = (n) => ({ id: `Q-${1791000000000 + n}-00000${n}`, added_at: '2026-10-04T00:00:00.000Z', provider: 'claude', goal: `Queued goal ${n}`, config: null, budgets: {} });
const resetAt = new Date(Date.now() + 45 * 60000).toISOString();

// A registry in a temporary data dir with one fixture project per case.
function fixtures(t) {
  const base = tempDir(t, 'forja-status-all-');
  const data = join(base, 'data');
  const entries = [];
  const project = (name, files = {}) => {
    const root = join(base, name);
    mkdirSync(root, { recursive: true });
    for (const [rel, value] of Object.entries(files)) json(join(root, rel), value);
    entries.push({ name, path: root, bootstrappedAt: '2026-10-01T00:00:00.000Z' });
    return root;
  };
  // Live controller: lock.json names this test process, which is alive.
  project('alpha-running', {
    '.forja/current.json': state({ status: 'running', tasks: [task('T1', 'done'), task('T2', 'doing', 2), task('T3', 'todo', 0)],
      pending: { id: 4, phase: 'develop', task: 'T2', attempt: 2, provider: 'claude', started_at: '2026-10-04T02:29:00.000Z' } }),
    '.forja/lock.json': { pid: process.pid, child: null, since: '2026-10-04T02:00:00.000Z' },
  });
  project('bravo-interrupted', { '.forja/current.json': state({ status: 'running', tasks: [task('T1', 'doing')], pending: null }) });
  project('charlie-blocked', { '.forja/current.json': state({ status: 'blocked', stopCode: 'attempts', tasks: [task('T1', 'done'), task('T2', 'doing', 2)] }) });
  project('delta-waiting', { '.forja/current.json': state({ status: 'blocked', stopCode: 'provider_limit', tasks: [task('T1', 'doing')],
    usageLimitWait: { reset_at: resetAt, source: 'provider', recorded_at: '2026-10-04T02:30:00.000Z', resumes: 0 } }) });
  project('echo-done', {
    '.forja/current.json': state({ status: 'done', finished_at: '2026-10-04T03:00:00.000Z', tasks: [task('T1', 'done'), task('T2', 'done')] }),
    '.forja/queue.json': { version: 1, entries: [queueEntry(1), queueEntry(2)] },
  });
  project('foxtrot-unreadable', { '.forja/current.json': '{ not json' });
  project('golf-legacy', { 'docs/forja/RUN.json': { run_id: 'R-1', status: 'running', goal: 'Legacy', started_at: '2026-10-04T00:00:00.000Z' } });
  project('hotel-empty');
  entries.push({ name: 'india-missing', path: join(base, 'gone'), bootstrappedAt: '2026-10-01T00:00:00.000Z' });
  json(join(data, 'projects.json'), { version: 1, projects: entries });
  return { base, data };
}

// Every file under dir: content and mtime, so a read-only claim is checked
// against both, including the live lock.json.
function snapshot(dir) {
  const files = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = join(rel, name);
      const stat = statSync(join(dir, path));
      if (stat.isDirectory()) { files[path + sep] = stat.mtimeMs; walk(path); }
      else files[path] = [stat.mtimeMs, readFileSync(join(dir, path)).toString('base64')];
    }
  };
  if (existsSync(dir)) walk('');
  return files;
}

function forja(cwd, data, args) {
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('core status --all --json reports each registered Core project and counts the rest', t => {
  const { base, data } = fixtures(t);
  const outside = tempDir(t, 'forja-status-all-cwd-');
  const before = snapshot(base);
  const r = forja(outside, data, ['core', 'status', '--all', '--json']);
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out);
  assert.deepEqual(Object.keys(report), ['ok', 'projects', 'without_core_run']);
  assert.equal(report.ok, true);
  // golf-legacy, hotel-empty and india-missing have no Core run.
  assert.equal(report.without_core_run, 3);
  const by = Object.fromEntries(report.projects.map(p => [p.project, p]));
  assert.deepEqual(report.projects.map(p => p.project), ['alpha-running', 'bravo-interrupted', 'charlie-blocked', 'delta-waiting', 'echo-done', 'foxtrot-unreadable']);
  for (const p of report.projects)
    assert.deepEqual(Object.keys(p), ['project', 'status', 'tasks_done', 'tasks_total', 'current', 'updated_at', 'block_reason', 'usage_limit_wait', 'queue_length']);
  assert.deepEqual(by['alpha-running'], { project: 'alpha-running', status: 'running', tasks_done: 1, tasks_total: 3,
    current: { task: 'T2', phase: 'develop', attempt: 2 }, updated_at: '2026-10-04T02:30:00.000Z', block_reason: null, usage_limit_wait: null, queue_length: 0 });
  assert.equal(by['bravo-interrupted'].status, 'interrupted');
  assert.equal(by['bravo-interrupted'].block_reason, 'Execution interrupted');
  assert.equal(by['bravo-interrupted'].current, null);
  assert.equal(by['charlie-blocked'].status, 'blocked');
  assert.equal(by['charlie-blocked'].block_reason, 'Implementation attempts exhausted');
  assert.equal(by['charlie-blocked'].tasks_done, 1);
  const wait = by['delta-waiting'];
  assert.equal(wait.status, 'waiting');
  assert.equal(wait.block_reason, 'Provider reported a usage limit');
  assert.deepEqual(wait.usage_limit_wait, { reset_at: resetAt, source: 'provider', auto_resume: true, stop_requested: false, resumes: 0, max_resumes: 6 });
  assert.deepEqual([by['echo-done'].status, by['echo-done'].tasks_done, by['echo-done'].tasks_total, by['echo-done'].queue_length, by['echo-done'].block_reason], ['done', 2, 2, 2, null]);
  assert.deepEqual(by['foxtrot-unreadable'], { project: 'foxtrot-unreadable', status: 'unreadable', tasks_done: null, tasks_total: null, current: null,
    updated_at: null, block_reason: 'Core state is unreadable; check it locally.', usage_limit_wait: null, queue_length: 0 });
  assert.deepEqual(snapshot(base), before, 'status --all changed a project, a lock or the registry');
  assert.deepEqual(readdirSync(outside), [], 'status --all wrote into the current folder');
});

test('core status --all prints one line per Core project, the count line, and touches nothing', t => {
  const { base, data } = fixtures(t);
  const before = snapshot(base);
  const r = forja(tempDir(t, 'forja-status-all-cwd-'), data, ['core', 'status', '--all']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split(/\r?\n/);
  assert.equal(lines.length, 7);
  assert.equal(lines[0], 'alpha-running | running | tasks 1/3 | current T2 develop attempt 2 | updated 2026-10-04T02:30:00.000Z | queue 0');
  assert.equal(lines[1], 'bravo-interrupted | interrupted | tasks 0/1 | updated 2026-10-04T02:30:00.000Z | reason: Execution interrupted | queue 0');
  assert.equal(lines[2], 'charlie-blocked | blocked | tasks 1/2 | updated 2026-10-04T02:30:00.000Z | reason: Implementation attempts exhausted | queue 0');
  assert.equal(lines[3], `delta-waiting | waiting for usage limit until ${resetAt} | tasks 0/1 | updated 2026-10-04T02:30:00.000Z | reason: Provider reported a usage limit | queue 0`);
  assert.equal(lines[4], 'echo-done | done | tasks 2/2 | updated 2026-10-04T02:30:00.000Z | queue 2');
  assert.equal(lines[5], 'foxtrot-unreadable | unreadable | reason: Core state is unreadable; check it locally. | queue 0');
  assert.equal(lines[6], '3 registered projects without a Core run.');
  assert.deepEqual(snapshot(base), before);
});

test('status --all: a wait without automatic resume, an unreadable queue and an empty registry', t => {
  const base = tempDir(t, 'forja-status-all-');
  const data = join(base, 'data');
  assert.deepEqual(statusAll({ dataDir: data }), { ok: true, projects: [], without_core_run: 0 });
  assert.deepEqual(statusAllLines(statusAll({ dataDir: data })), ['No registered project has a Core run.', '0 registered projects without a Core run.']);
  assert.equal(existsSync(data), false, 'a missing registry is not created');
  const root = join(base, 'kilo');
  json(join(root, '.forja/current.json'), state({ status: 'blocked', stopCode: 'provider_limit', config: { usageLimitResume: false }, tasks: [task('T1', 'doing')],
    usageLimitWait: { reset_at: resetAt, source: 'default', recorded_at: '2026-10-04T02:30:00.000Z', resumes: 0 } }));
  json(join(root, '.forja/queue.json'), '[broken');
  json(join(data, 'projects.json'), { version: 1, projects: [{ name: 'kilo', path: root }] });
  const report = statusAll({ dataDir: data });
  assert.equal(report.projects[0].status, 'waiting');
  assert.equal(report.projects[0].usage_limit_wait.auto_resume, false);
  assert.equal(report.projects[0].queue_length, null);
  assert.equal(statusAllLines(report)[0],
    `kilo | waiting for usage limit until ${resetAt} (no automatic resume; core resume after that time) | tasks 0/1 | updated 2026-10-04T02:30:00.000Z | reason: Provider reported a usage limit | queue unreadable`);
});

test('a corrupt registry exits non-zero with a clear message in text and JSON mode', t => {
  const base = tempDir(t, 'forja-status-all-');
  const data = join(base, 'data');
  json(join(data, 'projects.json'), '{ oops');
  const before = snapshot(base);
  const text = forja(base, data, ['core', 'status', '--all']);
  assert.notEqual(text.code, 0);
  assert.match(text.err, /project registry .* is unreadable/);
  assert.equal(text.out, '');
  const machine = forja(base, data, ['core', 'status', '--all', '--json']);
  assert.equal(machine.code, 1);
  const report = JSON.parse(machine.out);
  assert.equal(report.ok, false);
  assert.match(report.error, /project registry .* is unreadable/);
  assert.deepEqual(snapshot(base), before);
});

test('status --all refuses other flags and arguments; plain core status is unchanged', t => {
  const { base, data } = fixtures(t);
  const before = snapshot(base);
  for (const args of [['core', 'status', '--all', '--project', base], ['core', 'status', '--all', 'extra'], ['core', 'status', '--all', '--json', 'x'], ['core', 'status', 'extra', '--all']]) {
    const r = forja(base, data, args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, /core status --all/, args.join(' '));
    assert.equal(r.out, '', args.join(' '));
  }
  assert.deepEqual(snapshot(base), before);
  // Without --all, status still reads the current folder's run as before.
  const root = join(base, 'juliet-real');
  mkdirSync(root);
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'a.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  const check = [{ command: 'node', args: ['-e', 'process.exit(0)'] }];
  createRun(root, { goal: 'Set the value', provider: 'custom', plan: { decisions: [], tasks: [{ id: 'T1', title: 'Set a', criteria: ['a.mjs set'], files: ['a.mjs'], complexity: 'easy', risks: [], after: [], checks: check }] } });
  const plain = forja(root, data, ['core', 'status']);
  assert.equal(plain.code, 0, plain.err);
  const run = JSON.parse(plain.out);
  assert.match(run.run, /^F-/);
  assert.equal(run.status, 'running');
  for (const key of ['goal', 'provider', 'recovery', 'usage_limit_wait', 'limits', 'pending', 'tasks', 'evidence']) assert.ok(Object.hasOwn(run, key), key);
  assert.ok(!Object.hasOwn(run, 'projects') && !Object.hasOwn(run, 'without_core_run'));
  const none = forja(join(base, 'hotel-empty'), data, ['core', 'status']);
  assert.notEqual(none.code, 0);
  assert.equal(existsSync(join(base, 'hotel-empty', '.forja')), false);
});
