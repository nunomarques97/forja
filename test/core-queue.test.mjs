// Per-project goal queue (lib/core/queue.mjs): CLI add/list/remove, the
// done-only automatic start, clean-tree refusals, corrupt files, the hidden
// guard path and one writer per project across processes. Temporary Git
// repositories and data folders only; providers are fakes or a local node
// command that exits at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRun, current, drive } from '../lib/core/engine.mjs';
import { QUEUE_MAX_ENTRIES, addToQueue, continueQueue, listQueue, queueLength, readQueue, removeFromQueue, startFromQueue } from '../lib/core/queue.mjs';
import { coreObservation } from '../lib/core/observe.mjs';
import { requestStop, stopRequestPath } from '../lib/core/stop.mjs';

const cli = resolve('bin/forja.mjs');
const quiet = () => {};

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function repo(t) {
  const root = tempDir(t, 'forja-queue-');
  writeFileSync(join(root, '.gitignore'), '.forja/\ngoals/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']])
    execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}
// Goal and config files live in an ignored folder so the tree stays clean.
function file(root, name, text) {
  const dir = join(root, 'goals');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}
function forja(t, cwd, args) {
  const data = tempDir(t, 'forja-queue-data-');
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const state = root => JSON.parse(readFileSync(current(root), 'utf8'));
const save = (root, run) => writeFileSync(current(root), JSON.stringify(run, null, 2) + '\n');
const queueFile = root => join(root, '.forja', 'queue.json');
const raw = root => existsSync(queueFile(root)) ? readFileSync(queueFile(root), 'utf8') : null;
const plan = (goal = 'Keep the value') => ({ decisions: [], tasks: [{
  id: 'T1', title: goal, criteria: ['the check passes'], files: ['value.mjs'], complexity: 'easy', risks: [], after: [],
  checks: [{ command: 'node', args: ['--version'] }],
}] });
// Plans, develops without edits and approves: every run ends done on a clean tree.
const provider = async (_, o) => {
  const ctx = JSON.parse(o.text);
  if (ctx.phase === 'plan') return { code: 0, result: plan(ctx.goal.slice(0, 40)) };
  return { code: 0, result: { status: o.readOnly ? 'approve' : 'ready_for_validation', summary: 'ok', findings: [] } };
};
// A run marked done without driving it, for the identity checks.
function doneProject(t) {
  const root = repo(t);
  const run = createRun(root, { goal: 'First goal', provider: 'custom', plan: plan() });
  save(root, { ...state(root), status: 'done', finished_at: new Date().toISOString() });
  return { root, runId: run.run_id };
}
// A queue entry whose provider exits at once, so a started run blocks quickly.
const exitingConfig = root => file(root, 'exit.json', JSON.stringify({ provider: { command: process.execPath, args: ['-e', 'process.exit(3)'] } }));

test('core queue add/list/remove keep FIFO order through the CLI and list shows no goal or config content', async t => {
  const root = repo(t);
  const ids = [];
  for (const [i, extra] of [[1, []], [2, ['--config', exitingConfig(root), '--provider', 'custom', '--max-sessions', '7']], [3, []]]) {
    const r = forja(t, root, ['core', 'queue', 'add', '--goal-file', file(root, `g${i}.txt`, `\uFEFFGoal number ${i} with "quotes"\nand a second line`), ...extra]);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.equal(out.position, i);
    ids.push(out.added);
  }
  let list = JSON.parse(forja(t, root, ['core', 'queue', 'list']).out).queue;
  assert.deepEqual(list.map(e => e.id), ids);
  assert.equal(list[0].goal_preview, 'Goal number 1 with "quotes" and a second line');
  assert.deepEqual(list[1].budgets, { maxSessions: 7 });
  assert.deepEqual(list.map(e => [e.provider, e.config]), [['claude', false], ['custom', true], ['claude', false]]);
  assert.doesNotMatch(JSON.stringify(list), /process\.exit|execPath/);
  // The stored entry keeps the exact goal (BOM stripped) and the frozen config content.
  const stored = readQueue(root).entries;
  assert.equal(stored[0].goal, 'Goal number 1 with "quotes"\nand a second line');
  assert.deepEqual(stored[1].config.provider.args, ['-e', 'process.exit(3)']);
  // Editing the config file afterwards changes nothing in the queue.
  writeFileSync(join(root, 'goals', 'exit.json'), '{"allowDirty":true}');
  assert.deepEqual(readQueue(root).entries[1].config.provider.args, ['-e', 'process.exit(3)']);
  assert.equal(forja(t, root, ['core', 'queue', 'remove', ids[1]]).code, 0);
  list = JSON.parse(forja(t, root, ['core', 'queue', 'list']).out).queue;
  assert.deepEqual(list.map(e => e.id), [ids[0], ids[2]]);
  // Removing an unknown id fails and changes nothing.
  const before = raw(root);
  const missing = forja(t, root, ['core', 'queue', 'remove', ids[1]]);
  assert.notEqual(missing.code, 0);
  assert.match(missing.err, /No queued goal .*nothing was changed/);
  assert.equal(raw(root), before);
  await removeFromQueue(root, ids[0]);
  assert.deepEqual(listQueue(root).map(e => e.id), [ids[2]]);
  assert.equal(existsSync(join(root, '.forja', 'queue-lock.json')), false);
});

test('core queue add refuses allow-dirty, invalid configuration, budgets and goal files without any change', t => {
  const root = repo(t);
  const goal = file(root, 'goal.txt', 'A valid goal');
  const refused = [
    [['--goal-file', goal, '--allow-dirty'], /--allow-dirty/],
    [['--goal-file', goal, '--config', file(root, 'dirty.json', '{"allowDirty":true}')], /allowDirty/],
    [['--goal-file', goal, '--config', file(root, 'bad.json', '{not json')], /not valid JSON/],
    [['--goal-file', goal, '--config', file(root, 'array.json', '[]')], /JSON object/],
    [['--goal-file', goal, '--config', file(root, 'route.json', '{"providers":{"other":{}}}')], /provider configuration/],
    [['--goal-file', goal, '--config', file(root, 'resume.json', '{"usageLimitResume":"yes"}')], /usageLimitResume/],
    [['--goal-file', goal, '--config', file(root, 'lessons.json', '{"lessons":"yes"}')], /lessons must be true or false/],
    [['--goal-file', goal, '--max-sessions', '0'], /Budget/],
    [['--goal-file', goal, '--max-attempts', '1e1'], /Budget/],
    [['--goal-file', goal, '--max-minutes'], /needs an integer value/],
    [['--goal-file', goal, '--provider', 'other'], /Provider must be/],
    [['--goal-file', file(root, 'utf16.txt', Buffer.from('G\u0000o\u0000a\u0000l\u0000'))], /not UTF-8/],
    [['--goal-file', file(root, 'empty.txt', '  \n')], /empty/],
    [['--goal-file', join(root, 'goals', 'missing.txt')], /Cannot read/],
    [['--goal', 'inline goal'], /--goal/],
    [[], /needs --goal-file/],
    [['--goal-file', goal, 'stray'], /"stray"/],
    [['--goal-file', goal, '--bogus', 'x'], /--bogus/],
  ];
  for (const [args, message] of refused) {
    const r = forja(t, root, ['core', 'queue', 'add', ...args]);
    const shown = args.join(' ');
    assert.notEqual(r.code, 0, shown);
    assert.match(r.err, message, shown);
    assert.match(r.err, /nothing was changed/i, shown);
    assert.equal(existsSync(join(root, '.forja')), false, `${shown} created state`);
  }
  // Same rule from a subdirectory: refused before .forja exists anywhere.
  mkdirSync(join(root, 'sub'));
  const sub = forja(t, join(root, 'sub'), ['core', 'queue', 'add', '--goal-file', goal]);
  assert.notEqual(sub.code, 0);
  assert.equal(existsSync(join(root, 'sub', '.forja')), false);
  assert.equal(existsSync(join(root, '.forja')), false);
  // A boolean lessons setting is accepted at add time and frozen with the entry.
  const ok = forja(t, root, ['core', 'queue', 'add', '--goal-file', goal, '--config', file(root, 'lessons-on.json', '{"lessons":true}')]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(readQueue(root).entries[0].config.lessons, true);
});

test('core queue remove on a project without a queue fails without creating .forja', async t => {
  const root = repo(t);
  await assert.rejects(removeFromQueue(root, 'Q-1-abcdef'), /No queued goal .*nothing was changed/);
  const r = forja(t, root, ['core', 'queue', 'remove', 'Q-1-abcdef']);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /No queued goal/);
  assert.equal(existsSync(join(root, '.forja')), false);
});

test('the queue is bounded and only grows under its lock', async t => {
  const root = repo(t);
  const goal = file(root, 'goal.txt', 'Bounded goal');
  for (let i = 0; i < QUEUE_MAX_ENTRIES; i++) await addToQueue(root, { 'goal-file': goal });
  const before = raw(root);
  await assert.rejects(addToQueue(root, { 'goal-file': goal }), /already holds 50 entries; nothing was changed/);
  assert.equal(raw(root), before);
  // A live holder of the queue lock makes add wait, then refuse without changes.
  writeFileSync(join(root, '.forja', 'queue-lock.json'), JSON.stringify({ pid: process.pid, token: 'other' }));
  await assert.rejects(removeFromQueue(root, readQueue(root).entries[0].id), /goal queue is busy.*nothing was changed/);
  assert.equal(raw(root), before);
});

test('a corrupt queue file is reported and never reset, listed as empty or started', async t => {
  const { root, runId } = doneProject(t);
  for (const body of ['{oops', JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ id: 'Q-1-abcdef', goal: 'x' }] }),
    JSON.stringify({ version: 1, entries: [], extra: true })]) {
    writeFileSync(queueFile(root), body);
    const list = forja(t, root, ['core', 'queue', 'list']);
    assert.notEqual(list.code, 0);
    assert.match(list.err, /goal queue \.forja\/queue\.json is unreadable .*not reset and nothing was started/);
    await assert.rejects(addToQueue(root, { 'goal-file': file(root, 'g.txt', 'Goal') }), /unreadable/);
    await assert.rejects(startFromQueue(root, { expectedRunId: runId }), /unreadable/);
    const started = await continueQueue(root, state(root), { providerCall: provider, log: quiet }, { log: quiet, warn: quiet });
    assert.match(started.refused, /unreadable/);
    assert.equal(raw(root), body, 'the corrupt file is kept byte for byte');
    assert.equal(state(root).run_id, runId, 'no run was started');
    assert.deepEqual(queueLength(root), { length: null, error: 'Goal queue is unreadable; check it locally.' });
    assert.equal(coreObservation(root).run.queue_length, null);
    assert.equal(coreObservation(root).run.queue_unreadable, true);
  }
  // Oversized files are refused before parsing.
  writeFileSync(queueFile(root), ' '.repeat(4 * 1024 * 1024 + 1));
  assert.throws(() => readQueue(root), /larger than/);
});

