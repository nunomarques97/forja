// A/B evaluation of auto-learning: the same fixture tasks run with lessons off
// and on. Pre-registered config, alternating schedule (as in benchmark.mjs),
// metrics from run state and the usage ledger (metrics.mjs) and a deterministic
// verdict rule. Every run lives in its own OS temp directory.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createRun, drive } from './engine.mjs';
import { git } from './files.mjs';
import { readMetadata } from './diagnose.mjs';
import { parseUsageLedger, summarizeUsage } from './metrics.mjs';

const DAY = 86400000;
const lines = (...rows) => rows.join('\n') + '\n';
const check = file => ({ command: 'node', args: ['--test', file] });

// Synthetic fixtures built from real failure patterns. History is seeded as
// finished runs under .forja/runs/ so the extractor sees what it sees in use.
const slugCheck = check('test/slug.test.mjs'), datesCheck = check('test/dates.test.mjs');
const slugFixture = {
  id: 'slug-ligatures',
  pattern: 'rejected_then_fixed',
  goal: 'Add a slugify helper for article titles.',
  files: {
    'lib/slug.mjs': lines('export function slugify(title) {', "  throw new Error('not implemented');", '}'),
    'test/slug.test.mjs': lines(
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { slugify } from '../lib/slug.mjs';",
      '',
      "test('joins lowercase words with single hyphens', () => {",
      "  assert.equal(slugify('Hello World'), 'hello-world');",
      "  assert.equal(slugify('  Many   spaces -- here  '), 'many-spaces-here');",
      '});',
      "test('drops accents from Latin letters', () => {",
      "  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');",
      '});'),
  },
  task: {
    id: 'T1', title: 'Add a slugify helper for article titles', complexity: 'easy', risks: [], after: [],
    files: ['lib/slug.mjs'], checks: [slugCheck],
    criteria: [
      'slugify(title) in lib/slug.mjs returns lowercase ASCII words joined by single hyphens, without leading or trailing hyphens.',
      'Titles in German, French and Danish keep every letter readable in ASCII; no letter is silently lost.',
      'node --test test/slug.test.mjs passes.',
    ],
  },
  history: [{
    daysAgo: 6, title: 'Add a slugify helper for article titles', files: ['lib/slug.mjs'], checks: [slugCheck], attempts: 2, changed: ['lib/slug.mjs'],
    calls: [
      ['develop', 1, { status: 'done', summary: 'Implemented slugify with NFD normalization and hyphen joining.', findings: [] }],
      ['review', 1, { status: 'reject', summary: 'Letters without a decomposition are lost: Straße becomes stra-e and Æble becomes ble.',
        findings: ['lib/slug.mjs strips every character outside a-z after NFD, so ß, æ, ø and œ disappear.', 'Map ß to ss, æ to ae, ø to o and œ to oe before stripping.'] }],
      ['develop', 2, { status: 'done', summary: 'Mapped ß, æ, ø and œ to their ASCII spellings before removing combining marks.', findings: [] }],
      ['review', 2, { status: 'approve', summary: 'Slugs keep every letter.', findings: [] }],
    ],
    logs: { 'T1-a1-check-0.log': lines('# pass 2', '# fail 0'), 'T1-a2-check-0.log': lines('# pass 2', '# fail 0') },
  }],
  simulation: {
    path: 'lib/slug.mjs',
    trap: lines('export function slugify(title) {',
      "  return title.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase()",
      "    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');", '}'),
    correct: lines("const SPELLED = { 'ß': 'ss', 'æ': 'ae', 'ø': 'o', 'œ': 'oe' };",
      'export function slugify(title) {',
      "  return title.toLowerCase().replace(/[ßæøœ]/g, c => SPELLED[c]).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')",
      "    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');", '}'),
    rejection: 'Letters without a decomposition are lost: Straße becomes stra-e.',
  },
};
const datesFixture = {
  id: 'dates-offset',
  pattern: 'recurring_check_failure',
  goal: 'Parse report dates.',
  files: {
    'lib/dates.mjs': lines('export function reportDay(value) {', "  throw new Error('not implemented');", '}'),
    'test/dates.test.mjs': lines(
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { reportDay } from '../lib/dates.mjs';",
      '',
      "test('returns the day of a plain date', () => {",
      "  assert.equal(reportDay('2026-12-31'), '2026-12-31');",
      '});',
      "test('keeps the calendar day of a date-time with a UTC offset', () => {",
      "  assert.equal(reportDay('2026-03-01T23:30:00-05:00'), '2026-03-01');",
      "  assert.equal(reportDay('2026-03-01T01:30:00+09:00'), '2026-03-01');",
      '});',
      "test('refuses an invalid date', () => {",
      "  assert.throws(() => reportDay('yesterday'), RangeError);",
      '});'),
  },
  task: {
    id: 'T1', title: 'Parse report dates', complexity: 'easy', risks: [], after: [],
    files: ['lib/dates.mjs'], checks: [datesCheck],
    criteria: [
      'reportDay(value) in lib/dates.mjs returns the calendar day (YYYY-MM-DD) written in an ISO 8601 date or date-time string.',
      'An invalid string throws a RangeError.',
      'node --test test/dates.test.mjs passes.',
    ],
  },
  history: [9, 4].map(daysAgo => ({
    daysAgo, title: 'Parse report dates', files: ['lib/dates.mjs'], checks: [datesCheck], attempts: 2, changed: ['lib/dates.mjs'],
    calls: [
      ['develop', 1, { status: 'done', summary: 'Parsed the value with new Date and returned the ISO date part.', findings: [] }],
      ['develop', 2, { status: 'done', summary: 'Read the calendar day from the string instead of converting to UTC.', findings: [] }],
      ['review', 2, { status: 'approve', summary: 'Calendar days are kept for every offset.', findings: [] }],
    ],
    logs: {
      'T1-a1-check-0.log': lines('TAP version 13', 'ok 1 - returns the day of a plain date',
        'not ok 2 - keeps the calendar day of a date-time with a UTC offset', 'ok 3 - refuses an invalid date', '# pass 2', '# fail 1'),
      'T1-a2-check-0.log': lines('TAP version 13', 'ok 1 - returns the day of a plain date',
        'ok 2 - keeps the calendar day of a date-time with a UTC offset', 'ok 3 - refuses an invalid date', '# pass 3', '# fail 0'),
    },
  })),
  simulation: {
    path: 'lib/dates.mjs',
    trap: lines('export function reportDay(value) {', '  return new Date(value).toISOString().slice(0, 10);', '}'),
    correct: lines('export function reportDay(value) {',
      '  const match = /^(\\d{4}-\\d{2}-\\d{2})(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})?)?$/.exec(value);',
      "  if (!match || Number.isNaN(Date.parse(value))) throw new RangeError('Invalid ISO 8601 date');",
      '  return match[1];', '}'),
    rejection: 'The calendar day shifts for date-times with an offset.',
  },
};

