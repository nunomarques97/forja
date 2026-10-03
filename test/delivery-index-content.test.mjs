import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRun, drive } from '../lib/core/engine.mjs';
import { indexContentHash } from '../lib/core/delivery.mjs';
import { runProvider } from '../lib/core/providers.mjs';

// #30: a read-only git status during review refreshes the stat cache and
// rewrites .git/index. Delivery compares staged content, so that keeps the
// approval; a real staged change still voids it.
const roots = [];
after(() => { for (const root of roots) { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); } });
const git = (root, args, env = process.env) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// What an operator or reviewer runs from another terminal: optional locks enabled.
const status = root => git(root, ['status', '--porcelain'], { ...process.env, GIT_OPTIONAL_LOCKS: '1' });
const rawIndex = root => readFileSync(join(root, '.git', 'index'));
function repo(granularity) {
  const root = mkdtempSync(join(tmpdir(), 'forja-index-content-')); roots.push(root);
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  git(root, ['add', '--', '.gitignore', 'value.mjs']); git(root, ['commit', '-qm', 'fixture']);
  return { root, base: git(root, ['rev-parse', 'HEAD']), config: { delivery: { mode: 'commit', ...(granularity === 'task' ? { granularity } : {}) } } };
}
// Same content, new mtime: the next git status must refresh and rewrite the index.
function staleStat(root) {
  const later = new Date(Date.now() + 60000);
  utimesSync(join(root, '.gitignore'), later, later);
}
const plan = { decisions: [], tasks: [{ id: 'T1', title: 'Return two', criteria: ['value equals two'], files: ['value.mjs', 'notes.txt'], risks: [], complexity: 'easy', after: [],
  checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] }] };
async function run(f, duringReview) {
  createRun(f.root, { goal: 'Return two', provider: 'custom', plan, config: f.config });
  let reviews = 0;
  const result = await drive(f.root, { log: () => {}, providerCall: async (_, options) => {
    const packet = JSON.parse(options.text);
    if (!options.readOnly) {
      writeFileSync(join(f.root, 'value.mjs'), 'export const value = 2;\n');
      writeFileSync(join(f.root, 'notes.txt'), 'two\n');
      return { code: 0, result: { status: 'ready_for_validation', summary: 'Synthetic', findings: [] }, duration_ms: 1 };
    }
    assert.equal(packet.changes?.delivery?.status, 'ready', JSON.stringify(packet.changes?.delivery));
    reviews++;
    duringReview(f.root);
    const delivery = { status: 'approve', tree: packet.changes.delivery.tree, message: 'Return two', reason: 'Reviewed' };
    return { code: 0, result: { status: 'approve', summary: 'Reviewed', findings: [], delivery }, duration_ms: 1 };
  } });
  return { result, reviews };
}

test('the staged-content hash ignores a stat refresh and sees staged and intent-to-add changes', () => {
  const { root } = repo('run');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
  writeFileSync(join(root, 'empty.txt'), '');
  const before = indexContentHash(root), bytes = rawIndex(root);
  staleStat(root); status(root);
  assert.notDeepEqual(rawIndex(root), bytes, 'the fixture really rewrote .git/index');
  assert.equal(indexContentHash(root), before, 'a stat refresh is not a content change');
  git(root, ['add', '-N', '--', 'empty.txt']);
  const intent = indexContentHash(root);
  assert.notEqual(intent, before, 'an intent-to-add entry changes the hash');
  git(root, ['add', '--', 'empty.txt']);
  assert.notEqual(indexContentHash(root), intent, 'a staged empty file differs from an intent-to-add entry');
  git(root, ['reset', '-q', '--', 'empty.txt']);
  assert.equal(indexContentHash(root), before);
  git(root, ['add', '--', 'value.mjs']);
  assert.notEqual(indexContentHash(root), before, 'a staged modification changes the hash');
});

for (const granularity of ['run', 'task']) {
  test(`${granularity} granularity: a read-only git status during review keeps the approval`, async () => {
    const f = repo(granularity);
    let rewritten = false;
    const { result, reviews } = await run(f, root => {
      const bytes = rawIndex(root);
      staleStat(root); status(root);
      rewritten = !rawIndex(root).equals(bytes);
    });
    assert.ok(rewritten, 'the review-time git status rewrote .git/index');
    assert.equal(reviews, 1, 'no extra check and review cycle');
    assert.equal(result.status, 'done', result.failure);
    assert.equal(result.delivery.status, 'committed', result.delivery.reason);
    assert.equal(git(f.root, ['rev-parse', 'HEAD^']), f.base);
    assert.equal(git(f.root, ['show', 'HEAD:value.mjs']), 'export const value = 2;');
    assert.equal(git(f.root, ['status', '--porcelain']), '');
  });

  for (const [change, stage] of [['git add of a modified file', root => git(root, ['add', '--', 'value.mjs'])],
    ['an intent-to-add entry', root => git(root, ['add', '-N', '--', 'notes.txt'])]]) {
    test(`${granularity} granularity: ${change} during review still voids the approval`, async () => {
      const f = repo(granularity);
      const { result } = await run(f, stage);
      assert.equal(result.status === 'done' ? result.delivery.status : result.status, 'blocked');
      const reason = granularity === 'task' ? result.failure : result.delivery.reason;
      assert.match(reason, /Delivery inputs changed during review; approval cannot be applied/);
      assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base, 'no commit');
      assert.equal(readFileSync(join(f.root, 'value.mjs'), 'utf8'), 'export const value = 2;\n', 'work is preserved');
    });
  }
}

test('Core and delivery Git calls do not rewrite a stale index', async () => {
  const f = repo('task');
  staleStat(f.root);
  const bytes = rawIndex(f.root);
  const { result } = await run(f, () => { assert.deepEqual(rawIndex(f.root), bytes, 'preparation left .git/index untouched'); });
  assert.equal(result.status, 'done', result.failure);
});

test('worker invocations run with GIT_OPTIONAL_LOCKS=0 and otherwise inherit the environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forja-index-content-')); roots.push(root);
  const fixture = join(root, 'env.mjs');
  writeFileSync(fixture, "for await (const _ of process.stdin);console.log(JSON.stringify({result:{status:'approve',summary:'env',findings:[],vars:{locks:process.env.GIT_OPTIONAL_LOCKS ?? null,sentinel:process.env.FORJA_INDEX_SENTINEL ?? null,path:process.env.PATH ?? null}}}));");
  const saved = { locks: process.env.GIT_OPTIONAL_LOCKS, sentinel: process.env.FORJA_INDEX_SENTINEL };
  process.env.FORJA_INDEX_SENTINEL = 'kept';
  delete process.env.GIT_OPTIONAL_LOCKS;
  try {
    for (const readOnly of [false, true]) {
      const out = await runProvider('custom', { cwd: root, input: 'x', readOnly, config: { command: process.execPath, args: [fixture] },
        logPath: join(root, `log-${readOnly}.json`), resultPath: join(root, `result-${readOnly}.json`) });
      roots.push(resolve(out.access.scratch, '..'));
      assert.equal(out.code, 0);
      assert.deepEqual(out.result.vars, { locks: '0', sentinel: 'kept', path: process.env.PATH ?? null });
    }
    assert.equal(process.env.GIT_OPTIONAL_LOCKS, undefined, 'the controller environment is not changed');
  } finally {
    if (saved.locks === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = saved.locks;
    if (saved.sentinel === undefined) delete process.env.FORJA_INDEX_SENTINEL; else process.env.FORJA_INDEX_SENTINEL = saved.sentinel;
  }
});
