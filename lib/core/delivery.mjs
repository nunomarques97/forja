import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { current, lockProject, validateState, write } from './engine.mjs';
import { inside, treeHash, snapshot, changedFiles } from './context.mjs';
import { assertProtectedFiles } from './protected-files.mjs';
import { validateDelivery, assertDeliveryPolicy, publicationPermission } from './delivery-policy.mjs';
import { contentFindings, privatePath, reviewedFixture } from '../../tools/release-check.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const oid = value => /^[a-f0-9]{40,64}$/.test(value);
// Never inherit an alternate index, worktree or injected Git command config.
function git(root, args, { index, input, allowFailure = false } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  if (index) env.GIT_INDEX_FILE = index;
  env.GIT_TERMINAL_PROMPT = '0';
  try { return execFileSync('git', ['--no-pager', ...args], { cwd: root, env, input, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 32 * 1024 * 1024 }); }
  catch (error) { if (allowFailure && Number.isInteger(error.status)) return null; throw new Error(`Delivery Git ${args[0]} failed; no automatic retry or force push.`); }
}
const text = (root, args, options) => git(root, args, options)?.toString('utf8').trim() ?? null;
const head = root => text(root, ['rev-parse', '--verify', 'HEAD']);
const indexHash = path => existsSync(path) ? sha(readFileSync(path)) : null;
const gitConfigHash = root => sha(git(root, ['config', '--null', '--list', '--show-origin']));

function inspectTree(root, tree, names = null) {
  const entries = git(root, ['ls-tree', '-r', '-z', tree]).toString('utf8').split('\0').filter(Boolean);
  const findings = [], files = [];
  for (const entry of entries) {
    const tab = entry.indexOf('\t'), meta = entry.slice(0, tab), path = entry.slice(tab + 1);
    if (names && !names.includes(path)) continue;
    const [mode, type, id] = meta.split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('Delivery refuses symlinks, submodules and non-regular files in the reviewed snapshot.');
    const bytes = git(root, ['cat-file', 'blob', id]);
    const reasons = [...(privatePath(path) ? ['private execution/research/credential path'] : []), ...contentFindings(bytes)];
    for (const reason of reasons) if (!reviewedFixture(path, bytes, reason)) findings.push({ path, reason });
    files.push({ path, blob: id, bytes: bytes.length, binary: bytes.includes(0) });
  }
  return { files, findings };
}

function remoteHead(root, url, branch) {
  const output = text(root, ['ls-remote', '--refs', url, `refs/heads/${branch}`]);
  if (!output) return null;
  const rows = output.split('\n');
  const [id, ref] = rows[0].split(/\s+/);
  if (rows.length !== 1 || !oid(id) || ref !== `refs/heads/${branch}`) throw new Error('Ambiguous delivery destination.');
  return id;
}

function publicationBase(root, run, permission) {
  if (!permission.allowed) return null;
  // Explicit URLs are meaningless if local configuration silently rewrites them.
  if (git(root, ['config', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], { allowFailure: true }))
    throw new Error('Automatic publication refuses Git URL rewrite rules.');
  const { url, branch, baseBranch } = permission.destination;
  const base = remoteHead(root, url, baseBranch), target = remoteHead(root, url, branch);
  if (base !== run.base || (target !== null && target !== run.base))
    throw new Error('Publication requires the exact run base on the authorized remote and no outgoing ancestry. Use a clean checkout from that remote; private ancestry is never transferred.');
  return { base, target };
}


export const DELIVERY_REVIEW_SCHEMA = { type: 'object', additionalProperties: false,
  required: ['status', 'tree', 'message', 'reason'], properties: {
    status: { type: 'string', enum: ['approve', 'reject'] }, tree: { type: 'string' },
    message: { type: 'string' }, reason: { type: 'string' },
  } };

function locations(root, run) {
  const dir = inside(root, join('.forja/runs', run.run_id));
  return { dir, receiptPath: join(dir, 'delivery.json'), candidateIndex: join(dir, 'delivery.index'),
    indexPath: resolve(root, text(root, ['rev-parse', '--git-path', 'index'])) };
}
function remember(run, receipt, receiptPath) {
  receipt.updated_at = new Date().toISOString();
  write(receiptPath, receipt);
  run.delivery = { status: receipt.status, commit: receipt.commit || null, reason: receipt.reason || null, receipt_sha256: sha(readFileSync(receiptPath)) };
}
function checkedReceipt(run, path) {
  const bytes = readFileSync(path);
  if (sha(bytes) !== run.delivery?.receipt_sha256) throw new Error('Delivery receipt changed outside the controller; approval is not transferable.');
  return JSON.parse(bytes);
}

