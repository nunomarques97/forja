import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRun, drive, assertLessonsArguments } from '../lib/core/engine.mjs';
import { extractLessons, readLessonStore, listLessons, showLesson, forgetLesson, clearLessons, LESSON_STORE } from '../lib/core/lessons.mjs';

const cli = resolve('bin/forja.mjs');

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function repo(t) {
  const root = tempDir(t, 'forja-lessons-cli-');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}

const row = (id, phase, task, attempt) => ({ id, phase, task, attempt, provider: 'claude', model: 'model-a', result: 'returned', timed_out: false, rate_limited: false, context_limit_reached: false });
// A finished synthetic run: T1 is rejected once for the same reason, fixed and
// approved, so it yields rejection, fix and relevant-file lessons.
function finishedRun(root, id, finished) {
  const dir = join(root, '.forja', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const rows = [row(1, 'develop', 'T1', 1), row(2, 'review', 'T1', 1), row(3, 'develop', 'T1', 1), row(4, 'review', 'T1', 1)];
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, run_id: id, goal: 'synthetic', status: 'done', invocations: rows.length, config: { finalChecks: [] }, updated_at: finished, finished_at: finished,
    tasks: [{ id: 'T1', title: 'Raise the value', files: ['lib/a.mjs'], checks: [], status: 'done', attempts: 1, files_changed: ['lib/a.mjs'], validation: [] }] }));
  writeFileSync(join(dir, 'usage.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''));
  const results = {
    1: { status: 'ready_for_validation', summary: 'Value raised.', findings: [] },
    2: { status: 'reject', summary: 'The value export is not covered by a test.', findings: [] },
    3: { status: 'ready_for_validation', summary: 'Added a test for the value export.', findings: [] },
    4: { status: 'approve', summary: 'Approved.', findings: [] },
  };
  for (const [n, value] of Object.entries(results)) writeFileSync(join(dir, `call-${n}-result.json`), JSON.stringify(value));
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
  const data = tempDir(t, 'forja-lessons-cli-data-');
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr, data: readdirSync(data) };
}

function seeded(t) {
  const root = repo(t);
  finishedRun(root, 'F-1000000000001-aaaaaa', '2026-09-01T10:00:00.000Z');
  const result = extractLessons(root);
  assert.deepEqual(result.ingested, ['F-1000000000001-aaaaaa']);
  const lessons = readLessonStore(root).lessons;
  assert.deepEqual(lessons.map(l => l.kind).sort(), ['fix_after_rejection', 'relevant_files', 'review_rejection']);
  return { root, lessons, rejection: lessons.find(l => l.kind === 'review_rejection') };
}

test('list and show only read the store; show refuses unknown or malformed ids', t => {
  const { root, lessons, rejection } = seeded(t);
  const before = tree(join(root, '.forja'));
  const list = forja(t, root, ['core', 'lessons', 'list']);
  assert.equal(list.code, 0, list.err);
  const listed = JSON.parse(list.out);
  assert.equal(listed.store, LESSON_STORE);
  assert.equal(listed.runs, 1);
  assert.equal(listed.forgotten, 0);
  assert.deepEqual(listed.lessons.map(l => l.id).sort(), lessons.map(l => l.id).sort());
  for (const l of listed.lessons) assert.deepEqual(Object.keys(l), ['id', 'kind', 'count', 'last_seen', 'weight', 'text']);
  const show = forja(t, root, ['core', 'lessons', 'show', '--id', rejection.id]);
  assert.equal(show.code, 0, show.err);
  const shown = JSON.parse(show.out);
  assert.equal(shown.id, rejection.id);
  assert.equal(shown.evidence[0].run, 'F-1000000000001-aaaaaa');
  assert.equal(shown.evidence[0].task, 'T1');
  assert.match(shown.text, /not covered by a test/);
  const unknown = forja(t, root, ['core', 'lessons', 'show', '--id', 'L-0000000000000000']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /No lesson L-0000000000000000/);
  for (const r of [list, show, unknown]) {
    assert.deepEqual(r.data, []);
    assert.equal(existsSync(join(root, '.forja', 'lock.json')), false);
  }
  assert.deepEqual(tree(join(root, '.forja')), before);
  // Without a store or even .forja, list reports an empty store and creates nothing.
  const empty = repo(t);
  const r = forja(t, empty, ['core', 'lessons', 'list']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).lessons, []);
  assert.equal(existsSync(join(empty, '.forja')), false);
  // A damaged store is refused, not silently replaced.
  writeFileSync(join(root, LESSON_STORE), '{"version":2}');
  assert.throws(() => listLessons(root), /invalid; inspect or clear it/);
});

