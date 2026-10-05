// Regression tests for the stress-suite pipeline failures (2026-10-04
// baseline, docs/research/stress-2026-10-04.md): a local session whose final
// JSON is missing or not a result of its phase gets one same-session reminder
// and then one fresh session of its phase instead of blocking the run. Cloud
// routes keep stopping at once. Mock executors and a Node stand-in for Kilo
// only: no test starts Kilo, Ollama or a cloud CLI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runProvider, kiloSchemaPrompt, KILO_PHASE_ROLES } from '../lib/core/providers.mjs';
import { createRun, drive, current, phaseResultProblem, PHASE_STATUSES, fitLocalPlan } from '../lib/core/engine.mjs';
import { parseUsageLedger } from '../lib/core/metrics.mjs';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'forja-result-retry-')); dirs.push(dir); return dir; };
const MODEL = 'fixture-coder:30b-32k';
const local = { provider: 'kilo', localProvider: 'ollama', model: MODEL };
const localRoutes = { plan: local, develop: local, review: local };

// --- Same-session reminder (providers.mjs) ---

const kiloRoot = temp();
const schemaPath = join(kiloRoot, 'schema.json');
writeFileSync(schemaPath, JSON.stringify({ type: 'object', required: ['status'], properties: { status: { type: 'string' } } }));
// First launch answers with argv[3], a launch with --session with argv[4].
const kilo = join(kiloRoot, 'kilo-answers-fixture.mjs');
writeFileSync(kilo, `import { appendFileSync } from 'node:fs';
const [log, first, second] = process.argv.slice(2);
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  const session = process.argv.includes('--session');
  appendFileSync(log, JSON.stringify({ session, input }) + '\\n');
  const id = session ? 'm2' : 'm1';
  console.log(JSON.stringify({ type: 'text', sessionID: 'ses_r1', part: { messageID: id, text: session ? second : first } }));
  console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_r1', part: { messageID: id, reason: 'stop', cost: 0, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } }));
});
`);
const ollama = async (url) => ({ ok: true, status: 200, json: async () => url.endsWith('/api/tags') ? { models: [{ name: MODEL, model: MODEL }] } : { capabilities: ['tools'], parameters: 'num_ctx 32768' } });
const withFetch = async (body) => { const saved = globalThis.fetch; globalThis.fetch = ollama; try { return await body(); } finally { globalThis.fetch = saved; } };
const launches = log => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const kiloCall = (log, first, second, extra = {}, config = { localProvider: 'ollama' }) => ({
  model: MODEL, cwd: kiloRoot, input: 'TASK', readOnly: true, schemaPath, resultPath: join(kiloRoot, 'unused.json'), logPath: join(kiloRoot, 'stream.json'),
  ...extra, config: { command: process.execPath, args: [kilo, log, first, second], ...config },
});
const reviewProblem = result => phaseResultProblem('review', kiloRoot, result);

test('a local review whose final JSON has status "done" gets one reminder naming the problem in the same session', async () => {
  const log = join(kiloRoot, 'invalid.jsonl');
  const out = await withFetch(() => runProvider('kilo', kiloCall(log, '{"status":"done","summary":"Looks fine","findings":[]}', '{"status":"approve","summary":"Approved","findings":[]}', { phase: 'review', resultProblem: reviewProblem })));
  const [first, second] = launches(log);
  assert.equal(launches(log).length, 2);
  assert.equal(first.session, false);
  assert.ok(first.input.includes(KILO_PHASE_ROLES.review), 'the local review prompt states its phase next to the schema');
  assert.equal(second.session, true);
  assert.match(second.input, /your final JSON is not a valid review result: status "done" is not one of approve, reject, blocked\./);
  assert.match(second.input, /Do not call tools or change files/);
  assert.deepEqual(out.result, { status: 'approve', summary: 'Approved', findings: [] });
  assert.equal(out.error, null);
  assert.equal(out.resultFollowUp.reason, 'invalid');
});

