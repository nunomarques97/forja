import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { invocation, runProvider, localPreflight, kiloPermissions, ollamaContextTokens, OLLAMA_ENDPOINT, KILO_LOCAL_MIN_CONTEXT } from '../lib/core/providers.mjs';
import { validateRouting, routeFor } from '../lib/core/routing.mjs';
import { createRun, drive, current } from '../lib/core/engine.mjs';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'forja-local-')); dirs.push(dir); return dir; };
const root = temp();
const schemaPath = join(root, 'schema.json');
writeFileSync(schemaPath, JSON.stringify({ type: 'object', required: ['status'], properties: { status: { type: 'string' } } }));
const scratch = () => { const dir = join(mkdtempSync(join(root, 'owner-')), 'scratch'); mkdirSync(dir); return dir; };

const MODEL = 'fixture-coder:30b-32k';
const local = (extra = {}) => ({ provider: 'kilo', localProvider: 'ollama', model: MODEL, ...extra });
const localConfig = { maxCloudSessions: 0, routes: { plan: local({ maxMinutes: 4 }), develop: local(), review: local({ maxMinutes: 3 }) } };

// A mock Ollama server: every request is recorded; nothing loads or runs a model.
const ollama = ({ models = [{ name: MODEL, model: MODEL }], show = { capabilities: ['completion', 'tools'], parameters: 'num_ctx                        32768\ntemperature 0.7' }, down = null, status = 200 } = {}) => {
  const requests = [];
  const request = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET', body: init.body ?? null, signal: !!init.signal });
    if (down) throw down;
    const data = url.endsWith('/api/tags') ? { models } : show;
    return { ok: status === 200, status, json: async () => data };
  };
  return { request, requests };
};
const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });

test('routing accepts Kilo and Codex local routes and refuses unsafe local routes', () => {
  validateRouting(localConfig, 'claude');
  validateRouting({ routes: { 'develop.fast': { provider: 'codex', localProvider: 'ollama', model: 'fixture-local:20b' } } });
  for (const route of [
    local({ provider: 'claude' }), local({ provider: 'custom' }), local({ localProvider: 'lmstudio' }),
    local({ model: undefined }), local({ model: 'gpt-oss:120b-cloud' }), local({ fallback: 'claude' }), local({ maxMinutes: 0 }),
  ]) assert.throws(() => validateRouting({ routes: { develop: route } }), /Local routes|route field|maxMinutes|Invalid route|model must be/);
  const run = { provider: 'claude', config: { ...localConfig, providers: { kilo: { command: 'kilo-fixture' } } }, limits: { minutes: 10 } };
  for (const [phase, minutes] of [['plan', 4], ['develop', 10], ['review', 3]]) {
    const route = routeFor(run, phase, { complexity: 'easy', files: ['value.mjs'], risks: [] });
    assert.deepEqual([route.provider, route.backend, route.local, route.model, route.maxMinutes, route.config.localProvider, route.config.command], ['kilo', 'ollama', true, MODEL, minutes, 'ollama', 'kilo-fixture']);
  }
  // A route can shorten the run timeout but never extend it.
  assert.equal(routeFor({ ...run, config: { routes: { develop: local({ maxMinutes: 60 }) } } }, 'develop', { files: [] }).maxMinutes, 10);
  assert.throws(() => routeFor({ ...run, config: { routes: { develop: local() }, providers: { kilo: { args: ['--model', 'cloud/x'] } } } }, 'develop', { files: [] }), /extra native/);
  assert.throws(() => routeFor({ ...run, config: { routes: { develop: { provider: 'kilo' } }, providers: { kilo: { localProvider: 'ollama' } } } }, 'develop', { files: [] }), /explicit route/);
});

