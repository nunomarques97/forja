import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRun, drive, current } from '../lib/core/engine.mjs';
import { deliver, authorizeProduction } from '../lib/core/delivery.mjs';
import { validateDelivery, validatePublicationPolicy } from '../lib/core/delivery-policy.mjs';

const roots = [];
after(() => { for (const root of roots) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } });
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function directory() { const root = mkdtempSync(join(tmpdir(), 'forja-delivery-test-')); roots.push(root); return root; }
function repo({ effect, production = false, mode = effect ? 'push' : 'commit' } = {}) {
  const root = directory();
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.forja/\nlocal-delivery.json\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  let remote, policy;
  const config = { delivery: { mode, ...(production ? { production: true } : {}) } };
  if (effect) {
    remote = directory(); git(remote, ['init', '--bare', '-q']);
    policy = { version: 1, destination: { url: pathToFileURL(remote).href, branch: 'work/approved', baseBranch: 'main' },
      pipeline: { effect, description: 'Offline fixture; no deployment service exists.' }, pipelineFiles: [] };
    writeFileSync(join(root, 'local-delivery.json'), JSON.stringify(policy));
    config.delivery.policyFile = 'local-delivery.json';
  }
  git(root, ['add', '--', '.gitignore', 'value.mjs']); git(root, ['commit', '-qm', 'fixture']);
  if (remote) git(root, ['push', policy.destination.url, 'HEAD:refs/heads/main']);
  const base = git(root, ['rev-parse', 'HEAD']);
  return { root, remote, policy, base, config };
}
const plan = { decisions: [], tasks: [{ id: 'T1', title: 'Return two', criteria: ['value equals two'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [], checks: [{ command: 'node', args: ['--input-type=module', '-e', "import { value } from './value.mjs'; if (value !== 2) process.exit(1)"] }] }] };
async function run(fixture, { deliveryReview, develop, config = {} } = {}) {
  createRun(fixture.root, { goal: 'Return two', provider: 'custom', plan, config: { ...fixture.config, ...config } });
  let deliveries = 0;
  const result = await drive(fixture.root, { log: () => {}, providerCall: async (_, options) => {
    const packet = JSON.parse(options.text);
    let delivery;
    if (packet.changes?.delivery?.status === 'ready') {
      deliveries++;
      assert.equal(options.readOnly, true);
      assert.match(options.input, /final reviewer/);
      delivery = { status: 'approve', tree: packet.changes.delivery.tree, message: 'Return the expected value', reason: 'Reviewed fixture', ...(deliveryReview ? await deliveryReview(options) : {}) };
    }
    if (!options.readOnly) {
      writeFileSync(join(fixture.root, 'value.mjs'), 'export const value = 2;\n');
      if (develop) await develop();
    }
    return { code: 0, result: { status: options.readOnly ? 'approve' : 'ready_for_validation', summary: 'Synthetic fixture', findings: [], ...(delivery ? { delivery } : {}) }, duration_ms: 1 };
  } });
  return { result, deliveries };
}

test('delivery config separates commit, destination, pipeline effect and production authority', () => {
  assert.equal(validateDelivery({}), null);
  for (const delivery of [null, {}, { mode: 'auto' }, { mode: 'push' }, { mode: 'commit', production: true }, { mode: 'commit', policyFile: '../outside' }]) assert.throws(() => validateDelivery({ delivery }));
  const valid = { version: 1, destination: { url: 'https://example.invalid/project.git', branch: 'work/change', baseBranch: 'main' }, pipeline: { effect: 'unknown', description: 'Hosting settings not verified' }, pipelineFiles: [] };
  assert.equal(validatePublicationPolicy(valid), valid);
  for (const patch of [{ pipeline: { effect: 'safe', description: 'claim' } }, { destination: { ...valid.destination, url: 'https://user:password@example.invalid/repo' } }, { destination: { ...valid.destination, branch: '--all' } }, { pipelineFiles: ['../outside'] }])
    assert.throws(() => validatePublicationPolicy({ ...valid, ...patch }));
});

test('final reviewer approves delivery in its existing session; exact commit is idempotent', async () => {
  const f = repo(); const { result, deliveries } = await run(f);
  assert.equal(result.status, 'done'); assert.equal(result.delivery.status, 'committed', result.delivery.reason);
  assert.equal(deliveries, 1); assert.equal(result.invocations, 2);
  assert.notEqual(git(f.root, ['rev-parse', 'HEAD']), f.base);
  assert.equal(git(f.root, ['rev-parse', 'HEAD^']), f.base);
  assert.equal(git(f.root, ['status', '--porcelain']), '');
  assert.equal(git(f.root, ['show', 'HEAD:value.mjs']), 'export const value = 2;');
  assert.equal((await deliver(f.root, { providerCall: () => { throw new Error('unexpected repeat'); }, log: () => {} })).status, 'committed');
});

test('rejecting the delivery preserves source and the original index without a commit', async () => {
  const f = repo(), index = readFileSync(join(f.root, '.git/index'));
  const { result } = await run(f, { deliveryReview: () => ({ status: 'reject', summary: 'Missing release evidence', findings: ['Review required'], message: 'Unused' }) });
  assert.equal(result.delivery.status, 'blocked'); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
  assert.deepEqual(readFileSync(join(f.root, '.git/index')), index);
  assert.equal(readFileSync(join(f.root, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
  assert.equal(git(f.root, ['diff', '--cached', '--name-only']), '');
});

test('delivery refuses existing user edits even with allowDirty', () => {
  const f = repo(); writeFileSync(join(f.root, 'unrelated.txt'), 'user edit');
  assert.throws(() => createRun(f.root, { goal: 'Return two', provider: 'custom', plan, config: { ...f.config, allowDirty: true } }), /clean initial/);
  assert.equal(existsSync(current(f.root)), false);
});

test('adding automatic policy protection does not coerce an invalid protectedFiles config', () => {
  const f = repo({ effect: 'preview' });
  assert.throws(() => createRun(f.root, { goal: 'Return two', provider: 'custom', plan, config: { ...f.config, protectedFiles: 'value.mjs' } }), /protectedFiles must/);
});

test('unexpected source or index writes during delivery invalidate approval', async () => {
  for (const target of ['source', 'index']) {
    const f = repo();
    const { result } = await run(f, { deliveryReview: () => {
      if (target === 'source') writeFileSync(join(f.root, 'value.mjs'), 'export const value = 9;\n');
      else git(f.root, ['add', '--', 'value.mjs']);
      return { status: 'approve', summary: 'Invalid approval', findings: [], message: 'Must not commit' };
    } });
    assert.ok(result.delivery.status === 'blocked' || result.status === 'blocked'); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
  }
});

test('private file additions block delivery without adding delivery work to the reviewer', async () => {
  const f = repo();
  const { result, deliveries } = await run(f, { develop: () => writeFileSync(join(f.root, 'transcript.txt'), 'private fixture') });
  assert.equal(result.delivery.status, 'blocked'); assert.match(result.delivery.reason, /privacy scan/); assert.equal(deliveries, 0);
});

test('known preview pushes one approved commit to the exact authorized branch only', async () => {
  const f = repo({ effect: 'preview' }); const { result } = await run(f);
  assert.equal(result.delivery.status, 'pushed', result.delivery.reason);
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/work/approved']), result.delivery.commit);
  assert.equal(git(f.remote, ['rev-parse', 'refs/heads/main']), f.base);
  assert.equal(git(f.remote, ['tag', '--list']), '');
});

test('unknown effects and unapproved production preserve a local commit without a push', async () => {
  for (const effect of ['unknown', 'production']) {
    const f = repo({ effect }); const { result } = await run(f);
    assert.equal(result.delivery.status, 'push_blocked', result.delivery.reason);
    assert.notEqual(git(f.root, ['rev-parse', 'HEAD']), f.base);
    assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/']), 'refs/heads/main');
  }
});

test('explicit production grant permits only the configured ref in an offline fixture', async () => {
  const f = repo({ effect: 'production', production: true }); const { result } = await run(f);
  assert.equal(result.delivery.status, 'pushed', result.delivery.reason);
});

test('production can be approved after reviewing the exact local commit, without repeating a model session', async () => {
  const f = repo({ effect: 'production' }); const { result } = await run(f);
  assert.equal(result.delivery.status, 'push_blocked');
  assert.throws(() => authorizeProduction(f.root, f.base), /exact reviewed/);
  authorizeProduction(f.root, result.delivery.commit);
  const receipt = await deliver(f.root, { retry: true, log: () => {}, providerCall: () => { throw new Error('unnecessary model repeat'); } });
  assert.equal(receipt.status, 'pushed', receipt.reason);
  assert.equal(receipt.productionAuthorization.commit, result.delivery.commit);
});

test('pipeline additions during the run block publication before committing', async () => {
  const f = repo({ effect: 'preview' });
  const { result, deliveries } = await run(f, { develop: () => writeFileSync(join(f.root, 'vercel.json'), '{}') });
  assert.equal(result.delivery.status, 'blocked'); assert.match(result.delivery.reason, /pipeline changed/); assert.equal(deliveries, 0);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
});

test('a private local ancestor cannot be transferred to the public destination', async () => {
  const f = repo({ effect: 'preview' });
  writeFileSync(join(f.root, 'note.txt'), 'local only'); git(f.root, ['add', '--', 'note.txt']); git(f.root, ['commit', '-qm', 'local ancestor']);
  const before = git(f.root, ['rev-parse', 'HEAD']);
  const { result, deliveries } = await run(f);
  assert.equal(result.delivery.status, 'blocked'); assert.match(result.delivery.reason, /outgoing ancestry/); assert.equal(deliveries, 0);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), before);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/']), 'refs/heads/main');
});

test('two model sessions suffice for development, review and automatic delivery', async () => {
  const f = repo(); const { result, deliveries } = await run(f, { config: { maxSessions: 2 } });
  assert.equal(result.delivery.status, 'committed', result.delivery.reason); assert.equal(deliveries, 1);
  assert.equal(result.invocations, 2); assert.notEqual(git(f.root, ['rev-parse', 'HEAD']), f.base);
});

test('review approval for another tree cannot authorize a commit', async () => {
  const f = repo(); const { result } = await run(f, { deliveryReview: () => ({ tree: '0'.repeat(40) }) });
  assert.equal(result.delivery.status, 'blocked'); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
});

test('changing the delivery receipt during review is detected independently of model approval', async () => {
  const f = repo(); const { result } = await run(f, { deliveryReview: options => {
    const packet = JSON.parse(options.text), path = join(dirname(packet.changes.delivery.manifest), 'delivery.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8')); receipt.originalIndex = '0'.repeat(64); writeFileSync(path, JSON.stringify(receipt));
    return {};
  } });
  assert.equal(result.status, 'blocked'); assert.match(result.failure, /receipt changed/);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
});

test('changing Git configuration during review prevents publication', async () => {
  const f = repo({ effect: 'preview' }); const { result } = await run(f, { deliveryReview: () => {
    git(f.root, ['config', 'core.abbrev', '9']); return {};
  } });
  assert.equal(result.delivery.status, 'blocked'); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
  assert.equal(git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/']), 'refs/heads/main');
});

test('editing the deployment contract in development cannot grant production permission', async () => {
  const f = repo({ effect: 'production' }); const { result } = await run(f, { develop: () => {
    const changed = { ...f.policy, pipeline: { effect: 'none', description: 'Unauthorised change' } };
    writeFileSync(join(f.root, 'local-delivery.json'), JSON.stringify(changed));
  } });
  assert.equal(result.status, 'blocked'); assert.match(result.failure, /Protected file changed/);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
});

test('delivery stages more paths than one Windows command line holds', async () => {
  const f = repo();
  const corpus = 'fixtures/generated-corpus-with-a-descriptive-directory-name';
  const { result } = await run(f, { develop: () => {
    mkdirSync(join(f.root, corpus), { recursive: true });
    for (let i = 0; i < 300; i++) writeFileSync(join(f.root, corpus, `generated-sample-file-with-a-long-descriptive-name-${String(i).padStart(4, '0')}.json`), '{}\n');
  } });
  assert.equal(result.status, 'done', result.failure);
  assert.equal(result.delivery.status, 'committed', result.delivery.reason);
  const committed = git(f.root, ['ls-tree', '-r', '--name-only', 'HEAD', '--', corpus]).split('\n');
  assert.equal(committed.length, 300);
  assert.ok(committed.join(' ').length > 32767, 'the paths exceed one Windows command line');
  assert.equal(git(f.root, ['status', '--porcelain']), '');
});
