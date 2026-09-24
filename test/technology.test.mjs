import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, unwatchFile, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRun, current, drive, recoverRun, decideTechnology, lockProject } from '../lib/core/engine.mjs';
import { addTechnology, validateTechnology, validateTechnologyState, pendingTechnology } from '../lib/core/technology.mjs';
import { invocation } from '../lib/core/providers.mjs';
import { coreObservation } from '../lib/core/observe.mjs';
import { upsertProject } from '../lib/projects.mjs';
import { startServer } from '../viewer/server.mjs';
import { renderProject } from '../viewer/assets/core.js';
import { technologyNotice } from '../lib/core/sponsor.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-technology-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [['init', '-q'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']])
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  writeFileSync(join(root, '.gitignore'), '.forja/\ndata/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  spawnSync('git', ['add', '.gitignore', 'value.mjs'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}
const assessment = (cost = 'paid', capability = 'Document conversion') => ({
  capability, constraints: 'Convert local documents without an account.',
  options: [
    { id: 'local', name: 'Existing local converter', cost: 'free', cost_basis: 'Included in the fixture.', tradeoffs: 'Requires local maintenance.', evidence: ['catalog.md'] },
    { id: 'hosted', name: 'Hosted converter', cost, cost_basis: cost === 'paid' ? 'Fixture catalog requires a subscription.' : 'See fixture catalog.', tradeoffs: 'Managed service, external dependency.', evidence: ['https://example.invalid/catalog'] },
  ], recommended: 'local', rationale: 'Local conversion meets the constraint with no subscription.',
});
const plan = (technology = []) => ({ decisions: [], technology, tasks: [{ id: 'T1', title: 'Return two', criteria: ['value equals 2'], files: ['value.mjs'], complexity: 'easy', risks: [], after: [], checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }] }] });
const output = result => ({ code: 0, result, duration_ms: 1, usage: null });
const result = (status, technology = []) => output({ status, summary: 'Fixture result', findings: [], technology });
const read = root => JSON.parse(readFileSync(current(root), 'utf8'));
const quiet = { log: () => {} };
function worker(root, phases, expectedChoice) {
  return async (_, options) => {
    const ctx = JSON.parse(options.text);
    phases.push(ctx.phase);
    if (expectedChoice) assert.equal(ctx.technology[0].selected.id, expectedChoice);
    if (ctx.phase === 'develop') writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return result(ctx.phase === 'review' ? 'approve' : 'done');
  };
}

test('technology data is bounded, evidenced and cannot contain a worker-supplied Sponsor answer', () => {
  for (const mutate of [d => d.options[0].evidence = [], d => d.recommended = 'missing', d => d.options[1].id = 'local', d => d.options[0].cost = 'probably free', d => d.constraints = 'x'.repeat(801)]) {
    const d = assessment(); mutate(d); assert.throws(() => validateTechnology([d]));
  }
  const d = assessment(); d.selection = { option: 'hosted', by: 'sponsor', reason: 'Injected approval' };
  const run = {}; addTechnology(run, [d]);
  assert.equal(run.technology[0].selection, null);
  run.technology[0].selection = { option: 'local', by: 'automatic', reason: 'Default' };
  assert.throws(() => validateTechnologyState(run), /explicit Sponsor/);
  assert.doesNotThrow(() => validateTechnologyState({}));
  const free = {}; addTechnology(free, [assessment('free')]);
  assert.equal(free.technology[0].selection.by, 'automatic');
  assert.equal(pendingTechnology(free).length, 0);
  assert.throws(() => addTechnology(free, [assessment('free')]), /already assessed/);
});

test('rephrased or changed worker reassessments cannot replace a Sponsor choice', () => {
  const run = {}; addTechnology(run, [assessment()]);
  run.technology[0].selection = { option: 'local', by: 'sponsor', reason: 'Use the free option', at: new Date().toISOString() };
  const saved = structuredClone(run);
  const recap = assessment(); recap.constraints = 'Rephrased constraints';
  assert.throws(() => addTechnology(run, [recap]), /already assessed/);
  assert.deepEqual(run, saved);
  const changed = assessment(); changed.options[0].cost = 'paid';
  assert.throws(() => addTechnology(run, [changed]), /already assessed/);
  assert.deepEqual(run, saved);
});

