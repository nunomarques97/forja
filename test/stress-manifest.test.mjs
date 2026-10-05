// The stress suite's manifest, scenario templates and hidden acceptance checks
// (test/stress/). Every check must fail on the untouched scenario and pass on
// its reference solution, or it judges nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { findInvisible, walk } from '../tools/check.mjs';
import {
  ACCEPTANCE, MARKER, REPO, STRESS_DIR, TEMPLATES, acceptanceFile, applySolution, loadManifest, manifestProblems, materialize, parseArgs, scenarioBudgets, selectScenarios,
} from './stress/build-scenarios.mjs';
import { resultProblems, summarizeRecords } from './stress/verify-results.mjs';

const manifest = loadManifest();
const tempDir = () => mkdtempSync(join(tmpdir(), 'forja-stress-'));
const CATEGORIES = ['bug', 'failing-tests', 'regression', 'ambiguous', 'security', 'multi-file-feature', 'dependency-config', 'windows-paths'];

test('the manifest is valid and lists every field of every scenario', () => {
  assert.deepEqual(manifestProblems(manifest), []);
  assert.ok(manifest.scenarios.length >= 24, `${manifest.scenarios.length} scenarios`);
  for (const s of manifest.scenarios) {
    for (const key of ['id', 'category', 'kind', 'goal', 'template', 'overlays', 'acceptance', 'solution']) assert.ok(key in s, `${s.id} lacks ${key}`);
    const budgets = scenarioBudgets(manifest, s);
    for (const key of ['runMinutes', 'maxSessions', 'maxAttempts']) assert.ok(Number.isInteger(budgets[key]), `${s.id} budget ${key}`);
  }
});

test('all eight categories of the goal and both kinds are covered', () => {
  assert.deepEqual(manifest.categories, CATEGORIES);
  for (const category of CATEGORIES) {
    const of = manifest.scenarios.filter(s => s.category === category);
    assert.ok(of.length >= 3, `${category}: ${of.length} scenarios`);
  }
  for (const kind of manifest.kinds) assert.ok(manifest.scenarios.filter(s => s.kind === kind).length >= 4, kind);
  assert.deepEqual(manifest.kinds, ['new-project', 'unfamiliar-codebase']);
});

test('security checks assert negative cases and no stress file holds a credential', () => {
  for (const s of manifest.scenarios.filter(s => s.category === 'security'))
    assert.match(readFileSync(acceptanceFile(s), 'utf8'), /Negative cases?:/, `${s.id} documents its negative cases`);
  const credential = /-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}/;
  for (const f of walk(STRESS_DIR)) assert.doesNotMatch(readFileSync(join(STRESS_DIR, f), 'utf8'), credential, f);
});

test('every acceptance file exists and belongs to exactly one scenario', () => {
  const listed = manifest.scenarios.map(s => relative(ACCEPTANCE, acceptanceFile(s)).replace(/\\/g, '/'));
  for (const s of manifest.scenarios) assert.ok(existsSync(acceptanceFile(s)), s.id);
  const files = readdirSync(ACCEPTANCE).filter(name => name.endsWith('.test.mjs'));
  assert.deepEqual(files.sort(), [...listed].sort());
  assert.equal(new Set(listed).size, listed.length);
});

test('manifest validation names each problem', () => {
  const base = manifest.scenarios[0];
  const bad = {
    ...manifest,
    wallClockMinutes: 0,
    scenarios: [
      { ...base, id: 'Bad Id', category: 'nope', kind: 'other', goal: 'short' },
      { ...base, id: 'b', template: '../templates/tallybook', overlays: [{ dir: 'missing-overlay', commit: '' }] },
      { ...base, id: 'c', acceptance: { command: 'node', args: ['--test', 'test/stress/acceptance/missing.test.mjs'] }, solution: 'templates/tallybook' },
      { ...base, id: 'd', acceptance: { command: 'sh', args: ['-c', 'true'] }, budgets: { runMinutes: 600, maxSessions: 0 } },
      { ...base, id: 'd' },
    ],
  };
  const problems = manifestProblems(bad).join('\n');
  for (const expected of ['wallClockMinutes', 'Bad Id: id', 'unknown category', 'unknown kind', 'goal must', 'scenario b: template', 'overlay "missing-overlay" must', 'needs a commit message',
    'acceptance file test/stress/acceptance/missing.test.mjs does not exist', 'scenario c: solution', 'scenario d: acceptance must be node --test', 'budget runMinutes', 'budget maxSessions', 'scenario d: duplicate id'])
    assert.ok(problems.includes(expected), `missing problem ${expected}:\n${problems}`);
});

test('selection and arguments refuse unknown input', () => {
  assert.deepEqual(selectScenarios(manifest, 'bug-csv-quoted').map(s => s.id), ['bug-csv-quoted']);
  assert.throws(() => selectScenarios(manifest, 'bug-csv-quoted,nope'), /Unknown scenario nope/);
  assert.deepEqual(parseArgs(['--lab', 'x', '--only', 'a,b']), { lab: 'x', only: 'a,b' });
  assert.throws(() => parseArgs(['--lab']), /incomplete/);
});