// Pre-registered before any live run: fixtures, arms, repetitions, the per-run
// session cap, the resulting maximum and the verdict thresholds.
export const LESSONS_AB = Object.freeze({
  version: 1,
  id: 'lessons-ab-v1',
  fixtures: [slugFixture, datesFixture],
  arms: ['off', 'on'],
  repetitions: 3,
  sessionCapPerRun: 4,
  maxTotalSessions: 48,
  verdict: { approvalRateGain: 0.34, rejectionsPerRunDrop: 0.5, sessionsPerRunDrop: 0.5, maxTokenIncrease: 0.25 },
});

const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
export const maxSessions = config => config.fixtures.length * config.repetitions * config.arms.length * config.sessionCapPerRun;

export function lessonsAbConfig(config = LESSONS_AB) {
  const invalid = why => Error(`Invalid lessons A/B configuration: ${why}.`);
  if (config?.version !== 1 || typeof config.id !== 'string') throw invalid('version');
  if (JSON.stringify(config.arms) !== '["off","on"]') throw invalid('arms must be off and on');
  if (!integer(config.repetitions, 3, 10)) throw invalid('at least 3 repetitions');
  if (!integer(config.sessionCapPerRun, 1, 10)) throw invalid('session cap per run');
  if (!Array.isArray(config.fixtures) || !config.fixtures.length || new Set(config.fixtures.map(f => f.id)).size !== config.fixtures.length) throw invalid('fixtures');
  for (const pattern of ['rejected_then_fixed', 'recurring_check_failure'])
    if (!config.fixtures.some(f => f.pattern === pattern)) throw invalid(`a ${pattern} fixture is required`);
  for (const f of config.fixtures)
    if (!f.task || !Array.isArray(f.history) || !f.history.length || !f.files || !f.simulation) throw invalid(`fixture ${f.id}`);
  if (config.maxTotalSessions !== maxSessions(config)) throw invalid(`maxTotalSessions must be ${maxSessions(config)}`);
  const v = config.verdict;
  if (!v || !(v.approvalRateGain > 0) || !(v.rejectionsPerRunDrop > 0) || !(v.sessionsPerRunDrop > 0) || !(v.maxTokenIncrease >= 0)) throw invalid('verdict thresholds');
  return config;
}

