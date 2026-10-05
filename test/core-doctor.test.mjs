import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { doctor, doctorWithLocal, localRouteChecks } from '../lib/core/doctor.mjs';
import { providerInstallation } from '../lib/core/providers.mjs';

test('doctor checks a clean fork without writing project files or invoking a provider', t => {
  const root = mkdtempSync(join(tmpdir(), 'forja-doctor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: root });
  const before = readdirSync(root);
  const found = [];
  const report = doctor(root, { provider: 'codex', config: { routes: { review: { provider: 'claude' } } }, inspectProvider: name => { found.push(name); return { provider: name, installed: true, note: 'Synthetic inspection' }; } });
  assert.equal(report.ready, true);
  assert.deepEqual(found, ['codex', 'claude']);
  assert.ok(report.checks.every(c => c.status === 'ok'));
  assert.deepEqual(readdirSync(root), before);
  writeFileSync(join(root, 'pending.txt'), 'User work');
  assert.equal(doctor(root, { inspectProvider: () => ({ provider: 'claude', installed: false }) }).ready, false);
  assert.equal(doctor(root, { inspectProvider: () => ({ provider: 'claude', installed: true }) }).checks.find(c => c.name === 'worktree').status, 'warning');
  const child = join(root, 'child'); mkdirSync(child);
  assert.equal(doctor(child, { inspectProvider: () => ({ provider: 'claude', installed: true }) }).checks.find(c => c.name === 'project').status, 'error');
  assert.equal(doctor(root, { config: { finalChecks: [{ command: '<runner>', args: [] }] }, inspectProvider: () => { throw Error('must not inspect with invalid config'); } }).ready, false);
});

test('provider installation only checks the executable; custom commands are not invoked', () => {
  const found = providerInstallation('codex', { command: process.execPath, args: ['--eval', 'throw Error("must not execute")'] });
  assert.equal(found.installed, true);
  assert.equal(found.context_guard, 'unavailable');
  assert.equal(providerInstallation('claude', { command: join(tmpdir(), 'forja-missing-executable-123.exe') }).installed, false);
  assert.equal(providerInstallation('custom').installed, null);
});

// #32: with delivery, doctor pre-scans the would-be run base (report only).
test('doctor reports pre-existing privacy findings of the run base with file and line when delivery is configured', t => {
  const root = mkdtempSync(join(tmpdir(), 'forja-doctor-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'CLAUDE.md'), '# Notes\n\nClone into ' + ['', 'Users', 'someone', 'repo'].join('/') + '\n');
  writeFileSync(join(root, '.env.example'), 'API_KEY=\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: root });
  const inspectProvider = name => ({ provider: name, installed: true, note: 'Synthetic inspection' });
  const before = readdirSync(root);
  const report = doctor(root, { config: { delivery: { mode: 'commit' } }, inspectProvider });
  const check = report.checks.find(c => c.name === 'base_scan');
  assert.equal(check.status, 'warning');
  assert.match(check.detail, /already has 1 privacy-scan finding\(s\): CLAUDE\.md:3 personal home path\. They are reported, not approved/);
  assert.deepEqual(report.base_scan.findings, [{ path: 'CLAUDE.md', reason: 'personal home path', line: 3 }]);
  assert.equal(report.ready, true, 'a pre-existing finding is reported, not a readiness error');
  assert.deepEqual(readdirSync(root), before);
  const plain = doctor(root, { inspectProvider });
  assert.equal(plain.checks.find(c => c.name === 'base_scan'), undefined);
  assert.equal(plain.base_scan, undefined);
  writeFileSync(join(root, 'CLAUDE.md'), '# Notes\n');
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qam', 'Clean'], { cwd: root });
  const clean = doctor(root, { config: { delivery: { mode: 'commit' } }, inspectProvider }).checks.find(c => c.name === 'base_scan');
  assert.equal(clean.status, 'ok');
  assert.match(clean.detail, /found nothing in 3 tracked file\(s\)/);
});
test('doctor reports Ollama reachability and the models of configured local routes without invoking a model', async t => {
  const root = mkdtempSync(join(tmpdir(), 'forja-doctor-local-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const inspectProvider = name => ({ provider: name, installed: true, note: 'Synthetic inspection' });
  const kilo = model => ({ provider: 'kilo', localProvider: 'ollama', model });
  const config = { maxCloudSessions: 0, routes: { plan: kilo('coder:32k'), develop: kilo('coder:32k'), review: kilo('small:8b') } };
  const server = ({ down = false, shows = {} } = {}) => {
    const urls = [];
    const request = async (url, init = {}) => {
      urls.push(url);
      if (down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      const data = url.endsWith('/api/tags') ? { models: [{ name: 'coder:32k' }, { name: 'small:8b' }] } : shows[JSON.parse(init.body).model];
      return { ok: true, status: 200, json: async () => data };
    };
    return { request, urls };
  };
  const ready = server({ shows: { 'coder:32k': { capabilities: ['tools'], parameters: 'num_ctx 32768' }, 'small:8b': { capabilities: ['tools'], parameters: 'temperature 0.6' } } });
  const report = await doctorWithLocal(root, { provider: 'claude', config, inspectProvider, request: ready.request });
  const check = name => report.checks.find(c => c.name === name);
  assert.equal(check('ollama').status, 'ok');
  assert.match(check('ollama').detail, /reachable at http:\/\/127\.0\.0\.1:11434 with 2 installed model/);
  assert.equal(check('ollama:coder:32k').status, 'ok');
  assert.match(check('ollama:coder:32k').detail, /^Routes plan, develop: .*num_ctx 32768\. Not loaded or invoked\./);
  assert.equal(check('ollama:small:8b').status, 'error');
  assert.match(check('ollama:small:8b').detail, /^Route review: .*num_ctx of at least 16384/);
  assert.equal(report.ready, false);
  assert.ok(ready.urls.every(url => /^http:\/\/127\.0\.0\.1:11434\/api\/(tags|show)$/.test(url)), 'only listing and metadata, never a model call');
  const down = server({ down: true });
  const offline = await doctorWithLocal(root, { config, inspectProvider, request: down.request });
  assert.deepEqual(offline.checks.filter(c => c.name.startsWith('ollama')).map(c => c.status), ['error']);
  assert.match(offline.checks.at(-1).detail, /unavailable .*ECONNREFUSED.*fall back to cloud/);
  // Without local routes Ollama is not probed.
  const cloud = server();
  assert.deepEqual(await localRouteChecks({ routes: { develop: { provider: 'claude' } } }, { request: cloud.request }), []);
  assert.equal((await doctorWithLocal(root, { config: { routes: { develop: { provider: 'claude' } } }, inspectProvider, request: cloud.request })).checks.some(c => c.name.startsWith('ollama')), false);
  assert.deepEqual(cloud.urls, []);
});
