import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { doctor } from '../lib/core/doctor.mjs';
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
