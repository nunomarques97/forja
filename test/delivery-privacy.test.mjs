import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRun, drive, current } from '../lib/core/engine.mjs';
import { planningContract } from '../lib/core/plan-warnings.mjs';

// #32: scan rules stated up front, report-only base pre-scan, .env template
// allowance and findings that name file and line. Home-path-like strings are
// assembled at run time so this file itself passes the release guard.
const cli = fileURLToPath(new URL('../bin/forja.mjs', import.meta.url));
const roots = [];
after(() => { for (const root of roots) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } });
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function directory() { const root = mkdtempSync(join(tmpdir(), 'forja-delivery-privacy-')); roots.push(root); return root; }
const HOME = ['', 'Users', 'someone', 'repo'].join('/');
function repo({ base = {} } = {}) {
  const root = directory();
  git(root, ['init', '-q']); git(root, ['config', 'user.name', 'Fixture']); git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  for (const [name, text] of Object.entries(base)) writeFileSync(join(root, name), text);
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'fixture']);
  return { root, base: git(root, ['rev-parse', 'HEAD']) };
}
const config = { delivery: { mode: 'commit', granularity: 'task' } };
const plan = files => ({ decisions: [], tasks: [{ id: 'T1', title: 'Edit', criteria: ['done'], files, risks: [], complexity: 'easy', after: [], checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }] }] });
async function run(f, files, edit, { delivery = config } = {}) {
  createRun(f.root, { goal: 'Edit files', provider: 'custom', plan: plan(files), config: delivery });
  const seen = [];
  const result = await drive(f.root, { log: () => {}, providerCall: async (_, options) => {
    const packet = JSON.parse(options.text);
    seen.push({ phase: packet.phase, input: options.input });
    if (!options.readOnly) { edit(f.root); return { code: 0, result: { status: 'ready_for_validation', summary: 'Synthetic', findings: [] }, duration_ms: 1 }; }
    const ready = packet.changes?.delivery?.status === 'ready';
    const approval = ready ? { delivery: { status: 'approve', tree: packet.changes.delivery.tree, message: 'Apply T1', reason: 'Reviewed' } } : {};
    return { code: 0, result: { status: 'approve', summary: 'Reviewed', findings: [], ...approval }, duration_ms: 1 };
  } });
  return { result, seen };
}