export const configHash = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');

// Arm order alternates per repetition, so neither arm always runs first.
export function lessonsAbSchedule(config = LESSONS_AB) {
  lessonsAbConfig(config);
  const runs = [];
  for (let repeat = 1; repeat <= config.repetitions; repeat++)
    for (const fixture of config.fixtures)
      for (const arm of repeat % 2 ? ['off', 'on'] : ['on', 'off'])
        runs.push({ id: runs.length + 1, repeat, fixture: fixture.id, arm, max_sessions: config.sessionCapPerRun });
  return runs;
}

const inside = (parent, child) => {
  const path = relative(parent, child);
  return path !== '' && !path.startsWith('..') && !isAbsolute(path);
};

// A fresh Git project in the OS temp directory, with the fixture committed and
// its synthetic history seeded as finished runs (ignored state).
export function materializeFixture(fixture, now = Date.now()) {
  const root = mkdtempSync(join(tmpdir(), 'forja-lessons-ab-'));
  if (!inside(realpathSync(tmpdir()), realpathSync(root))) throw Error('A/B runs must live in the OS temp directory.');
  for (const [file, text] of Object.entries({ ...fixture.files, '.gitignore': '.forja/\n' })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=FORJA A/B', '-c', 'user.email=ab@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  fixture.history.forEach((prior, index) => seedRun(root, prior, index, now));
  return root;
}

function seedRun(root, prior, index, now) {
  const at = now - prior.daysAgo * DAY, id = `F-${at}-seed${String(index).padStart(2, '0')}`;
  const dir = join(root, '.forja', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const last = prior.attempts, logs = Object.keys(prior.logs).filter(n => n.startsWith(`T1-a${last}-`));
  const task = { id: 'T1', title: prior.title, criteria: ['synthetic'], files: prior.files, risks: [], complexity: 'easy', after: [], checks: prior.checks,
    status: 'done', attempts: last, rotations: 0, files_changed: prior.changed,
    validation: logs.map((name, i) => ({ ...prior.checks[i], code: 0, passed: true, log: `.forja/runs/${id}/${name}` })) };
  const time = new Date(at).toISOString();
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, run_id: id, goal: 'synthetic prior run', provider: 'claude', status: 'done',
    created_at: time, updated_at: time, finished_at: time, config: {}, invocations: prior.calls.length, tasks: [task], decisions: [] }, null, 2));
  writeFileSync(join(dir, 'usage.jsonl'), prior.calls.map(([phase, attempt], i) => '\n' + JSON.stringify({ id: i + 1, phase, task: 'T1', attempt,
    provider: 'claude', model: 'synthetic-model', result: 'returned', usage: { input_tokens: 1000, output_tokens: 100 }, duration_ms: 1000 }) + '\n').join(''));
  prior.calls.forEach(([, , result], i) => writeFileSync(join(dir, `call-${i + 1}-result.json`), JSON.stringify(result)));
  for (const [name, text] of Object.entries(prior.logs)) writeFileSync(join(dir, name), text);
}

