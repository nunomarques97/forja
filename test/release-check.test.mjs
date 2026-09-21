import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { privatePath, contentFindings, inspectIndex, reviewedFixture } from '../tools/release-check.mjs';

test('release paths exclude raw execution and private research, allow curated knowledge', () => {
  for (const path of ['.forja/run.json', 'data/log.jsonl', 'docs/forja/RUN.json', 'docs/NEXT-RESUME.md', 'docs/CONTINUATION-REPORT.md', 'docs/benchmarks/raw.json', '.env.local', 'chat-history.json']) assert.equal(privatePath(path), true, path);
  for (const path of ['README.md', 'docs/RELEASE.md', 'docs/forja/KNOWLEDGE.json', 'docs/forja/CORE-CONVENTIONS.md', 'test/fixtures/example.json']) assert.equal(privatePath(path), false, path);
});
test('release scanner detects credential shapes without reporting their values', () => {
  assert.ok(contentFindings(Buffer.from('sk-' + 'x'.repeat(32))).includes('credential-like value'));
  assert.deepEqual(contentFindings(Buffer.from('const token = process.env.TOKEN;')), []);
});
test('release scanner detects home paths and raw conversation export shapes', () => {
  assert.ok(contentFindings(Buffer.from(['C:', 'Users', 'someone', 'private'].join('\\'))).includes('personal home path'));
  assert.ok(contentFindings(Buffer.from(JSON.stringify({ role: 'user', content: 'private' }))).includes('possible conversation export'));
});
test('synthetic fixture review expires when bytes change and never waives credentials', () => {
  const path = 'test/fixtures/handover-t3-before.md';
  const bytes = readFileSync(new URL('./fixtures/handover-t3-before.md', import.meta.url));
  const reason = 'private execution/research/credential path';
  assert.ok(reviewedFixture(path, bytes, reason));
  assert.equal(reviewedFixture(path, Buffer.concat([bytes, Buffer.from('changed')]), reason), null);
  assert.equal(reviewedFixture('docs/HANDOVER.md', bytes, reason), null);
  assert.equal(reviewedFixture(path, bytes, 'credential-like value'), null);
  assert.equal(privatePath('test/handover.test.mjs'), false);
  assert.equal(privatePath('test/handover.json'), true);
});
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  return { root, git };
}
test('release checks staged content, even if worktree subsequently hides the secret', t => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, 'config.txt'), 'sk-' + 'a'.repeat(32)); git('add', 'config.txt');
  writeFileSync(join(root, 'config.txt'), 'safe');
  assert.equal(inspectIndex(root).findings[0].reason, 'credential-like value');
});
test('release checks do not absorb or inspect unstaged user edits', t => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, 'README.md'), 'public'); git('add', 'README.md');
  writeFileSync(join(root, 'README.md'), 'sk-' + 'b'.repeat(32));
  assert.deepEqual(inspectIndex(root).findings, []);
});
test('release blocks staged private paths and permits removing them from index', t => {
  const { root, git } = fixture(t);
  mkdirSync(join(root, 'data')); writeFileSync(join(root, 'data', 'run.json'), '{}'); git('add', 'data/run.json');
  assert.equal(inspectIndex(root).findings.length, 1);
  git('rm', '--cached', '-f', 'data/run.json');
  assert.deepEqual(inspectIndex(root).findings, []);
});
test('publication snapshot audit exposes private files already in history/index', t => {
  const { root, git } = fixture(t);
  mkdirSync(join(root, 'data')); writeFileSync(join(root, 'data', 'run.json'), '{}'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  assert.deepEqual(inspectIndex(root).findings, []);
  assert.equal(inspectIndex(root, { tree: true }).findings.length, 1);
});
