import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRun, drive, current } from '../lib/core/engine.mjs';
import { recordTaskDeliveryReview, commitTaskDelivery } from '../lib/core/delivery.mjs';

// #35: worktrees share .git/config, so tracking entries a sibling worktree
// writes for its own branches must not void an approval. Configuration that
// can change the created commit, its tree or the push still does, and the
// block names the key, never its value.
const roots = [];
after(() => { for (const root of roots) { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); } });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
const git = (root, args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function directory() { const root = mkdtempSync(join(tmpdir(), 'forja-delivery-config-')); roots.push(root); return root; }
// A dotted target branch with its own remote: branch.<target>.* and
// remote.origin.* are bound; lookalike subsections are not.
const TARGET = 'work.v1.2';
function repo(granularity, { push = false } = {}) {
  const root = directory();
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.forja/\nlocal-delivery.json\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  git(root, ['add', '--', '.gitignore', 'value.mjs']); git(root, ['commit', '-qm', 'fixture']);
  git(root, ['checkout', '-q', '-b', TARGET]);
  git(root, ['remote', 'add', 'origin', 'https://example.invalid/fixture.git']);
  git(root, ['config', `branch.${TARGET}.remote`, 'origin']); git(root, ['config', `branch.${TARGET}.merge`, `refs/heads/${TARGET}`]);
  git(root, ['remote', 'add', 'other', 'https://example.invalid/other.git']);
  const config = { delivery: { mode: push ? 'push' : 'commit', ...(granularity === 'task' ? { granularity } : {}) } };
  let remote;
  if (push) {
    remote = directory(); git(remote, ['init', '--bare', '-q']);
    const policy = { version: 1, destination: { url: pathToFileURL(remote).href, branch: 'work/approved', baseBranch: 'main' },
      pipeline: { effect: 'preview', description: 'Offline fixture; no deployment service exists.' }, pipelineFiles: [] };
    writeFileSync(join(root, 'local-delivery.json'), JSON.stringify(policy));
    config.delivery.policyFile = 'local-delivery.json';
    git(root, ['push', '-q', policy.destination.url, 'HEAD:refs/heads/main']);
    // Not the target branch's remote: bound because its URL is the destination.
    git(root, ['remote', 'add', 'publish', policy.destination.url]);
  }
  return { root, remote, config, base: git(root, ['rev-parse', 'HEAD']) };
}
const plan = { decisions: [], tasks: [{ id: 'T1', title: 'Return two', criteria: ['value equals two'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [],
  checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] }] };
async function run(f, duringReview) {
  createRun(f.root, { goal: 'Return two', provider: 'custom', plan, config: f.config });
  let reviews = 0;
  const result = await drive(f.root, { log: () => {}, providerCall: async (_, options) => {
    const packet = JSON.parse(options.text);
    if (!options.readOnly) {
      writeFileSync(join(f.root, 'value.mjs'), 'export const value = 2;\n');
      return { code: 0, result: { status: 'ready_for_validation', summary: 'Synthetic', findings: [] }, duration_ms: 1 };
    }
    assert.equal(packet.changes?.delivery?.status, 'ready', JSON.stringify(packet.changes?.delivery));
    reviews++;
    if (duringReview === 'outage') return { code: 1, error: 'synthetic review outage', duration_ms: 1 };
    duringReview(f.root);
    const delivery = { status: 'approve', tree: packet.changes.delivery.tree, message: 'Return two', reason: 'Reviewed' };
    return { code: 0, result: { status: 'approve', summary: 'Reviewed', findings: [], delivery }, duration_ms: 1 };
  } });
  return { result, reviews };
}
// What the issue reported: branch creation with tracking in another worktree
// of the same repository while the review runs.
function siblingWork(root) {
  const before = git(root, ['config', '--list']);
  const sibling = join(directory(), 'sibling');
  git(root, ['worktree', 'add', '-q', '--track', '-b', 'sibling-a', sibling, TARGET]);
  git(sibling, ['branch', '--track', 'sibling-b', TARGET]);
  git(sibling, ['switch', '-q', '-c', 'sibling-c', '--track', TARGET]);
  // Lookalike subsections: a prefix of the dotted target and another case.
  git(sibling, ['config', 'branch.work.v1.merge', 'refs/heads/sibling-b']);
  git(sibling, ['config', 'branch.Work.v1.2.merge', 'refs/heads/sibling-c']);
  git(sibling, ['config', 'remote.other.url', 'https://example.invalid/moved.git']);
  git(sibling, ['config', 'alias.st', 'status']);
  const after = git(root, ['config', '--list']);
  for (const key of ['branch.sibling-a.merge', 'branch.sibling-b.merge', 'branch.sibling-c.merge', 'branch.Work.v1.2.merge'])
    assert.ok(!before.includes(key + '=') && after.includes(key + '='), `the sibling worktree wrote ${key} to the shared config`);
}
const reasonOf = (granularity, result) => granularity === 'task' ? result.failure : result.delivery.reason;

for (const granularity of ['run', 'task']) {
  test(`${granularity} granularity: branches tracked from a sibling worktree during review keep the approval`, async () => {
    const f = repo(granularity);
    const { result, reviews } = await run(f, siblingWork);
    assert.equal(reviews, 1, 'no extra check and review cycle');
    assert.equal(result.status, 'done', result.failure);
    assert.equal(result.delivery.status, 'committed', result.delivery.reason);
    assert.equal(git(f.root, ['rev-parse', 'HEAD^']), f.base);
    assert.equal(git(f.root, ['symbolic-ref', '--short', 'HEAD']), TARGET);
    assert.equal(git(f.root, ['show', 'HEAD:value.mjs']), 'export const value = 2;');
  });

  test(`${granularity} granularity: sibling-worktree tracking keeps a push approval and publishes once`, async () => {
    const f = repo(granularity, { push: true });
    const { result } = await run(f, siblingWork);
    assert.equal(result.status, 'done', result.failure);
    assert.equal(result.delivery.status, 'pushed', result.delivery.reason);
    assert.equal(git(f.remote, ['rev-parse', 'refs/heads/work/approved']), git(f.root, ['rev-parse', 'HEAD']));
    assert.equal(git(f.root, ['rev-parse', 'HEAD^']), f.base);
  });

  const bound = [['user.email', 'sentinel-author@example.invalid'], ['core.autocrlf', 'false'], ['filter.sentinel.clean', 'sentinel-clean-command'],
    [`branch.${TARGET}.merge`, 'refs/heads/sentinel-merge'], ['remote.origin.url', 'https://example.invalid/sentinel-remote.git']];
  for (const [key, value] of bound) {
    test(`${granularity} granularity: changing ${key} during review voids the approval and names the key`, async () => {
      const f = repo(granularity);
      const { result } = await run(f, root => git(root, ['config', key, value]));
      assert.equal(result.status === 'done' ? result.delivery.status : result.status, 'blocked');
      const reason = reasonOf(granularity, result);
      assert.match(reason, /Delivery inputs changed during review; approval cannot be applied/);
      assert.ok(reason.includes(`Git config ${key}`), reason);
      assert.ok(!reason.includes(value), 'the reason never contains the configured value');
      assert.ok(!/\b(source|index|HEAD)\b/.test(reason.split('Changed:')[1]), 'only the configuration is named');
      assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base, 'no commit');
      assert.equal(readFileSync(join(f.root, 'value.mjs'), 'utf8'), 'export const value = 2;\n', 'work is preserved');
    });
  }

  test(`${granularity} granularity: changing a remote that matches the destination URL voids a push approval`, async () => {
    const f = repo(granularity, { push: true });
    const { result } = await run(f, root => git(root, ['config', 'remote.publish.pushurl', 'https://example.invalid/sentinel-push.git']));
    assert.equal(result.status === 'done' ? result.delivery.status : result.status, 'blocked');
    const reason = reasonOf(granularity, result);
    assert.ok(reason.includes('Git config remote.publish.pushurl'), reason);
    assert.ok(!reason.includes('sentinel-push'));
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base, 'no commit');
    assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/']), 'refs/heads/main', 'nothing published');
  });

  test(`${granularity} granularity: removing a bound key during review names it`, async () => {
    const f = repo(granularity);
    const { result } = await run(f, root => git(root, ['config', '--unset', `branch.${TARGET}.remote`]));
    const reason = reasonOf(granularity, result);
    assert.ok(reason.includes(`Git config branch.${TARGET}.remote`), reason);
    assert.ok(reason.includes('Git config remote.origin.url'), 'the target branch no longer binds its old remote');
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base, 'no commit');
  });
}

