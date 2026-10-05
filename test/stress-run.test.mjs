// tools/stress-run.mjs with a fake forja binary: no model, no GPU check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, exportResults, ledgerTotals, outcomeOf, parseArgs, stressProfile, summarize } from '../tools/stress-run.mjs';
import { resultProblems } from './stress/verify-results.mjs';
import { REPO, STRESS_DIR, loadManifest } from './stress/build-scenarios.mjs';

const manifest = loadManifest();
const localProfile = JSON.parse(readFileSync(join(REPO, 'config', 'core-local.json'), 'utf8'));
const budgets = { runMinutes: 25, maxSessions: 4, maxAttempts: 1 };
const tempDir = () => mkdtempSync(join(tmpdir(), 'forja-stress-run-'));

// Writes what a finished Core run leaves behind; FAKE_MODE=hang never exits.
const FAKE_FORJA = `
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
const project = get('--project');
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ args, cwd: process.cwd(), apiKey: 'ANTHROPIC_API_KEY' in process.env, goal: readFileSync(get('--goal-file'), 'utf8'), config: JSON.parse(readFileSync(get('--config'), 'utf8')) }) + '\\n');
if (process.env.FAKE_MODE === 'hang') setInterval(() => {}, 1000);
else {
  if (process.env.FAKE_SOLUTION) cpSync(process.env.FAKE_SOLUTION, project, { recursive: true });
  const run = join(project, '.forja', 'runs', 'F-1-abcdef');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'state.json'), JSON.stringify({ version: 1, run_id: 'F-1-abcdef', status: process.env.FAKE_STATUS || 'done', stopCode: process.env.FAKE_STATUS ? 'review' : null, tasks: [{ id: 'T1' }] }));
  writeFileSync(join(run, 'usage.jsonl'), [
    { id: 1, phase: 'plan', local: true, usage: { input_tokens: 100, output_tokens: 10 } },
    { id: 2, phase: 'develop', local: true },
    { id: 2, phase: 'develop', local: true, usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 50 } },
    { id: 3, phase: 'review', local: true, usage: { input_tokens: 200, output_tokens: 20 } },
  ].map(row => JSON.stringify(row)).join('\\n') + '\\n');
  if (process.env.FAKE_STATUS) console.log('FORJA blocked: review: the reviewer rejected twice');
}
`;

function setup(env = {}) {
  const lab = tempDir();
  const forjaBin = join(lab, 'fake-forja.mjs');
  writeFileSync(forjaBin, FAKE_FORJA);
  const calls = join(lab, 'calls.jsonl');
  const saved = {};
  for (const [key, value] of Object.entries({ FAKE_CALLS: calls, ANTHROPIC_API_KEY: 'placeholder-not-a-credential', ...env })) { saved[key] = process.env[key]; process.env[key] = value; }
  const restore = () => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  const readCalls = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
  return { lab, forjaBin, readCalls, cleanup: () => { restore(); rmSync(lab, { recursive: true, force: true }); } };
}

test('arguments', () => {
  assert.deepEqual(parseArgs(['run', '--detach', '--label', 'after', '--only', 'a,b']), { command: 'run', detach: true, label: 'after', only: 'a,b' });
  assert.throws(() => parseArgs(['status', '--detach']), /Unknown or incomplete/);
  assert.throws(() => parseArgs(['run', '--label', 'Bad Label']), /--label/);
  assert.throws(() => parseArgs(['launch']), /Unknown command/);
});

test('the stress profile is local only, capped by the scenario budgets, without cloud sessions', () => {
  const profile = stressProfile(localProfile, budgets);
  assert.equal(profile.maxCloudSessions, 0);
  assert.equal(profile.maxSessions, Math.min(localProfile.maxSessions, 4));
  assert.equal(profile.maxAttempts, 1);
  assert.deepEqual(profile.routes, localProfile.routes);
  const cloud = { ...localProfile, routes: { ...localProfile.routes, review: { provider: 'claude', model: 'sonnet' } } };
  assert.throws(() => stressProfile(cloud, budgets), /route review is not a local Ollama route/);
  assert.throws(() => stressProfile({ ...localProfile, escalation: { route: { provider: 'claude' } } }, budgets), /escalation/);
  assert.throws(() => stressProfile({ ...localProfile, routes: { develop: localProfile.routes.develop } }, budgets), /routes.plan is missing/);
  assert.equal(stressProfile({ ...localProfile, maxCloudSessions: 5 }, budgets).maxCloudSessions, 0);
});