test('a valid local result, a gateway route and a missing problem check get no reminder', async () => {
  const valid = join(kiloRoot, 'valid.jsonl');
  const ok = await withFetch(() => runProvider('kilo', kiloCall(valid, '{"status":"reject","summary":"Missing test","findings":["a.mjs: no test"]}', 'unused', { phase: 'review', resultProblem: reviewProblem })));
  assert.equal(launches(valid).length, 1);
  assert.equal(ok.resultFollowUp, undefined);
  assert.equal(ok.result.status, 'reject');
  const gateway = join(kiloRoot, 'gateway.jsonl');
  const cloud = await runProvider('kilo', kiloCall(gateway, '{"status":"done","summary":"x","findings":[]}', 'unused', { model: 'org-gateway/model', phase: 'review', resultProblem: reviewProblem }, {}));
  assert.equal(launches(gateway).length, 1);
  assert.equal(cloud.result.status, 'done', 'the engine, not the provider, refuses a cloud result');
  assert.ok(!launches(gateway)[0].input.includes(KILO_PHASE_ROLES.review), 'gateway prompts are unchanged');
  const unchecked = join(kiloRoot, 'unchecked.jsonl');
  await withFetch(() => runProvider('kilo', kiloCall(unchecked, '{"status":"done","summary":"x","findings":[]}', 'unused')));
  assert.equal(launches(unchecked).length, 1);
});

test('the local plan role tells the planner not to implement; the reminder for missing JSON repeats it', async () => {
  assert.match(kiloSchemaPrompt(schemaPath, 'plan'), /You are the planner, not the developer/);
  assert.equal(kiloSchemaPrompt(schemaPath).includes('FORJA phase'), false);
  const log = join(kiloRoot, 'plan-prose.jsonl');
  await withFetch(() => runProvider('kilo', kiloCall(log, '## Final Answer\nI fixed it.', '{"tasks":[],"decisions":[]}', { phase: 'plan' })));
  const [, second] = launches(log);
  assert.match(second.input, /ended without the required final JSON result/);
  assert.ok(second.input.includes(KILO_PHASE_ROLES.plan));
});

test('phase result problems: develop and review statuses, a plan without tasks', () => {
  assert.deepEqual(PHASE_STATUSES, { develop: ['done', 'ready_for_validation', 'blocked', 'checkpoint'], review: ['approve', 'reject', 'blocked'] });
  assert.match(phaseResultProblem('develop', kiloRoot, { status: 'completed', summary: 'x', findings: [] }), /status "completed" is not one of/);
  assert.match(phaseResultProblem('develop', kiloRoot, { error: 'No active session to summarize' }), /status null is not one of/);
  assert.equal(phaseResultProblem('develop', kiloRoot, { status: 'ready_for_validation', summary: 'x', findings: [] }), null);
  assert.match(phaseResultProblem('develop', kiloRoot, { status: 'done', summary: 'x' }), /findings is not a list/);
  assert.match(phaseResultProblem('plan', kiloRoot, { status: 'completed', summary: 'Fixed the cache' }), /Plan must contain 1–30 cohesive tasks/);
  assert.equal(phaseResultProblem('review', kiloRoot, { status: 'approve', summary: 'x', findings: [] }), null);
});

// --- Fresh session of the phase (engine.mjs) ---

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-result-retry-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  for (const args of [['init', '-q'], ['add', '--', 'value.mjs', '.gitignore'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}
const plan = () => ({ decisions: [], tasks: [{ id: 'T1', title: 'Return two', criteria: ['value equals 2'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [],
  checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }] }] });
const fixed = root => writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
const result = status => ({ status, summary: 'ok', findings: [] });
// answers[phase] is a list of answers in order; an answer is a provider output
// or a function of the call options returning one.
function executor(root, answers) {
  const calls = [];
  const providerCall = async (provider, options) => {
    const phase = JSON.parse(options.text).phase;
    calls.push({ phase, local: options.config.localProvider === 'ollama', feedback: JSON.parse(options.text).feedback, schema: JSON.parse(readFileSync(options.schemaPath, 'utf8')) });
    const queue = answers[phase];
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (phase === 'develop') fixed(root);
    return { duration_ms: 1, usage: null, ...(typeof answer === 'function' ? answer(options) : answer) };
  };
  return { calls, providerCall };
}
const rows = root => parseUsageLedger(readFileSync(join(root, '.forja', 'runs', JSON.parse(readFileSync(current(root), 'utf8')).run_id, 'usage.jsonl'), 'utf8')).rows;
const ok = r => ({ code: 0, result: r });
const noJson = { code: 0, error: 'Kilo returned no final JSON result (last finish reason: stop)' };

test('a local planner that returns a developer-style result gets one fresh planning session, then the run proceeds', async t => {
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'claude', config: { maxCloudSessions: 0, routes: localRoutes } });
  const { calls, providerCall } = executor(root, { plan: [ok({ status: 'completed', summary: 'Fixed value' }), ok(plan())], develop: [ok(result('ready_for_validation'))], review: [ok(result('approve'))] });
  const logs = [];
  const run = await drive(root, { log: line => logs.push(line), providerCall });
  assert.equal(run.status, 'done', run.failure);
  assert.deepEqual(calls.map(c => c.phase), ['plan', 'plan', 'develop', 'review']);
  assert.equal(calls[1].feedback.status, 'result_retry');
  assert.match(calls[1].feedback.summary, /call-1 returned no usable plan result \(Plan must contain 1–30 cohesive tasks\.\)\. You are the planner/);
  assert.ok(logs.some(line => /returned no usable plan .* Starting one fresh planning session/.test(line)));
  assert.deepEqual(rows(root)[1].automatic_retry, { reason: 'result', after_invocation: 1, problem: 'Plan must contain 1–30 cohesive tasks.' });
});