test('a run ending done starts the next queued goal, and the chain continues while runs end done', async t => {
  const root = repo(t);
  createRun(root, { goal: 'First goal', provider: 'custom', plan: plan() });
  await addToQueue(root, { 'goal-file': file(root, 'a.txt', 'Second goal'), provider: 'custom' });
  await addToQueue(root, { 'goal-file': file(root, 'b.txt', 'Third goal'), provider: 'custom', 'max-sessions': '9' });
  const first = await drive(root, { log: quiet, providerCall: provider });
  assert.equal(first.status, 'done', first.failure);
  const lines = [];
  const { result, refused } = await continueQueue(root, first, { log: quiet, providerCall: provider }, { log: l => lines.push(l), warn: quiet });
  assert.equal(refused, null);
  assert.equal(result.status, 'done', result.failure);
  assert.equal(result.goal, 'Third goal');
  assert.equal(result.limits.sessions, 9, 'queued budgets apply to the new run');
  assert.equal(readQueue(root).entries.length, 0);
  assert.equal(lines.length, 2);
  const runs = readdirSync(join(root, '.forja', 'runs'));
  assert.equal(runs.length, 3);
  assert.ok(runs.includes(first.run_id));
});

test('an operator stop requested before the last review approves holds the queue: no chain, entry kept', async t => {
  for (const afterTask of [false, true]) {
    const root = repo(t);
    createRun(root, { goal: 'First goal', provider: 'custom', plan: plan() });
    await addToQueue(root, { 'goal-file': file(root, 'a.txt', 'Queued goal') });
    const before = raw(root);
    let called = 0;
    // The operator runs `core stop` while the final review is pending; it approves.
    const stopping = async (_, o) => {
      called++;
      if (o.readOnly) requestStop(root, { afterTask, controllerAlive: () => true });
      return provider(_, o);
    };
    const first = await drive(root, { log: quiet, providerCall: stopping });
    assert.equal(first.status, 'done', first.failure);
    assert.equal(first.queueHold.reason, 'operator_stop');
    assert.equal(existsSync(stopRequestPath(root)), false, 'the request is consumed');
    const lines = [];
    const callsBefore = called;
    const { result, refused } = await continueQueue(root, first, { log: quiet, providerCall: provider }, { log: l => lines.push(l), warn: quiet });
    assert.equal(refused, null);
    assert.equal(result.run_id, first.run_id, 'no new run was chained');
    assert.equal(called, callsBefore);
    assert.match(lines.join(' '), /operator stop .* honoured; the queued goals were not started and stay queued/);
    assert.equal(raw(root), before);
    assert.equal(state(root).run_id, first.run_id);
    assert.equal(readdirSync(join(root, '.forja', 'runs')).length, 1);
    // The guard path refuses the held run, and the guard sees the hold.
    await assert.rejects(startFromQueue(root, { expectedRunId: first.run_id }), /operator stop was requested .* nothing was changed/);
    const r = forja(t, root, ['core', 'queue', 'start', '--expected-run', first.run_id]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /queue is held/);
    assert.equal(raw(root), before);
    assert.equal(coreObservation(root).run.queue_held, true);
  }
});