test('forget removes a lesson that later extraction never re-creates, from the same or new runs', t => {
  const { root, rejection } = seeded(t);
  const r = forja(t, root, ['core', 'lessons', 'forget', '--id', rejection.id]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { id: rejection.id, forgotten: true, changed: true });
  assert.equal(existsSync(join(root, '.forja', 'lock.json')), false, 'lock released');
  let store = readLessonStore(root);
  assert.ok(!store.lessons.some(l => l.id === rejection.id));
  assert.deepEqual(store.forgotten, [rejection.id]);
  const bytes = readFileSync(join(root, LESSON_STORE));
  // Re-extraction of the same runs changes nothing; a new run with the same
  // rejection does not bring the forgotten lesson back.
  assert.equal(extractLessons(root).written, false);
  assert.deepEqual(readFileSync(join(root, LESSON_STORE)), bytes);
  finishedRun(root, 'F-1000000000002-bbbbbb', '2026-09-05T10:00:00.000Z');
  assert.deepEqual(extractLessons(root).ingested, ['F-1000000000002-bbbbbb']);
  store = readLessonStore(root);
  assert.ok(!store.lessons.some(l => l.id === rejection.id));
  assert.equal(store.lessons.find(l => l.kind === 'fix_after_rejection').count, 2);
  // Forgetting again is idempotent; an id that was never stored is refused.
  assert.deepEqual(forgetLesson(root, rejection.id), { id: rejection.id, forgotten: true, changed: false });
  const before = tree(join(root, '.forja'));
  const unknown = forja(t, root, ['core', 'lessons', 'forget', '--id', 'L-0000000000000000']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /No lesson L-0000000000000000.*nothing was changed/);
  assert.deepEqual(tree(join(root, '.forja')), before);
  assert.throws(() => showLesson(root, rejection.id), /No lesson/);
});

test('clear drops every lesson, keeps ingested runs and forgotten ids, and resets a damaged store', t => {
  const { root, rejection } = seeded(t);
  forgetLesson(root, rejection.id);
  const r = forja(t, root, ['core', 'lessons', 'clear']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { removed: 2, reset: false, changed: true });
  const store = readLessonStore(root);
  assert.deepEqual(store.lessons, []);
  assert.deepEqual(Object.keys(store.runs), ['F-1000000000001-aaaaaa']);
  assert.deepEqual(store.forgotten, [rejection.id]);
  // The same runs are not ingested again, so nothing comes back.
  assert.equal(extractLessons(root).written, false);
  assert.deepEqual(readLessonStore(root).lessons, []);
  assert.deepEqual(clearLessons(root), { removed: 0, reset: false, changed: false });
  writeFileSync(join(root, LESSON_STORE), 'not json');
  assert.deepEqual(clearLessons(root), { removed: 0, reset: true, changed: true });
  assert.deepEqual(readLessonStore(root), { version: 1, runs: {}, forgotten: [], lessons: [] });
  const empty = repo(t);
  assert.deepEqual(clearLessons(empty), { removed: 0, reset: false, changed: false });
  assert.equal(existsSync(join(empty, LESSON_STORE)), false);
});