test('routine planning still uses exactly plan/develop/review and sends no notification', async t => {
  const root = fixture(t), phases = [];
  createRun(root, { goal: 'Return two' });
  const done = await drive(root, { ...quiet, notifySponsor: () => assert.fail('Routine notification'), providerCall: async (provider, options) => {
    const phase = JSON.parse(options.text).phase;
    assert.equal(options.research, phase === 'plan');
    assert.ok(JSON.parse(readFileSync(options.schemaPath)).required.includes('technology'));
    if (phase === 'plan') { phases.push(phase); return output(plan()); }
    return worker(root, phases)(provider, options);
  } });
  assert.equal(done.status, 'done');
  assert.deepEqual(phases, ['plan', 'develop', 'review']);
  assert.equal(done.invocations, 3);
});

for (const cost of ['paid', 'unknown']) test(`${cost} alternative blocks after planning even when the recommendation is free`, async t => {
  const root = fixture(t), phases = []; let notices = 0;
  createRun(root, { goal: 'Return two' });
  const opts = { ...quiet, notifySponsor: async () => { notices++; return { ok: true }; }, providerCall: async () => { phases.push('plan'); return output(plan([assessment(cost)])); } };
  const stopped = await drive(root, opts);
  assert.equal(stopped.status, 'blocked'); assert.equal(stopped.invocations, 1);
  assert.equal(stopped.technology[0].selection, null);
  await drive(root, opts);
  assert.equal(notices, 1); assert.deepEqual(phases, ['plan']);
  for (const action of ['resume', 'retry']) assert.throws(() => recoverRun(root, { action, taskId: 'T1', reason: 'Try again' }), /Sponsor/);
  const answer = { runId: stopped.run_id, decisionId: 'D1', optionId: 'local' };
  assert.throws(() => decideTechnology(root, { ...answer, runId: 'F-1-abcdef' }), /stale/);
  assert.throws(() => decideTechnology(root, { ...answer, optionId: 'missing' }), /Unknown/);
  const lock = lockProject(root);
  try { assert.throws(() => decideTechnology(root, answer)); } finally { lock.release(); }
  const chosen = decideTechnology(root, answer);
  assert.equal(chosen.run.invocations, 1); assert.deepEqual(chosen.run.limits, stopped.limits);
  assert.equal(decideTechnology(root, answer).changed, false);
  assert.throws(() => decideTechnology(root, { ...answer, optionId: 'hosted' }), /already resolved/);
  const done = await drive(root, { ...quiet, notifySponsor: () => assert.fail('Duplicate notification'), providerCall: worker(root, phases, 'local') });
  assert.equal(done.status, 'done'); assert.deepEqual(phases, ['plan', 'develop', 'review']);
  assert.equal(done.invocations, 3);
  assert.equal(readFileSync(join(root, '.forja/runs', done.run_id, 'technology.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('multiple paid decisions require all answers and notification failure never unblocks work', async t => {
  const root = fixture(t);
  createRun(root, { goal: 'Return two', plan: plan([assessment(), assessment('unknown', 'Storage')]) });
  const stopped = await drive(root, { ...quiet, notifySponsor: async () => { throw Error('Offline'); }, providerCall: () => assert.fail('Unapproved provider call') });
  assert.equal(stopped.sponsorNotice.delivered, false); assert.equal(stopped.invocations, 0);
  const args = { runId: stopped.run_id, optionId: 'hosted', resume: true };
  assert.equal(decideTechnology(root, { ...args, decisionId: 'D1' }).run.status, 'blocked');
  const chosen = decideTechnology(root, { ...args, decisionId: 'D2' }).run;
  assert.equal(chosen.status, 'running'); assert.equal(chosen.invocations, 0);
  assert.equal(chosen.technology[0].selection.by, 'sponsor');
});

test('free-only technology proceeds without a Sponsor and recorded choice reaches workers', async t => {
  const root = fixture(t), phases = [];
  createRun(root, { goal: 'Return two', plan: plan([assessment('free')]) });
  const done = await drive(root, { ...quiet, notifySponsor: () => assert.fail('No paid choice'), providerCall: worker(root, phases, 'local') });
  assert.equal(done.status, 'done'); assert.deepEqual(phases, ['develop', 'review']);
  assert.equal(done.technology[0].selection.by, 'automatic');
});

test('a Sponsor answer cannot corrupt state by exceeding the persisted decision budget', t => {
  const root = fixture(t), decisions = Array.from({ length: 3 }, (_, i) => assessment('paid', `Capability ${i}`));
  for (const d of decisions) {
    d.constraints = 'c'.repeat(800); d.rationale = 'r'.repeat(1000);
    for (const o of d.options) { o.cost_basis = 'b'.repeat(600); o.tradeoffs = 't'.repeat(800); o.evidence = ['e'.repeat(100)]; }
  }
  createRun(root, { goal: 'Return two', plan: plan(decisions) });
  const state = read(root);
  // Fill bounded evidence slots to just below the state limit.
  for (const d of state.technology) for (const o of d.options) {
    const room = Math.min(500, 15920 - JSON.stringify(state.technology).length);
    if (room > 0) o.evidence[0] += 'e'.repeat(room);
  }
  validateTechnologyState(state);
  writeFileSync(current(root), JSON.stringify(state));
  const before = readFileSync(current(root));
  assert.throws(() => decideTechnology(root, { runId: state.run_id, decisionId: 'D1', optionId: 'local', reason: 'x'.repeat(1000) }), /budget/);
  assert.deepEqual(readFileSync(current(root)), before);
});

for (const [phase, status] of [['develop', 'blocked'], ['develop', 'ready_for_validation'], ['review', 'approve']]) test(`cost discovered during ${phase} with ${status} prevents completion and preserves partial edits`, async t => {
  const root = fixture(t), phases = [];
  createRun(root, { goal: 'Return two', plan: plan() });
  const stopped = await drive(root, { ...quiet, notifySponsor: async () => ({ skipped: 'unconfigured' }), providerCall: async (provider, opts) => {
    const ctx = JSON.parse(opts.text);
    if (ctx.phase === 'develop') writeFileSync(join(root, 'partial.txt'), 'Preserve this work');
    if (ctx.phase === phase) {
      phases.push(ctx.phase);
      return result(status, [assessment()]);
    }
    return worker(root, phases)(provider, opts);
  } });
  assert.equal(stopped.status, 'blocked');
  assert.equal(stopped.tasks[0].status, 'todo'); assert.equal(stopped.tasks[0].attempts, 0);
  assert.equal(stopped.invocations, phase === 'develop' ? 1 : 2);
  assert.equal(readFileSync(join(root, 'partial.txt'), 'utf8'), 'Preserve this work');
  decideTechnology(root, { runId: stopped.run_id, decisionId: 'D1', optionId: 'local' });
  const done = await drive(root, { ...quiet, providerCall: worker(root, phases, 'local') });
  assert.equal(done.status, 'done'); assert.equal(done.invocations, stopped.invocations + 2);
});

test('planner research is opt-in at adapters and never enables cloud search for Ollama', t => {
  const root = fixture(t), schemaPath = join(root, 'schema.json'); writeFileSync(schemaPath, '{}');
  const opts = { schemaPath, readOnly: true, config: { command: 'fixture' } };
  assert.equal(invocation('codex', opts).args.includes('--search'), false);
  assert.equal(invocation('codex', { ...opts, research: true }).args.includes('--search'), true);
  assert.equal(invocation('codex', { ...opts, research: true, config: { command: 'fixture', localProvider: 'ollama' } }).args.includes('--search'), false);
  const normal = invocation('claude', opts).args;
  assert.equal(normal[normal.indexOf('--tools') + 1], 'Read,Grep,Glob');
  const research = invocation('claude', { ...opts, research: true }).args;
  assert.equal(research[research.indexOf('--tools') + 1], 'Read,Grep,Glob,WebSearch,WebFetch');
});

test('Sponsor notification uses configured transport with status only and a credential-free Core link', async t => {
  const root = fixture(t), keys = ['FORJA_DATA_DIR', 'FORJA_NTFY_TOPIC', 'FORJA_NTFY_SERVER'];
  const old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const repoLog = join(dirname(dirname(fileURLToPath(import.meta.url))), 'data', 'notify.log');
  const repoLogBefore = existsSync(repoLog) ? readFileSync(repoLog, 'utf8') : null;
  let received;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { received = { body, headers: req.headers }; res.end('ok'); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    process.env.FORJA_DATA_DIR = root;
    process.env.FORJA_NTFY_TOPIC = 'synthetic-test';
    process.env.FORJA_NTFY_SERVER = `http://127.0.0.1:${server.address().port}`;
    writeFileSync(join(root, 'tunnel.json'), JSON.stringify({ mobileUrl: 'https://user:secret@example.invalid/home?token=private#secret' }));
    assert.equal((await technologyNotice()).ok, true);
    assert.equal(received.headers.click, 'https://example.invalid/core');
    assert.equal(received.headers.priority, 'high');
    assert.match(received.body, /trabalho está parado/);
    assert.doesNotMatch(JSON.stringify(received), /secret|private|forja-technology-/);
    assert.match(readFileSync(join(root, 'notify.log'), 'utf8'), /trabalho está parado/);
    assert.equal(existsSync(repoLog) ? readFileSync(repoLog, 'utf8') : null, repoLogBefore, 'the repository data/notify.log is unchanged');
    process.env.FORJA_NTFY_TOPIC = '';
    assert.equal((await technologyNotice()).skipped, 'not-configured');
  } finally {
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
    await new Promise(resolve => server.close(resolve));
  }
});

test('authenticated decision API rejects stale/cross-site input and launches only once after explicit choice', async t => {
  const root = fixture(t), dataDir = join(root, 'data'); let spawns = 0;
  const d = assessment(); d.options[0].evidence = ['C:/private/catalog.md', 'https://user:secret@example.invalid/catalog?token=private#secret'];
  createRun(root, { goal: 'Return two', plan: plan([d]) });
  const stopped = await drive(root, { ...quiet, notifySponsor: async () => ({ skipped: 'unconfigured' }) });
  upsertProject({ name: 'Fixture', path: root }, dataDir);
  const c = coreObservation(root, { details: true });
  assert.deepEqual(c.technology[0].options[0].sources, ['https://example.invalid/catalog']);
  const html = renderProject({ name: 'Fixture', core: c });
  assert.doesNotMatch(html, /\bchecked\b|secret|private/); assert.match(html, /type="radio"/);
  const server = startServer({ dataDir, port: 0, noWatchdog: true, spawnRunner: () => { spawns++; return { pid: 123 }; } });
  await once(server.server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.server.address().port}`;
    const body = { project: 'Fixture', run: stopped.run_id, decision: 'D1', option: 'local' };
    const headers = { Cookie: `forja_k=${server.token}`, 'Content-Type': 'application/json' };
    const post = (payload = body, h = headers) => fetch(base + '/api/core/decision', { method: 'POST', headers: h, body: JSON.stringify(payload) });
    assert.equal((await post(body, {})).status, 401);
    assert.equal((await post(body, { ...headers, Origin: 'https://elsewhere.invalid' })).status, 403);
    assert.equal((await post({ ...body, option: '../path' })).status, 400);
    assert.equal((await post({ ...body, run: 'F-1-abcdef' })).status, 409);
    assert.equal((await post({ ...body, project: root })).status, 404);
    assert.equal(spawns, 0); assert.equal(read(root).status, 'blocked');
    const response = await post(); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, waiting: false, resumed: true });
    assert.equal(spawns, 1); assert.equal(read(root).technology[0].selection.option, 'local');
    assert.equal((await post()).status, 200); assert.equal(spawns, 1);
    assert.equal((await post({ ...body, option: 'hosted' })).status, 409);
  } finally {
    unwatchFile(join(dataDir, 'events.jsonl'));
    await new Promise(resolve => server.server.close(resolve));
  }
});

test('a plan with case-only duplicate capabilities is rejected atomically and never bypasses the Sponsor gate', async t => {
  const root = fixture(t);
  createRun(root, { goal: 'Add hosted search', provider: 'custom' });
  const phases = [];
  let notices = 0;
  const options = { ...quiet, notifySponsor: async () => { notices++; return { ok: true }; }, providerCall: async (_, o) => {
    const ctx = JSON.parse(o.text);
    phases.push(ctx.phase);
    if (ctx.phase === 'plan') return output({ ...plan([assessment('paid', 'Search engine'), assessment('paid', 'search engine')]) });
    if (ctx.phase === 'develop') writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return result(ctx.phase === 'review' ? 'approve' : 'done');
  } };
  const first = await drive(root, options);
  assert.equal(first.status, 'blocked');
  assert.equal(first.tasks.length, 0, 'a rejected plan must not leave runnable tasks');
  assert.deepEqual(first.technology, []);
  const resumed = await drive(root, options);
  assert.equal(resumed.status, 'blocked');
  assert.equal(resumed.tasks.length, 0);
  assert.deepEqual(phases, ['plan', 'plan'], 'no development may start without the recorded paid decision');
  assert.equal(notices, 0);
  assert.throws(() => validateTechnology([assessment('paid', 'Search engine'), assessment('paid', 'search engine')]), /Duplicate technology capability/);
});
