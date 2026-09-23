import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { invocation } from '../lib/core/providers.mjs';
import { validateRouting, routeFor } from '../lib/core/routing.mjs';
import { createRun, drive } from '../lib/core/engine.mjs';

const owned = mkdtempSync(join(tmpdir(), 'forja-access-'));
after(() => {
  assert.ok(resolve(owned).startsWith(resolve(tmpdir()) + sep));
  rmSync(owned, { recursive: true, force: true });
});
const schemaPath = join(owned, 'schema.json');
writeFileSync(schemaPath, '{"type":"object"}');
const opts = { schemaPath, resultPath: join(owned, 'result.json'), mcpPath: join(owned, 'mcp.json') };
const value = (args, flag) => args[args.indexOf(flag) + 1];

test('both native providers opt into full access for planning, development and review', () => {
  for (const provider of ['codex', 'claude']) for (const phase of ['plan', 'develop', 'review']) {
    const run = { provider, config: { providers: { [provider]: { fullAccess: true } } }, limits: { minutes: 10 } };
    validateRouting(run.config, provider);
    const route = routeFor(run, phase);
    const { args } = invocation(provider, { ...opts, config: { ...route.config, command: 'fixture' }, readOnly: phase !== 'develop' });
    if (provider === 'codex') {
      assert.equal(value(args, '--sandbox'), 'danger-full-access');
      assert.ok(args.includes('approval_policy="never"'));
    } else {
      assert.equal(value(args, '--permission-mode'), 'bypassPermissions');
      assert.equal(value(args, '--tools'), 'default');
      assert.deepEqual(JSON.parse(value(args, '--settings')), { sandbox: { enabled: false } });
      assert.ok(args.includes('--strict-mcp-config'));
    }
  }
});

test('omitted and false fullAccess retain native defaults, including research tools', () => {
  for (const fullAccess of [undefined, false]) for (const readOnly of [true, false]) {
    const config = { command: 'fixture', ...(fullAccess === undefined ? {} : { fullAccess }) };
    const codex = invocation('codex', { ...opts, config, readOnly }).args;
    assert.equal(value(codex, '--sandbox'), readOnly ? 'read-only' : 'workspace-write');
    assert.ok(!codex.includes('approval_policy="never"'));
    const claude = invocation('claude', { ...opts, config, readOnly, research: true }).args;
    assert.equal(value(claude, '--permission-mode'), 'auto');
    assert.equal(value(claude, '--tools'), readOnly ? 'Read,Grep,Glob,WebSearch,WebFetch' : 'Read,Write,Edit,Bash,PowerShell,Grep,Glob');
    assert.ok(!claude.includes('--settings'));
  }
});

test('invalid access settings fail instead of treating strings as consent', () => {
  for (const fullAccess of ['true', 1, null, {}, []]) {
    assert.throws(() => validateRouting({ provider: { fullAccess } }), /fullAccess/);
    assert.throws(() => validateRouting({ providers: { claude: { fullAccess } } }), /fullAccess/);
  }
  assert.throws(() => routeFor({ provider: 'custom', config: { provider: { fullAccess: true } }, limits: { minutes: 10 } }, 'develop'), /custom executor permissions/);
});

test('provider access cannot leak across a mixed route and explicit false overrides legacy settings', () => {
  const run = { provider: 'codex', config: { provider: { fullAccess: true }, providers: { codex: { fullAccess: false } }, routes: { review: { provider: 'claude' } } }, limits: { minutes: 10 } };
  assert.equal(routeFor(run, 'develop').config.fullAccess, false);
  assert.equal(routeFor(run, 'review').config.fullAccess, undefined);
});

test('explicit full access also applies to local Codex without enabling web search', () => {
  const args = invocation('codex', { ...opts, config: { command: 'fixture', localProvider: 'ollama', fullAccess: true }, readOnly: true, research: true }).args;
  assert.equal(value(args, '--sandbox'), 'danger-full-access');
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('--oss'));
  assert.ok(!args.includes('--search'));
});

