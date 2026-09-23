import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateCheckIsolation, checkSnapshot, isolatedCheck, preflightCheckIsolation } from '../lib/core/check-isolation.mjs';
import { createRun, drive } from '../lib/core/engine.mjs';
import { execute } from '../lib/core/providers.mjs';
import { fileURLToPath } from 'node:url';

const roots = [];
after(() => { for (const root of roots) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true, force: true }); } });
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'forja-check-test-')); roots.push(root);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']])
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  writeFileSync(join(root, '.gitignore'), '.forja/\nignored/\n');
  writeFileSync(join(root, 'source.py'), 'value = 1\n');
  assert.equal(spawnSync('git', ['add', '--', '.gitignore', 'source.py'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root }).status, 0);
  return root;
}

test('isolation configuration is opt-in, strict and platform specific', () => {
  assert.equal(validateCheckIsolation({}), null);
  assert.ok(validateCheckIsolation({ checkIsolation: { backend: 'bubblewrap' } }, 'linux'));
  assert.ok(validateCheckIsolation({ checkIsolation: { backend: 'bubblewrap', distribution: 'Ubuntu-24.04' } }, 'win32'));
  for (const value of [null, false, 'bubblewrap', {}, { backend: 'host' }, { backend: 'bubblewrap', args: ['--share-net'] }])
    assert.throws(() => validateCheckIsolation({ checkIsolation: value }, 'linux'));
  assert.throws(() => validateCheckIsolation({ checkIsolation: { backend: 'bubblewrap' } }, 'win32'));
  assert.throws(() => validateCheckIsolation({ checkIsolation: { backend: 'bubblewrap', distribution: '--exec' } }, 'win32'));
  assert.throws(() => validateCheckIsolation({ checkIsolation: { backend: 'bubblewrap', distribution: 'Ubuntu' } }, 'linux'));
  assert.throws(() => validateCheckIsolation({ checkIsolation: { backend: 'bubblewrap' } }, 'darwin'));
});

test('snapshot includes new sources but excludes ignored state and severs hardlinks', () => {
  const root = repo();
  mkdirSync(join(root, 'ignored')); writeFileSync(join(root, 'ignored', 'private.txt'), 'private');
  mkdirSync(join(root, '.forja')); writeFileSync(join(root, '.forja', 'current.json'), 'private');
  writeFileSync(join(root, 'new.py'), 'new source');
  linkSync(join(root, 'source.py'), join(root, 'linked.py'));
  const copy = checkSnapshot(root);
  try {
    assert.equal(copy.manifest.files, 4);
    assert.match(copy.manifest.sha256, /^[a-f0-9]{64}$/);
    for (const path of ['ignored', '.forja', '.git']) assert.equal(existsSync(join(copy.workspace, path)), false);
    assert.equal(readFileSync(join(copy.workspace, 'new.py'), 'utf8'), 'new source');
    writeFileSync(join(copy.workspace, 'linked.py'), 'copied inode');
    assert.equal(readFileSync(join(root, 'source.py'), 'utf8'), 'value = 1\n');
  } finally { copy.cleanup(); }
  assert.equal(existsSync(copy.workspace), false);
});

test('snapshot refuses directory junctions instead of exposing their targets', () => {
  const root = repo(), external = repo();
  symlinkSync(external, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => checkSnapshot(root), /Symlink|symbolic|regular|Unsupported path/);
});

test('snapshot rejects oversized input before allocation', () => {
  const root = repo();
  writeFileSync(join(root, 'large.bin'), Buffer.alloc(64 * 1024 * 1024));
  assert.throws(() => checkSnapshot(root), /64 MiB/);
});

const enabled = process.env.FORJA_TEST_CHECK_ISOLATION;
const config = { checkIsolation: { backend: 'bubblewrap', ...(process.platform === 'win32' ? { distribution: enabled || 'Ubuntu' } : {}) } };
const nativeOptions = { skip: !enabled && 'Set FORJA_TEST_CHECK_ISOLATION to the WSL distro (Windows) or 1 (Linux).' };

test('real sandbox denies host/state/source writes, network and privilege expansion while allowing scratch', nativeOptions, async () => {
  const root = repo();
  mkdirSync(join(root, '.forja')); writeFileSync(join(root, '.forja', 'current.json'), 'original-state');
  mkdirSync(join(root, 'ignored')); writeFileSync(join(root, 'ignored', 'private.txt'), 'private');
  const script = `import os, pathlib, socket, subprocess\nassert not pathlib.Path('/workspace/.forja').exists()\nassert not pathlib.Path('/workspace/.git').exists()\nassert not pathlib.Path('/workspace/ignored').exists()\nassert not pathlib.Path('/mnt/c').exists()\nassert 'WSL_INTEROP' not in os.environ\nassert 'FORJA_TEST_SECRET' not in os.environ\nfor p in ['/workspace/source.py', '/workspace/.forja/current.json', '/outside', '/usr/forja-escape']:\n try: pathlib.Path(p).write_text('escape')\n except OSError: pass\n else: raise AssertionError(p)\npathlib.Path('/tmp/scratch').write_text('allowed')\nassert pathlib.Path('/tmp/scratch').read_text() == 'allowed'\ns = socket.socket(); s.settimeout(.3)\nassert s.connect_ex(('192.0.2.1', 80)) != 0\ns.close()\nassert subprocess.run(['/usr/bin/unshare', '-Ur', '/usr/bin/true'], capture_output=True).returncode != 0\nprint('denials and scratch verified')\n`;
  writeFileSync(join(root, 'probe.py'), script);
  await preflightCheckIsolation(config);
  process.env.FORJA_TEST_SECRET = 'fixture-private-value';
  try {
    const result = await isolatedCheck('python3', ['probe.py'], { cwd: root, config, timeoutMs: 5000 });
    assert.equal(result.code, 0, result.stderr); assert.equal(result.timedOut, false);
    assert.match(result.stdout, /denials and scratch verified/);
    assert.equal(result.isolation.source, 'read-only');
    assert.equal(readFileSync(join(root, '.forja', 'current.json'), 'utf8'), 'original-state');
    assert.equal(readFileSync(join(root, 'source.py'), 'utf8'), 'value = 1\n');
  } finally { delete process.env.FORJA_TEST_SECRET; }
});