test('a second unusable local plan blocks as before; providerRetries 0 and cloud planners block at once', async t => {
  for (const [config, planCalls] of [[{ maxCloudSessions: 0, routes: localRoutes }, 2], [{ maxCloudSessions: 0, routes: localRoutes, providerRetries: 0 }, 1], [{}, 1]]) {
    const root = repo(t);
    createRun(root, { goal: 'Return two', provider: 'claude', config });
    const { calls, providerCall } = executor(root, { plan: [ok({ status: 'success' })], develop: [ok(result('done'))], review: [ok(result('approve'))] });
    const run = await drive(root, { log: () => {}, providerCall });
    assert.equal(run.status, 'blocked');
    assert.equal(run.failure, 'Plan must contain 1–30 cohesive tasks.');
    assert.equal(calls.length, planCalls);
  }
  // A plan session without any JSON is retried the same way.
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'claude', config: { maxCloudSessions: 0, routes: localRoutes } });
  const { calls, providerCall } = executor(root, { plan: [noJson, ok(plan())], develop: [ok(result('ready_for_validation'))], review: [ok(result('approve'))] });
  assert.equal((await drive(root, { log: () => {}, providerCall })).status, 'done');
  assert.deepEqual(calls.map(c => c.phase), ['plan', 'plan', 'develop', 'review']);
});

test('a local developer result outside the enum or a local provider failure gets one fresh session in the same attempt', async t => {
  for (const first of [ok(result('completed')), ok({ error: 'No active session to summarize' }), { code: 1, error: 'Compaction exhausted' }]) {
    const root = repo(t);
    createRun(root, { goal: 'Return two', provider: 'claude', plan: plan(), config: { maxCloudSessions: 0, maxAttempts: 1, routes: localRoutes } });
    const { calls, providerCall } = executor(root, { develop: [first, ok(result('ready_for_validation'))], review: [ok(result('approve'))] });
    const run = await drive(root, { log: () => {}, providerCall });
    assert.equal(run.status, 'done', run.failure);
    assert.deepEqual(calls.map(c => c.phase), ['develop', 'develop', 'review']);
    assert.equal(run.tasks[0].attempts, 1, 'the fresh session spends no attempt');
    assert.equal(calls[1].feedback.status, 'checkpoint');
    assert.match(calls[1].feedback.summary, /previous local develop session of this attempt \(call-1\)/);
    assert.equal(rows(root)[1].automatic_retry.reason, first.code ? 'provider' : 'result');
    assert.deepEqual(calls[0].schema.properties.status.enum, PHASE_STATUSES.develop);
  }
});

test('a cloud developer with an invalid result or a provider failure still stops at once', async t => {
  for (const [first, failure] of [[ok(result('completed')), /^Invalid\/oversize worker result: unknown status\.$/], [{ code: 1, error: 'boom' }, /No automatic retry of provider failures\./]]) {
    const root = repo(t);
    createRun(root, { goal: 'Return two', provider: 'claude', plan: plan(), config: { maxAttempts: 2 } });
    const { calls, providerCall } = executor(root, { develop: [first, ok(result('ready_for_validation'))], review: [ok(result('approve'))] });
    const run = await drive(root, { log: () => {}, providerCall });
    assert.equal(run.status, 'blocked');
    assert.match(run.failure, failure);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].schema.properties.status.enum.length, 6, 'cloud schemas keep the shared enum');
  }
});