const task = { id: 'T1', title: 'Return two', criteria: ['value equals 2'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [], checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }] };
const response = status => ({ code: 0, result: { status, summary: 'Fixture', findings: [] } });
function repo(name, extraConfig = {}) {
  const root = join(owned, name); mkdirSync(root);
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'], ['add', '--', 'value.mjs', '.gitignore'], ['commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  createRun(root, { goal: 'Return two', provider: 'codex', config: { providers: { codex: { fullAccess: true }, claude: { fullAccess: true } }, routes: { review: { provider: 'claude' } }, ...extraConfig } });
  return root;
}

test('full access reaches all phases while controller checks and independent approval remain required', async () => {
  const root = repo('success'), phases = [];
  const run = await drive(root, { log: () => {}, providerCall: async (provider, options) => {
    const phase = JSON.parse(options.text).phase; phases.push(phase);
    assert.equal(options.config.fullAccess, true);
    if (phase === 'plan') return { code: 0, result: { decisions: [], tasks: [task] } };
    if (phase === 'develop') writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    if (phase === 'review') {
      assert.equal(provider, 'claude');
      assert.match(options.prompt, /Full access is enabled/);
      assert.doesNotMatch(options.prompt, /Your sandbox is read-only/);
      assert.match(options.prompt, /Do not edit project files/);
    }
    return response(phase === 'review' ? 'approve' : 'ready_for_validation');
  } });
  assert.deepEqual(phases, ['plan', 'develop', 'review']);
  assert.equal(run.status, 'done');
  assert.equal(run.tasks[0].validation[0].passed, true);
});

test('full access does not turn reviewer source edits into independent approval', async () => {
  const root = repo('review-edit');
  const run = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    const phase = JSON.parse(options.text).phase;
    if (phase === 'plan') return { code: 0, result: { decisions: [], tasks: [task] } };
    writeFileSync(join(root, 'value.mjs'), `export const value = ${phase === 'review' ? 3 : 2};\n`);
    return response(phase === 'review' ? 'approve' : 'ready_for_validation');
  } });
  assert.equal(run.status, 'blocked');
  assert.match(run.failure, /read-only|modified|changed/i);
  assert.match(readFileSync(join(root, 'value.mjs'), 'utf8'), /value = 3/);
});

test('full access cannot replace a declared acceptance baseline', async () => {
  const root = repo('protected', { protectedFiles: ['value.mjs'] }); let calls = 0;
  const run = await drive(root, { log: () => {}, providerCall: async (_, options) => {
    calls++;
    if (JSON.parse(options.text).phase === 'plan') return { code: 0, result: { decisions: [], tasks: [task] } };
    writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    return response('ready_for_validation');
  } });
  assert.equal(run.status, 'blocked');
  assert.match(run.failure, /Protected file.*value\.mjs/);
  assert.equal(calls, 2);
  assert.match(readFileSync(join(root, 'value.mjs'), 'utf8'), /value = 2/);
});

test('restricted access reaches workers with caller protections and still requires controller validation and review', async () => {
  const root = repo('restricted', { providers: { codex: { fullAccess: true }, claude: { writePolicy: 'restricted' } }, protectedFiles: ['.gitignore'] });
  const calls = [];
  const run = await drive(root, { log: () => {}, providerCall: async (provider, options) => {
    const phase = JSON.parse(options.text).phase; calls.push(phase);
    assert.deepEqual(options.protectedPaths, ['.gitignore']);
    if (phase === 'plan') return { code: 0, result: { decisions: [], tasks: [task] } };
    if (phase === 'develop') writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
    if (phase === 'review') {
      assert.equal(provider, 'claude'); assert.equal(options.config.writePolicy, 'restricted');
      assert.match(options.prompt, /Restricted write policy: no shell/);
      assert.doesNotMatch(options.prompt, /scratch space outside the project|Your sandbox is read-only/);
    }
    return { ...response(phase === 'review' ? 'approve' : 'ready_for_validation'), access: { policy: phase === 'review' ? 'restricted' : 'fullAccess', scratch: 'fixture-scratch' } };
  } });
  assert.deepEqual(calls, ['plan', 'develop', 'review']); assert.equal(run.status, 'done');
  assert.ok(run.tasks[0].validation.every(check => check.passed));
  const usage = readFileSync(join(root, '.forja/runs', run.run_id, 'usage.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(usage.some(entry => entry.phase === 'review' && entry.access?.policy === 'restricted'));
});
