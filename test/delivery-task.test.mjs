import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRun, drive, recoverRun, current } from '../lib/core/engine.mjs';
import { validateDelivery } from '../lib/core/delivery-policy.mjs';
import { planningContract } from '../lib/core/plan-warnings.mjs';

// Task granularity (#12): one reviewer-approved local commit per task that
// changes source; a push, if configured, only after the whole run passes.
const roots = [];
after(() => { for (const root of roots) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } });
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function directory() { const root = mkdtempSync(join(tmpdir(), 'forja-task-delivery-')); roots.push(root); return root; }
function repo({ effect } = {}) {
  const root = directory();
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.forja/\nlocal-delivery.json\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  let remote, policy;
  const config = { delivery: { mode: effect ? 'push' : 'commit', granularity: 'task' } };
  if (effect) {
    remote = directory(); git(remote, ['init', '--bare', '-q']);
    policy = { version: 1, destination: { url: pathToFileURL(remote).href, branch: 'work/approved', baseBranch: 'main' },
      pipeline: { effect, description: 'Offline fixture; no deployment service exists.' }, pipelineFiles: [] };
    writeFileSync(join(root, 'local-delivery.json'), JSON.stringify(policy));
    config.delivery.policyFile = 'local-delivery.json';
  }
  git(root, ['add', '--', '.gitignore', 'value.mjs']); git(root, ['commit', '-qm', 'fixture']);
  if (remote) git(root, ['push', '-q', policy.destination.url, 'HEAD:refs/heads/main']);
  return { root, remote, config, base: git(root, ['rev-parse', 'HEAD']) };
}
const pass = { command: 'node', args: ['-e', 'process.exit(0)'] };
const task = (id, after = []) => ({ id, title: `Task ${id}`, criteria: ['done'], files: ['value.mjs', 'notes.txt'], risks: [], complexity: 'easy', after, checks: [pass] });
const plan = { decisions: [], tasks: [task('T1'), task('T2', ['T1']), task('T3', ['T2'])] };
// T1 edits value.mjs, T2 changes nothing, T3 edits value.mjs again and adds notes.txt.
const edits = {
  T1: root => writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n'),
  T2: () => {},
  T3: root => { writeFileSync(join(root, 'value.mjs'), 'export const value = 3;\n'); writeFileSync(join(root, 'notes.txt'), 'three\n'); },
};
function provider(f, { review = () => ({}), develop = () => {}, seen = [] } = {}) {
  return async (_, options) => {
    const packet = JSON.parse(options.text), id = packet.task.id;
    seen.push(`${packet.phase}:${id}`);
    if (!options.readOnly) {
      edits[id](f.root); await develop(id);
      return { code: 0, result: { status: 'ready_for_validation', summary: 'Synthetic', findings: [] }, duration_ms: 1 };
    }
    const ready = packet.changes?.delivery?.status === 'ready';
    if (ready) assert.match(options.input, /As the reviewer of this task, also own approval of its commit/);
    const delivery = ready ? { status: 'approve', tree: packet.changes.delivery.tree, message: `Apply ${id}`, reason: 'Reviewed', ...(await review(id, packet)) } : undefined;
    return { code: 0, result: { status: 'approve', summary: 'Reviewed', findings: [], ...(delivery ? { delivery } : {}) }, duration_ms: 1 };
  };
}

test('task granularity is opt-in configuration and changes the planner contract', () => {
  assert.equal(validateDelivery({ delivery: { mode: 'commit', granularity: 'task' } }).granularity, 'task');
  assert.throws(() => validateDelivery({ delivery: { mode: 'commit', granularity: 'file' } }), /granularity must be run/);
  assert.equal(planningContract({ limits: {}, config: { delivery: { mode: 'commit', granularity: 'task' } } }).commits_during_run, true);
  assert.equal(planningContract({ limits: {}, config: { delivery: { mode: 'commit' } } }).commits_during_run, false);
  assert.equal(planningContract({ limits: {}, config: { delivery: { mode: 'commit' } } }).delivery_granularity, 'run');
});