test('a local reviewer without a verdict gets one fresh review per validated tree; a second one blocks as before', async t => {
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'claude', plan: plan(), config: { maxCloudSessions: 0, routes: localRoutes } });
  let { calls, providerCall } = executor(root, { develop: [ok(result('ready_for_validation'))], review: [ok(result('done')), ok(result('approve'))] });
  let run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.status, 'done', run.failure);
  assert.deepEqual(calls.map(c => c.phase), ['develop', 'review', 'review']);
  assert.deepEqual(calls[1].schema.properties.status.enum, PHASE_STATUSES.review);
  assert.equal(calls[2].feedback.status, 'result_retry');
  assert.match(calls[2].feedback.summary, /call-2 returned no usable review result \(status "done" is not one of approve, reject, blocked\.\)\. You are the reviewer/);
  assert.ok(calls[2].feedback.earlier.developer_result, 'the developer result pointer is kept');
  assert.equal(run.tasks[0].review_retry.after_invocation, 2);
  assert.deepEqual(rows(root)[2].automatic_retry, { reason: 'result', after_invocation: 2, problem: 'status "done" is not one of approve, reject, blocked.' });

  for (const answers of [[ok(result('done'))], [noJson]]) {
    const again = repo(t);
    createRun(again, { goal: 'Return two', provider: 'claude', plan: plan(), config: { maxCloudSessions: 0, routes: localRoutes } });
    ({ calls, providerCall } = executor(again, { develop: [ok(result('ready_for_validation'))], review: answers }));
    run = await drive(again, { log: () => {}, providerCall });
    assert.equal(run.status, 'blocked');
    assert.match(run.failure, answers[0].error ? /Provider review failed \(Kilo returned no final JSON result/ : /^T1: review did not approve or reject\.$/);
    assert.deepEqual(calls.map(c => c.phase), ['develop', 'review', 'review']);
  }
  // A cloud reviewer and providerRetries 0 keep the immediate stop.
  for (const config of [{}, { maxCloudSessions: 0, routes: localRoutes, providerRetries: 0 }]) {
    const once = repo(t);
    createRun(once, { goal: 'Return two', provider: 'claude', plan: plan(), config });
    ({ calls, providerCall } = executor(once, { develop: [ok(result('ready_for_validation'))], review: [ok(result('done'))] }));
    run = await drive(once, { log: () => {}, providerCall });
    assert.equal(run.status, 'blocked');
    assert.deepEqual(calls.map(c => c.phase), ['develop', 'review']);
  }
});

// --- Local plans that cannot fit the session budget (stress rerun, 2026-10-05) ---

const step = (id, after, extra = {}) => ({ id, title: `Step ${id}`, criteria: [`${id} holds`], files: ['value.mjs'], risks: [], complexity: 'easy', after,
  checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }], ...extra });
const splitPlan = () => ({ decisions: [], tasks: [
  step('test_value', ['fix_value'], { criteria: ['value equals 2', 'a test covers it'], checks: [{ command: 'node', args: ['--test'] }] }),
  step('inspect_value', [], { criteria: ['Identify why value is 1'], risks: ['security'] }),
  step('fix_value', ['inspect_value'], { criteria: ['value equals 2'], complexity: 'medium', files: ['value.mjs', 'other.mjs'] }),
] });

test('fitLocalPlan merges a plan that cannot finish within the remaining sessions with one spare, in dependency order', () => {
  const tasks = splitPlan().tasks;
  assert.equal(fitLocalPlan(tasks, 7), null, 'three tasks need six sessions plus one spare');
  assert.equal(fitLocalPlan([tasks[1]], 1), null, 'a single task is never merged');
  const merged = fitLocalPlan(tasks, 6);
  assert.deepEqual(merged.merged_from, ['inspect_value', 'fix_value', 'test_value']);
  assert.equal(merged.id, 'inspect_value');
  assert.equal(merged.title, 'Step inspect_value; Step fix_value; Step test_value');
  assert.deepEqual(merged.criteria, ['Identify why value is 1', 'value equals 2', 'a test covers it']);
  assert.deepEqual(merged.files, ['value.mjs', 'other.mjs']);
  assert.deepEqual(merged.risks, ['security']);
  assert.equal(merged.complexity, 'medium');
  assert.deepEqual(merged.after, []);
  assert.deepEqual(merged.checks.map(c => c.args[0]), ['--input-type=module', '--test'], 'identical checks run once, none is dropped');
});

