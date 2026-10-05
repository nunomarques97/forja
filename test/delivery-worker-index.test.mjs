import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRun, drive } from '../lib/core/engine.mjs';
import { indexContentHash, workerIndexBaseline, restoreWorkerIndex } from '../lib/core/delivery.mjs';

// #36: a develop worker's git rm / git mv / git add staged its own changes and
// the occupied-index guard then blocked delivery before review. The controller
// now unstages what the session staged when the index was clean before it and
// every staged entry equals the working tree; anything else still blocks.
const roots = [];
after(() => { for (const root of roots) { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); } });
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const staged = root => git(root, ['diff', '--cached', '--name-status', '--no-renames']);
function repo(granularity = 'task') {
  const root = mkdtempSync(join(tmpdir(), 'forja-worker-index-')); roots.push(root);
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, 'old.md'), 'old\n');
  writeFileSync(join(root, 'moved.md'), 'moved\n');
  git(root, ['add', '--', '.gitignore', 'value.mjs', 'old.md', 'moved.md']); git(root, ['commit', '-qm', 'fixture']);
  return { root, base: git(root, ['rev-parse', 'HEAD']), config: { delivery: { mode: 'commit', granularity } } };
}
const plan = { decisions: [], tasks: [{ id: 'T1', title: 'Tidy docs', criteria: ['value equals two'], files: ['value.mjs', 'old.md', 'moved.md', 'renamed.md', 'notes.md'], risks: [], complexity: 'easy', after: [],
  checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] }] };