// Deterministic preparation, under the scheduler lock, before the FINAL existing
// reviewer. A compact reference extends that review; no extra model is invoked.
export function prepareDelivery(root, run, task) {
  if (!run.config.delivery || run.tasks.some(t => t.id !== task.id && t.status !== 'done')) return null;
  const { dir, receiptPath, candidateIndex, indexPath } = locations(root, run);
  mkdirSync(dir, { recursive: true });
  let receipt = { version: 1, run: run.run_id, reviewerTask: task.id, status: 'pending_review' };
  try {
    assertProtectedFiles(root, run); assertDeliveryPolicy(root, run);
    if (text(root, ['replace', '-l']) || existsSync(resolve(root, text(root, ['rev-parse', '--git-path', 'info/grafts']))))
      throw new Error('Automatic delivery refuses replaced or grafted Git history.');
    if (head(root) !== run.base) throw new Error('HEAD changed since the run began.');
    const branch = text(root, ['symbolic-ref', '-q', 'HEAD']);
    if (!branch?.startsWith('refs/heads/')) throw new Error('Automatic delivery requires a local branch.');
    if (text(root, ['diff', '--cached', '--name-only'])) throw new Error('Delivery refuses an occupied index; preserve existing staged work.');
    const originalIndex = indexHash(indexPath), source = treeHash(root), configHash = gitConfigHash(root);
    const files = changedFiles(run.initial, snapshot(root));
    if (!files.length) { receipt.status = 'no_changes'; remember(run, receipt, receiptPath); return { status: 'no_changes' }; }
    if (files.length > 500 || files.some(path => /[\x00-\x1f\\:]/.test(path) || path.split('/').some(part => !part || /[. ]$/.test(part))))
      throw new Error('Delivery requires at most 500 portable file paths.');
    git(root, ['read-tree', run.base], { index: candidateIndex });
    // Paths go through stdin: 500 of them can exceed the Windows command line.
    git(root, ['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { index: candidateIndex, input: files.join('\0') });
    const tree = text(root, ['write-tree'], { index: candidateIndex });
    const permission = publicationPermission(run);
    const intent = run.config.delivery.mode === 'push' ? { allowed: true, destination: run.deliveryPolicy.policy.destination, effect: run.deliveryPolicy.policy.pipeline.effect } : permission;
    const scan = inspectTree(root, tree, intent.allowed ? null : files);
    write(join(dir, 'delivery-scan.json'), scan);
    if (scan.findings.length) throw new Error('Delivery privacy scan found material requiring inspection; see delivery-scan.json.');
    const publishedBase = publicationBase(root, run, intent);
    const patch = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', run.base, tree, '--']);
    if (patch.length > 4 * 1024 * 1024) throw new Error('Delivery diff exceeds the 4 MiB review limit.');
    const patchPath = join(dir, 'delivery.patch'), manifestPath = join(dir, 'delivery-manifest.json');
    writeFileSync(patchPath, patch);
    write(manifestPath, { parent: run.base, tree, files, scan, publication: permission, intent,
      outgoing: publishedBase ? { commits: 1, parentAlreadyAtDestination: true } : 'local commit only',
      previousReviews: run.tasks.filter(t => t.id !== task.id).map(t => ({ id: t.id, review: t.review, validation: t.validation })) });
    if (head(root) !== run.base || treeHash(root) !== source || indexHash(indexPath) !== originalIndex || gitConfigHash(root) !== configHash)
      throw new Error('Source, index or Git configuration changed while preparing delivery.');
    receipt = { ...receipt, tree, parent: run.base, branch, files, source, originalIndex, gitConfig: configHash,
      publicReviewed: intent.allowed, manifestHash: sha(readFileSync(manifestPath)), patchHash: sha(patch) };
    remember(run, receipt, receiptPath);
    return { status: 'ready', tree, files: files.length, manifest: manifestPath, patch: patchPath,
      publication: permission, effect: intent.effect || null };
  } catch (error) {
    receipt.status = 'blocked'; receipt.reason = error.message;
    remember(run, receipt, receiptPath);
    return { status: 'blocked', reason: error.message };
  }
}

export function recordDeliveryReview(root, run, task, review) {
  if (!run.config.delivery || run.tasks.some(t => t.id !== task.id && t.status !== 'done')) return;
  const { dir, receiptPath, candidateIndex, indexPath } = locations(root, run);
  const receipt = checkedReceipt(run, receiptPath);
  if (receipt.status !== 'pending_review' || receipt.reviewerTask !== task.id) return;
  try {
    const decision = review.delivery;
    if (review.status !== 'approve' || !decision || decision.status !== 'approve' || decision.tree !== receipt.tree ||
        typeof decision.message !== 'string' || !decision.message.trim() || decision.message.length > 4000 ||
        typeof decision.reason !== 'string' || decision.reason.length > 4000 || contentFindings(Buffer.from(decision.message)).length)
      throw new Error('Final reviewer did not approve delivery of this exact snapshot or returned an invalid commit message.');
    if (head(root) !== run.base || treeHash(root) !== receipt.source || indexHash(indexPath) !== receipt.originalIndex ||
        gitConfigHash(root) !== receipt.gitConfig || text(root, ['symbolic-ref', '-q', 'HEAD']) !== receipt.branch ||
        text(root, ['write-tree'], { index: candidateIndex }) !== receipt.tree ||
        sha(readFileSync(join(dir, 'delivery-manifest.json'))) !== receipt.manifestHash || sha(readFileSync(join(dir, 'delivery.patch'))) !== receipt.patchHash)
      throw new Error('Delivery inputs changed during review; approval cannot be applied.');
    assertDeliveryPolicy(root, run);
    receipt.review = decision; receipt.invocation = run.invocations; receipt.status = 'approved';
  } catch (error) { receipt.status = 'blocked'; receipt.reason = error.message; }
  remember(run, receipt, receiptPath);
}

export async function deliver(root, { log = console.log, retry = false } = {}) {
  const lock = lockProject(root);
  let run, receipt, dir, receiptPath;
  const save = () => {
    remember(run, receipt, receiptPath);
    write(current(root), run); write(join(dir, 'state.json'), run);
  };
  try {
    run = validateState(json(current(root)), root);
    if (!validateDelivery(run.config)) return null;
    if (run.status !== 'done' || run.tasks.some(t => t.status !== 'done' || t.review?.status !== 'approve' || !t.validation?.length || t.validation.some(v => !v.passed)))
      throw new Error('Delivery requires a completed run with passing checks and independent task approvals.');
    let candidateIndex, indexPath;
    ({ dir, receiptPath, candidateIndex, indexPath } = locations(root, run));
    receipt = checkedReceipt(run, receiptPath);
    if (receipt.version !== 1 || receipt.run !== run.run_id) throw new Error('Invalid delivery receipt.');
    if (['pushed', 'no_changes'].includes(receipt.status) || (receipt.status === 'committed' && run.config.delivery.mode === 'commit')) return receipt;
    if (receipt.status !== 'approved' && !retry) throw new Error(receipt.reason || 'Delivery requires explicit inspection; use core deliver --retry only after resolving the cause.');
    assertProtectedFiles(root, run); assertDeliveryPolicy(root, run);
    const permission = publicationPermission(run);
    if (receipt.commit) {
      if (!oid(receipt.commit) || head(root) !== receipt.commit || text(root, ['rev-parse', receipt.commit + '^{tree}']) !== receipt.tree)
        throw new Error('Recorded delivery commit no longer matches HEAD; inspect before recovery.');
      if (text(root, ['status', '--porcelain'])) throw new Error('Delivery recovery requires a clean worktree and index.');
    } else {
      const finalTask = run.tasks.find(t => t.id === receipt.reviewerTask);
      if (receipt.review?.status !== 'approve' || !finalTask || finalTask.reviewed_tree !== receipt.source ||
          finalTask.review.delivery?.tree !== receipt.tree || JSON.stringify(finalTask.review.delivery) !== JSON.stringify(receipt.review))
        throw new Error('Final reviewer approval is missing or stale; Git commands cannot approve delivery.');
      const unchanged = () => head(root) === run.base && treeHash(root) === receipt.source &&
        indexHash(indexPath) === receipt.originalIndex && gitConfigHash(root) === receipt.gitConfig &&
        text(root, ['symbolic-ref', '-q', 'HEAD']) === receipt.branch;
      if (!unchanged() || text(root, ['write-tree'], { index: candidateIndex }) !== receipt.tree)
        throw new Error('Source, index, candidate or Git configuration changed after review.');
      if (inspectTree(root, receipt.tree, receipt.publicReviewed ? null : receipt.files).findings.length)
        throw new Error('Approved snapshot failed the final privacy scan.');
      writeFileSync(join(dir, 'delivery-message.txt'), receipt.review.message.trim() + '\n');
      receipt.commit = text(root, ['commit-tree', receipt.tree, '-p', run.base, '-F', join(dir, 'delivery-message.txt')]);
      if (!oid(receipt.commit)) throw new Error('Invalid generated delivery commit.');
      receipt.status = 'prepared'; save();
      const indexLock = indexPath + '.lock';
      let fd, owned = false, moved = false;
      try {
        fd = openSync(indexLock, 'wx'); owned = true;
        if (!unchanged()) throw new Error('Concurrent change interrupted commit installation.');
        writeFileSync(fd, readFileSync(candidateIndex)); closeSync(fd); fd = undefined;
        git(root, ['update-ref', '-m', 'FORJA reviewer-approved delivery', receipt.branch, receipt.commit, run.base]);
        moved = true; renameSync(indexLock, indexPath);
      } finally {
        if (fd !== undefined) closeSync(fd);
        if (!moved && owned && existsSync(indexLock)) unlinkSync(indexLock);
      }
      receipt.status = 'committed'; save();
      log('FORJA delivery: reviewer-approved snapshot committed locally; no extra model session.');
    }
    if (run.config.delivery.mode !== 'push') return receipt;
    if (!permission.allowed) { receipt.status = 'push_blocked'; receipt.reason = permission.reason; save(); return receipt; }
    if (!receipt.publicReviewed || gitConfigHash(root) !== receipt.gitConfig) throw new Error('Publication review or Git configuration changed; push refused.');
    assertDeliveryPolicy(root, run);
    const { url, branch, baseBranch } = permission.destination;
    if (head(root) !== receipt.commit || text(root, ['status', '--porcelain'])) throw new Error('Source/index changed before publication.');
    const target = remoteHead(root, url, branch);
    if (target === receipt.commit) { receipt.status = 'pushed'; receipt.reason = null; save(); return receipt; }
    if (remoteHead(root, url, baseBranch) !== run.base || (target !== null && target !== run.base)) throw new Error('Remote advanced; publication stopped without force or rebase.');
    if (text(root, ['rev-list', '--count', run.base + '..' + receipt.commit]) !== '1' || text(root, ['rev-parse', receipt.commit + '^']) !== run.base)
      throw new Error('Unexpected outgoing history; publication refused.');
    if (inspectTree(root, receipt.tree).findings.length) throw new Error('Public snapshot failed the final privacy scan.');
    receipt.status = 'pushing'; save();
    git(root, ['-c', 'core.hooksPath=' + join(dir, 'empty-hooks'), 'push', '--porcelain', '--no-follow-tags', url, receipt.commit + ':refs/heads/' + branch]);
    if (remoteHead(root, url, branch) !== receipt.commit) throw new Error('Cannot confirm the published ref; inspect before retrying.');
    receipt.status = 'pushed'; receipt.reason = null; save();
    log('FORJA delivery: pushed approved commit (' + permission.effect + ' pipeline).');
    return receipt;
  } catch (error) {
    if (run && receiptPath && receipt) { receipt.status = 'blocked'; receipt.reason = error.message; save(); }
    else if (run && receiptPath) {
      run.delivery = { ...run.delivery, status: 'blocked', reason: error.message };
      write(current(root), run); write(join(dir, 'state.json'), run);
    }
    log('FORJA delivery blocked: ' + error.message);
    return receipt || { status: 'blocked', reason: error.message };
  } finally { lock.release(); }
}

// A shell user can approve a concrete production commit after reviewing it.
// This grant is confined to this run and hash; it does not change project defaults.
export function authorizeProduction(root, commit) {
  const lock = lockProject(root);
  try {
    const run = validateState(json(current(root)), root);
    const dir = inside(root, join('.forja/runs', run.run_id)), path = join(dir, 'delivery.json');
    const receipt = checkedReceipt(run, path);
    if (!oid(commit) || run.status !== 'done' || run.config.delivery?.mode !== 'push' || run.deliveryPolicy?.policy.pipeline.effect !== 'production' ||
        receipt.commit !== commit || !receipt.publicReviewed || head(root) !== commit || receipt.review?.status !== 'approve')
      throw new Error('Production approval requires the exact reviewed delivery commit and a known production contract.');
    assertDeliveryPolicy(root, run);
    run.config.delivery.production = true;
    receipt.productionAuthorization = { commit, destination: run.deliveryPolicy.policy.destination, at: new Date().toISOString() };
    remember(run, receipt, path); write(current(root), run); write(join(dir, 'state.json'), run);
  } finally { lock.release(); }
}