test('forget and clear refuse while a controller is alive and leave the store and lock untouched', t => {
  const { root, rejection } = seeded(t);
  // This test process stands in for a live controller holding the lock.
  const lock = JSON.stringify({ pid: process.pid, token: 'live', at: '2026-10-01T00:00:00.000Z' });
  writeFileSync(join(root, '.forja', 'lock.json'), lock);
  const before = tree(join(root, '.forja'));
  for (const args of [['core', 'lessons', 'forget', '--id', rejection.id], ['core', 'lessons', 'clear']]) {
    const r = forja(t, root, args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, /controller or its worker is alive.*Nothing was changed/, args.join(' '));
    assert.deepEqual(tree(join(root, '.forja')), before, args.join(' '));
  }
  // Read-only commands still work while the controller runs.
  assert.equal(forja(t, root, ['core', 'lessons', 'list']).code, 0);
  assert.equal(readFileSync(join(root, '.forja', 'lock.json'), 'utf8'), lock);
});

test('unknown subcommands, flags, extra arguments and bad ids are refused before any effect; --help changes nothing', t => {
  const { root, rejection } = seeded(t);
  const forjaDir = join(root, '.forja');
  const before = tree(forjaDir);
  const refused = [
    [['core', 'lessons'], /Missing core lessons subcommand/],
    [['core', 'lessons', 'purge'], /Unknown core lessons subcommand "purge"/],
    [['core', 'lessons', 'constructor'], /Unknown core lessons subcommand "constructor"/],
    [['core', 'lessons', 'list', '--bogus'], /--bogus/],
    [['core', 'lessons', 'list', '--id', rejection.id], /--id for core lessons list/],
    [['core', 'lessons', 'list', 'all'], /"all"/],
    [['core', 'lessons', 'show'], /Pass a lesson id after --id/],
    [['core', 'lessons', 'show', '--id'], /Pass a lesson id after --id/],
    [['core', 'lessons', 'show', '--id', '../store'], /Pass a lesson id after --id/],
    [['core', 'lessons', 'forget', '--id', rejection.id, 'now'], /"now"/],
    [['core', 'lessons', 'forget', '--id', rejection.id, '--all'], /--all/],
    [['core', 'lessons', 'forget', '--id', rejection.id.toUpperCase()], /Pass a lesson id after --id/],
    [['core', 'lessons', 'clear', '--yes'], /--yes/],
    [['core', 'lessons', 'clear', 'everything'], /"everything"/],
  ];
  for (const [args, message] of refused) {
    const r = forja(t, root, args);
    const shown = args.join(' ');
    assert.notEqual(r.code, 0, shown);
    assert.match(r.err, message, shown);
    assert.match(r.err, /nothing was changed/i, shown);
    assert.deepEqual(r.data, [], shown);
    assert.equal(existsSync(join(forjaDir, 'lock.json')), false, shown);
    assert.deepEqual(tree(forjaDir), before, shown);
  }
  assert.throws(() => assertLessonsArguments({ pos: ['lessons', 'forget'], opt: { id: true } }), /Pass a lesson id/);
  assert.equal(assertLessonsArguments({ pos: ['lessons', 'forget'], opt: { id: rejection.id, project: root } }), 'forget');
  for (const args of [['core', 'lessons', '--help'], ['core', 'lessons', '-h'], ['core', 'lessons', 'clear', '--help'], ['core', 'lessons', 'forget', '--id', rejection.id, '-h'], ['core', 'lessons', 'purge', '--help']]) {
    const r = forja(t, root, args);
    const shown = args.join(' ');
    assert.equal(r.code, 0, `${shown}: ${r.err}`);
    assert.match(r.out, /core lessons list \| show --id L-\.\.\. \| forget --id L-\.\.\. \| clear/, shown);
    assert.equal(r.err, '', shown);
    assert.deepEqual(r.data, [], shown);
    assert.equal(existsSync(join(forjaDir, 'lock.json')), false, shown);
    assert.deepEqual(tree(forjaDir), before, shown);
  }
});