test('a done run without a pending stop is not held and its delivery shows in the observation', async t => {
  const { root } = doneProject(t);
  assert.equal(coreObservation(root).run.queue_held, false);
  assert.equal(coreObservation(root).run.delivered, true);
  save(root, { ...state(root), config: { ...state(root).config, delivery: { mode: 'commit' } }, delivery: { status: 'blocked' } });
  assert.equal(coreObservation(root).run.delivered, false);
});

test('blocked and failed runs never start the queue; done without delivery never does either', async t => {
  const root = repo(t);
  createRun(root, { goal: 'First goal', provider: 'custom', plan: plan() });
  await addToQueue(root, { 'goal-file': file(root, 'a.txt', 'Queued goal') });
  const blocked = await drive(root, { log: quiet, providerCall: async () => ({ code: 0, result: { status: 'blocked', summary: 'Need a person', findings: [] } }) });
  assert.equal(blocked.status, 'blocked');
  const before = raw(root);
  let called = 0;
  const watch = async (...a) => { called++; return provider(...a); };
  assert.deepEqual(await continueQueue(root, blocked, { log: quiet, providerCall: watch }, { log: quiet, warn: quiet }), { result: blocked, refused: null });
  // The hidden path refuses a blocked run as well.
  await assert.rejects(startFromQueue(root, { expectedRunId: blocked.run_id }), /identity or status changed/);
  const r = forja(t, root, ['core', 'queue', 'start', '--expected-run', blocked.run_id]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /identity or status changed/);
  // Abandoned (failed) runs too.
  assert.equal(forja(t, root, ['core', 'abandon', '--why', 'Stop here']).code, 0);
  const failed = state(root);
  assert.equal(failed.status, 'failed');
  await continueQueue(root, failed, { log: quiet, providerCall: watch }, { log: quiet, warn: quiet });
  await assert.rejects(startFromQueue(root, { expectedRunId: failed.run_id }), /identity or status changed/);
  // A done run whose configured delivery did not complete.
  const undelivered = { ...failed, status: 'done', config: { delivery: { mode: 'commit' } }, delivery: { status: 'blocked' } };
  await continueQueue(root, undelivered, { log: quiet, providerCall: watch }, { log: quiet, warn: quiet });
  assert.equal(called, 0);
  assert.equal(raw(root), before);
  assert.equal(state(root).run_id, blocked.run_id);
});