// Measured from run state and the usage ledger only: what the run recorded.
export function measureRun(root, runId) {
  const budget = { left: 16 * 1024 * 1024 }, prefix = `.forja/runs/${runId}`, gaps = new Set();
  const state = readMetadata(root, `${prefix}/state.json`, budget);
  let run;
  try { run = JSON.parse(state.text); } catch { return { run: runId, gaps: ['state_unavailable'] }; }
  const ledger = readMetadata(root, `${prefix}/usage.jsonl`, budget);
  const parsed = parseUsageLedger(ledger.text ?? '');
  if (ledger.warning || parsed.warnings.length) gaps.add('invalid_ledger');
  const usage = summarizeUsage(parsed.rows, { expectedInvocations: run.invocations });
  const t = usage.totals, rows = [...usage.rows].sort((a, b) => a.id - b.id);
  if (t.recorded_invocations < run.invocations) gaps.add('missing_invocation_records');
  if (t.input_covered_invocations < t.invocations || t.output_covered_invocations < t.invocations) gaps.add('token_coverage');
  if (t.duration_covered_invocations < t.invocations) gaps.add('duration_coverage');
  // Provider errors, timeouts and interruptions measure the provider, not lessons.
  if (rows.some(r => r.result !== 'returned')) gaps.add('execution_failure');
  const reviews = [];
  for (const row of rows.filter(r => r.phase === 'review' && r.result === 'returned')) {
    const read = readMetadata(root, `${prefix}/call-${row.id}-result.json`, budget, 256 * 1024);
    let status = null;
    try { status = JSON.parse(read.text).status; } catch {}
    if (['approve', 'reject'].includes(status)) reviews.push(status);
    else gaps.add('missing_review_result');
  }
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const finalPass = run.status === 'done' && tasks.length > 0 && tasks.every(task => task.status === 'done' &&
    Array.isArray(task.validation) && task.validation.length > 0 && task.validation.every(v => v.passed === true));
  const sent = Array.isArray(run.lessonsSent) ? run.lessonsSent : [];
  return {
    run: run.run_id,
    status: run.status,
    stop: run.stopCode ?? null,
    final_pass: finalPass,
    sessions: run.invocations,
    first_review: reviews[0] ?? null,
    rejections: reviews.filter(s => s === 'reject').length,
    input_tokens: t.input_tokens_including_cache,
    output_tokens: t.output_tokens,
    tokens: t.input_tokens_including_cache === null || t.output_tokens === null ? null : t.input_tokens_including_cache + t.output_tokens,
    duration_ms: t.duration_ms,
    lessons: {
      enabled: run.config?.lessons === true,
      invocations_with_lessons: sent.filter(e => e.ids?.length).length,
      ids: [...new Set(sent.flatMap(e => e.ids ?? []))].sort(),
    },
    gaps: [...gaps],
  };
}

// A missing value makes the mean unknown rather than silently counting as 0.
const mean = values => values.length && values.every(Number.isFinite) ? Math.round(1000 * values.reduce((a, b) => a + b, 0) / values.length) / 1000 : null;

export function summarizeArm(runs) {
  const measured = runs.filter(r => !r.error && !r.metrics?.gaps?.length).map(r => r.metrics);
  const reviewed = measured.filter(m => m.first_review !== null);
  return {
    runs: runs.length,
    measured: measured.length,
    // Runs that never reached review count as not approved at first review.
    first_review_approval_rate: mean(measured.map(m => m.first_review === 'approve' ? 1 : 0)),
    reviewed_runs: reviewed.length,
    rejections_per_run: mean(measured.map(m => m.rejections)),
    sessions_per_run: mean(measured.map(m => m.sessions)),
    tokens_per_run: mean(measured.map(m => m.tokens)),
    duration_ms_per_run: mean(measured.map(m => m.duration_ms)),
    final_pass_rate: mean(measured.map(m => m.final_pass ? 1 : 0)),
    runs_with_lessons: measured.filter(m => m.lessons.invocations_with_lessons > 0).length,
  };
}