test('planning_contract and the develop instructions state the scan rules only when delivery is configured', async () => {
  const contract = planningContract({ limits: {}, config });
  assert.match(contract.delivery_scan_rules, /\.env\.example, \.env\.sample and \.env\.template pass when every non-comment, non-blank line is KEY=/);
  assert.match(contract.delivery_scan_rules, /personal home directory paths/);
  assert.match(contract.delivery_scan_rules, /credentials\.json, \*\.pem, \*\.key/);
  assert.equal(planningContract({ limits: {}, config: {} }).delivery_scan_rules, undefined);
  const f = repo();
  const { seen } = await run(f, ['value.mjs'], root => writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n'));
  assert.match(seen.find(s => s.phase === 'develop').input, /Delivery privacy scan: before review/);
  assert.doesNotMatch(seen.find(s => s.phase === 'review').input, /Delivery privacy scan: before review/);
  const plain = repo();
  const without = await run(plain, ['value.mjs'], root => writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n'), { delivery: {} });
  assert.doesNotMatch(without.seen.find(s => s.phase === 'develop').input, /Delivery privacy scan/);
});

test('createRun pre-scans the run base only with delivery, and records findings with file and line', () => {
  const f = repo({ base: { 'CLAUDE.md': `# Notes\n\nClone into ${HOME}/x\n`, '.env.example': 'API_KEY=\n' } });
  const run = createRun(f.root, { goal: 'Edit files', provider: 'custom', plan: plan(['value.mjs']), config });
  assert.deepEqual(run.baseScan, { files: 4, skipped: 0, findings_total: 1, findings: [{ path: 'CLAUDE.md', reason: 'personal home path', line: 3 }] });
  assert.deepEqual(JSON.parse(readFileSync(current(f.root), 'utf8')).baseScan, run.baseScan);
  assert.ok(!JSON.stringify(run.baseScan).includes('someone'), 'the report never copies the matched text');
  const plain = repo({ base: { 'CLAUDE.md': `${HOME}\n` } });
  assert.equal(createRun(plain.root, { goal: 'Edit files', provider: 'custom', plan: plan(['value.mjs']), config: {} }).baseScan, undefined);
});

test('a pre-existing finding is reported, never approved: changing that file still blocks and says it pre-existed', async () => {
  const f = repo({ base: { 'CLAUDE.md': `# Notes\n\nClone into ${HOME}/x\n` } });
  const { result, seen } = await run(f, ['CLAUDE.md'], root => writeFileSync(join(root, 'CLAUDE.md'), `# Notes\n\nClone into ${HOME}/x\nMore.\n`));
  assert.equal(result.status, 'blocked');
  assert.match(result.failure, /T1: Task delivery blocked before review: Delivery privacy scan found material requiring inspection: CLAUDE\.md:3 personal home path \(already in the run base; reported at start\)\. Pre-existing findings are not approved automatically/);
  assert.deepEqual(seen.map(s => s.phase), ['develop'], 'no review session is spent');
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.base);
  const scan = JSON.parse(readFileSync(result.failure.match(/; see (\S+-scan\.json)\. /)[1], 'utf8'));
  assert.deepEqual(scan.findings, [{ path: 'CLAUDE.md', line: 3, reason: 'personal home path', pre_existing: true }]);
});

test('an untouched file with a pre-existing finding does not block a commit of other files', async () => {
  const f = repo({ base: { 'CLAUDE.md': `${HOME}\n` } });
  const { result } = await run(f, ['value.mjs'], root => writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n'));
  assert.equal(result.status, 'done', result.failure);
  assert.equal(result.delivery.status, 'committed', result.delivery.reason);
  assert.equal(result.baseScan.findings_total, 1);
});

test('a finding introduced by the run names its file and line and is not marked pre-existing', async () => {
  const f = repo({ base: { 'notes.md': 'clean\n' } });
  const { result } = await run(f, ['notes.md'], root => writeFileSync(join(root, 'notes.md'), `clean\nsee ${HOME}/y\n`));
  assert.equal(result.status, 'blocked');
  assert.match(result.failure, /requiring inspection: notes\.md:2 personal home path\. Pre-existing/);
  assert.doesNotMatch(result.failure, /already in the run base/);
});

test('.env.example with empty or placeholder values is delivered; a real-looking value blocks with its line', async () => {
  const ok = repo();
  const delivered = await run(ok, ['.env.example'], root => writeFileSync(join(root, '.env.example'), '# Public settings\nAPI_URL=\nAPI_KEY=<your-api-key>\n'));
  assert.equal(delivered.result.status, 'done', delivered.result.failure);
  assert.equal(delivered.result.delivery.status, 'committed', delivered.result.delivery.reason);
  assert.equal(git(ok.root, ['show', 'HEAD:.env.example']), '# Public settings\nAPI_URL=\nAPI_KEY=<your-api-key>');
  const bad = repo();
  const blocked = await run(bad, ['.env.example'], root => writeFileSync(join(root, '.env.example'), 'API_URL=\nAPI_KEY=abc123\n'));
  assert.equal(blocked.result.status, 'blocked');
  assert.match(blocked.result.failure, /\.env\.example:2 private execution\/research\/credential path/);
  const local = repo();
  const env = await run(local, ['.env.local'], root => writeFileSync(join(root, '.env.local'), 'API_KEY=\n'));
  assert.equal(env.result.status, 'blocked');
  assert.match(env.result.failure, /\.env\.local private execution\/research\/credential path/);
});

test('start reports base findings before any session and core status shows them', t => {
  const f = repo({ base: { 'CLAUDE.md': `# Notes\n\nClone into ${HOME}/x\n` } });
  const data = directory();
  writeFileSync(join(data, 'config.json'), JSON.stringify(config));
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const forja = args => spawnSync(process.execPath, [cli, ...args], { cwd: f.root, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const started = forja(['start', '--goal', 'Edit files', '--provider', 'custom', '--config', join(data, 'config.json')]);
  assert.match(started.stdout, /FORJA warning: The run base already has 1 privacy-scan finding\(s\): CLAUDE\.md:3 personal home path\. They are reported, not approved/, started.stderr);
  assert.ok(started.stdout.indexOf('privacy-scan finding') < Math.max(0, started.stdout.indexOf('"invocations"')) || !started.stdout.includes('"invocations"'));
  const status = forja(['core', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).base_scan.findings, [{ path: 'CLAUDE.md', reason: 'personal home path', line: 3 }]);
});