test('real sandbox kills detached descendants on exit and deadline; output flood fails', nativeOptions, async () => {
  const root = repo();
  for (const timeout of [false, true]) {
    const marker = `forja-descendant-${randomUUID()}`;
    writeFileSync(join(root, 'process.py'), `import subprocess, time\nsubprocess.Popen(['${marker}', '-c', 'import time; time.sleep(60)'], executable='/usr/bin/python3', start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n${timeout ? 'time.sleep(60)' : 'print("parent done")'}\n`);
    const result = await isolatedCheck('python3', ['process.py'], { cwd: root, config, timeoutMs: timeout ? 500 : 5000 });
    assert.equal(result.timedOut, timeout, result.stderr);
    if (!timeout) assert.equal(result.code, 0, result.stderr);
    const command = process.platform === 'win32' ? 'wsl.exe' : '/usr/bin/pgrep';
    const args = [...(process.platform === 'win32' ? ['-d', enabled, '--', '/usr/bin/pgrep'] : []), '-f', `^${marker}`];
    assert.equal(spawnSync(command, args).status, 1, 'sandbox descendant survived');
  }
  writeFileSync(join(root, 'flood.py'), 'import os\nwhile True: os.write(1, b"x" * 65536)\n');
  const flood = await isolatedCheck('python3', ['flood.py'], { cwd: root, config, timeoutMs: 5000 });
  assert.equal(flood.overflow, true); assert.notEqual(flood.code, 0);
});

test('Core uses isolation for acceptance and stale final checks without invoking the host check hook', nativeOptions, async () => {
  const root = repo();
  writeFileSync(join(root, 'test_source.py'), 'from source import value\nassert value == 2\n');
  writeFileSync(join(root, 'test_other.py'), 'from other import value\nassert value == 3\n');
  const task = (id, file, testFile, after) => ({ id, title: `Implement ${file}`, criteria: ['Expected value passes the check'], files: [file], risks: [], complexity: 'easy', after, checks: [{ command: 'python3', args: [testFile] }] });
  createRun(root, { goal: 'Exercise isolated controller checks', provider: 'custom', config: { ...config, allowDirty: true }, plan: { decisions: [], tasks: [task('T1', 'source.py', 'test_source.py', []), task('T2', 'other.py', 'test_other.py', ['T1'])] } });
  const result = await drive(root, {
    log: () => {}, runCheck: () => { throw new Error('host execution forbidden'); },
    providerCall: async (_, ctx) => {
      const packet = JSON.parse(ctx.text);
      if (!ctx.readOnly) writeFileSync(join(root, packet.task.id === 'T1' ? 'source.py' : 'other.py'), `value = ${packet.task.id === 'T1' ? 2 : 3}\n`);
      return { code: 0, result: { status: ctx.readOnly ? 'approve' : 'ready_for_validation', summary: 'Synthetic worker fixture', findings: [] } };
    },
  });
  assert.equal(result.status, 'done', result.failure);
  for (const task of result.tasks) assert.equal(task.validation[0].isolation.backend, 'bubblewrap');
  assert.equal(result.tasks[0].finalValidation[0].isolation.backend, 'bubblewrap');
});

test('missing isolated executable fails without running a host command', nativeOptions, async () => {
  const root = repo();
  const result = await isolatedCheck('forja-command-that-does-not-exist', [], { cwd: root, config, timeoutMs: 5000 });
  assert.notEqual(result.code, 0);
});

test('disconnecting the Windows WSL client does not leave the Linux command alive', { skip: !enabled || process.platform !== 'win32' }, async () => {
  const marker = `forja-descendant-${randomUUID()}`;
  const runner = fileURLToPath(new URL('../lib/core/check-runner.py', import.meta.url));
  const linuxPath = spawnSync('wsl.exe', ['-d', enabled, '--exec', '/usr/bin/wslpath', '-a', '-u', runner], { encoding: 'utf8' });
  assert.equal(linuxPath.status, 0);
  const payload = { snapshot: null, timeout_ms: 10000, command: '/usr/bin/python3', args: ['-c', `import os; os.execv('/usr/bin/python3', ['${marker}', '-c', 'import time; time.sleep(30)'])`] };
  const result = await execute('wsl.exe', ['-d', enabled, '--exec', '/usr/bin/python3', '-I', '-B', linuxPath.stdout.trim()], { input: JSON.stringify(payload), timeoutMs: 1000 });
  assert.equal(result.timedOut, true);
  // Bounded allowance for pipe teardown, independent of the inner 10s deadline.
  const until = Date.now() + 2000;
  let probe;
  do {
    probe = spawnSync('wsl.exe', ['-d', enabled, '--', '/usr/bin/pgrep', '-f', `^${marker}`]);
    if (probe.status === 1) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  assert.equal(probe.status, 1, 'Linux command survived client disconnect');
});
