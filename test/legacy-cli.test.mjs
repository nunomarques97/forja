// 0.22.0 removed the legacy crew workflow (docs/LEGACY-REMOVAL.md). Through the
// real bin/forja.mjs: every removed command refuses with exit 2, names itself
// and points to Core without writing anything; Core still prepares and runs a
// project that holds legacy files, and still refuses next to a running legacy run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/forja.mjs', import.meta.url));

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function forja(cwd, data, args) {
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9', FORJA_NTFY_TOPIC: 'fixture-legacy-cli' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function tree(dir) {
  const files = {};
  const walk = rel => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = join(rel, name);
      if (statSync(join(dir, path)).isDirectory()) { files[path + '/'] = ''; walk(path); }
      else files[path] = readFileSync(join(dir, path)).toString('base64');
    }
  };
  if (existsSync(dir)) walk('');
  return files;
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, message) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message); };
const write = (root, name, text) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), text); };

const AGENT = '---\nname: qa\ndescription: QA of the forja crew (legacy)\n---\n\nLegacy crew agent.\n';
const SKILL = '---\nname: forja-lead\ndescription: Legacy Lead of the crew workflow\n---\n\nLegacy skill.\n';
// A Git project from before 0.22.0: legacy run state, a crew agent, a legacy skill.
function legacyProject(t, runStatus) {
  const root = tempDir(t, 'forja-legacy-project-');
  git(root, 'init', '-q');
  write(root, 'value.mjs', 'export const value = 1;\n');
  write(root, 'other.mjs', 'export const other = 1;\n');
  write(root, 'docs/forja/RUN.json', JSON.stringify({ run_id: 'R-20260901-ab12', status: runStatus, goal: 'Old legacy goal' }, null, 2) + '\n');
  write(root, '.claude/agents/qa.md', AGENT);
  write(root, '.claude/skills/forja-lead/SKILL.md', SKILL);
  commit(root, 'Legacy fixture');
  return root;
}

// The T1 set (docs/LEGACY-REMOVAL.md), each with arguments it used to take.
const REMOVED = [
  ['run', 'start', '--goal', 'Anything'], ['run', 'resume'], ['run'],
  ['task', 'add', '--id', 'T1', '--owner', 'backend-dev', '--title', 'x'], ['task', '--help'],
  ['runner', '--goal', 'Anything'], ['forjalvl', 'set', 'max'], ['models', 'show'],
  ['autonomy', 'set', 'total'], ['decide', 'Use X', '--why', 'Because'], ['decisions', 'reindex'],
  ['technology', 'split'], ['obsidian', 'sync'], ['ask', 'Which?', '--default', 'A', '--why', 'x'],
  ['answers'], ['fallback', 'qa', 'opus', 'sonnet', '--why', 'x'], ['progress', 'Working'],
  ['report', 'Done'], ['notify', 'Hello'], ['status'], ['context', '--task', 'T1'], ['resume'],
];