test('each task that changes source gets one reviewed commit with only its own delta, and no extra model session', async () => {
  const f = repo();
  createRun(f.root, { goal: 'Three changes', provider: 'custom', plan, config: f.config });
  const r = await drive(f.root, { log: () => {}, providerCall: provider(f) });
  assert.equal(r.status, 'done', r.failure);
  assert.equal(r.invocations, 6, 'three develop and three review sessions only');
  assert.equal(r.delivery.status, 'committed', r.delivery.reason);
  const log = git(f.root, ['log', '--format=%s', `${f.base}..HEAD`]).split('\n');
  assert.deepEqual(log, ['Apply T3', 'Apply T1'], 'T2 changed nothing and made no empty commit');
  assert.equal(git(f.root, ['diff', '--name-only', `${f.base}`, 'HEAD~1']), 'value.mjs');
  assert.equal(git(f.root, ['show', 'HEAD~1:value.mjs']), 'export const value = 2;');
  assert.deepEqual(git(f.root, ['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n'), ['notes.txt', 'value.mjs'], 'successive delta on the shared file');
  assert.equal(git(f.root, ['show', 'HEAD:value.mjs']), 'export const value = 3;');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  assert.deepEqual(r.tasks.map(t => t.delivery.status), ['committed', 'no_changes', 'committed']);
  assert.deepEqual(r.taskCommits.map(c => c.task), ['T1', 'T3']);
  assert.equal(r.delivery.commit, git(f.root, ['rev-parse', 'HEAD']));
});

test('push mode publishes the approved chain once, after the run, never between tasks', async () => {
  const f = repo({ effect: 'preview' });
  createRun(f.root, { goal: 'Three changes', provider: 'custom', plan, config: f.config });
  const remoteBranches = [];
  const r = await drive(f.root, { log: () => {}, providerCall: provider(f, { develop: () => remoteBranches.push(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])) }) });
  assert.equal(r.status, 'done', r.failure);
  assert.equal(r.delivery.status, 'pushed', r.delivery.reason);
  assert.deepEqual(remoteBranches, ['refs/heads/main', 'refs/heads/main', 'refs/heads/main'], 'no push during the run');
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/work/approved']), git(f.root, ['rev-parse', 'HEAD']));
  assert.equal(git(f.remote, ['rev-list', '--count', `${f.base}..refs/heads/work/approved`]), '2');
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/main']), f.base);
});

test('a rejected task delivery blocks later tasks, keeps earlier commits, and a fresh review recovers it', async () => {
  const f = repo();
  createRun(f.root, { goal: 'Three changes', provider: 'custom', plan, config: f.config });
  let reject = true;
  const seen = [];
  const call = provider(f, { seen, review: id => (id === 'T3' && reject ? { status: 'reject', reason: 'Message must name the ticket' } : {}) });
  const blocked = await drive(f.root, { log: () => {}, providerCall: call });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.tasks[2].status, 'blocked');
  assert.match(blocked.failure, /T3: Task delivery blocked: .*did not approve delivery.*core retry --task T3 --validate-only/);
  assert.equal(git(f.root, ['log', '-1', '--format=%s']), 'Apply T1', 'the earlier commit is preserved');
  assert.equal(readFileSync(join(f.root, 'notes.txt'), 'utf8'), 'three\n', 'working files are preserved');
  assert.equal(git(f.root, ['diff', '--cached', '--name-only']), '');
  reject = false;
  seen.length = 0;
  recoverRun(f.root, { action: 'retry', taskId: 'T3', reason: 'Message fixed', validateOnly: true });
  const done = await drive(f.root, { log: () => {}, providerCall: call });
  assert.equal(done.status, 'done', done.failure);
  assert.deepEqual(seen, ['review:T3'], 'only a fresh review, no new implementation');
  assert.deepEqual(git(f.root, ['log', '--format=%s', `${f.base}..HEAD`]).split('\n'), ['Apply T3', 'Apply T1']);
});

test('private material in an intermediate task blocks that commit before its review, even if a later task would remove it', async () => {
  const f = repo({ effect: 'preview' });
  createRun(f.root, { goal: 'Three changes', provider: 'custom', plan, config: f.config });
  const seen = [];
  const r = await drive(f.root, { log: () => {}, providerCall: provider(f, { seen, develop: id => {
    // Assembled at run time so this source file itself passes the release guard.
    if (id === 'T1') writeFileSync(join(f.root, 'notes.txt'), `copied from /${'home'}/alice/work\n`);
  } }) });
  assert.equal(r.status, 'blocked');
  assert.match(r.failure, /T1: Task delivery blocked before review: Delivery privacy scan found material/);
  assert.deepEqual(seen, ['develop:T1'], 'no review session is spent on an undeliverable snapshot');
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/']), 'refs/heads/main');
});

