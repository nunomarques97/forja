import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { current, lockProject, validateState, write } from './engine.mjs';
import { inside, treeHash, snapshot, changedFiles } from './context.mjs';
import { assertProtectedFiles } from './protected-files.mjs';
import { validateDelivery, assertDeliveryPolicy, publicationPermission, taskGranularity } from './delivery-policy.mjs';
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

// ---- Task granularity: one reviewed local commit per task that changes source.
// The run base stays immutable; only commits recorded in run.taskCommits may
// advance the expected HEAD. Each task's existing reviewer approves its exact
// snapshot and message; no extra model session is added for Git.
export const deliveryHead = run => run.taskCommits?.at(-1)?.commit || run.base;

function taskPaths(root, run) {
  const dir = inside(root, join('.forja/runs', run.run_id, 'delivery'));
  mkdirSync(dir, { recursive: true });
  const key = run.taskDelivery.key;
  return { dir, receiptPath: join(dir, `${key}.json`), candidateIndex: join(dir, `${key}.index`), manifestPath: join(dir, `${key}-manifest.json`),
    patchPath: join(dir, `${key}.patch`), scanPath: join(dir, `${key}-scan.json`), messagePath: join(dir, `${key}-message.txt`),
    indexPath: resolve(root, text(root, ['rev-parse', '--git-path', 'index'])) };
}
function rememberTask(run, receipt, path) {
  receipt.updated_at = new Date().toISOString();
  write(path, receipt);
  run.taskDelivery = { task: receipt.task, key: receipt.key, status: receipt.status, reason: receipt.reason || null, receipt_sha256: sha(readFileSync(path)) };
}
function checkedTaskReceipt(run, path) {
  const bytes = readFileSync(path);
  if (sha(bytes) !== run.taskDelivery?.receipt_sha256) throw new Error('Task delivery receipt changed outside the controller; approval is not transferable.');
  return JSON.parse(bytes);
}
const changedBetween = (root, from, to) => git(root, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', from, to]).toString('utf8').split('\0').filter(Boolean);

// Before the task's existing review: stage the task's delta against the last
// accepted commit in a separate index and describe it for that reviewer.
export function prepareTaskDelivery(root, run, task) {
  if (!taskGranularity(run)) return null;
  if (run.taskDelivery?.status === 'prepared') throw new Error('A task commit is being installed; resume to reconcile it before another review.');
  const parent = deliveryHead(run);
  run.taskDelivery = { task: task.id, key: `${task.id}-${run.invocations + 1}`, status: 'pending_review' };
  const { receiptPath, candidateIndex, manifestPath, patchPath, scanPath, indexPath } = taskPaths(root, run);
  let receipt = { version: 1, run: run.run_id, task: task.id, key: run.taskDelivery.key, parent, status: 'pending_review' };
  try {
    assertProtectedFiles(root, run); assertDeliveryPolicy(root, run);
    if (text(root, ['replace', '-l']) || existsSync(resolve(root, text(root, ['rev-parse', '--git-path', 'info/grafts']))))
      throw new Error('Automatic delivery refuses replaced or grafted Git history.');
    if (head(root) !== parent) throw new Error('HEAD moved outside the controller since the last accepted task commit; manual commits are never adopted.');
    const branch = text(root, ['symbolic-ref', '-q', 'HEAD']);
    if (!branch?.startsWith('refs/heads/')) throw new Error('Automatic delivery requires a local branch.');
    if (run.taskCommits?.length && branch !== run.taskCommits.at(-1).branch) throw new Error('The checked-out branch changed since the last task commit.');
    if (text(root, ['diff', '--cached', '--name-only'])) throw new Error('Delivery refuses an occupied index; preserve existing staged work.');
    const originalIndex = indexHash(indexPath), source = treeHash(root), configHash = gitConfigHash(root);
    const runFiles = changedFiles(run.initial, snapshot(root));
    if (runFiles.length > 500 || runFiles.some(path => /[\x00-\x1f\\:]/.test(path) || path.split('/').some(part => !part || /[. ]$/.test(part))))
      throw new Error('Delivery requires at most 500 portable file paths.');
    git(root, ['read-tree', parent], { index: candidateIndex });
    // Every run change is staged on top of the last accepted commit, so the
    // commit delta is exactly this task's work, including later edits to
    // shared files. A clean start guarantees no unrelated edit is included.
    if (runFiles.length) git(root, ['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { index: candidateIndex, input: runFiles.join('\0') });
    const tree = text(root, ['write-tree'], { index: candidateIndex });
    if (tree === text(root, ['rev-parse', `${parent}^{tree}`])) {
      receipt.status = 'no_changes'; rememberTask(run, receipt, receiptPath);
      return { status: 'no_changes' };
    }
    const files = changedBetween(root, parent, tree);
    const permission = publicationPermission(run);
    const intent = run.config.delivery.mode === 'push' ? { allowed: true, destination: run.deliveryPolicy.policy.destination, effect: run.deliveryPolicy.policy.pipeline.effect } : permission;
    const scan = inspectTree(root, tree, intent.allowed ? null : files);
    write(scanPath, scan);
    if (scan.findings.length) throw new Error(`Delivery privacy scan found material requiring inspection; see ${scanPath}.`);
    publicationBase(root, run, intent);
    const patch = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', parent, tree, '--']);
    if (patch.length > 4 * 1024 * 1024) throw new Error('Delivery diff exceeds the 4 MiB review limit.');
    writeFileSync(patchPath, patch);
    const earlier = (run.taskCommits || []).map(c => ({ task: c.task, commit: c.commit, message: c.message }));
    write(manifestPath, { granularity: 'task', task: task.id, parent, tree, files, scan, publication: permission, intent, earlierCommits: earlier,
      outgoing: intent.allowed ? { commits: earlier.length + 1, base: run.base, publishedOnlyAfterRunCompletes: true } : 'local commits only' });
    if (head(root) !== parent || treeHash(root) !== source || indexHash(indexPath) !== originalIndex || gitConfigHash(root) !== configHash)
      throw new Error('Source, index or Git configuration changed while preparing delivery.');
    receipt = { ...receipt, tree, branch, files, source, originalIndex, gitConfig: configHash, publicReviewed: intent.allowed,
      earlierCommits: earlier.map(c => c.commit), manifestHash: sha(readFileSync(manifestPath)), patchHash: sha(patch) };
    rememberTask(run, receipt, receiptPath);
    return { status: 'ready', granularity: 'task', tree, files: files.length, earlier_commits: earlier.length, manifest: manifestPath, patch: patchPath,
      publication: permission, effect: intent.effect || null };
  } catch (error) {
    receipt.status = 'blocked'; receipt.reason = error.message;
    rememberTask(run, receipt, receiptPath);
    return { status: 'blocked', reason: error.message };
  }
}

export function recordTaskDeliveryReview(root, run, task, review) {
  if (!taskGranularity(run) || run.taskDelivery?.task !== task.id) return;
  const { receiptPath, candidateIndex, manifestPath, patchPath, indexPath } = taskPaths(root, run);
  const receipt = checkedTaskReceipt(run, receiptPath);
  if (receipt.status !== 'pending_review') return;
  try {
    const decision = review.delivery;
    if (review.status !== 'approve' || !decision || decision.status !== 'approve' || decision.tree !== receipt.tree ||
        typeof decision.message !== 'string' || !decision.message.trim() || decision.message.length > 4000 ||
        typeof decision.reason !== 'string' || decision.reason.length > 4000 || contentFindings(Buffer.from(decision.message)).length)
      throw new Error(`The reviewer of ${task.id} did not approve delivery of this exact snapshot or returned an invalid commit message.`);
    if (head(root) !== receipt.parent || treeHash(root) !== receipt.source || indexHash(indexPath) !== receipt.originalIndex ||
        gitConfigHash(root) !== receipt.gitConfig || text(root, ['symbolic-ref', '-q', 'HEAD']) !== receipt.branch ||
        text(root, ['write-tree'], { index: candidateIndex }) !== receipt.tree ||
        sha(readFileSync(manifestPath)) !== receipt.manifestHash || sha(readFileSync(patchPath)) !== receipt.patchHash)
      throw new Error('Delivery inputs changed during review; approval cannot be applied.');
    assertDeliveryPolicy(root, run);
    receipt.review = decision; receipt.invocation = run.invocations; receipt.status = 'approved';
  } catch (error) { receipt.status = 'blocked'; receipt.reason = error.message; }
  rememberTask(run, receipt, receiptPath);
}

// Creates and installs the approved task commit. Safe to call again after an
// interruption: the recorded commit object is reused, never duplicated.
export function commitTaskDelivery(root, run, task, save) {
  const paths = taskPaths(root, run);
  const receipt = checkedTaskReceipt(run, paths.receiptPath);
  if (receipt.task !== task.id) throw new Error('The pending task delivery belongs to another task.');
  if (!['approved', 'prepared'].includes(receipt.status)) throw new Error(receipt.reason || 'Task delivery was not approved.');
  const unchanged = () => treeHash(root) === receipt.source && indexHash(paths.indexPath) === receipt.originalIndex &&
    gitConfigHash(root) === receipt.gitConfig && text(root, ['symbolic-ref', '-q', 'HEAD']) === receipt.branch;
  if (receipt.status === 'approved') {
    if (head(root) !== receipt.parent || !unchanged() || text(root, ['write-tree'], { index: paths.candidateIndex }) !== receipt.tree)
      throw new Error('Source, index, candidate or Git configuration changed after review.');
    if (inspectTree(root, receipt.tree, receipt.publicReviewed ? null : receipt.files).findings.length)
      throw new Error('Approved snapshot failed the final privacy scan.');
    writeFileSync(paths.messagePath, receipt.review.message.trim() + '\n');
    receipt.commit = text(root, ['commit-tree', receipt.tree, '-p', receipt.parent, '-F', paths.messagePath]);
    if (!oid(receipt.commit)) throw new Error('Invalid generated delivery commit.');
    receipt.status = 'prepared'; rememberTask(run, receipt, paths.receiptPath); save();
  }
  const at = head(root);
  if (at === receipt.parent) {
    const indexLock = paths.indexPath + '.lock';
    let fd, owned = false, moved = false;
    try {
      fd = openSync(indexLock, 'wx'); owned = true;
      if (!unchanged()) throw new Error('Concurrent change interrupted task commit installation.');
      writeFileSync(fd, readFileSync(paths.candidateIndex)); closeSync(fd); fd = undefined;
      git(root, ['update-ref', '-m', `FORJA reviewer-approved task ${task.id}`, receipt.branch, receipt.commit, receipt.parent]);
      moved = true; renameSync(indexLock, paths.indexPath);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (!moved && owned && existsSync(indexLock)) unlinkSync(indexLock);
    }
  } else if (at !== receipt.commit || text(root, ['write-tree']) !== receipt.tree)
    throw new Error(`Task commit ${receipt.commit} was created but HEAD or the index no longer match it; inspect before recovery (no second commit is created).`);
  receipt.status = 'committed'; receipt.reason = null;
  rememberTask(run, receipt, paths.receiptPath);
  (run.taskCommits ||= []).push({ task: task.id, commit: receipt.commit, parent: receipt.parent, tree: receipt.tree, branch: receipt.branch,
    message: receipt.review.message.trim(), publicReviewed: receipt.publicReviewed, receipt: receipt.key, receipt_sha256: run.taskDelivery.receipt_sha256 });
  delete run.taskDelivery;
  save();
  return receipt.commit;
}

// After the run: the approved chain stays local (commit) or is published once
// (push), only after every task and final check passed.
async function deliverTaskChain(root, run, { log, retry, save, receipt }) {
  const mode = run.config.delivery.mode;
  if (['pushed', 'no_changes'].includes(receipt.status) || (receipt.status === 'committed' && mode === 'commit')) return receipt;
  if (receipt.status === 'blocked' && !retry) throw new Error(receipt.reason || 'Delivery requires explicit inspection; use core deliver --retry only after resolving the cause.');
  if (run.taskDelivery && run.taskDelivery.status !== 'no_changes') throw new Error('A task delivery is unresolved; inspect it before final delivery.');
  assertProtectedFiles(root, run); assertDeliveryPolicy(root, run);
  const commits = run.taskCommits || [];
  if (!commits.length) { receipt.status = 'no_changes'; save(); return receipt; }
  const tip = commits.at(-1);
  if (head(root) !== tip.commit) throw new Error('HEAD no longer matches the last reviewed task commit; manual commits are never adopted.');
  if (text(root, ['status', '--porcelain'])) throw new Error('Uncommitted changes remain after the last task commit; inspect before delivery.');
  const chain = text(root, ['rev-list', '--reverse', '--parents', `${run.base}..${tip.commit}`]).split('\n').filter(Boolean).map(line => line.split(' '));
  if (commits[0].parent !== run.base || chain.length !== commits.length ||
      chain.some(([id, ...parents], i) => id !== commits[i].commit || parents.length !== 1 || parents[0] !== commits[i].parent))
    throw new Error('Local history does not match the reviewed task commit chain.');
  const lastPath = inside(root, join('.forja/runs', run.run_id, 'delivery', `${tip.receipt}.json`));
  const lastBytes = readFileSync(lastPath);
  if (sha(lastBytes) !== tip.receipt_sha256) throw new Error('Task delivery receipt changed outside the controller.');
  const last = JSON.parse(lastBytes);
  Object.assign(receipt, { granularity: 'task', commit: tip.commit, commits: commits.map(c => c.commit), review: last.review,
    publicReviewed: commits.every(c => c.publicReviewed), status: 'committed', reason: null });
  save();
  if (mode !== 'push') { log(`FORJA delivery: ${commits.length} reviewer-approved task commit(s) kept locally; no extra model session.`); return receipt; }
  const permission = publicationPermission(run);
  if (!permission.allowed) { receipt.status = 'push_blocked'; receipt.reason = permission.reason; save(); return receipt; }
  // The last task's reviewer saw the whole outgoing chain in its manifest.
  if (!receipt.publicReviewed || JSON.stringify(last.earlierCommits) !== JSON.stringify(commits.slice(0, -1).map(c => c.commit)))
    throw new Error('The outgoing commit chain was not covered by the last task review; push refused.');
  const { url, branch, baseBranch } = permission.destination;
  const target = remoteHead(root, url, branch);
  if (target === tip.commit) { receipt.status = 'pushed'; save(); return receipt; }
  if (remoteHead(root, url, baseBranch) !== run.base || (target !== null && target !== run.base)) throw new Error('Remote advanced; publication stopped without force or rebase.');
  // History keeps what later commits removed: scan every outgoing commit.
  for (const c of commits) {
    const message = git(root, ['log', '-1', '--format=%B', c.commit]);
    if (inspectTree(root, c.tree, changedBetween(root, c.parent, c.commit)).findings.length || contentFindings(message).length)
      throw new Error(`Outgoing commit ${c.commit} (task ${c.task}) failed the privacy scan; push refused.`);
  }
  if (inspectTree(root, tip.tree).findings.length) throw new Error('Public snapshot failed the final privacy scan.');
  receipt.status = 'pushing'; save();
  git(root, ['-c', 'core.hooksPath=' + join(inside(root, join('.forja/runs', run.run_id)), 'empty-hooks'), 'push', '--porcelain', '--no-follow-tags', url, tip.commit + ':refs/heads/' + branch]);
  if (remoteHead(root, url, branch) !== tip.commit) throw new Error('Cannot confirm the published ref; inspect before retrying.');
  receipt.status = 'pushed'; receipt.reason = null; save();
  log(`FORJA delivery: pushed ${commits.length} approved task commit(s) (${permission.effect} pipeline).`);
  return receipt;
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
    if (taskGranularity(run)) {
      receipt = run.delivery?.receipt_sha256 ? checkedReceipt(run, receiptPath) : { version: 1, run: run.run_id, granularity: 'task', status: 'pending' };
      return await deliverTaskChain(root, run, { log, retry, save, receipt });
    }
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