// Deterministic, pre-registered rule; a triage of a small sample, not a
// statistical test. Inconclusive whenever the evidence is incomplete.
export function lessonsVerdict(results, config = LESSONS_AB) {
  const schedule = lessonsAbSchedule(config), runs = results?.runs ?? [];
  const reasons = [];
  const done = new Map(runs.map(r => [r.id, r]));
  if (schedule.some(s => !done.has(s.id) || done.get(s.id).arm !== s.arm || done.get(s.id).fixture !== s.fixture) || runs.length !== schedule.length)
    reasons.push('incomplete_schedule');
  if (runs.some(r => r.error || !r.metrics)) reasons.push('run_errors');
  if (runs.some(r => r.metrics?.gaps?.length)) reasons.push('measurement_gaps');
  if (runs.some(r => r.arm === 'on' && r.metrics && !r.metrics.lessons.invocations_with_lessons)) reasons.push('lessons_not_received');
  if (runs.some(r => r.arm === 'off' && r.metrics && (r.metrics.lessons.enabled || r.metrics.lessons.invocations_with_lessons))) reasons.push('lessons_in_off_arm');
  const off = summarizeArm(runs.filter(r => r.arm === 'off')), on = summarizeArm(runs.filter(r => r.arm === 'on'));
  if (!reasons.length && [off, on].some(a => [a.tokens_per_run, a.sessions_per_run, a.duration_ms_per_run, a.final_pass_rate].includes(null))) reasons.push('measurement_gaps');
  if (reasons.length) return { verdict: 'inconclusive', reasons, arms: { off, on } };
  const v = config.verdict;
  const regressed = on.final_pass_rate < off.final_pass_rate || on.first_review_approval_rate < off.first_review_approval_rate ||
    on.rejections_per_run > off.rejections_per_run;
  const gains = [];
  if (on.first_review_approval_rate - off.first_review_approval_rate >= v.approvalRateGain) gains.push('first_review_approval');
  if (off.rejections_per_run - on.rejections_per_run >= v.rejectionsPerRunDrop) gains.push('fewer_rejections');
  if (off.sessions_per_run - on.sessions_per_run >= v.sessionsPerRunDrop) gains.push('fewer_sessions');
  if (regressed) reasons.push('quality_regressed');
  if (!gains.length) reasons.push('no_gain_over_threshold');
  if (on.tokens_per_run > off.tokens_per_run * (1 + v.maxTokenIncrease)) reasons.push('token_increase_over_limit');
  return { verdict: reasons.length ? 'no_benefit' : 'benefit', reasons: [...gains, ...reasons], arms: { off, on } };
}

// Scripted provider for simulated mode: no provider call. The developer writes
// the trap solution unless the packet carries lessons or review/check feedback;
// the reviewer approves only the correct solution. Every packet is observed.
export function scriptedProvider(fixture, observed = []) {
  const { path, trap, correct, rejection } = fixture.simulation;
  return async (_, options) => {
    const ctx = JSON.parse(options.text);
    const lessons = ctx.lessons?.selected?.length ?? 0;
    observed.push({ phase: ctx.phase, lessons, prompt_mentions_lessons: /lessons section/.test(options.input) });
    const usage = { input_tokens: Math.ceil(options.input.length / 4), cache_creation_input_tokens: 0, cached_input_tokens: 0, output_tokens: 200 };
    const reply = result => ({ code: 0, result, duration_ms: 1000, usage, reported_model: 'scripted' });
    if (ctx.phase === 'develop') {
      writeFileSync(join(options.cwd, path), lessons || ctx.feedback ? correct : trap);
      return reply({ status: 'done', summary: `Implemented ${path}.`, findings: [] });
    }
    if (ctx.phase === 'review') {
      const ok = readFileSync(join(options.cwd, path), 'utf8') === correct;
      return reply(ok ? { status: 'approve', summary: 'Criteria met.', findings: [] } : { status: 'reject', summary: rejection, findings: [rejection] });
    }
    throw Error(`Unexpected ${ctx.phase} call: A/B runs use fixed plans.`);
  };
}

