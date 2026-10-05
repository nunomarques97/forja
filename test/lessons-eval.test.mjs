import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  LESSONS_AB, lessonsAbConfig, maxSessions, lessonsAbSchedule, materializeFixture, measureRun,
  summarizeArm, lessonsVerdict, armConfig, runLessonsAb, resultsPathProblem,
} from '../lib/core/lessons-eval.mjs';
import { extractLessons, readLessonStore } from '../lib/core/lessons.mjs';
import { parseArgs, plan } from '../tools/lessons-ab.mjs';

const tool = resolve('tools/lessons-ab.mjs');

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

// Runs the tool with its OS temp directory redirected, so writes are observable.
function runTool(t, args) {
  const temp = tempDir(t, 'forja-lessons-ab-tool-');
  const env = { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp };
  const result = spawnSync(process.execPath, [tool, ...args], { cwd: resolve('.'), env, encoding: 'utf8', windowsHide: true });
  return { ...result, temp, written: readdirSync(temp) };
}

const gitStatus = () => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', windowsHide: true });

test('the pre-registered config covers both failure patterns, both arms, 3+ repetitions and its session maximum', () => {
  assert.equal(lessonsAbConfig(), LESSONS_AB);
  assert.deepEqual(LESSONS_AB.arms, ['off', 'on']);
  assert.ok(LESSONS_AB.repetitions >= 3);
  assert.deepEqual(LESSONS_AB.fixtures.map(f => f.pattern).sort(), ['recurring_check_failure', 'rejected_then_fixed']);
  assert.equal(maxSessions(LESSONS_AB), 2 * 3 * 2 * 4);
  assert.equal(LESSONS_AB.maxTotalSessions, 48);
  for (const fixture of LESSONS_AB.fixtures) {
    assert.ok(fixture.task.checks.length && fixture.task.files.length && fixture.history.length);
    assert.notEqual(fixture.simulation.trap, fixture.simulation.correct);
  }
});

test('an invalid config is refused', () => {
  const variant = change => ({ ...LESSONS_AB, ...change });
  assert.throws(() => lessonsAbConfig(variant({ repetitions: 2, maxTotalSessions: 32 })), /at least 3 repetitions/);
  assert.throws(() => lessonsAbConfig(variant({ maxTotalSessions: 40 })), /maxTotalSessions must be 48/);
  assert.throws(() => lessonsAbConfig(variant({ arms: ['on', 'off'] })), /arms/);
  assert.throws(() => lessonsAbConfig(variant({ fixtures: [LESSONS_AB.fixtures[0]], maxTotalSessions: 24 })), /recurring_check_failure fixture is required/);
  assert.throws(() => lessonsAbConfig(variant({ verdict: { ...LESSONS_AB.verdict, approvalRateGain: 0 } })), /verdict thresholds/);
});

test('the schedule alternates arm order per repetition and holds every fixture and arm once per repetition', () => {
  const schedule = lessonsAbSchedule();
  assert.equal(schedule.length, 12);
  assert.deepEqual(schedule.map(s => s.id), schedule.map((_, i) => i + 1));
  for (const fixture of LESSONS_AB.fixtures) {
    const order = repeat => schedule.filter(s => s.repeat === repeat && s.fixture === fixture.id).map(s => s.arm);
    assert.deepEqual(order(1), ['off', 'on']);
    assert.deepEqual(order(2), ['on', 'off']);
    assert.deepEqual(order(3), ['off', 'on']);
  }
  assert.ok(schedule.every(s => s.max_sessions === 4));
  assert.equal(schedule.reduce((n, s) => n + s.max_sessions, 0), LESSONS_AB.maxTotalSessions);
});

test('a materialized fixture lives in the OS temp directory and its seeded history yields lessons', t => {
  for (const fixture of LESSONS_AB.fixtures) {
    const root = materializeFixture(fixture);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }), '');
    assert.equal(extractLessons(root).ingested.length, fixture.history.length);
    const { lessons } = readLessonStore(root);
    const kinds = new Set(lessons.map(l => l.kind));
    if (fixture.pattern === 'rejected_then_fixed') {
      assert.ok(kinds.has('review_rejection') && kinds.has('fix_after_rejection'), [...kinds].join());
    } else {
      const failure = lessons.find(l => l.kind === 'check_failure');
      assert.ok(failure, [...kinds].join());
      assert.equal(failure.count, 2);
    }
  }
});

