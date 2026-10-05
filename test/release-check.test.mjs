import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { privatePath, contentFindings, inspectIndex, reviewedFixture, fileFindings, envTemplateProblem, scanTree, redactPrivateText } from '../tools/release-check.mjs';

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
  assert.equal(reviewedFixture('test/runner.test.mjs', Buffer.from('x'), 'possible conversation export'), null, 'no asset is reviewed since 0.22.0');
  const path = 'test/fixtures/synthetic-state.md';
  const bytes = Buffer.from('synthetic state');
  const reason = 'private execution/research/credential path';
  const table = { [path]: { sha256: createHash('sha256').update(bytes).digest('hex'), reason, note: 'Synthetic state.' } };
  assert.equal(reviewedFixture(path, bytes, reason, table), 'Synthetic state.');
  assert.equal(reviewedFixture(path, Buffer.concat([bytes, Buffer.from('changed')]), reason, table), null);
  assert.equal(reviewedFixture('docs/HANDOVER.md', bytes, reason, table), null);
  assert.equal(reviewedFixture(path, bytes, 'credential-like value', table), null);
  assert.equal(reviewedFixture('toString', bytes, reason, table), null, 'prototype names are not entries');
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

// #32: .env templates, line-level findings, base pre-scan.
const PRIVATE = 'private execution/research/credential path';
const reasons = (path, text) => fileFindings(path, Buffer.from(text)).map(f => f.reason);
test('.env.example, .env.sample and .env.template pass only with empty or placeholder values (#32)', () => {
  const allowed = [
    'API_URL=\nAPI_KEY=\n',
    '# Public settings\r\n\r\nAPI_KEY=""\r\nexport TOKEN=\r\n',
    "KEY=<your-api-key>\nOTHER='changeme'\nNAME=your-project-name\nX=xxxx\nY=...\nZ= # filled in by the operator\n",
  ];
  for (const name of ['.env.example', 'web/.env.sample', '.env.template', '.ENV.EXAMPLE'])
    for (const text of allowed) assert.deepEqual(reasons(name, text), [], `${name}: ${text}`);
  const refused = [
    ['API_URL=\nAPI_KEY=abc123\n', 2],
    ['PORT=3000\n', 1],
    ['KEY=#secret\n', 1],
    ['KEY="real value"\n', 1],
    ['KEY=<sk-proj-0123>\n', 1],
    ['KEY=your_sk-proj-abcdefabcdefabcdefabcdef\n', 1],
    ['just some prose\n', 1],
    ['A=\n\nB=hunter2 # not a placeholder\n', 3],
  ];
  for (const [text, line] of refused) {
    assert.equal(envTemplateProblem(Buffer.from(text)), line, text);
    assert.deepEqual(fileFindings('.env.example', Buffer.from(text))[0], { reason: PRIVATE, line }, text);
  }
  assert.equal(envTemplateProblem(Buffer.from([65, 61, 0])), 1, 'binary content is never a template');
  // Credential detection still runs on an otherwise acceptable template.
  assert.ok(reasons('.env.example', 'KEY=\n# sk-' + 'a'.repeat(32) + '\n').includes('credential-like value'));
});
test('other .env names, keys and credential files stay refused whatever their content (#32)', () => {
  for (const path of ['.env', '.env.local', '.env.production', '.env.example.local', 'config/.env.dev', 'credentials.json', 'id.key', 'cert.pem', 'app.keystore', 'release.jks'])
    assert.deepEqual(reasons(path, 'KEY=\n'), [PRIVATE], path);
});
test('findings name the line of the first match and never the matched text (#32)', () => {
  const home = ['C:', 'Users', 'someone', 'notes.txt'].join('\\');
  const text = ['# Lesson', '', 'Escapes:', '```csharp', `var path = @"${home}";`, '```', 'key: sk-' + 'b'.repeat(32)].join('\n');
  const found = fileFindings('docs/lesson.md', Buffer.from(text));
  assert.deepEqual(found, [{ reason: 'credential-like value', line: 7 }, { reason: 'personal home path', line: 5 }],
    'a home path inside a Markdown code fence is still reported');
  assert.ok(!JSON.stringify(found).includes('someone'));
  const unix = ['', 'home', 'someone', 'x'].join('/');
  assert.deepEqual(fileFindings('a.txt', Buffer.from(`one\ntwo ${unix}\n${home}\n`)), [{ reason: 'personal home path', line: 2 }]);
  assert.deepEqual(fileFindings('a.txt', Buffer.from(['-----BEGIN', 'PRIVATE', 'KEY-----\n'].join(' '))), [{ reason: 'private key', line: 1 }]);
  assert.deepEqual(fileFindings('data/run.json', Buffer.from('{}')), [{ reason: PRIVATE, line: null }]);
});
test('release-check names file and line in its JSON and stderr output (#32)', t => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, 'notes.md'), 'intro\n' + ['C:', 'Users', 'someone', 'x'].join('\\') + '\n'); git('add', 'notes.md');
  writeFileSync(join(root, '.env.example'), 'API_KEY=\n'); git('add', '.env.example');
  assert.deepEqual(inspectIndex(root).findings, [{ path: 'notes.md', reason: 'personal home path', line: 2 }]);
  const cli = new URL('../tools/release-check.mjs', import.meta.url);
  let failure;
  try { execFileSync(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1')], { cwd: root, stdio: 'pipe' }); } catch (error) { failure = error; }
  assert.equal(failure?.status, 1);
  assert.equal(JSON.parse(failure.stdout).findings[0].line, 2);
  assert.match(failure.stderr.toString(), /^notes\.md:2 personal home path$/m);
});
test('the base scan reports every tracked finding with file and line, and skips reviewed fixtures (#32)', t => {
  const { root, git } = fixture(t);
  writeFileSync(join(root, 'CLAUDE.md'), 'a\nb\n' + ['', 'Users', 'someone', 'repo'].join('/') + '\n');
  writeFileSync(join(root, '.env.example'), 'TOKEN=\n');
  writeFileSync(join(root, 'clean.txt'), 'nothing');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base');
  const report = scanTree(root, 'HEAD');
  assert.equal(report.files, 3);
  assert.deepEqual(report.findings, [{ path: 'CLAUDE.md', reason: 'personal home path', line: 3 }]);
});
test('private text redaction reuses the detectors and replaces the project root first', () => {
  const bs = '\\';
  const home = ['C:', 'Users', 'someone'].join(bs);
  const root = [home, 'project'].join(bs);
  const key = ['-----BEGIN', 'PRIVATE KEY-----\nabc\n-----END PRIVATE', 'KEY----- after'].join(' ');
  const route = 'https://api.example.com' + ['', 'users', 'octocat', 'repos'].join('/');
  const cases = [
    [[root, 'lib', 'a.mjs:3 failed'].join(bs), ['<project>', 'lib', 'a.mjs:3 failed'].join(bs)],
    [root.toLowerCase().replaceAll(bs, '/') + '/lib/a.mjs', '<project>/lib/a.mjs'],
    [JSON.stringify({ at: [root, 'a.js'].join(bs) }), JSON.stringify({ at: ['<project>', 'a.js'].join(bs) })],
    [[root + 'sibling', 'x.txt'].join(bs), '<home>'],
    ['see ' + [home, 'other', 'notes.md'].join(bs) + ' here', 'see <home> here'],
    ['open ' + ['', 'home', 'someone', 'x', 'y.txt'].join('/') + ' now', 'open <home> now'],
    ['key ' + ['sk', 'proj', 'z'.repeat(30)].join('-') + ' and ' + ['gh', 'p_' + 'q'.repeat(36)].join(''), 'key <redacted> and <redacted>'],
    [key, '<redacted> after'],
    [route, route],
  ];
  for (const [input, expected] of cases) {
    const output = redactPrivateText(input, { root });
    assert.equal(output, expected, input);
    assert.deepEqual(contentFindings(Buffer.from(output)), [], output);
  }
  // Without a root, a project path under a home directory is still redacted.
  assert.equal(redactPrivateText([root, 'a.mjs'].join(bs)), '<home>');
  // A conversation export cannot be redacted; callers drop text that keeps a finding.
  const exported = JSON.stringify({ role: 'user', content: 'private' });
  assert.deepEqual(contentFindings(Buffer.from(redactPrivateText(exported, { root }))), ['possible conversation export']);
});