test('a manual commit between tasks is detected and never adopted', async () => {
  const f = repo();
  createRun(f.root, { goal: 'Three changes', provider: 'custom', plan, config: f.config });
  const r = await drive(f.root, { log: () => {}, providerCall: provider(f, { develop: id => {
    if (id === 'T3') { git(f.root, ['add', '--', 'notes.txt']); git(f.root, ['commit', '-qm', 'manual']); }
  } }) });
  assert.equal(r.status, 'blocked');
  assert.match(r.failure, /develop changed Git HEAD; work preserved/);
  assert.deepEqual(r.taskCommits.map(c => c.task), ['T1']);
  // Also after a pause: a resume never prepares a commit on top of a foreign one.
  const resumed = await drive(f.root, { log: () => {}, providerCall: provider(f) });
  assert.equal(resumed.status, 'blocked');
  assert.deepEqual(resumed.taskCommits.map(c => c.task), ['T1']);
  assert.equal(git(f.root, ['log', '-1', '--format=%s']), 'manual');
});

test('an interrupted task commit installation resumes with the same commit and never duplicates it', async () => {
  for (const moved of [false, true]) {
    const f = repo();
    const lock = join(f.root, '.git', 'index.lock');
    createRun(f.root, { goal: 'Three changes', provider: 'custom', plan: { decisions: [], tasks: [task('T1')] }, config: f.config });
    // An index lock held by another process makes installation fail after the commit object exists.
    const stopped = await drive(f.root, { log: () => {}, providerCall: provider(f, { review: () => { writeFileSync(lock, ''); return {}; } }) });
    assert.equal(stopped.status, 'blocked');
    assert.match(stopped.failure, /Resume retries installing the same commit/);
    const pending = JSON.parse(readFileSync(join(f.root, '.forja', 'runs', stopped.run_id, 'delivery', `${stopped.taskDelivery.key}.json`), 'utf8'));
    assert.equal(pending.status, 'prepared');
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
    unlinkSync(lock);
    if (moved) {
      // The branch moved and the index was installed, but state was not saved.
      git(f.root, ['update-ref', 'HEAD', pending.commit, f.base]); git(f.root, ['read-tree', pending.commit]);
    }
    assert.throws(() => recoverRun(f.root, { action: 'retry', taskId: 'T1', reason: 'x', validateOnly: true }), /pending installation; resume/);
    const done = await drive(f.root, { log: () => {}, providerCall: () => { throw new Error('no model session is needed'); } });
    assert.equal(done.status, 'done', done.failure);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), pending.commit);
    assert.equal(git(f.root, ['rev-parse', 'HEAD^']), f.base);
    assert.equal(git(f.root, ['status', '--porcelain']), '');
    assert.deepEqual(done.taskCommits.map(c => c.commit), [pending.commit]);
  }
});

test('an existing run without granularity keeps a single commit after the run', async () => {
  const f = repo();
  createRun(f.root, { goal: 'Three changes', provider: 'custom', plan, config: { delivery: { mode: 'commit' } } });
  const r = await drive(f.root, { log: () => {}, providerCall: async (_, options) => {
    const packet = JSON.parse(options.text), id = packet.task.id;
    if (!options.readOnly) { edits[id](f.root); return { code: 0, result: { status: 'ready_for_validation', summary: 'x', findings: [] }, duration_ms: 1 }; }
    const d = packet.changes?.delivery;
    return { code: 0, result: { status: 'approve', summary: 'x', findings: [], ...(d?.status === 'ready' ? { delivery: { status: 'approve', tree: d.tree, message: 'All three', reason: 'ok' } } : {}) }, duration_ms: 1 };
  } });
  assert.equal(r.delivery.status, 'committed', r.delivery.reason);
  assert.equal(git(f.root, ['rev-list', '--count', `${f.base}..HEAD`]), '1');
  assert.equal(r.taskCommits, undefined);
  assert.equal(JSON.parse(readFileSync(current(f.root), 'utf8')).taskDelivery, undefined);
});