test('measureRun reports measurement gaps instead of numbers it cannot support', t => {
  const root = materializeFixture(LESSONS_AB.fixtures[1]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [seeded] = readdirSync(join(root, '.forja', 'runs'));
  // Seeded rows carry no cache fields, so Claude token coverage is incomplete.
  assert.ok(measureRun(root, seeded).gaps.includes('token_coverage'));
  mkdirSync(join(root, '.forja', 'runs', 'F-1-broken'));
  writeFileSync(join(root, '.forja', 'runs', 'F-1-broken', 'state.json'), '{');
  assert.deepEqual(measureRun(root, 'F-1-broken').gaps, ['state_unavailable']);
});

// Synthetic results for the verdict rule: per arm and fixture, the given
// first-review outcomes, rejections, sessions and tokens.
function results({ off = {}, on = {}, drop = 0, edit = () => {} } = {}) {
  const metrics = (arm, values) => ({
    run: 'F-x', status: 'done', final_pass: values.pass ?? true, sessions: values.sessions ?? 2, first_review: values.first ?? 'approve',
    rejections: values.rejections ?? 0, tokens: values.tokens ?? 1000, duration_ms: 1000,
    lessons: { enabled: arm === 'on', invocations_with_lessons: arm === 'on' ? 2 : 0, ids: [] }, gaps: [],
  });
  const runs = lessonsAbSchedule().map(entry => ({ ...entry, metrics: metrics(entry.arm, entry.arm === 'on' ? on : off) }));
  runs.forEach(edit);
  return { runs: runs.slice(0, runs.length - drop) };
}
const worse = { first: 'reject', rejections: 1, sessions: 4 };

test('the verdict rule returns benefit, no_benefit or inconclusive deterministically', () => {
  const benefit = lessonsVerdict(results({ off: worse }));
  assert.equal(benefit.verdict, 'benefit');
  assert.deepEqual(benefit.reasons, ['first_review_approval', 'fewer_rejections', 'fewer_sessions']);
  assert.equal(benefit.arms.off.first_review_approval_rate, 0);
  assert.equal(benefit.arms.on.first_review_approval_rate, 1);
  assert.deepEqual(lessonsVerdict(results({ off: worse })), benefit);

  const same = lessonsVerdict(results());
  assert.equal(same.verdict, 'no_benefit');
  assert.deepEqual(same.reasons, ['no_gain_over_threshold']);

  const regressed = lessonsVerdict(results({ off: worse, on: { pass: false } }));
  assert.equal(regressed.verdict, 'no_benefit');
  assert.ok(regressed.reasons.includes('quality_regressed'));

  const costly = lessonsVerdict(results({ off: worse, on: { tokens: 1300 } }));
  assert.equal(costly.verdict, 'no_benefit');
  assert.ok(costly.reasons.includes('token_increase_over_limit'));
});

test('an incomplete schedule, run errors, measurement gaps or lessons not received give inconclusive', () => {
  const inconclusive = (value, reason) => {
    const verdict = lessonsVerdict(value);
    assert.equal(verdict.verdict, 'inconclusive');
    assert.ok(verdict.reasons.includes(reason), verdict.reasons.join());
  };
  inconclusive(results({ off: worse, drop: 1 }), 'incomplete_schedule');
  inconclusive({ runs: [] }, 'incomplete_schedule');
  inconclusive(results({ off: worse, edit: r => { if (r.id === 3) r.arm = r.arm === 'on' ? 'off' : 'on'; } }), 'incomplete_schedule');
  inconclusive(results({ off: worse, edit: r => { if (r.id === 2) { r.error = 'provider failed'; delete r.metrics; } } }), 'run_errors');
  inconclusive(results({ off: worse, edit: r => { if (r.id === 5) r.metrics.gaps = ['token_coverage']; } }), 'measurement_gaps');
  inconclusive(results({ off: worse, edit: r => { if (r.id === 5) r.metrics.tokens = null; } }), 'measurement_gaps');
  inconclusive(results({ off: worse, edit: r => { if (r.arm === 'on' && r.id === 2) r.metrics.lessons.invocations_with_lessons = 0; } }), 'lessons_not_received');
  inconclusive(results({ off: worse, edit: r => { if (r.arm === 'off' && r.id === 1) r.metrics.lessons.invocations_with_lessons = 1; } }), 'lessons_in_off_arm');
});

test('summarizeArm excludes runs with gaps or errors from the means', () => {
  const ok = { first_review: 'approve', rejections: 0, sessions: 2, tokens: 100, duration_ms: 10, final_pass: true, lessons: { invocations_with_lessons: 1 }, gaps: [] };
  const arm = summarizeArm([{ metrics: ok }, { metrics: { ...ok, first_review: 'reject', gaps: ['execution_failure'] } }, { error: 'x' }]);
  assert.equal(arm.runs, 3);
  assert.equal(arm.measured, 1);
  assert.equal(arm.first_review_approval_rate, 1);
  assert.equal(arm.runs_with_lessons, 1);
});

test('armConfig sets the lessons flag and session cap and refuses delivery-like profile keys', () => {
  assert.deepEqual(armConfig({ models: { develop: 'm' } }, 'on'), { models: { develop: 'm' }, lessons: true, maxSessions: 4 });
  assert.equal(armConfig({ lessons: true }, 'off').lessons, false);
  for (const key of ['delivery', 'finalChecks', 'allowDirty']) assert.throws(() => armConfig({ [key]: {} }, 'on'), new RegExp(key));
  assert.throws(() => armConfig([], 'on'), /JSON object/);
});

test('the simulated A/B runs end to end without provider calls; only the lessons-on arm receives lessons', async t => {
  const before = new Set(readdirSync(tmpdir()).filter(n => n.startsWith('forja-lessons-ab-')));
  const partial = [];
  const value = await runLessonsAb({ mode: 'simulated', onRun: r => partial.push(r.runs.length) });
  assert.deepEqual(partial, lessonsAbSchedule().map(s => s.id));
  assert.equal(value.mode, 'simulated');
  assert.equal(value.runs.length, 12);
  assert.ok(value.sessions_used <= value.max_sessions);
  for (const run of value.runs) {
    assert.equal(run.error, undefined, run.error);
    assert.deepEqual(run.metrics.gaps, [], `${run.id}: ${run.metrics.gaps}`);
    assert.ok(run.metrics.sessions <= LESSONS_AB.sessionCapPerRun);
    const develop = run.packets.filter(p => p.phase === 'develop');
    assert.ok(develop.length > 0);
    if (run.arm === 'on') {
      assert.equal(run.metrics.lessons.enabled, true);
      assert.ok(run.metrics.lessons.ids.length > 0);
      assert.ok(develop[0].lessons > 0 && develop[0].prompt_mentions_lessons);
      assert.equal(run.metrics.first_review, 'approve');
    } else {
      assert.equal(run.metrics.lessons.enabled, false);
      assert.equal(run.metrics.lessons.invocations_with_lessons, 0);
      assert.ok(run.packets.every(p => p.lessons === 0 && !p.prompt_mentions_lessons));
      assert.equal(run.metrics.first_review, 'reject');
    }
    assert.equal(run.metrics.final_pass, true);
  }
  assert.equal(value.verdict.verdict, 'benefit');
  const after = readdirSync(tmpdir()).filter(n => n.startsWith('forja-lessons-ab-') && !before.has(n));
  assert.deepEqual(after, [], 'temp projects are removed');
});

test('the results path is refused inside a Git work tree unless ignored, and never overwritten', t => {
  const dir = tempDir(t, 'forja-lessons-ab-out-');
  assert.equal(resultsPathProblem(join(dir, 'results.json')), null);
  writeFileSync(join(dir, 'taken.json'), '{}');
  assert.match(resultsPathProblem(join(dir, 'taken.json')), /already exists/);
  assert.match(resultsPathProblem(join(dir, 'missing', 'results.json')), /does not exist/);
  assert.match(resultsPathProblem(resolve('docs', 'lessons-ab-results.json')), /inside a Git work tree and not ignored/);
  const project = materializeFixture(LESSONS_AB.fixtures[0]);
  t.after(() => rmSync(project, { recursive: true, force: true }));
  assert.equal(resultsPathProblem(join(project, '.forja', 'results.json')), null, 'an ignored path is accepted');
  assert.match(resultsPathProblem(join(project, 'lib', 'results.json')), /not ignored/);
});

test('parseArgs accepts the documented flags and refuses unknown or incomplete ones', () => {
  assert.deepEqual(parseArgs(['--confirm-sessions', '48', '--config', 'p.json']), { 'confirm-sessions': '48', config: 'p.json' });
  assert.throws(() => parseArgs(['--confirm']), /Unknown or incomplete/);
  assert.throws(() => parseArgs(['--out']), /Unknown or incomplete/);
  assert.throws(() => parseArgs(['--dry-run', '--simulate']), /either/);
  assert.equal(plan().max_sessions, 48);
});

test('--dry-run prints the schedule and the maximum session count and writes nothing', t => {
  const status = gitStatus();
  const result = runTool(t, ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Maximum provider sessions: 48\./);
  const printed = JSON.parse(result.stdout.slice(0, result.stdout.lastIndexOf('}') + 1));
  assert.equal(printed.mode, 'dry-run');
  assert.equal(printed.max_sessions, 48);
  assert.deepEqual(printed.schedule, lessonsAbSchedule());
  assert.deepEqual(result.written, []);
  assert.equal(gitStatus(), status);
});

test('live mode refuses without --confirm-sessions equal to the maximum; nothing is run or written', t => {
  const status = gitStatus();
  for (const args of [[], ['--confirm-sessions', '12'], ['--confirm-sessions', '49']]) {
    const result = runTool(t, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Confirm with --confirm-sessions 48/);
    assert.deepEqual(result.written, []);
  }
  const refused = runTool(t, ['--simulate', '--out', resolve('docs', 'lessons-ab-results.json')]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /not ignored/);
  assert.deepEqual(refused.written, []);
  const profile = runTool(t, ['--dry-run', '--config', resolve('test', 'missing-profile.json')]);
  assert.equal(profile.status, 2);
  assert.match(profile.stderr, /Cannot read the profile/);
  assert.equal(gitStatus(), status);
});