test('a local plan too large for the session budget runs as one merged task; cloud plans and roomy budgets keep their tasks', async t => {
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'claude', config: { maxCloudSessions: 0, maxSessions: 6, routes: localRoutes } });
  const { calls, providerCall } = executor(root, { plan: [ok(splitPlan())], develop: [ok(result('ready_for_validation'))], review: [ok(result('approve'))] });
  const logs = [];
  const run = await drive(root, { log: line => logs.push(line), providerCall });
  assert.equal(run.status, 'done', run.failure);
  assert.deepEqual(calls.map(c => c.phase), ['plan', 'develop', 'review']);
  assert.deepEqual(run.tasks.map(task => task.merged_from), [['inspect_value', 'fix_value', 'test_value']]);
  assert.ok(logs.some(line => /3 tasks need at least 6 sessions and 5 remain; merged inspect_value, fix_value, test_value into one task/.test(line)));
  for (const config of [{ maxSessions: 6 }, { maxCloudSessions: 0, maxSessions: 8, routes: localRoutes }]) {
    const kept = repo(t);
    createRun(kept, { goal: 'Return two', provider: 'claude', config });
    const out = executor(kept, { plan: [ok(splitPlan())], develop: [ok(result('ready_for_validation'))], review: [ok(result('approve'))] });
    const keptRun = await drive(kept, { log: () => {}, providerCall: out.providerCall });
    assert.deepEqual(keptRun.tasks.map(task => task.id), ['test_value', 'inspect_value', 'fix_value']);
    assert.ok(keptRun.tasks.every(task => !task.merged_from));
  }
});

test('a local plan or review session that times out gets the one fresh session of its phase; a cloud planner timeout still stops', async t => {
  const timedOut = { code: null, timedOut: true, error: null };
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'claude', config: { maxCloudSessions: 0, routes: localRoutes } });
  const { calls, providerCall } = executor(root, { plan: [timedOut, ok(plan())], develop: [ok(result('ready_for_validation'))], review: [timedOut, ok(result('approve'))] });
  const run = await drive(root, { log: () => {}, providerCall });
  assert.equal(run.status, 'done', run.failure);
  assert.deepEqual(calls.map(c => c.phase), ['plan', 'plan', 'develop', 'review', 'review']);
  assert.match(calls[1].feedback.summary, /call-1 returned no usable plan result \(timeout after \d+ minutes? per call without a result\)/);
  assert.match(calls[4].feedback.summary, /returned no usable review result \(timeout after \d+ minutes? per call without a result\)/);
  const cloud = repo(t);
  createRun(cloud, { goal: 'Return two', provider: 'claude', config: {} });
  const out = executor(cloud, { plan: [timedOut, ok(plan())], develop: [ok(result('ready_for_validation'))], review: [ok(result('approve'))] });
  const blocked = await drive(cloud, { log: () => {}, providerCall: out.providerCall });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stopCode, 'timeout');
  assert.equal(out.calls.length, 1);
});

test('an off-schema local plan is answered with every wrong task field at once, in the reminder problem and the plan retry', async t => {
  // Shape seen in failing-slugify and bug-lru-recency: numeric IDs, text criteria, prose checks.
  const invented = { decisions: [], tasks: [{ id: 1, title: 'Analyze', criteria: 'Understand the bug', files: ['value.mjs'], risks: 'Misreading', complexity: 'Low', checks: ['Verify get()'], after: 'Analysis done' }] };
  const problem = phaseResultProblem('plan', process.cwd(), invented);
  assert.match(problem, /^Invalid or duplicate task ID\. Every task needs /);
  for (const field of ['id a string', 'criteria a non-empty array', 'risks an array', 'after an array of task IDs', 'complexity "easy"', 'checks an array of {"command"'])
    assert.ok(problem.includes(field), field);
  assert.ok(!problem.includes('title a non-empty') && !problem.includes('files an array'), 'correct fields are not named');
  assert.ok(problem.length <= 600);
  assert.equal(phaseResultProblem('plan', process.cwd(), { decisions: [], tasks: [] }), 'Plan must contain 1–30 cohesive tasks.');
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'claude', config: { maxCloudSessions: 0, routes: localRoutes } });
  const { calls, providerCall } = executor(root, { plan: [ok(invented), ok(plan())], develop: [ok(result('ready_for_validation'))], review: [ok(result('approve'))] });
  assert.equal((await drive(root, { log: () => {}, providerCall })).status, 'done');
  assert.match(calls[1].feedback.summary, /Invalid or duplicate task ID\. Every task needs id a string such as "T1"; criteria/);
});
