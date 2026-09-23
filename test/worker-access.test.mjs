import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { invocation, runProvider } from '../lib/core/providers.mjs';
import { validateRouting, routeFor } from '../lib/core/routing.mjs';
import { restrictedSettings, workerAccessPrompt } from '../lib/core/worker-access.mjs';

const root = mkdtempSync(join(tmpdir(), 'forja-access-test-'));
const owned = [root];
after(() => { for (const path of owned) { assert.ok(resolve(path).startsWith(resolve(tmpdir()) + sep)); rmSync(path, { recursive: true, force: true }); } });
const schemaPath = join(root, 'schema.json'), mcpPath = join(root, 'mcp.json'), scratchPath = join(root, 'scratch');
writeFileSync(schemaPath, '{"type":"object"}'); writeFileSync(mcpPath, '{"mcpServers":{}}'); mkdirSync(scratchPath);
const options = { schemaPath, mcpPath, scratchPath, config: { command: 'fixture', writePolicy: 'restricted' }, protectedPaths: ['test/acceptance.test.mjs'] };
const value = (args, flag) => args[args.indexOf(flag) + 1];

test('restricted developer has file tools only, noninteractive denials and isolated configuration', () => {
  const args = invocation('claude', options).args;
  assert.ok(args.includes('--restricted')); assert.ok(args.includes('--safe-mode')); assert.ok(!args.includes('--bare'));
  assert.equal(value(args, '--permission-mode'), 'dontAsk');
  assert.equal(value(args, '--permission-prompts'), 'none');
  assert.equal(value(args, '--tools'), 'Read,Write,Edit,Grep,Glob');
  assert.equal(value(args, '--add-dir'), scratchPath);
  assert.equal(value(args, '--disallowedTools'), 'mcp__*');
  const settings = JSON.parse(value(args, '--settings'));
  assert.equal(settings.disableAllHooks, true);
  for (const path of ['.forja', '.git', '.claude', '.codex', 'test/acceptance.test.mjs']) assert.ok(settings.permissions.deny.includes(`Edit(./${path})`));
  assert.ok(!args.includes('bypassPermissions'));
});

test('restricted planning and review cannot edit or execute even with research enabled', () => {
  const args = invocation('claude', { ...options, readOnly: true, research: true }).args;
  assert.equal(value(args, '--tools'), 'Read,Grep,Glob');
  assert.equal(value(args, '--allowedTools'), 'Read,Grep,Glob');
  assert.doesNotMatch(workerAccessPrompt({ scratch: scratchPath, restricted: true, readOnly: true }), /Run targeted/);
});

test('restricted policies reject incompatible providers, privilege flags and argument injection', () => {
  for (const provider of ['codex', 'custom']) assert.throws(() => validateRouting({ provider: { writePolicy: 'restricted' } }, provider), /requires Claude/);
  for (const writePolicy of [null, false, {}, 'workspace']) assert.throws(() => validateRouting({ providers: { claude: { writePolicy } } }), /writePolicy/);
  for (const config of [{ fullAccess: true }, { args: ['--tools', 'default'] }, { args: ['--settings=unsafe.json'] }]) assert.throws(() => invocation('claude', { ...options, config: { ...options.config, ...config } }), /conflicts|refuses/);
  assert.throws(() => validateRouting({ provider: { fullAccess: true }, providers: { claude: { writePolicy: 'restricted' } } }), /conflicts/);
  assert.doesNotThrow(() => validateRouting({ provider: { fullAccess: true }, providers: { claude: { writePolicy: 'restricted', fullAccess: false } } }));
});

test('restricted settings preserve literal protected paths and reject traversal', () => {
  assert.ok(restrictedSettings(['test/[id]*?.mjs']).permissions.deny.includes('Edit(./test/\\[id\\]\\*\\?.mjs)'));
  for (const path of ['../outside', '/absolute', 'C:/drive', 'test/../outside', '.forja ', 'x\nvalue']) assert.throws(() => restrictedSettings([path]), /Invalid restricted/);
});

test('restricted mode refuses other MCP capabilities before invocation', () => {
  const other = join(root, 'other-mcp.json'); writeFileSync(other, '{"mcpServers":{"external":{"command":"fixture"}}}');
  assert.throws(() => invocation('claude', { ...options, mcpPath: other }), /empty MCP/);
  assert.throws(() => validateRouting({ providers: { claude: { writePolicy: 'restricted' } }, mcp: { mcpServers: { external: {} } } }), /empty MCP/);
  assert.throws(() => invocation('claude', { ...options, scratchPath: undefined }), /scratch directory/);
});

test('mixed routing does not impose a Claude policy on Codex', () => {
  const run = { provider: 'codex', config: { providers: { claude: { writePolicy: 'restricted' } }, routes: { review: { provider: 'claude' } } }, limits: { minutes: 1 } };
  assert.equal(routeFor(run, 'develop').config.writePolicy, undefined);
  assert.equal(routeFor(run, 'review').config.writePolicy, 'restricted');
});

test('unsupported native version stops before a model process and never falls back', async () => {
  // Node --version is deliberately not a Claude identity/version response.
  await assert.rejects(runProvider('claude', { ...options, cwd: root, config: { command: process.execPath, writePolicy: 'restricted' } }), /requires Claude Code/);
});

test('concurrent child processes get distinct real scratch directories and the parent environment stays intact', async () => {
  const fixture = join(root, 'child.mjs');
  writeFileSync(fixture, `import{writeFileSync}from'node:fs';import{join}from'node:path';let input='';for await(const s of process.stdin)input+=s;writeFileSync(join(process.env.TMPDIR,'proof.txt'),'owned');console.log(JSON.stringify({result:{status:'approve',summary:input,findings:[],vars:Object.fromEntries(['TMPDIR','TMP','TEMP','FORJA_SCRATCH_DIR'].map(k=>[k,process.env[k]]))}}));`);
  const before = Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map(k => [k, process.env[k]]));
  const results = await Promise.all([1, 2].map(i => runProvider('custom', { cwd: root, input: 'unchanged stdin', config: { command: process.execPath, args: [fixture] }, logPath: join(root, `log-${i}.json`), resultPath: join(root, `result-${i}.json`) })));
  for (const result of results) {
    owned.push(resolve(result.access.scratch, '..'));
    assert.equal(result.code, 0); assert.equal(result.result.summary, 'unchanged stdin');
    assert.ok(Object.values(result.result.vars).every(v => v === result.access.scratch));
    assert.equal(readFileSync(join(result.access.scratch, 'proof.txt'), 'utf8'), 'owned');
  }
  assert.notEqual(results[0].access.scratch, results[1].access.scratch);
  assert.deepEqual(Object.fromEntries(['TMPDIR', 'TMP', 'TEMP'].map(k => [k, process.env[k]])), before);
});