test('a dirty tree keeps the entry queued with a bounded reason and never applies allow-dirty', async t => {
  const { root, runId } = doneProject(t);
  await addToQueue(root, { 'goal-file': file(root, 'a.txt', 'Queued goal') });
  writeFileSync(join(root, 'stray.txt'), 'uncommitted work');
  const warnings = [];
  const { refused } = await continueQueue(root, state(root), { log: quiet, providerCall: provider }, { log: quiet, warn: w => warnings.push(w) });
  assert.match(refused, /uncommitted work/);
  assert.match(warnings[0], /stays queued/);
  assert.equal(state(root).run_id, runId, 'no run was created');
  assert.equal(state(root).config.allowDirty, undefined);
  const [entry] = readQueue(root).entries;
  assert.match(entry.last_refusal.reason, /uncommitted work/);
  assert.ok(entry.last_refusal.reason.length <= 500);
  const listed = JSON.parse(forja(t, root, ['core', 'queue', 'list']).out).queue;
  assert.match(listed[0].last_refusal.reason, /uncommitted work/);
  // The same through the hidden guard path: non-zero exit, entry kept.
  const r = forja(t, root, ['core', 'queue', 'start', '--expected-run', runId]);
  assert.notEqual(r.code, 0);
  assert.match(r.err, /stays queued: .*uncommitted work/);
  assert.equal(readQueue(root).entries.length, 1);
  // Once the tree is clean the guard path starts it and removes the entry.
  rmSync(join(root, 'stray.txt'));
  const started = await startFromQueue(root, { expectedRunId: runId });
  assert.equal(started.entry, entry.id);
  assert.equal(state(root).run_id, started.run.run_id);
  assert.equal(state(root).goal, 'Queued goal');
  assert.equal(readQueue(root).entries.length, 0);
});