// Profile keys that would act outside the temp project are refused.
const REFUSED_PROFILE_KEYS = ['delivery', 'finalChecks', 'allowDirty'];
export function armConfig(profile, arm, config = LESSONS_AB) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Error('The profile must be a JSON object.');
  const refused = REFUSED_PROFILE_KEYS.filter(k => Object.hasOwn(profile, k));
  if (refused.length) throw Error(`The A/B profile must not set ${refused.join(', ')}; runs happen in temp projects without delivery.`);
  return { ...profile, lessons: arm === 'on', maxSessions: config.sessionCapPerRun };
}

// Runs the whole schedule. Live mode (no providerCall) launches real provider
// sessions and must be confirmed by the caller against maxTotalSessions.
export async function runLessonsAb({ config = LESSONS_AB, mode = 'simulated', provider = 'claude', profile = {}, now = Date.now(), log = () => {}, keep = false, onRun = () => {} } = {}) {
  lessonsAbConfig(config);
  if (!['live', 'simulated'].includes(mode)) throw Error('Mode must be live or simulated.');
  for (const arm of config.arms) armConfig(profile, arm, config);
  const schedule = lessonsAbSchedule(config), runs = [];
  const started = new Date().toISOString();
  for (const entry of schedule) {
    const fixture = config.fixtures.find(f => f.id === entry.fixture), observed = [];
    const root = materializeFixture(fixture, now);
    const record = { ...entry };
    try {
      const run = createRun(root, { goal: fixture.goal, provider, plan: { decisions: [], tasks: [fixture.task] }, config: armConfig(profile, entry.arm, config) });
      log(`A/B ${entry.id}/${schedule.length}: ${entry.fixture} lessons ${entry.arm} (${run.run_id})`);
      try {
        await drive(root, { log, ...(mode === 'simulated' ? { providerCall: scriptedProvider(fixture, observed) } : {}) });
      } catch (error) { record.error = String(error.message).split('\n')[0].slice(0, 300); }
      record.metrics = measureRun(root, run.run_id);
      if (mode === 'simulated') record.packets = observed;
    } catch (error) {
      record.error ??= String(error.message).split('\n')[0].slice(0, 300);
    } finally {
      if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
    runs.push(record);
    // Partial results after each run: an interrupted A/B keeps what it spent.
    onRun(results(runs, null));
  }
  return results(runs, new Date().toISOString());
  function results(done, finished) {
    const value = { version: 1, config: config.id, config_sha256: configHash(config), mode, provider, started_at: started,
      finished_at: finished, max_sessions: config.maxTotalSessions,
      sessions_used: done.reduce((n, r) => n + (r.metrics?.sessions ?? 0), 0), runs: done };
    return { ...value, verdict: lessonsVerdict(value, config) };
  }
}

// The results file never lands among tracked files: outside any Git work tree,
// or ignored by it. An existing file is never overwritten.
export function resultsPathProblem(path) {
  const parent = dirname(path);
  if (!existsSync(parent)) return `The results directory does not exist: ${parent}`;
  if (existsSync(path)) return `The results file already exists: ${path}`;
  const inTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: parent, encoding: 'utf8', windowsHide: true });
  if (inTree.status === 0 && inTree.stdout.trim() === 'true' &&
      spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: parent, windowsHide: true }).status !== 0)
    return `The results file would be inside a Git work tree and not ignored: ${path}. Choose a path outside the repository (default: the OS temp directory).`;
  return null;
}
