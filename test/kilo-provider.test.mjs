import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { invocation, parseOutput, runProvider, finalJson, requestContextTokens, kiloPermissions, kiloExecutable, providerInstallation } from '../lib/core/providers.mjs';
import { validateRouting, routeFor } from '../lib/core/routing.mjs';
import { validateWorkerAccess } from '../lib/core/worker-access.mjs';

const root = mkdtempSync(join(tmpdir(), 'forja-kilo-'));
after(() => rmSync(root, { recursive: true, force: true }));
const scratch = () => { const dir = mkdtempSync(join(root, 'owner-')); mkdirSync(join(dir, 'scratch')); return join(dir, 'scratch'); };
const schemaPath = join(root, 'schema.json');
writeFileSync(schemaPath, JSON.stringify({ type: 'object', required: ['status'], properties: { status: { type: 'string' } } }));

// Recorded shape of `kilo run --format json` (Kilo CLI 7.8.1), trimmed.
const step = (message, tokens, extra = {}) => JSON.stringify({ type: 'step_finish', sessionID: 'ses_fixture', part: { messageID: message, type: 'step-finish', model: { providerID: 'org-gateway', modelID: 'claude-sonnet-4-6' }, cost: 0.01, tokens, ...extra } });
const stream = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_fixture', part: { messageID: 'msg_1', type: 'step-start' } }),
  JSON.stringify({ type: 'tool_use', sessionID: 'ses_fixture', part: { messageID: 'msg_1', type: 'tool', tool: 'read', state: { status: 'completed' } } }),
  step('msg_1', { total: 1100, input: 900, output: 40, reasoning: 10, cache: { read: 150, write: 0 } }, { reason: 'tool-calls' }),
  JSON.stringify({ type: 'text', sessionID: 'ses_fixture', part: { messageID: 'msg_1', type: 'text', text: 'Reading first.' } }),
  JSON.stringify({ type: 'text', sessionID: 'ses_fixture', part: { messageID: 'msg_2', type: 'text', text: '\n\n{"status":' } }),
  JSON.stringify({ type: 'text', sessionID: 'ses_fixture', part: { messageID: 'msg_2', type: 'text', text: '"done"}' } }),
  step('msg_2', { total: 1300, input: 1000, output: 6, reasoning: 4, cache: { read: 200, write: 90 } }, { reason: 'stop' }),
].join('\n');

