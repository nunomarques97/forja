import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRun, drive } from '../lib/core/engine.mjs';
import { validateDelivery, DEFAULT_MAX_BINARY_BYTES } from '../lib/core/delivery-policy.mjs';

// #34: binary files no longer count toward the 4 MiB review patch limit. They
// are listed by path, change, size and SHA-256, bound by the approved tree and
// capped by delivery.maxBinaryBytes; the privacy scan still sees every file.
const roots = [];
after(() => { for (const root of roots) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } });
const git = (root, args, encoding = 'utf8') => execFileSync('git', args, { cwd: root, encoding, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const MiB = 1024 * 1024;
// Deterministic pseudo-random bytes behind a PNG signature: incompressible and
// binary to Git, like real screenshots.
function png(seed, size) {
  const bytes = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).copy(bytes);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 12; i < size; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; bytes[i] = x & 0xff; }
  return bytes;
}
function repo(granularity, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forja-delivery-binary-')); roots.push(root);
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  mkdirSync(join(root, 'docs/evidence'), { recursive: true });
  writeFileSync(join(root, 'docs/evidence/before.png'), png(101, 4096));
  writeFileSync(join(root, 'docs/evidence/old.png'), png(102, 2048));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'fixture']);
  return { root, base: git(root, ['rev-parse', 'HEAD']).trim(), config: { delivery: { mode: 'commit', granularity, ...extra } } };
}
// About 8 MiB of screenshots plus a small code edit, a modified and a deleted image.
function screenshots(root) {
  writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
  for (let i = 0; i < 8; i++) writeFileSync(join(root, `docs/evidence/shot-${i}.png`), png(i + 1, MiB + i * 1000));
  writeFileSync(join(root, 'docs/evidence/before.png'), png(103, 5000));
  rmSync(join(root, 'docs/evidence/old.png'));
}
const plan = files => ({ decisions: [], tasks: [{ id: 'T1', title: 'Edit', criteria: ['done'], files, risks: [], complexity: 'easy', after: [], checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] }] });
async function run(f, edit, { duringReview } = {}) {
  createRun(f.root, { goal: 'Edit with screenshots', provider: 'custom', plan: plan(['value.mjs', 'docs/evidence']), config: f.config });
  const reviews = [];
  const result = await drive(f.root, { log: () => {}, providerCall: async (_, options) => {
    const packet = JSON.parse(options.text);
    if (!options.readOnly) { edit(f.root); return { code: 0, result: { status: 'ready_for_validation', summary: 'Synthetic', findings: [] }, duration_ms: 1 }; }
    const delivery = packet.changes?.delivery;
    let approval = {};
    if (delivery?.status === 'ready') {
      reviews.push({ delivery, input: options.input, manifest: JSON.parse(readFileSync(delivery.manifest, 'utf8')), patchBytes: statSync(delivery.patch).size, patch: readFileSync(delivery.patch, 'utf8') });
      if (duringReview) duringReview(f.root, delivery);
      approval = { delivery: { status: 'approve', tree: delivery.tree, message: 'Add screenshots', reason: 'Reviewed' } };
    }
    return { code: 0, result: { status: 'approve', summary: 'Reviewed', findings: [], ...approval }, duration_ms: 1 };
  } });
  return { result, reviews };
}
const outcome = (granularity, result) => granularity === 'task' ? { status: result.status, reason: result.failure } : { status: result.delivery?.status, reason: result.delivery?.reason };

test('delivery.maxBinaryBytes is an optional positive integer, 32 MiB by default', () => {
  assert.equal(DEFAULT_MAX_BINARY_BYTES, 32 * MiB);
  assert.equal(validateDelivery({ delivery: { mode: 'commit', maxBinaryBytes: 1 } }).maxBinaryBytes, 1);
  for (const maxBinaryBytes of [0, -1, 1.5, '1048576', null, Number.MAX_VALUE])
    assert.throws(() => validateDelivery({ delivery: { mode: 'commit', maxBinaryBytes } }), /delivery\.maxBinaryBytes must be a positive integer/);
});