const ledger = (root, run) => readFileSync(join(root, '.forja', 'runs', run, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
async function run(f, develop, { before } = {}) {
  createRun(f.root, { goal: 'Tidy docs', provider: 'custom', plan, config: f.config });
  before?.(f.root);
  const seen = { reviews: 0, prompts: [], stagedAtReview: null };
  const result = await drive(f.root, { log: () => {}, providerCall: async (_, options) => {
    const packet = JSON.parse(options.text);
    if (!options.readOnly) {
      seen.prompts.push(options.input);
      writeFileSync(join(f.root, 'value.mjs'), 'export const value = 2;\n');
      develop(f.root);
      return { code: 0, result: { status: 'ready_for_validation', summary: 'Synthetic', findings: [] }, duration_ms: 1 };
    }
    seen.reviews++;
    seen.stagedAtReview = staged(f.root);
    const ready = packet.changes?.delivery?.status === 'ready';
    const delivery = ready ? { delivery: { status: 'approve', tree: packet.changes.delivery.tree, message: 'Tidy docs', reason: 'Reviewed' } } : {};
    return { code: 0, result: { status: 'approve', summary: 'Reviewed', findings: [], ...delivery }, duration_ms: 1 };
  } });
  return { result, seen };
}

// What the issue's worker did, plus the other staging commands a worker may run.
const stagingWorker = root => {
  git(root, ['rm', '-q', '--', 'old.md']);
  git(root, ['mv', 'moved.md', 'renamed.md']);
  writeFileSync(join(root, 'notes.md'), 'notes\n');
  git(root, ['add', '--', 'notes.md', 'value.mjs']);
};

for (const granularity of ['task', 'run']) {
  test(`${granularity} granularity: a worker's git rm, git mv and git add no longer block delivery before review (#36)`, async () => {
    const f = repo(granularity);
    const { result, seen } = await run(f, stagingWorker);
    assert.equal(result.status, 'done', result.failure);
    assert.equal(seen.reviews, 1, 'the task reached its review');
    assert.equal(seen.stagedAtReview, '', 'the index was clean again before checks and review');
    assert.equal(result.delivery.status, 'committed', result.delivery.reason);
    assert.equal(git(f.root, ['rev-parse', 'HEAD^']), f.base);
    assert.deepEqual(git(f.root, ['diff', '--name-status', '--no-renames', f.base, 'HEAD']).split('\n'),
      ['D\tmoved.md', 'A\tnotes.md', 'D\told.md', 'A\trenamed.md', 'M\tvalue.mjs'], 'every worker change is in the reviewed commit');
    assert.equal(git(f.root, ['status', '--porcelain']), '');
    const [restore] = result.tasks[0].index_restored;
    assert.deepEqual(restore.paths, ['moved.md', 'notes.md', 'old.md', 'renamed.md', 'value.mjs']);
    const developRow = ledger(f.root, result.run_id).find(row => row.phase === 'develop' && row.worker_index);
    assert.deepEqual(developRow.worker_index, { restored: true, paths: restore.paths, total: 5 }, 'the ledger records the restore');
    assert.match(seen.prompts[0], /Do not stage: create, delete or move files with filesystem operations, never git add, git rm or git mv\./);
  });
}

// Each case leaves the worker's change on disk and only adds staging that must
// not be undone: the run blocks before review and names the staged paths.
const blocked = [
  ['a staged-then-modified file', root => { git(root, ['add', '--', 'value.mjs']); writeFileSync(join(root, 'value.mjs'), 'export const value = 3;\n'); },
    /staged content differs from the working tree: value\.mjs/, /Staged: value\.mjs\./, 'M\tvalue.mjs'],
  ['a staged deletion of a file kept on disk', root => git(root, ['rm', '-q', '--cached', '--', 'old.md']),
    /staged content differs from the working tree: old\.md/, /Staged: old\.md\./, 'D\told.md'],
  // core.fileMode=false (the Windows default) hides a staged mode from a
  // porcelain diff, and a working-tree add would drop it.
  ['a staged executable bit under core.fileMode=false', root => { git(root, ['config', 'core.fileMode', 'false']); git(root, ['add', '--chmod=+x', '--', 'value.mjs']); },
    /staged content differs from the working tree: value\.mjs/, /Staged: value\.mjs\./, 'M\tvalue.mjs', root => assert.match(git(root, ['ls-files', '--stage', '--', 'value.mjs']), /^100755 /)],
];
for (const [name, develop, kept, message, entry, check] of blocked) {
  test(`${name} is left staged and still blocks before review`, async () => {
    const f = repo();
    const logs = [];
    createRun(f.root, { goal: 'Tidy docs', provider: 'custom', plan, config: f.config });
    let reviews = 0;
    const result = await drive(f.root, { log: line => logs.push(line), providerCall: async (_, options) => {
      if (options.readOnly) { reviews++; return { code: 0, result: { status: 'approve', summary: 'Reviewed', findings: [] }, duration_ms: 1 }; }
      writeFileSync(join(f.root, 'value.mjs'), 'export const value = 2;\n');
      develop(f.root);
      return { code: 0, result: { status: 'ready_for_validation', summary: 'Synthetic', findings: [] }, duration_ms: 1 };
    } });
    assert.equal(result.status, 'blocked');
    assert.equal(reviews, 0, 'no review is paid for');
    assert.match(result.failure, /Task delivery blocked before review: Delivery refuses an occupied index/);
    assert.match(result.failure, message, 'the block names the staged paths');
    assert.ok(logs.some(line => kept.test(line)), logs.join('\n'));
    assert.ok(staged(f.root).split('\n').includes(entry), 'the staged entry is preserved');
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base, 'no commit');
    assert.equal(result.tasks[0].index_restored, undefined);
    check?.(f.root);
  });
}

test('a user-staged entry that predates the session is preserved and still refused', async () => {
  const f = repo();
  const userStage = root => { writeFileSync(join(root, 'user.md'), 'operator work\n'); git(root, ['add', '--', 'user.md']); };
  const { result, seen } = await run(f, root => git(root, ['rm', '-q', '--', 'old.md']), { before: userStage });
  assert.equal(result.status, 'blocked');
  assert.equal(seen.reviews, 0);
  assert.match(result.failure, /Delivery refuses an occupied index; preserve existing staged work\. Staged: old\.md, user\.md\./);
  assert.deepEqual(staged(f.root).split('\n'), ['D\told.md', 'A\tuser.md'], 'nothing is unstaged when the index was occupied before the session');
  assert.equal(readFileSync(join(f.root, 'user.md'), 'utf8'), 'operator work\n');
  assert.equal(result.tasks[0].index_restored, undefined);
  assert.deepEqual(ledger(f.root, result.run_id).find(row => row.worker_index).worker_index,
    { restored: false, paths: ['old.md', 'user.md'], total: 2, reason: 'staged entries existed before the session' });
});

test('a user-staged entry alone is refused as before, without touching the index', async () => {
  const f = repo();
  const { result } = await run(f, () => {}, { before: root => git(root, ['rm', '-q', '--cached', '--', 'moved.md']) });
  assert.equal(result.status, 'blocked');
  assert.match(result.failure, /Staged: moved\.md\./);
  assert.equal(staged(f.root), 'D\tmoved.md');
  assert.equal(ledger(f.root, result.run_id).find(row => row.worker_index), undefined, 'an unchanged index is not reported');
});

test('restoreWorkerIndex unstages only session staging that equals the working tree', () => {
  const { root } = repo();
  const clean = workerIndexBaseline(root);
  assert.deepEqual(clean.staged, []);
  assert.equal(restoreWorkerIndex(root, clean), null, 'nothing changed');
  // Staged new file, staged deletion, intent-to-add entry.
  writeFileSync(join(root, 'notes.md'), 'notes\n'); git(root, ['add', '--', 'notes.md']);
  git(root, ['rm', '-q', '--', 'old.md']);
  writeFileSync(join(root, 'draft.md'), 'draft\n'); git(root, ['add', '-N', '--', 'draft.md']);
  assert.deepEqual(restoreWorkerIndex(root, clean), { restored: true, paths: ['draft.md', 'notes.md', 'old.md'] });
  assert.equal(indexContentHash(root), clean.hash);
  assert.equal(staged(root), '');
  assert.ok(existsSync(join(root, 'notes.md')) && existsSync(join(root, 'draft.md')) && !existsSync(join(root, 'old.md')), 'the working tree is untouched');
  // A staged deletion whose path came back on disk differs from the working tree.
  git(root, ['rm', '-q', '--', 'moved.md']); writeFileSync(join(root, 'moved.md'), 'recreated\n');
  assert.deepEqual(restoreWorkerIndex(root, clean), { restored: false, paths: ['moved.md'], reason: 'staged content differs from the working tree: moved.md' });
  assert.equal(staged(root), 'D\tmoved.md');
  // An earlier baseline with staged entries is never restored.
  assert.equal(restoreWorkerIndex(root, workerIndexBaseline(root)), null);
  git(root, ['add', '--', 'notes.md']);
  assert.equal(restoreWorkerIndex(root, { ...clean, staged: ['moved.md'] }).reason, 'staged entries existed before the session');
});

test('restoreWorkerIndex leaves unmerged entries for inspection', () => {
  const { root } = repo();
  const clean = workerIndexBaseline(root);
  git(root, ['checkout', '-q', '-b', 'other']);
  writeFileSync(join(root, 'value.mjs'), 'export const value = 3;\n'); git(root, ['commit', '-qam', 'other']);
  git(root, ['checkout', '-q', '-']);
  writeFileSync(join(root, 'value.mjs'), 'export const value = 4;\n'); git(root, ['commit', '-qam', 'main']);
  const conflicted = workerIndexBaseline(root);
  try { git(root, ['merge', '-q', 'other']); } catch {}
  const result = restoreWorkerIndex(root, { ...clean, hash: conflicted.hash, head: conflicted.head });
  assert.equal(result.restored, false);
  assert.equal(result.reason, 'unmerged entries');
});

test('restoreWorkerIndex keeps staging a working-tree add would not reproduce', () => {
  const { root } = repo();
  git(root, ['config', 'core.fileMode', 'false']); git(root, ['config', 'core.symlinks', 'false']);
  const clean = workerIndexBaseline(root);
  const keeps = (paths, label) => {
    const result = restoreWorkerIndex(root, clean);
    assert.deepEqual(result, { restored: false, paths, reason: `staged content differs from the working tree: ${paths.join(', ')}` }, label);
    git(root, ['reset', '-q']);
    assert.equal(staged(root), '');
  };
  // Mode only: content equals HEAD and the working tree.
  git(root, ['update-index', '--chmod=+x', '--', 'value.mjs']);
  keeps(['value.mjs'], 'executable bit on a tracked file');
  writeFileSync(join(root, 'run.sh'), 'echo run\n'); git(root, ['add', '--chmod=+x', '--', 'run.sh']);
  keeps(['run.sh'], 'new executable file');
  // A symlink staged while core.symlinks=false leaves a plain file on disk.
  writeFileSync(join(root, 'link'), 'value.mjs');
  const blob = execFileSync('git', ['hash-object', '-w', '--', 'link'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git(root, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  keeps(['link'], 'symlink type');
  // An ignored file a worker force-added cannot be added from the working tree.
  writeFileSync(join(root, '.gitignore'), '.forja/\n*.log\n'); git(root, ['commit', '-qam', 'ignore logs']);
  const ignoring = workerIndexBaseline(root);
  writeFileSync(join(root, 'debug.log'), 'trace\n'); git(root, ['add', '-f', '--', 'debug.log']);
  assert.deepEqual(restoreWorkerIndex(root, ignoring), { restored: false, paths: ['debug.log'], reason: 'staged content differs from the working tree: debug.log' });
  git(root, ['reset', '-q']);
  // A worker that committed and staged leaves the index for inspection.
  writeFileSync(join(root, 'value.mjs'), 'export const value = 5;\n'); git(root, ['commit', '-qam', 'worker commit']);
  writeFileSync(join(root, 'notes.md'), 'notes\n'); git(root, ['add', '--', 'notes.md']);
  assert.deepEqual(restoreWorkerIndex(root, ignoring), { restored: false, paths: ['notes.md'], reason: 'HEAD changed during the session' });
  assert.equal(staged(root), 'A\tnotes.md');
  // The same content and default mode is still unstaged.
  git(root, ['reset', '-q', '--soft', 'HEAD^']); git(root, ['reset', '-q']);
  git(root, ['add', '--', 'notes.md', 'value.mjs']);
  assert.deepEqual(restoreWorkerIndex(root, ignoring), { restored: true, paths: ['notes.md', 'value.mjs'] });
});