test('a built scenario is a Git project with its history and without hidden material', () => {
  const root = tempDir();
  try {
    const scenario = manifest.scenarios.find(s => s.id === 'regression-report-grouping');
    const dest = materialize(scenario, join(root, scenario.id));
    const log = spawnSync('git', ['log', '--format=%s'], { cwd: dest, encoding: 'utf8' }).stdout.trim().split('\n');
    assert.deepEqual(log, ['refactor: simplify report grouping', 'initial import']);
    assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dest, encoding: 'utf8' }).stdout, '');
    const files = walk(dest).filter(f => !f.startsWith('.git/'));
    const hidden = new Set(walk(ACCEPTANCE));
    for (const f of files) {
      assert.ok(!hidden.has(f), `${f} comes from acceptance/`);
      assert.doesNotMatch(readFileSync(join(dest, f), 'utf8'), /STRESS_PROJECT|Hidden acceptance/, f);
    }
    assert.ok(existsSync(join(dest, '.git', MARKER)));
    // A rebuild replaces an earlier build, never an unrelated folder.
    writeFileSync(join(dest, 'scratch.txt'), 'x');
    materialize(scenario, dest);
    assert.equal(existsSync(join(dest, 'scratch.txt')), false);
    const foreign = join(root, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'keep.txt'), 'mine');
    assert.throws(() => materialize(scenario, foreign), /refusing to delete/);
    assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'mine');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stress files have no invisible characters and none is Git-ignored', () => {
  const files = walk(STRESS_DIR);
  for (const f of files) assert.deepEqual(findInvisible(readFileSync(join(STRESS_DIR, f), 'utf8')), [], f);
  const paths = files.map(f => `test/stress/${f}`);
  const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: REPO, input: paths.join('\n'), encoding: 'utf8' });
  assert.equal(ignored.stdout.trim(), '', 'ignored files would be missing from the commit');
  assert.ok(files.some(f => f.startsWith('templates/')) && !files.some(f => f.startsWith('templates/') && /acceptance/.test(f)));
});

test('results verification requires a judged record per scenario and a class per failure', () => {
  const record = s => ({ id: s.id, category: s.category, kind: s.kind, outcome: 'done', acceptance: 'pass', verdict: 'pass', tokens: { input: 100, output: 10 }, sessions: 3, duration_s: 60, judgement: 'ok' });
  const results = records => ({ scenarios: records, summary: summarizeRecords(records) });
  const all = manifest.scenarios.map(record);
  assert.deepEqual(resultProblems(results(all)), []);
  assert.match(resultProblems(results(all.slice(1))).join('\n'), new RegExp(`${manifest.scenarios[0].id}: no result`));
  const unclassified = [{ ...all[0], outcome: 'blocked', failure: { evidence: 'runs/x/forja.log: reviewer answered done' } }, ...all.slice(1)];
  assert.match(resultProblems(results(unclassified)).join('\n'), /failure lacks a class/);
  const noArea = [{ ...all[0], verdict: 'fail', failure: { class: 'pipeline', evidence: 'e' } }, ...all.slice(1)];
  assert.match(resultProblems(results(noArea)).join('\n'), /pipeline failure lacks an area/);
  const classified = [{ ...all[0], verdict: 'fail', acceptance: 'fail', failure: { class: 'model', evidence: 'acceptance.log: 2 of 5 fail' } }, ...all.slice(1)];
  assert.deepEqual(resultProblems(results(classified)), []);
  assert.match(resultProblems({ ...results(classified), summary: summarizeRecords(all) }).join('\n'), /summary does not match/);
  const leaky = [{ ...all[0], judgement: 'see C:\\Users\\someone\\lab' }, ...all.slice(1)];
  assert.match(resultProblems(results(leaky)).join('\n'), /absolute local path/);
  assert.match(resultProblems(results([...all, all[0]])).join('\n'), /more than one record/);
});

function acceptance(scenario, project) {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return new Promise(done => {
    const child = spawn(process.execPath, scenario.acceptance.args, { cwd: REPO, env: { ...env, STRESS_PROJECT: project }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('exit', code => { clearTimeout(timer); done({ code, out }); });
  });
}

test('every acceptance check fails on the untouched scenario and passes on the reference solution', { timeout: 600_000 }, async () => {
  const root = tempDir();
  try {
    const queue = [...manifest.scenarios];
    const failures = [];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        const dest = materialize(s, join(root, s.id));
        const before = await acceptance(s, dest);
        if (before.code === 0) failures.push(`${s.id}: passes untouched`);
        applySolution(s, dest);
        const after = await acceptance(s, dest);
        if (after.code !== 0) failures.push(`${s.id}: fails on the reference solution\n${after.out.slice(-1200)}`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    assert.deepEqual(failures, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('templates are only reachable through the manifest', () => {
  const used = new Set(manifest.scenarios.flatMap(s => [s.template, ...s.overlays.map(o => o.dir)]));
  assert.deepEqual(readdirSync(TEMPLATES).filter(name => !used.has(name)), []);
});