test('kilo invocation runs non-interactive JSON with explicit model and effort', () => {
  const spec = invocation('kilo', { model: 'org-gateway/claude-opus-4-6', effort: 'high', schemaPath, scratchPath: scratch(), cwd: root, config: { command: 'kilo-fixture' } });
  assert.equal(spec.command, 'kilo-fixture');
  assert.deepEqual(spec.args, ['run', '--format', 'json', '--dir', root, '--model', 'org-gateway/claude-opus-4-6', '--variant', 'high']);
  assert.equal(spec.env.PWD, root);
  assert.equal(spec.env.KILO_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(spec.env.KILO_DISABLE_SESSION_INGEST, '1');
  assert.match(spec.env.XDG_CONFIG_HOME, /kilo-config$/);
  const config = JSON.parse(spec.env.KILO_CONFIG_CONTENT);
  assert.equal(config.permission['*'], 'deny');
  assert.deepEqual(config.mcp, {});
  assert.throws(() => invocation('kilo', { schemaPath, config: { command: 'kilo-fixture' } }), /scratch directory/);
});

test('kilo permissions follow the phase and write policy', () => {
  const read = kiloPermissions({ readOnly: true });
  assert.deepEqual(read, { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' });
  assert.equal(kiloPermissions({ readOnly: true, research: true }).webfetch, 'allow');
  const develop = kiloPermissions({});
  assert.equal(develop.edit, 'allow');
  assert.equal(develop.bash, 'allow');
  assert.equal(develop.external_directory, 'allow');
  const restricted = kiloPermissions({ restricted: true });
  assert.equal(restricted.edit, 'allow');
  assert.equal(restricted.bash, undefined);
  assert.deepEqual(kiloPermissions({ fullAccess: true }), { '*': 'allow' });
});

test('kilo output yields the final JSON, summed usage, cost and model', () => {
  const out = parseOutput('kilo', stream, join(root, 'unused.json'));
  assert.deepEqual(out.result, { status: 'done' });
  assert.equal(out.error, null);
  assert.equal(out.session, 'ses_fixture');
  assert.equal(out.calls, 2);
  assert.deepEqual(out.usage, { input_tokens: 1900, cache_creation_input_tokens: 90, cached_input_tokens: 350, output_tokens: 60, source: 'provider step_finish sum; input excludes cache fields; output includes reasoning' });
  assert.equal(out.reported_model, 'org-gateway/claude-sonnet-4-6');
  assert.equal(out.reported_cost_usd, 0.02);
});

test('kilo errors and missing JSON are provider failures', () => {
  const failed = JSON.stringify({ type: 'error', sessionID: 'ses_fixture', error: { name: 'UnknownError', data: { message: 'Model not found: org-gateway/missing.' } } });
  assert.equal(parseOutput('kilo', failed, '').error, 'Model not found: org-gateway/missing.');
  const prose = [JSON.stringify({ type: 'text', part: { messageID: 'm', text: 'I am done.' } }), step('m', { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } })].join('\n');
  assert.equal(parseOutput('kilo', prose, '').error, 'Kilo returned no final JSON result');
});

test('final JSON tolerates fences and surrounding prose only around one object', () => {
  assert.deepEqual(finalJson('```json\n{"status":"done"}\n```'), { status: 'done' });
  assert.deepEqual(finalJson('Result:\n{"status":"blocked"}'), { status: 'blocked' });
  assert.deepEqual(finalJson('{"status":"draft"}</think>{"status":"done","nested":{"a":1}}'), { status: 'done', nested: { a: 1 } });
  assert.equal(finalJson('[1,2]'), null);
  assert.equal(finalJson(''), null);
});

test('context guard reads Kilo step_finish including cache', () => {
  assert.equal(requestContextTokens(JSON.parse(stream.split('\n').at(-1))), 1290);
  assert.equal(requestContextTokens({ type: 'step_finish', part: { tokens: { input: 5 } } }), null);
  assert.equal(requestContextTokens({ type: 'assistant', message: { usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } }), 6);
});

test('kilo discovery prefers the newest CLI bundled with a Kilo Code extension', () => {
  const home = join(root, 'home');
  for (const name of ['acme.kilo-code-1.0.1', 'acme.kilo-code-7.3.41', 'kilocode.kilo-code-7.3.9', 'other.tool-9.9.9']) {
    mkdirSync(join(home, '.vscode/extensions', name, 'bin'), { recursive: true });
    writeFileSync(join(home, '.vscode/extensions', name, 'bin', process.platform === 'win32' ? 'kilo.exe' : 'kilo'), '');
  }
  assert.equal(kiloExecutable({ home }), join(home, '.vscode/extensions', 'acme.kilo-code-7.3.41', 'bin', process.platform === 'win32' ? 'kilo.exe' : 'kilo'));
  assert.equal(providerInstallation('kilo', { command: process.execPath }).context_guard, 'observed_request');
});

test('routing accepts kilo routes and restricted kilo workers', () => {
  const run = { provider: 'kilo', config: { providers: { kilo: { writePolicy: 'restricted', models: { strong: 'org-gateway/claude-opus-4-6' } } } }, limits: { minutes: 10 } };
  validateRouting(run.config, run.provider);
  const review = routeFor(run, 'review', { complexity: 'easy', files: [], risks: [] });
  assert.equal(review.provider, 'kilo');
  assert.equal(review.model, 'org-gateway/claude-opus-4-6');
  assert.doesNotThrow(() => validateWorkerAccess('kilo', { writePolicy: 'restricted' }));
});

test('kilo worker receives the prompt on stdin, isolated config and the result contract', async () => {
  const fixture = join(root, 'kilo-fixture.mjs');
  writeFileSync(fixture, `let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  const config = JSON.parse(process.env.KILO_CONFIG_CONTENT);
  const ok = input.includes('TASK') && input.includes('FORJA result format') && process.argv.includes('run') && config.permission.bash === undefined && process.env.XDG_CONFIG_HOME.endsWith('kilo-config');
  const text = ok ? '{"status":"done"}' : 'fixture rejected the invocation';
  console.log(JSON.stringify({ type: 'text', sessionID: 's', part: { messageID: 'm', text } }));
  console.log(JSON.stringify({ type: 'step_finish', sessionID: 's', part: { messageID: 'm', cost: 0, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } }));
});`);
  const out = await runProvider('kilo', {
    config: { command: process.execPath, args: [fixture] },
    cwd: root, input: 'TASK', readOnly: true, schemaPath,
    resultPath: join(root, 'kilo-result.json'), logPath: join(root, 'kilo-stream.json'),
  });
  assert.equal(out.code, 0);
  assert.equal(out.error, null);
  assert.deepEqual(out.result, { status: 'done' });
  assert.match(readFileSync(join(root, 'kilo-stream.json'), 'utf8'), /step_finish/);
});