test('ledger totals deduplicate invocations; outcomes and summary', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'usage.jsonl'), '{"id":1,"phase":"plan","local":true}\n{"id":1,"phase":"plan","local":true,"usage":{"input_tokens":5,"output_tokens":1}}\nnot json\n{"id":2,"phase":"develop","local":false}\n');
    const totals = ledgerTotals(dir);
    assert.equal(totals.sessions, 2);
    assert.equal(totals.cloud_sessions, 1);
    assert.deepEqual(totals.tokens, { input: 5, output: 1, coverage: 0.5 });
    assert.deepEqual(ledgerTotals(null).tokens, { input: null, output: null, coverage: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(outcomeOf({ capped: true, state: { status: 'done' } }), 'capped');
  assert.equal(outcomeOf({ capped: false, state: null }), 'error');
  assert.equal(outcomeOf({ capped: false, state: { status: 'blocked' } }), 'blocked');
  const s = summarize({ scenarios: { a: { status: 'done', outcome: 'done', acceptance: { passed: true }, tokens: { input: 10, output: 2 }, sessions: 3, duration_ms: 120000 }, b: { status: 'running' } } }, [{ id: 'a' }, { id: 'b' }]);
  assert.deepEqual([s.judged, s.accepted, s.completion_rate, s.tokens.input, s.sessions, s.minutes], [1, 1, 50, 10, 3, 2]);
});

test('a scenario runs with the derived profile and is judged by its hidden check; a rerun resumes', async () => {
  const scenario = manifest.scenarios.find(s => s.id === 'bug-lru-recency');
  const env = setup({ FAKE_SOLUTION: join(STRESS_DIR, scenario.solution) });
  try {
    const options = { lab: env.lab, label: 'unit', only: scenario.id, forjaBin: env.forjaBin, gpu: false, log: () => {} };
    const harness = new Harness(manifest, options);
    await harness.run();
    const record = harness.results.scenarios[scenario.id];
    assert.equal(record.status, 'done');
    assert.equal(record.outcome, 'done');
    assert.equal(record.acceptance.passed, true, readFileSync(join(record.evidence, 'acceptance.log'), 'utf8').slice(-800));
    assert.deepEqual(record.tokens, { input: 1800, output: 80, coverage: 1 });
    assert.deepEqual([record.sessions, record.cloud_sessions, record.run_id, record.files_changed], [3, 0, 'F-1-abcdef', 2]);
    assert.ok(record.duration_ms >= 0 && record.failure === null);
    const [call] = env.readCalls();
    assert.equal(call.goal, scenario.goal);
    assert.equal(call.apiKey, false, 'a provider credential reached the nested run');
    assert.equal(call.config.maxCloudSessions, 0);
    assert.equal(call.args[0], 'start');
    assert.equal(call.args[call.args.indexOf('--provider') + 1], 'kilo');
    // Hidden material stays outside the project; the change is saved as evidence.
    assert.equal(existsSync(join(record.project, 'test', 'stress')), false);
    assert.match(readFileSync(join(record.evidence, 'change.diff'), 'utf8'), /src\/cache\.mjs/);
    const saved = JSON.parse(readFileSync(harness.paths.results, 'utf8'));
    assert.equal(saved.status, 'done');
    assert.equal(existsSync(harness.paths.pid), false);
    await new Harness(manifest, options).run();
    assert.equal(env.readCalls().length, 1, 'a finished scenario ran again');
  } finally {
    env.cleanup();
  }
});

test('a run past its wall-clock cap is killed and recorded as capped; a blocked run keeps its reason', async () => {
  const env = setup({ FAKE_MODE: 'hang' });
  try {
    const harness = new Harness(manifest, { lab: env.lab, label: 'cap', only: 'bug-word-frequency', forjaBin: env.forjaBin, gpu: false, capMs: 1500, log: () => {} });
    await harness.run();
    const record = harness.results.scenarios['bug-word-frequency'];
    assert.equal(record.outcome, 'capped');
    assert.equal(record.acceptance.passed, false);
    assert.match(record.failure, /harness cap/);
  } finally {
    env.cleanup();
  }
  const blocked = setup({ FAKE_STATUS: 'blocked' });
  try {
    const harness = new Harness(manifest, { lab: blocked.lab, label: 'blocked', only: 'bug-word-frequency', forjaBin: blocked.forjaBin, gpu: false, log: () => {} });
    await harness.run();
    const record = harness.results.scenarios['bug-word-frequency'];
    assert.deepEqual([record.outcome, record.stop_code, record.acceptance.passed], ['blocked', 'review', false]);
    assert.match(record.failure, /FORJA blocked: review/);
  } finally {
    blocked.cleanup();
  }
});

