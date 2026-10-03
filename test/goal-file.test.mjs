import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startGoal } from '../lib/core/engine.mjs';

const cli = resolve('bin/forja.mjs');
// Built at run time: a literal BOM in a versioned file fails tools/check.mjs.
const BOM = String.fromCharCode(0xfeff);

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

function repo(t) {
  const root = tempDir(t, 'forja-goal-');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'a.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}

// argv array, no shell: the arguments reach node exactly as written here.
function forja(t, cwd, args) {
  const data = tempDir(t, 'forja-goal-data-');
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr, data: readdirSync(data) };
}

const stored = root => JSON.parse(readFileSync(join(root, '.forja', 'current.json'), 'utf8')).goal;

test('start --goal-file stores a multi-line goal with double quotes byte-exact, without the BOM', t => {
  const root = repo(t);
  const elsewhere = tempDir(t, 'forja-goal-cwd-');
  mkdirSync(join(elsewhere, 'notes'));
  // The shape PowerShell 5.1 cuts: inner double quotes (one unbalanced), CRLF, accents.
  const goal = 'Corrigir a saudação.\r\nO Sponsor disse "hey" e depois "olá\r\n  - manter ✓ os testes\n';
  writeFileSync(join(elsewhere, 'notes', 'goal.md'), BOM + goal, 'utf8');
  // The path is relative to the current folder, not to --project.
  const r = forja(t, elsewhere, ['start', '--goal-file', join('notes', 'goal.md'), '--provider', 'custom', '--project', root]);
  assert.ok(existsSync(join(root, '.forja', 'current.json')), r.err);
  assert.equal(stored(root), goal);
  assert.doesNotMatch(r.err, /unbalanced/);
  assert.doesNotMatch(r.err, /Unknown flag|nothing was changed/);
});

test('start --goal-file refusals happen before any run state is written', t => {
  const files = tempDir(t, 'forja-goal-files-');
  writeFileSync(join(files, 'empty.md'), '');
  writeFileSync(join(files, 'bom-only.md'), BOM, 'utf8');
  writeFileSync(join(files, 'blank.md'), ' \r\n\t\n');
  writeFileSync(join(files, 'ok.md'), 'A goal');
  // What Windows PowerShell 5.1 Out-File writes by default.
  writeFileSync(join(files, 'utf16.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('A goal', 'utf16le')]));
  writeFileSync(join(files, 'utf16-nobom.md'), Buffer.from('A goal', 'utf16le'));
  writeFileSync(join(files, 'long.md'), 'x'.repeat(16001));
  mkdirSync(join(files, 'folder'));
  const refused = [
    [['--goal', 'Inline', '--goal-file', join(files, 'ok.md')], /either --goal or --goal-file/],
    [['--goal-file', join(files, 'ok.md'), '--goal', 'Inline'], /either --goal or --goal-file/],
    [['--goal-file', join(files, 'missing.md')], /Cannot read the goal file .*missing\.md.*ENOENT/],
    [['--goal-file', join(files, 'folder')], /Cannot read the goal file/],
    [['--goal-file', join(files, 'empty.md')], /empty/],
    [['--goal-file', join(files, 'bom-only.md')], /empty/],
    [['--goal-file', join(files, 'blank.md')], /empty/],
    [['--goal-file', join(files, 'utf16.md')], /not UTF-8/],
    [['--goal-file', join(files, 'utf16-nobom.md')], /not UTF-8/],
    [['--goal-file', join(files, 'long.md')], /16001 characters; a goal has 1–16,000/],
    [['--provider', 'custom', '--goal-file'], /Provide a path after --goal-file/],
  ];
  for (const [flags, message] of refused) {
    const root = repo(t);
    const args = ['start', '--provider', 'custom', ...flags];
    const r = forja(t, root, args);
    const shown = args.join(' ');
    assert.notEqual(r.code, 0, shown);
    assert.match(r.err, message, shown);
    assert.match(r.err, /[Nn]othing was changed/, shown);
    assert.equal(existsSync(join(root, '.forja')), false, `${shown} wrote run state`);
    assert.deepEqual(r.data, [], `${shown} wrote FORJA data`);
  }
});

test('startGoal keeps the 1..16,000-character bounds and the exact file contents', t => {
  const dir = tempDir(t, 'forja-goal-unit-');
  writeFileSync(join(dir, 'max.md'), BOM + 'y'.repeat(16000), 'utf8');
  assert.equal(startGoal({ 'goal-file': 'max.md' }, dir), 'y'.repeat(16000));
  writeFileSync(join(dir, 'one.md'), 'z');
  assert.equal(startGoal({ 'goal-file': 'one.md' }, dir), 'z');
  // Only one leading BOM is removed; a second one is content.
  writeFileSync(join(dir, 'two.md'), BOM + BOM + 'g', 'utf8');
  assert.equal(startGoal({ 'goal-file': 'two.md' }, dir), BOM + 'g');
  assert.throws(() => startGoal({ 'goal-file': true }, dir), /Provide a path after --goal-file/);
  assert.throws(() => startGoal({ goal: true, 'goal-file': 'one.md' }, dir), /either --goal or --goal-file/);
});

test('a --goal with an unbalanced double quote warns about --goal-file and the run still starts', t => {
  const root = repo(t);
  const goal = 'Corrigir a saudação. O Sponsor disse hey';
  const cut = forja(t, root, ['start', '--goal', `${goal} "`, '--provider', 'custom']);
  assert.match(cut.err, /warning: the goal has an unbalanced double quote/);
  assert.match(cut.err, /--goal-file/);
  assert.equal(stored(root), `${goal} "`);

  const balanced = repo(t);
  const r = forja(t, balanced, ['start', '--goal', 'Say "hello" twice', '--provider', 'custom']);
  assert.doesNotMatch(r.err, /unbalanced/);
  assert.equal(stored(balanced), 'Say "hello" twice');
});

test('stray start arguments (a goal split by PowerShell 5.1 quoting) are refused naming --goal-file', t => {
  for (const args of [
    ['start', '--goal', 'O', 'Sponsor', 'disse', 'hey', '--provider', 'custom'],
    ['core', 'start', '--provider', 'custom', '--goal', 'Goal', 'tail'],
  ]) {
    const root = repo(t);
    const r = forja(t, root, args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, /Unexpected argument/);
    assert.match(r.err, /--goal-file <path>/);
    assert.match(r.err, /nothing was changed/);
    assert.equal(existsSync(join(root, '.forja')), false);
    assert.deepEqual(r.data, []);
  }
  // Other commands keep their message.
  const root = repo(t);
  const r = forja(t, root, ['core', 'resume', 'now']);
  assert.match(r.err, /Unexpected argument "now"/);
  assert.doesNotMatch(r.err, /--goal-file/);
});
