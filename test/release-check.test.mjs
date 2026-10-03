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
// Path-like strings are assembled so this file never contains a literal the scanner flags.
const homeFound = text => contentFindings(Buffer.from(text)).includes('personal home path');
test('release scanner detects home paths at every filesystem path boundary', () => {
  const windows = ['C:', 'Users', 'someone', 'private'];
  const paths = [
    windows.join('\\'),
    windows.join('/'),
    ['c:', 'users', 'someone', 'private'].join('\\'),
    windows.join('\\\\'),
    JSON.stringify({ path: windows.join('\\') }),
    ['', 'Users', 'someone', 'notes.md'].join('/'),
    ['', 'home', 'someone', '.config'].join('/'),
  ];
  for (const path of paths) {
    for (const prefix of ['', 'see ', '\n', '"', "'", '`', 'root=', 'open(', 'path:', '{"path":"', 'file://']) {
      assert.ok(homeFound(prefix + path), prefix + path);
    }
  }
  assert.ok(homeFound('file:///' + windows.join('/')));
});
test('release scanner ignores URL and route segments that resemble home paths (#26)', () => {
  const calendar = ['', 'calendar', 'v3', 'users', 'me', 'calendarList', ''].join('/');
  const texts = [
    'if (u.pathname.startsWith("' + calendar + '")) {',
    'url: "={{ \'https://www.googleapis.com' + calendar + '\' + encodeURIComponent($json.calendar_id) }}",',
    '(`GET ' + calendar + '{id}`, one HTTP node ...)',
    'https://graph.microsoft.com' + ['', 'v1.0', 'users', 'abc', 'calendar'].join('/'),
    'https://api.github.com' + ['', 'users', 'octocat', 'repos'].join('/'),
    "app.get('" + ['', 'home', ':id', ''].join('/') + "')",
    '"https://example.com' + ['', 'home', 'dashboard', ''].join('/') + '"',
    ' ' + ['', 'users', 'someone', ''].join('/'),
    'https://example.com' + ['', 'Users', 'someone', ''].join('/'),
    ['', 'v1', 'Users', 'someone', ''].join('/'),
    ['', 'api', 'home', 'someone', ''].join('/'),
    'x' + ['', 'home', 'someone', ''].join('/'),
    '-' + ['', 'Users', 'someone', ''].join('/'),
  ];
  for (const text of texts) assert.equal(homeFound(text), false, text);
});
test('release scanner keeps a user segment without a following separator unflagged', () => {
  assert.equal(homeFound("'" + ['', 'home', 'secret'].join('/') + "'"), false);
  assert.equal(homeFound('"' + ['C:', 'Users'].join('\\\\') + '"'), false);
  for (const file of ['../test/kilo-provider.test.mjs', '../lib/core/check-runner.py']) {
    assert.deepEqual(contentFindings(readFileSync(new URL(file, import.meta.url))), [], file);
  }
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