test('local Kilo invocation pins loopback Ollama and keeps the FORJA permission policy and config home', () => {
  for (const readOnly of [true, false]) {
    const spec = invocation('kilo', { model: MODEL, effort: 'low', schemaPath, scratchPath: scratch(), cwd: root, readOnly, localContextTokens: 32768, config: { command: 'kilo-fixture', localProvider: 'ollama' } });
    assert.deepEqual(spec.args, ['run', '--format', 'json', '--dir', root, '--model', `ollama/${MODEL}`, '--variant', 'low']);
    assert.match(spec.env.XDG_CONFIG_HOME, /kilo-config$/);
    assert.equal(spec.env.KILO_DISABLE_PROJECT_CONFIG, '1');
    const config = JSON.parse(spec.env.KILO_CONFIG_CONTENT);
    assert.deepEqual(config.permission, kiloPermissions({ readOnly }));
    assert.deepEqual(config.mcp, {});
    assert.deepEqual(config.enabled_providers, ['ollama']);
    assert.equal(config.model, `ollama/${MODEL}`);
    assert.equal(config.small_model, `ollama/${MODEL}`);
    assert.deepEqual(Object.keys(config.provider), ['ollama']);
    assert.equal(config.provider.ollama.options.baseURL, 'http://127.0.0.1:11434/v1');
    assert.deepEqual(config.provider.ollama.models[MODEL], { name: MODEL, tool_call: true, limit: { context: 32768, output: 8192 } });
  }
  // Gateway (non-local) Kilo routes are unchanged.
  const cloud = invocation('kilo', { model: 'org-gateway/claude-opus-4-6', schemaPath, scratchPath: scratch(), config: { command: 'kilo-fixture' } });
  assert.ok(cloud.args.includes('org-gateway/claude-opus-4-6'));
  const cloudConfig = JSON.parse(cloud.env.KILO_CONFIG_CONTENT);
  assert.equal(cloudConfig.provider, undefined);
  assert.equal(cloudConfig.enabled_providers, undefined);
  assert.throws(() => invocation('kilo', { schemaPath, scratchPath: scratch(), config: { command: 'kilo-fixture', localProvider: 'ollama' } }), /explicit Ollama model/);
});