async function statusProject(t, config) {
  const root = repo(t);
  finishedRun(root, 'F-1000000000001-aaaaaa', '2026-09-01T10:00:00.000Z');
  const check = [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './lib/a.mjs'; if(value!==2)process.exit(1)"] }];
  createRun(root, { goal: 'Raise the value', provider: 'custom', config: { maxAttempts: 3, maxRotations: 0, ...config },
    plan: { decisions: [], tasks: [{ id: 'T1', title: 'Raise the value export', criteria: ['lib/a.mjs value equals two'], files: ['lib/a.mjs'], complexity: 'easy', risks: [], after: [], checks: check }] } });
  const blocked = async () => ({ code: 0, result: { status: 'blocked', summary: 'Need an operator decision', findings: [] } });
  assert.equal((await drive(root, { log: () => {}, providerCall: blocked })).status, 'blocked');
  return root;
}
const STATUS_KEYS = ['run', 'goal', 'provider', 'status', 'failure', 'recovery', 'usage_limit_wait', 'plan_warnings', 'limits', 'provider_timeout', 'check_timeout', 'process_cleanup', 'invocations', 'pending', 'stop_request', 'delivery', 'technology', 'sponsor_notice', 'tasks', 'evidence'];

test('core status shows a lessons block only for runs with the flag on', async t => {
  const on = await statusProject(t, { lessons: true });
  const r = forja(t, on, ['core', 'status']);
  assert.equal(r.code, 0, r.err);
  const status = JSON.parse(r.out);
  assert.deepEqual(Object.keys(status), [...STATUS_KEYS.slice(0, -2), 'lessons', ...STATUS_KEYS.slice(-2)]);
  const { lessons } = status;
  assert.equal(lessons.enabled, true);
  assert.deepEqual(lessons.store, { path: LESSON_STORE, lessons: 3, runs: 1, forgotten: 0 });
  assert.deepEqual(lessons.ingest.ingested, ['F-1000000000001-aaaaaa']);
  assert.equal(lessons.sent.length, 1);
  assert.equal(lessons.sent[0].phase, 'develop');
  assert.equal(lessons.sent[0].task, 'T1');
  assert.ok(lessons.sent[0].ids.length > 0);
  assert.ok(lessons.sent[0].ids.every(id => readLessonStore(on).lessons.some(l => l.id === id)));
  // A damaged store is reported in the block, never fatal for status.
  writeFileSync(join(on, LESSON_STORE), 'not json');
  const damaged = JSON.parse(forja(t, on, ['core', 'status']).out).lessons.store;
  assert.equal(damaged.path, LESSON_STORE);
  assert.match(damaged.error, /invalid/);

  for (const config of [{}, { lessons: false }]) {
    const off = await statusProject(t, config);
    const first = forja(t, off, ['core', 'status']);
    assert.equal(first.code, 0, first.err);
    assert.deepEqual(Object.keys(JSON.parse(first.out)), STATUS_KEYS);
    assert.doesNotMatch(first.out, /"lessons"/);
    // A store in the project changes nothing for a flag-off run.
    extractLessons(off);
    assert.ok(existsSync(join(off, LESSON_STORE)));
    assert.equal(forja(t, off, ['core', 'status']).out, first.out);
  }
});

test('CLI help and the runbook document the flag, the commands and the privacy rule', t => {
  const root = repo(t);
  const help = forja(t, root, ['core', '--help']).out;
  const runbook = readFileSync(resolve('docs/CORE-RUNBOOK.md'), 'utf8');
  for (const text of [help, runbook]) {
    assert.match(text, /"lessons": true/);
    assert.match(text, /core lessons list/);
    for (const sub of ['show --id', 'forget --id', 'clear']) assert.ok(text.includes(sub), sub);
    assert.ok(text.includes('.forja/lessons/store.json'));
  }
  assert.match(help, /never committed and never sent anywhere except this project's own packets/);
  assert.match(help, /refuse while a controller is alive/);
  assert.match(runbook, /nunca é commitado nem enviado para lado nenhum além dos pacotes deste mesmo projeto/);
  assert.match(runbook, /recusam enquanto um controlador ou o seu worker estiver vivo/);
});