test('a URL subsection is named without its credentials', async () => {
  const f = repo('task');
  const token = ['sentinel', 'credential'].join('-');
  const { result } = await run(f, root => git(root, ['config', `url.https://${token}@example.invalid/.insteadOf`, 'https://example.invalid/']));
  assert.match(result.failure, /Git config url\.https:\/\/\*\*\*@example\.invalid\/\.insteadof/);
  assert.ok(!result.failure.includes(token));
  const { run_id, taskDelivery } = JSON.parse(readFileSync(current(f.root), 'utf8'));
  const receipt = readFileSync(join(f.root, '.forja', 'runs', run_id, 'delivery', `${taskDelivery.key}.json`), 'utf8');
  assert.ok(!receipt.includes(token), 'the receipt stores neither the value nor the credential');
});

// The review is approved and recorded; configuration then changes before the
// controller installs the task commit.
async function approvedTask(legacy = false) {
  const f = repo('task');
  await run(f, 'outage');
  const runState = JSON.parse(readFileSync(current(f.root), 'utf8')), task = runState.tasks.find(t => t.id === 'T1');
  assert.equal(runState.taskDelivery?.status, 'pending_review');
  const receiptPath = join(f.root, '.forja', 'runs', runState.run_id, 'delivery', `${runState.taskDelivery.key}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(typeof receipt.gitConfig, 'object');
  for (const digest of Object.values(receipt.gitConfig)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(receipt.gitConfig).includes('fixture@example.invalid'), 'digests, never values');
  if (legacy) {
    // A receipt written before 0.21.2 bound the whole configuration.
    receipt.gitConfig = sha(execFileSync('git', ['config', '--null', '--list', '--show-origin'], { cwd: f.root, env, windowsHide: true }));
    writeFileSync(receiptPath, JSON.stringify(receipt));
    runState.taskDelivery.receipt_sha256 = sha(readFileSync(receiptPath));
  }
  recordTaskDeliveryReview(f.root, runState, task, { status: 'approve', delivery: { status: 'approve', tree: receipt.tree, message: 'Return two', reason: 'Reviewed' } });
  assert.equal(runState.taskDelivery.status, 'approved', runState.taskDelivery.reason);
  return { f, runState, task };
}

test('task granularity: a bound key changed after approval blocks commit installation and is named', async () => {
  const { f, runState, task } = await approvedTask();
  git(f.root, ['config', 'commit.gpgSign', 'false']);
  assert.throws(() => commitTaskDelivery(f.root, runState, task, () => {}),
    /^Error: Source, index, candidate or Git configuration changed after review\. Changed: Git config commit\.gpgsign\.$/);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base, 'no commit');
  assert.equal(readFileSync(join(f.root, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
});

test('task granularity: sibling tracking after approval does not block commit installation', async () => {
  const { f, runState, task } = await approvedTask();
  siblingWork(f.root);
  const commit = commitTaskDelivery(f.root, runState, task, () => {});
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), commit);
  assert.equal(git(f.root, ['rev-parse', 'HEAD^']), f.base);
});

test('a receipt from before 0.21.2 keeps the whole-configuration comparison', async () => {
  const { f, runState, task } = await approvedTask(true);
  git(f.root, ['branch', '--track', 'sibling-legacy', TARGET]);
  assert.throws(() => commitTaskDelivery(f.root, runState, task, () => {}), /Changed: Git configuration\.$/);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base, 'no commit');
});