test('every removed command exits 2, names itself and 0.22.0, points to forja core and writes nothing', t => {
  const root = legacyProject(t, 'running');
  const data = tempDir(t, 'forja-legacy-data-');
  const before = { project: tree(root), data: tree(data), head: git(root, 'rev-parse', 'HEAD') };
  const covered = new Set();
  for (const args of REMOVED) {
    const shown = args.join(' ');
    const r = forja(root, data, args);
    covered.add(args[0]);
    assert.equal(r.code, 2, shown);
    assert.equal(r.out, '', `${shown}: nothing on stdout`);
    const lines = r.err.trim().split('\n');
    assert.equal(lines.length, 1, `${shown}: one line\n${r.err}`);
    assert.match(lines[0], new RegExp(`^forja: \`${args[0]}\` was removed in 0\\.22\\.0 with the legacy crew workflow\\. Use instead: .+\\. See \`forja core --help\` for every Core command\\.$`), shown);
    assert.match(lines[0], /`forja (?:start|core [a-z]+)\b/, `${shown}: names a Core command`);
    assert.doesNotMatch(lines[0], /[ãçéêóõúà]/i, `${shown}: English`);
  }
  assert.deepEqual([...covered].sort(), ['answers', 'ask', 'autonomy', 'context', 'decide', 'decisions', 'fallback', 'forjalvl', 'models', 'notify', 'obsidian', 'progress', 'report', 'resume', 'run', 'runner', 'status', 'task', 'technology']);
  assert.deepEqual({ project: tree(root), data: tree(data), head: git(root, 'rev-parse', 'HEAD') }, before, 'no file in the project or the data dir changed');
  assert.equal(existsSync(join(root, '.forja')), false);
});

test('each removed command names its own Core replacement', t => {
  const root = tempDir(t, 'forja-legacy-map-');
  const data = tempDir(t, 'forja-legacy-map-data-');
  const expected = {
    status: /Use instead: `forja core status`\./,
    resume: /Use instead: `forja core resume`\./,
    context: /Use instead: `forja core context --query "\.\.\."`\./,
    run: /`forja start --goal "\.\.\." --provider claude\|codex\|kilo` for a new run; `forja core resume`/,
    runner: /`forja start --goal "\.\.\." --provider claude\|codex\|kilo` for a new run, `forja core resume` to continue one/,
    task: /`forja core retry --task T1 --why "\.\.\."`/,
    decide: /`forja core decide --run <id> --decision <D> --option <id> --why "\.\.\."`/,
    answers: /answer it with `forja core decide`/,
    forjalvl: /`forja start --config <profile\.json>`, checked with `forja core doctor --config <profile\.json>`/,
    progress: /`forja core status`, `forja core usage`, `forja core evidence`/,
  };
  for (const [cmd, pattern] of Object.entries(expected)) assert.match(forja(root, data, [cmd]).err, pattern, cmd);
  assert.deepEqual(tree(root), {});
  assert.deepEqual(tree(data), {});
});

// A fake provider outside the project: it implements T1, blocks the first
// attempt at T2, then implements T2. Reviews approve.
function worker(t) {
  const dir = tempDir(t, 'forja-legacy-worker-');
  const path = join(dir, 'worker.mjs');
  writeFileSync(path, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const prompt = readFileSync(0, 'utf8');",
    "const counter = process.argv[2];",
    "const review = prompt.includes('\"phase\":\"review\"');",
    "const task = (prompt.match(/\"task\":\\{\"id\":\"(T\\d+)\"/) || [])[1];",
    "const seen = existsSync(counter) ? JSON.parse(readFileSync(counter, 'utf8')) : [];",
    "seen.push((review ? 'review ' : 'develop ') + task);",
    "writeFileSync(counter, JSON.stringify(seen));",
    "let status = review ? 'approve' : 'done';",
    "if (!review && task === 'T1') writeFileSync('value.mjs', 'export const value = 2;\\n');",
    "if (!review && task === 'T2') {",
    "  if (seen.filter(s => s === 'develop T2').length === 1) status = 'blocked';",
    "  else writeFileSync('other.mjs', 'export const other = 3;\\n');",
    "}",
    "console.log(JSON.stringify({ result: { status, summary: 'Synthetic ' + status, findings: [] } }));",
  ].join('\n'));
  const counter = join(dir, 'seen.json');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ provider: { command: process.execPath, args: [path, counter] } }));
  const check = (file, name, value) => ({ command: 'node', args: ['--input-type=module', '-e', `import { ${name} } from './${file}'; if (${name} !== ${value}) process.exit(1);`] });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ decisions: [], tasks: [
    { id: 'T1', title: 'Value two', criteria: ['value is 2'], files: ['value.mjs'], complexity: 'easy', risks: [], after: [], checks: [check('value.mjs', 'value', 2)] },
    { id: 'T2', title: 'Other three', criteria: ['other is 3'], files: ['other.mjs'], complexity: 'easy', risks: [], after: ['T1'], checks: [check('other.mjs', 'other', 3)] },
  ] }));
  return { config: join(dir, 'config.json'), plan: join(dir, 'plan.json'), seen: () => JSON.parse(readFileSync(counter, 'utf8')) };
}
const status = (root, data) => {
  const r = forja(root, data, ['core', 'status']);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};

test('core init archives and disables legacy files of a finished legacy project; start, status, resume and retry then run Core', t => {
  const root = legacyProject(t, 'finished');
  const data = tempDir(t, 'forja-legacy-core-data-');
  const runBefore = readFileSync(join(root, 'docs/forja/RUN.json'));

  const init = forja(root, data, ['core', 'init']);
  assert.equal(init.code, 0, init.err);
  const report = JSON.parse(init.out);
  assert.deepEqual(report.legacy_agents.archived, [{ from: '.claude/agents/qa.md', to: 'docs/forja/legacy-agents/qa.md' }]);
  assert.equal(existsSync(join(root, '.claude/agents/qa.md')), false, 'the crew agent left .claude/agents');
  assert.equal(readFileSync(join(root, 'docs/forja/legacy-agents/qa.md'), 'utf8'), AGENT, 'archived byte for byte, never deleted');
  const skill = readFileSync(join(root, '.claude/skills/forja-lead/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: forja-lead\ndescription: Legacy Lead of the crew workflow\ndisable-model-invocation: true\n---\n\nLegacy skill\.\n$/);
  assert.deepEqual(readFileSync(join(root, 'docs/forja/RUN.json')), runBefore, 'the finished legacy run is history, never rewritten');
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /<!-- forja-core:begin -->/);
  assert.ok(readFileSync(join(root, '.gitignore'), 'utf8').split(/\r?\n/).includes('.forja/'));
  commit(root, 'Prepare FORJA Core');

  const w = worker(t);
  const started = forja(root, data, ['start', '--goal', 'Value two, then other three', '--provider', 'custom', '--plan', w.plan, '--config', w.config, '--max-sessions', '2']);
  assert.equal(started.code, 1, `the session budget stops the run after T1\n${started.err}`);
  let s = status(root, data);
  assert.equal(s.status, 'blocked');
  assert.deepEqual(s.tasks.map(task => [task.id, task.status]), [['T1', 'done'], ['T2', 'todo']]);
  assert.equal(s.invocations, 2);

  const resumed = forja(root, data, ['core', 'resume', '--max-sessions', '3']);
  assert.equal(resumed.code, 1, resumed.err);
  s = status(root, data);
  assert.equal(s.status, 'blocked');
  assert.deepEqual(s.tasks.map(task => [task.id, task.status]), [['T1', 'done'], ['T2', 'blocked']]);
  assert.equal(s.invocations, 3, 'resume ran one more session within the raised budget');

  const retried = forja(root, data, ['core', 'retry', '--task', 'T2', '--why', 'The blocker is resolved', '--max-sessions', '10']);
  assert.equal(retried.code, 0, retried.err);
  s = status(root, data);
  assert.equal(s.status, 'done');
  assert.deepEqual(s.tasks.map(task => [task.id, task.status, task.review]), [['T1', 'done', 'approve'], ['T2', 'done', 'approve']]);
  assert.deepEqual(w.seen(), ['develop T1', 'review T1', 'develop T2', 'develop T2', 'review T2']);
  assert.equal(readFileSync(join(root, 'other.mjs'), 'utf8'), 'export const other = 3;\n');
  assert.deepEqual(readFileSync(join(root, 'docs/forja/RUN.json')), runBefore, 'Core never touches the legacy run file');
  const registry = JSON.parse(readFileSync(join(data, 'projects.json'), 'utf8'));
  assert.deepEqual(registry.projects.map(p => resolve(p.path)), [resolve(root)], 'init and start registered the project once');
});

test('start still refuses while a legacy RUN.json is running, and init keeps its crew agents in place', t => {
  const root = legacyProject(t, 'running');
  const data = tempDir(t, 'forja-legacy-active-data-');
  const init = forja(root, data, ['core', 'init']);
  assert.equal(init.code, 0, init.err);
  const report = JSON.parse(init.out);
  assert.deepEqual(report.legacy_agents, { archived: [], kept: ['.claude/agents/qa.md'], reason: 'active legacy run' });
  assert.equal(readFileSync(join(root, '.claude/agents/qa.md'), 'utf8'), AGENT);
  commit(root, 'Prepare FORJA Core');
  const w = worker(t);
  const started = forja(root, data, ['start', '--goal', 'Value two', '--provider', 'custom', '--plan', w.plan, '--config', w.config]);
  assert.equal(started.code, 1);
  assert.match(started.err, /^forja: A legacy run is active\. Finish or explicitly stop it before starting core work\.$/m);
  assert.equal(existsSync(join(root, '.forja/current.json')), false, 'no Core run was created');
  assert.equal(existsSync(join(dirname(w.config), 'seen.json')), false, 'no provider session ran');
});