test('preflight names the cause of every failure and only reads tags and model metadata on loopback', async () => {
  const cases = [
    [{ down: refused }, /unavailable at http:\/\/127\.0\.0\.1:11434 \(ECONNREFUSED\).*does not download models or fall back to cloud/],
    [{ down: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }, /unavailable .*no answer within 5 seconds/],
    [{ status: 503 }, /answered \/api\/tags with HTTP 503/],
    [{ models: [{ name: 'other:7b' }] }, new RegExp(`model ${MODEL} is not installed; FORJA does not download`)],
    [{ models: [{ name: MODEL, remote_host: 'https://ollama.com:443' }] }, /remote \(cloud\) model; local routes require local weights/],
    [{ show: { remote_model: 'x', capabilities: ['tools'] } }, /remote \(cloud\) model/],
    [{ show: { capabilities: ['completion'], parameters: 'num_ctx 32768' } }, /has no tool support/],
  ];
  for (const [server, message] of cases) {
    const { request, requests } = ollama(server);
    await assert.rejects(localPreflight(MODEL, request, { minContext: KILO_LOCAL_MIN_CONTEXT }), message);
    assert.ok(requests.every(r => r.url.startsWith(`${OLLAMA_ENDPOINT}/api/`) && /\/api\/(tags|show)$/.test(r.url) && r.signal));
  }
  await assert.rejects(localPreflight('gpt-oss:120b-cloud', ollama().request), /explicit installed local Ollama model/);
  // Kilo needs a declared context window; the Codex pilot keeps its original contract.
  const defaultContext = ollama({ show: { capabilities: ['tools'], parameters: 'temperature 0.7' } }).request;
  await assert.rejects(localPreflight(MODEL, defaultContext, { minContext: KILO_LOCAL_MIN_CONTEXT }), /server's default .*num_ctx of at least 16384/);
  await assert.rejects(localPreflight(MODEL, ollama({ show: { capabilities: ['tools'], parameters: 'num_ctx 8192' } }).request, { minContext: KILO_LOCAL_MIN_CONTEXT }), /a 8192-token context/);
  assert.deepEqual(await localPreflight(MODEL, defaultContext), { backend: 'ollama', model: MODEL });
  const { request, requests } = ollama();
  assert.deepEqual(await localPreflight(MODEL, request, { minContext: KILO_LOCAL_MIN_CONTEXT }), { backend: 'ollama', model: MODEL, contextTokens: 32768 });
  assert.deepEqual(JSON.parse(requests[1].body), { model: MODEL });
  assert.equal(ollamaContextTokens('stop "<|im_end|>"\nnum_ctx 4096'), 4096);
  assert.equal(ollamaContextTokens(undefined), null);
});

// Node fixture standing in for kilo.exe: records its argv/env, then answers or hangs.
const fixture = join(root, 'kilo-local-fixture.mjs');
writeFileSync(fixture, `import { writeFileSync } from 'node:fs';
const [marker, mode] = process.argv.slice(2);
writeFileSync(marker, JSON.stringify({ argv: process.argv.slice(4), host: process.env.OLLAMA_HOST, base: process.env.OLLAMA_BASE_URL ?? null, config: JSON.parse(process.env.KILO_CONFIG_CONTENT) }));
if (mode === 'hang') setInterval(() => {}, 1000);
else process.stdin.resume().on('end', () => {
  console.log(JSON.stringify({ type: 'text', sessionID: 's', part: { messageID: 'm', text: '{"status":"done"}' } }));
  console.log(JSON.stringify({ type: 'step_finish', sessionID: 's', part: { messageID: 'm', cost: 0, tokens: { input: 9000, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } } }));
});
`);
const withFetch = async (request, body) => {
  const saved = globalThis.fetch;
  globalThis.fetch = request;
  try { return await body(); } finally { globalThis.fetch = saved; }
};
const callOptions = (marker, mode = 'answer', extra = {}) => ({
  model: MODEL, config: { command: process.execPath, localProvider: 'ollama' }, cwd: root, input: 'TASK', readOnly: true, schemaPath,
  resultPath: join(root, 'unused-result.json'), logPath: join(root, `${mode}-stream.json`), ...extra,
});
const withArgs = (options, marker, mode) => ({ ...options, config: { ...options.config, args: [fixture, marker, mode] } });

test('runProvider preflights, then launches Kilo on the loopback model; preflight failures never launch', async () => {
  const marker = join(root, 'launched.json');
  const out = await withFetch(ollama().request, () => runProvider('kilo', withArgs(callOptions(marker), marker, 'answer')));
  assert.equal(out.code, 0);
  assert.deepEqual(out.result, { status: 'done' });
  const seen = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(seen.argv[seen.argv.indexOf('--model') + 1], `ollama/${MODEL}`);
  assert.equal(seen.host, '127.0.0.1:11434');
  assert.equal(seen.base, null);
  assert.equal(seen.config.provider.ollama.models[MODEL].limit.context, 32768);
  assert.deepEqual(seen.config.enabled_providers, ['ollama']);
  for (const server of [{ down: refused }, { models: [] }, { models: [{ name: MODEL, remote_model: 'x' }] }, { show: { capabilities: ['completion'] } }]) {
    const missing = join(root, `never-${Math.random().toString(36).slice(2)}.json`);
    await assert.rejects(withFetch(ollama(server).request, () => runProvider('kilo', withArgs(callOptions(missing), missing, 'answer'))), /Ollama/);
    assert.equal(existsSync(missing), false, 'no Kilo process after a failed preflight');
  }
});

test('a local call that exceeds its route time limit is killed and reported as a timeout', async () => {
  const marker = join(root, 'hang.json');
  const out = await withFetch(ollama().request, () => runProvider('kilo', withArgs(callOptions(marker, 'hang', { timeoutMs: 1500 }), marker, 'hang')));
  assert.equal(out.timedOut, true);
  assert.ok(existsSync(marker));
});

// Kilo stand-in that ends its first session with prose, like the real local
// smoke run, and answers a follow-up in the same session with the result.
const prose = join(root, 'kilo-prose-fixture.mjs');
writeFileSync(prose, `import { appendFileSync } from 'node:fs';
const [log] = process.argv.slice(2);
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  const argv = process.argv.slice(3);
  const session = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : null;
  appendFileSync(log, JSON.stringify({ session, reminder: input.includes('FORJA result format reminder'), tools: !input.includes('Do not call tools') }) + '\\n');
  const text = session ? '{"status":"ready_for_validation","summary":"Fixed"}' : 'I fixed the function and all tests pass.';
  console.log(JSON.stringify({ type: 'text', sessionID: 'ses_local1', part: { messageID: session ? 'm2' : 'm1', text } }));
  console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_local1', part: { messageID: session ? 'm2' : 'm1', reason: 'stop', cost: 0, tokens: { input: session ? 100 : 9000, output: 10, reasoning: 0, cache: { read: session ? 9000 : 0, write: 0 } } } }));
});
`);
const launches = log => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
const proseCall = (log, extra = {}, config = { localProvider: 'ollama' }) => ({
  model: MODEL, cwd: root, input: 'TASK', readOnly: false, schemaPath, resultPath: join(root, 'unused-result.json'), logPath: join(root, 'prose-stream.json'),
  ...extra, config: { command: process.execPath, args: [prose, log], ...config },
});

test('a local Kilo session that ends without the result JSON gets one follow-up in the same session', async () => {
  const log = join(root, 'followup.jsonl');
  const out = await withFetch(ollama().request, () => runProvider('kilo', proseCall(log)));
  assert.deepEqual(launches(log), [{ session: null, reminder: false, tools: true }, { session: 'ses_local1', reminder: true, tools: false }]);
  assert.equal(out.error, null);
  assert.deepEqual(out.result, { status: 'ready_for_validation', summary: 'Fixed' });
  assert.equal(out.calls, 2);
  assert.deepEqual([out.usage.input_tokens, out.usage.cached_input_tokens, out.usage.output_tokens], [9100, 9000, 20]);
  assert.equal(out.resultFollowUp.code, 0);
  assert.match(readFileSync(join(root, 'prose-stream.json'), 'utf8'), /ready_for_validation/);
  // Not for gateway routes, and not when too little of the call time remains.
  const gateway = join(root, 'gateway.jsonl');
  const cloud = await runProvider('kilo', proseCall(gateway, { model: 'org-gateway/model' }, {}));
  assert.equal(launches(gateway).length, 1);
  assert.match(cloud.error, /no final JSON result/);
  const late = join(root, 'late.jsonl');
  const short = await withFetch(ollama().request, () => runProvider('kilo', proseCall(late, { timeoutMs: 10000 })));
  assert.equal(launches(late).length, 1);
  assert.equal(short.resultFollowUp, undefined);
  assert.match(short.error, /no final JSON result/);
});

function repo() {
  const p = temp();
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test']]) assert.equal(spawnSync('git', args, { cwd: p }).status, 0);
  writeFileSync(join(p, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(p, '.gitignore'), '.forja/\n');
  spawnSync('git', ['add', '.'], { cwd: p });
  spawnSync('git', ['commit', '-qm', 'initial'], { cwd: p });
  return p;
}
const plan = () => ({ decisions: [], tasks: [{ id: 'T1', title: 'Return two', criteria: ['value equals 2'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [],
  checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }] }] });
const ledger = p => { const run = JSON.parse(readFileSync(current(p), 'utf8')); return readFileSync(join(p, '.forja', 'runs', run.run_id, 'usage.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); };

test('an all-local run plans, develops and reviews with zero cloud sessions and a local usage ledger', async () => {
  const p = repo();
  createRun(p, { goal: 'Return two', provider: 'claude', config: { ...localConfig, maxMinutes: 10 } });
  const calls = [];
  const done = await drive(p, { log: () => {}, providerCall: async (provider, options) => {
    calls.push({ provider, model: options.model, local: options.config.localProvider, minutes: options.timeoutMs / 60000, readOnly: options.readOnly });
    const phase = JSON.parse(options.text).phase;
    if (phase === 'plan') return { code: 0, result: plan(), duration_ms: 1, usage: null };
    if (phase === 'develop') writeFileSync(join(p, 'value.mjs'), 'export const value = 2;\n');
    return { code: 0, result: { status: phase === 'review' ? 'approve' : 'done', summary: 'ok', findings: [] }, duration_ms: 1, usage: { input_tokens: 9000, output_tokens: 20 } };
  } });
  assert.equal(done.status, 'done');
  assert.equal(done.cloudInvocations, 0);
  assert.deepEqual(calls.map(c => [c.provider, c.model, c.local, c.minutes]), [['kilo', MODEL, 'ollama', 4], ['kilo', MODEL, 'ollama', 10], ['kilo', MODEL, 'ollama', 3]]);
  const rows = ledger(p);
  assert.equal(rows.length, 3);
  for (const row of rows) assert.deepEqual([row.provider, row.backend, row.local], ['kilo', 'ollama', true]);
  assert.deepEqual(rows.map(r => r.time_limit_ms / 60000), [4, 10, 3]);
});

test('a failed local preflight blocks the run with its cause and no cloud call', async () => {
  const p = repo();
  createRun(p, { goal: 'Return two', provider: 'claude', plan: plan(), config: { maxCloudSessions: 3, routes: { develop: local() } } });
  const providers = [];
  const blocked = await withFetch(ollama({ down: refused }).request, () => drive(p, { log: () => {}, providerCall: async (provider, options) => {
    providers.push(provider);
    return runProvider(provider, { ...options, config: { ...options.config, command: process.execPath, args: [fixture, join(root, 'engine-never.json'), 'answer'] } });
  } }));
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.failure, /Provider develop failed \(Local Ollama is unavailable at http:\/\/127\.0\.0\.1:11434 \(ECONNREFUSED\)/);
  assert.deepEqual(providers, ['kilo']);
  assert.equal(blocked.cloudInvocations, 0);
  assert.equal(existsSync(join(root, 'engine-never.json')), false);
  const [row] = ledger(p);
  assert.deepEqual([row.backend, row.local, row.result], ['ollama', true, 'error']);
});