for (const granularity of ['run', 'task']) {
  test(`${granularity} granularity: ~8 MiB of PNGs with a small code edit reaches review and is committed`, async () => {
    const f = repo(granularity);
    const { result, reviews } = await run(f, screenshots);
    assert.equal(result.status, 'done', result.failure);
    assert.equal(result.delivery.status, 'committed', result.delivery.reason);
    assert.equal(reviews.length, 1);
    const [{ delivery, input, manifest, patchBytes, patch }] = reviews;
    assert.ok(patchBytes < 64 * 1024, `the review patch holds text only (${patchBytes} bytes)`);
    assert.match(patch, /Binary files .*shot-0\.png differ/);
    assert.match(patch, /-export const value = 1;\n\+export const value = 2;/);
    assert.doesNotMatch(patch, /GIT binary patch/);
    assert.equal(delivery.binaries, 10);
    assert.match(input, /listed in manifest binaries with its path, change \(added, modified or deleted\), byte size and SHA-256/);
    assert.equal(git(f.root, ['show', 'HEAD:value.mjs']).trim(), 'export const value = 2;');
    assert.equal(git(f.root, ['rev-parse', 'HEAD^']).trim(), f.base);
    assert.equal(git(f.root, ['status', '--porcelain']), '');
    const changes = Object.fromEntries(manifest.binaries.map(b => [b.path, b.change]));
    assert.deepEqual(changes, { 'docs/evidence/before.png': 'modified', 'docs/evidence/old.png': 'deleted',
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`docs/evidence/shot-${i}.png`, 'added'])) });
    for (const binary of manifest.binaries) {
      assert.deepEqual(Object.keys(binary).sort(), ['bytes', 'change', 'path', 'sha256'], 'no bytes, only the description');
      const blob = git(f.root, ['cat-file', 'blob', `${binary.change === 'deleted' ? f.base : 'HEAD'}:${binary.path}`], 'buffer');
      assert.equal(binary.sha256, sha(blob), `${binary.path} hash matches the committed blob`);
      assert.equal(binary.bytes, blob.length);
      if (binary.change !== 'deleted') assert.equal(binary.sha256, sha(readFileSync(join(f.root, binary.path))));
    }
    assert.ok(statSync(delivery.manifest).size < 64 * 1024, 'the manifest carries no binary bytes');
    const receiptPath = granularity === 'task'
      ? join(f.root, '.forja/runs', result.run_id, 'delivery', `${result.taskCommits[0].receipt}.json`)
      : join(f.root, '.forja/runs', result.run_id, 'delivery.json');
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, 'utf8')).binaries, manifest.binaries);
  });

  test(`${granularity} granularity: changing a binary after review voids the approval`, async () => {
    // Same size, other bytes, swapped into the candidate the reviewer approved.
    const f = repo(granularity);
    const swapped = await run(f, screenshots, { duringReview: (root, delivery) => {
      const path = join(root, 'swap.png');
      writeFileSync(path, png(99, MiB + 3000));
      const blob = git(root, ['hash-object', '-w', path]).trim();
      rmSync(path);
      execFileSync('git', ['update-index', '--cacheinfo', `100644,${blob},docs/evidence/shot-3.png`], { cwd: root, windowsHide: true, stdio: 'ignore',
        env: { ...process.env, GIT_INDEX_FILE: delivery.manifest.replace(/-manifest.json$/, '.index') } });
    } });
    assert.equal(swapped.reviews.length, 1);
    const { status, reason } = outcome(granularity, swapped.result);
    assert.equal(status, 'blocked');
    assert.match(reason, /Delivery inputs changed during review; approval cannot be applied/);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']).trim(), f.base, 'no commit');
    // A working-tree edit during the read-only review stops the run without a commit.
    const g = repo(granularity);
    const edited = await run(g, screenshots, { duringReview: root => writeFileSync(join(root, 'docs/evidence/shot-3.png'), png(99, MiB + 3000)) });
    assert.notEqual(edited.result.status, 'done');
    assert.equal(git(g.root, ['rev-parse', 'HEAD']).trim(), g.base, 'no commit');
  });

  test(`${granularity} granularity: a text diff over 4 MiB still blocks`, async () => {
    const f = repo(granularity);
    const line = 'export const filler = "' + 'x'.repeat(100) + '";\n';
    const { result } = await run(f, root => { screenshots(root); writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n' + line.repeat(Math.ceil(4.5 * MiB / line.length))); });
    const { status, reason } = outcome(granularity, result);
    assert.equal(status, 'blocked');
    assert.match(reason, /Delivery diff exceeds the 4 MiB review limit\./);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']).trim(), f.base);
  });
}

test('binaries over delivery.maxBinaryBytes block before review and name the largest files', async () => {
  const f = repo('task', { maxBinaryBytes: 2 * MiB });
  const { result, reviews } = await run(f, root => {
    writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    for (const [name, size] of [['a.png', 0.3 * MiB], ['big.png', 1.5 * MiB], ['mid.png', 0.75 * MiB], ['small.png', 0.5 * MiB]])
      writeFileSync(join(root, 'docs/evidence', name), png(size, Math.round(size)));
  });
  assert.equal(result.status, 'blocked');
  assert.equal(reviews.length, 0, 'no review is spent');
  assert.match(result.failure, /Task delivery blocked before review: Delivery binary files total 3\.1 MiB, over the 2\.0 MiB limit \(delivery\.maxBinaryBytes\); largest: docs\/evidence\/big\.png \(1\.5 MiB\), docs\/evidence\/mid\.png \(0\.8 MiB\), docs\/evidence\/small\.png \(0\.5 MiB\)\./);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']).trim(), f.base);
  const deletions = repo('run', { maxBinaryBytes: 1024 });
  const { result: deleted } = await run(deletions, root => { writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n'); rmSync(join(root, 'docs/evidence/before.png')); });
  assert.equal(deleted.delivery.status, 'committed', 'deleted binaries do not count toward the cap');
});

test('the privacy scan still blocks a binary under a refused path', async () => {
  for (const path of ['data/capture.png', 'docs/server.key']) {
    const f = repo('task');
    const { result, reviews } = await run(f, root => {
      writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), png(7, 2048));
    });
    assert.equal(result.status, 'blocked');
    assert.equal(reviews.length, 0);
    assert.match(result.failure, new RegExp(`Delivery privacy scan found material requiring inspection: ${path.replace('.', '\\.')} private execution`));
  }
});