test('the guard path needs the same done run and no live controller; an empty queue starts nothing', async t => {
  const { root, runId } = doneProject(t);
  const empty = forja(t, root, ['core', 'queue', 'start', '--expected-run', runId]);
  assert.equal(empty.code, 0, empty.err);
  assert.match(empty.out, /no queued goal; nothing was started/);
  await addToQueue(root, { 'goal-file': file(root, 'a.txt', 'Queued goal') });
  const before = raw(root);
  await assert.rejects(startFromQueue(root, { expectedRunId: 'F-1-abcdef' }), /identity or status changed/);
  // A live controller holds the project lock.
  writeFileSync(join(root, '.forja', 'lock.json'), JSON.stringify({ pid: process.pid, token: 'live' }));
  await assert.rejects(startFromQueue(root, { expectedRunId: runId }), /still alive/);
  rmSync(join(root, '.forja', 'lock.json'));
  assert.equal(raw(root), before);
  assert.equal(state(root).run_id, runId);
  for (const args of [['core', 'queue', 'start'], ['core', 'queue', 'start', '--expected-run', 'not-a-run'], ['core', 'queue', 'start', '--expected-run', runId, '--goal', 'x']]) {
    const r = forja(t, root, args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, /nothing was changed/, args.join(' '));
  }
  assert.equal(raw(root), before);
  assert.equal(coreObservation(root).run.queue_length, 1);
  assert.equal(coreObservation(root).run.queue_unreadable, false);
});

test('two concurrent queue starts in separate processes create exactly one run and consume exactly one entry', async t => {
  const { root, runId } = doneProject(t);
  for (const name of ['a', 'b']) await addToQueue(root, { 'goal-file': file(root, `${name}.txt`, `Queued goal ${name}`), provider: 'custom', config: exitingConfig(root) });
  const [head, second] = readQueue(root).entries.map(e => e.id);
  const data = tempDir(t, 'forja-queue-data-');
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const run = () => new Promise(done => {
    const child = spawn(process.execPath, [cli, 'core', 'queue', 'start', '--expected-run', runId], { cwd: root, env, windowsHide: true });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.stdout.resume();
    child.on('close', code => done({ code, err }));
  });
  const results = await Promise.all([run(), run()]);
  const runs = readdirSync(join(root, '.forja', 'runs')).filter(id => id !== runId);
  assert.equal(runs.length, 1, JSON.stringify(results));
  assert.deepEqual(readQueue(root).entries.map(e => e.id), [second], 'exactly the head was consumed');
  assert.notEqual(state(root).run_id, runId);
  assert.equal(state(root).goal, 'Queued goal a');
  assert.ok(head);
  // The new run's provider exits at once, so both processes exit non-zero; the
  // loser says why it did not start anything.
  const losers = results.filter(r => /identity or status changed|still alive|already in progress|goal queue is busy/.test(r.err));
  assert.equal(losers.length, 1, JSON.stringify(results));
  for (const leftover of ['lock.json', 'takeover.json', 'queue-lock.json', 'queue-takeover.json'])
    assert.equal(existsSync(join(root, '.forja', leftover)), false, leftover);
});

test('a queue file tracked by Git is never started or changed', async t => {
  const { root, runId } = doneProject(t);
  await addToQueue(root, { 'goal-file': file(root, 'a.txt', 'Queued goal') });
  for (const args of [['add', '-f', '.forja/queue.json'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Committed queue']])
    execFileSync('git', args, { cwd: root, windowsHide: true });
  const before = raw(root);
  await assert.rejects(startFromQueue(root, { expectedRunId: runId }), /tracked by Git.*nothing was changed/);
  await assert.rejects(removeFromQueue(root, readQueue(root).entries[0].id), /tracked by Git/);
  assert.equal(raw(root), before);
  assert.equal(state(root).run_id, runId);
});