test('an interrupted scenario restarts once, a second interruption fails it; one harness at a time', async () => {
  const env = setup();
  try {
    const options = { lab: env.lab, label: 'resume', only: 'bug-word-frequency', forjaBin: env.forjaBin, gpu: false, log: () => {} };
    const harness = new Harness(manifest, options);
    mkdirSync(harness.root, { recursive: true });
    writeFileSync(harness.paths.results, JSON.stringify({ version: 1, label: 'resume', active_ms: 0, status: 'running', scenarios: { 'bug-word-frequency': { id: 'bug-word-frequency', tries: 2, status: 'running' } } }));
    await harness.run();
    assert.deepEqual([harness.results.scenarios['bug-word-frequency'].status, harness.results.scenarios['bug-word-frequency'].error], ['failed', 'interrupted twice']);
    assert.equal(env.readCalls().length, 0);
    writeFileSync(harness.paths.pid, JSON.stringify({ pid: process.ppid, label: 'other' }));
    await assert.rejects(new Harness(manifest, { ...options, label: 'again' }).run(), /Another stress harness is running/);
    // A bad profile is refused before any scenario starts.
    rmSync(harness.paths.pid);
    const bad = join(env.lab, 'cloud.json');
    writeFileSync(bad, JSON.stringify({ ...localProfile, escalation: { route: { provider: 'claude' } } }));
    await assert.rejects(new Harness(manifest, { ...options, label: 'bad', profilePath: bad }).run(), /escalation/);
    assert.equal(env.readCalls().length, 0);
  } finally {
    env.cleanup();
  }
});

test('export keeps judgements, anonymizes paths and needs a judgement per scenario', () => {
  const lab = 'C:/lab';
  const [a, b] = manifest.scenarios;
  const results = { label: 'baseline', created_at: 't0', active_ms: 120000, scenarios: {
    [a.id]: { status: 'done', tries: 1, outcome: 'done', acceptance: { passed: true, pass: 3, fail: 0 }, tokens: { input: 10, output: 2 }, sessions: 3, duration_ms: 61000, failure: null },
    [b.id]: { status: 'done', tries: 2, outcome: 'blocked', stop_code: 'review', acceptance: { passed: false, pass: 1, fail: 2 }, tokens: { input: 20, output: 4 }, sessions: 4, duration_ms: 1000,
      failure: `FORJA blocked: see ${lab}/stress/baseline/runs/x and D:\\other\\place` },
  } };
  const first = exportResults(results, manifest, null, lab);
  assert.equal(first.scenarios.length, manifest.scenarios.length);
  const [ra, rb] = first.scenarios;
  assert.deepEqual([ra.outcome, ra.verdict, ra.duration_s, ra.failure], ['done', 'pass', 61, undefined]);
  assert.deepEqual([rb.outcome, rb.acceptance, rb.verdict, rb.evidence], ['blocked', 'fail', 'fail', `<lab>/stress/baseline/runs/${b.id}-2/`]);
  assert.equal(rb.forja_failure, 'FORJA blocked: see <lab>/stress/baseline/runs/x and <path>');
  assert.equal(first.scenarios[2].outcome, 'error');
  assert.match(resultProblems(first, manifest).join('\n'), /judgement .* is missing/);
  // Judgements written into the committed file survive a re-export.
  const judged = { ...first, scenarios: first.scenarios.map(r => ({ ...r, judgement: 'read the diff', failure: r.id === a.id ? undefined : { class: 'model', evidence: 'acceptance.log' } })) };
  const again = exportResults(results, manifest, judged, lab);
  assert.deepEqual(resultProblems(again, manifest), []);
  assert.deepEqual(again.scenarios[1].failure, { class: 'model', evidence: 'acceptance.log' });
  assert.equal(again.summary.completed, 1);
});
