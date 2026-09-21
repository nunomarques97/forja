import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRouting, routeFor } from '../lib/core/routing.mjs';
import { invocation, localPreflight } from '../lib/core/providers.mjs';
import { checksFor, validateFinalChecks, reviewFocus } from '../lib/core/quality.mjs';

const local = { provider: 'codex', localProvider: 'ollama', model: 'fixture-local:20b', maxMinutes: 2 };
const run = config => ({ provider: 'claude', config, limits: { minutes: 10 } });
test('routing separates native commands and selects explicit phase/tier routes', () => {
  const r = run({ provider: { command: 'claude-fixture' }, providers: { codex: { command: 'codex-fixture' } }, routes: { 'develop.fast': local, review: { provider: 'codex', model: 'review-fixture' } } });
  validateRouting(r.config, r.provider);
  const fast = routeFor(r, 'develop', { complexity: 'easy', files: ['value.mjs'], risks: [], attempts: 1 });
  assert.equal(fast.config.command, 'codex-fixture');
  assert.equal(fast.local, true);
  assert.equal(fast.maxMinutes, 2);
  assert.equal(routeFor(r, 'review', { complexity: 'easy', files: [], risks: [] }).model, 'review-fixture');
  const retry = routeFor(r, 'develop', { complexity: 'easy', files: [], risks: [], attempts: 2 });
  assert.equal(retry.tier, 'strong');
  assert.equal(retry.provider, 'claude');
  assert.equal(retry.local, false);
});
test('unlabelled security paths cannot select the cheap development tier', () => {
  const r = run({ routes: { 'develop.fast': local } });
  assert.equal(routeFor(r, 'develop', { complexity: 'easy', files: ['auth.ts'], risks: [] }).tier, 'strong');
  assert.equal(routeFor(r, 'review', { complexity: 'easy', files: ['auth.ts'], risks: [] }).tier, 'critical');
});
test('invalid routes and budgets fail before execution rather than falling back', () => {
  for (const config of [
    { routes: { 'develep.fast': local } }, { routes: { develop: { ...local, provider: 'claude' } } },
    { routes: { develop: { ...local, model: 'fixture-cloud' } } }, { routes: { develop: { provider: 'missing' } } },
    { routes: { develop: { ...local, fallback: 'paid' } } }, { maxCloudSessions: -1 },
  ]) assert.throws(() => validateRouting(config));
  assert.throws(() => routeFor(run({ provider: { args: ['--profile', 'other'] }, routes: { develop: local }, providers: { codex: { args: ['--profile', 'other'] } } }), 'develop'), /extra native/);
});
test('local invocation opts into OSS and retains the native workspace sandbox', () => {
  const spec = invocation('codex', { model: 'fixture-local:20b', schemaPath: 'schema.json', resultPath: 'result.json', config: { command: 'codex-fixture', localProvider: 'ollama' } });
  assert.ok(spec.args.includes('--oss'));
  assert.ok(spec.args.includes('--ignore-user-config'));
  assert.equal(spec.args[spec.args.indexOf('--local-provider') + 1], 'ollama');
  assert.equal(spec.args[spec.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(!spec.args.includes('--dangerously-bypass-approvals-and-sandbox'));
});
test('local preflight rejects absent, remote and tool-incapable models without downloading', async () => {
  const response = data => ({ ok: true, json: async () => data });
  const request = info => async url => response(url.endsWith('/api/tags') ? { models: [{ name: 'fixture:20b' }] } : info);
  await assert.rejects(localPreflight('fixture:20b', async () => response({ models: [] })), /not installed/);
  await assert.rejects(localPreflight('fixture:20b', request({ remote_host: 'remote', capabilities: ['tools'] })), /local weights/);
  await assert.rejects(localPreflight('fixture:20b', request({ capabilities: ['completion'] })), /tool support/);
  assert.deepEqual(await localPreflight('fixture:20b', request({ capabilities: ['tools'] })), { backend: 'ollama', model: 'fixture:20b' });
});
test('goal checks wait for integration and do not repeat on every old task', () => {
  const a = { id: 'A', status: 'validate', checks: [{ command: 'a', args: [] }] }, b = { id: 'B', status: 'todo', checks: [{ command: 'b', args: [] }] };
  const r = { tasks: [a, b], config: { finalChecks: [{ command: 'acceptance', args: [] }] } };
  assert.equal(checksFor(r, a).length, 1);
  a.status = 'done';
  assert.equal(checksFor(r, b).length, 2);
  b.status = 'done'; r.finalCheckTaskId = 'B';
  assert.equal(checksFor(r, a).length, 1);
  assert.equal(checksFor(r, b).length, 2);
  assert.throws(() => validateFinalChecks({ finalChecks: [{ command: 'node', args: 'shell text' }] }));
});
test('review probes cover async failure transitions and UI focus without claiming evidence', () => {
  const probes = reviewFocus({ files: ['View.tsx'], criteria: ['refresh current search'], risks: [] }).join(' ');
  assert.match(probes, /keyboard focus/);
  assert.match(probes, /failed refresh/);
  assert.match(probes, /executed evidence/);
});
