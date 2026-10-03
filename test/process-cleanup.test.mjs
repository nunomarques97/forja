import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { execute } from '../lib/core/providers.mjs';
import { treeTracker, cleanupTree, processCleanupNote } from '../lib/core/process-tree.mjs';
import { createRun, drive, current } from '../lib/core/engine.mjs';

const cli = resolve('bin/forja.mjs');
// Fast snapshots and a short grace period keep the tests bounded.
const tree = { pollMs: 250, graceMs: 300 };

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
// Processes started by these tests are always ended, whatever the assertion.
const reap = (t, pid) => t.after(() => { if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {} });
async function gone(pid, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (!alive(pid)) return true;
  return !alive(pid);
}

const sleeper = "setTimeout(() => {}, 120000)";
// Starts a long-sleeping child that outlives this process, prints its PID and
// exits after `stay` ms (the child keeps no handle on the parent's pipes). On
// Windows only a detached child outlives a Node parent; on POSIX a detached
// child would leave the process group, which a worker could also do.
const launcher = stay => `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(sleeper)}], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' }); c.unref(); console.log('GRANDCHILD ' + c.pid); setTimeout(() => {}, ${stay});`;
const grandchildOf = stdout => Number(/GRANDCHILD (\d+)/.exec(stdout)?.[1]);

test('a grandchild left behind by an exited process is terminated, and an unrelated process survives', async t => {
  const unrelated = spawn(process.execPath, ['-e', sleeper], { stdio: 'ignore', windowsHide: true });
  reap(t, unrelated.pid);
  const out = await execute(process.execPath, ['-e', launcher(0)], { timeoutMs: 60000, processTree: tree });
  const pid = grandchildOf(out.stdout);
  assert.ok(Number.isSafeInteger(pid), out.stdout + out.stderr);
  reap(t, pid);
  assert.equal(out.code, 0);
  assert.ok(await gone(pid), `grandchild ${pid} still running`);
  assert.deepEqual(out.processCleanup.survivors, []);
  assert.ok(out.processCleanup.terminated.includes(pid));
  assert.equal(out.processCleanup.error, null);
  assert.ok(alive(unrelated.pid), 'a process not started through execute() must survive');
  assert.ok(!out.processCleanup.terminated.includes(unrelated.pid));
});

test('after a timeout the orphan of an exited intermediate process is terminated too', async t => {
  // root -> middle (starts the grandchild, lives long enough to be observed, exits) ; root keeps sleeping.
  const root = `const m = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(launcher(2500))}], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); m.stdout.pipe(process.stdout); setTimeout(() => {}, 120000);`;
  const out = await execute(process.execPath, ['-e', root], { timeoutMs: 6000, processTree: tree });
  const pid = grandchildOf(out.stdout);
  assert.ok(Number.isSafeInteger(pid), out.stdout + out.stderr);
  reap(t, pid);
  assert.equal(out.timedOut, true);
  assert.ok(await gone(pid), `grandchild ${pid} still running after the timeout`);
  assert.deepEqual(out.processCleanup.survivors, []);
});

test('a process that cleanup cannot end is reported with its PID, and the session result is kept', async t => {
  const out = await execute(process.execPath, ['-e', launcher(0)], { timeoutMs: 60000, processTree: { ...tree, terminate: () => {} } });
  const pid = grandchildOf(out.stdout);
  reap(t, pid);
  assert.equal(out.code, 0);
  assert.match(out.stdout, /GRANDCHILD/);
  assert.ok(alive(pid));
  assert.deepEqual(out.processCleanup.survivors, [pid]);
  assert.deepEqual(out.processCleanup.terminated, []);
  assert.match(processCleanupNote(out.processCleanup), new RegExp(`PID ${pid}\\b`));

  const failed = await execute(process.execPath, ['-e', launcher(0)], { timeoutMs: 60000, processTree: { ...tree, terminate: () => { throw new Error('access denied'); } } });
  const other = grandchildOf(failed.stdout);
  reap(t, other);
  assert.equal(failed.code, 0);
  assert.match(failed.stdout, /GRANDCHILD/);
  assert.equal(failed.processCleanup.error, 'access denied');
  assert.deepEqual(failed.processCleanup.survivors, [other]);
  assert.match(processCleanupNote(failed.processCleanup), /could not complete: access denied/);
});

test('when no snapshot answers, the descendants last seen alive are reported as survivors', async () => {
  let closed = false;
  const source = {
    method: 'process_tree',
    known: () => [{ pid: 4242, created: 'x' }, { pid: 4343, created: 'y' }],
    snapshot: async () => { throw new Error('process snapshot stopped unexpectedly'); },
    kill: async () => { throw new Error('not reached'); },
    close: () => { closed = true; },
  };
  const report = await cleanupTree(source, { grace: 0 });
  assert.deepEqual(report.survivors, [4242, 4343]);
  assert.deepEqual(report.terminated, []);
  assert.equal(report.error, 'process snapshot stopped unexpectedly');
  assert.ok(closed);
  assert.match(processCleanupNote(report), /PID 4242, 4343\b.*could not complete/);
});

// The operator's Ctrl+C reaches every process of the console, so the snapshot
// watcher can end before the session does; cleanup then uses one replacement.
test('cleanup still ends the tree after the process snapshot watcher was lost', { skip: process.platform !== 'win32' && 'Windows watcher only' }, async t => {
  const watchers = () => {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true });
    return r.stdout.split(/\s+/).filter(Boolean).map(Number);
  };
  let lost = [];
  const out = await execute(process.execPath, ['-e', launcher(6000)], {
    timeoutMs: 60000, processTree: tree,
    onStdoutLine: line => {
      if (!/GRANDCHILD/.test(line)) return;
      // This test process started the watcher, so it may end it.
      lost = watchers();
      for (const pid of lost) process.kill(pid);
    },
  });
  const pid = grandchildOf(out.stdout);
  assert.ok(Number.isSafeInteger(pid), out.stdout + out.stderr);
  reap(t, pid);
  assert.equal(lost.length, 1, `watchers found: ${lost}`);
  assert.equal(out.code, 0);
  assert.ok(await gone(pid), `grandchild ${pid} still running`);
  assert.deepEqual(out.processCleanup.survivors, []);
  assert.ok(out.processCleanup.terminated.includes(pid));
  assert.equal(out.processCleanup.error, null);
});

// CIM datetimes in UTC (+000) for synthetic snapshots.
const at = ms => {
  const d = new Date(ms), p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000+000`;
};

test('tracking follows only proven descendants: no PID reuse, no older processes', () => {
  const t0 = Date.UTC(2026, 9, 3, 12, 0, 0);
  // spawnedAt is taken after spawn() returned, so the root is created before it.
  const tracker = treeTracker(100, t0 + 10);
  const first = tracker.observe([
    { pid: 100, ppid: 1, created: at(t0 + 5) },
    { pid: 200, ppid: 100, created: at(t0 + 100) },
    { pid: 300, ppid: 200, created: at(t0 + 200) },
    // Its parent PID matches the root, but it is older than the root: not ours.
    { pid: 400, ppid: 100, created: at(t0 - 60000) },
    { pid: 500, ppid: 9, created: at(t0 + 300) },
  ], t0 + 1000);
  assert.deepEqual(first.map(p => p.pid).sort(), [200, 300]);
  // 200 exits; 300 is an orphan whose parent is gone and is still tracked.
  tracker.exited(t0 + 2000);
  const second = tracker.observe([
    { pid: 300, ppid: 200, created: at(t0 + 200) },
    // PID 100 and 200 reused by unrelated processes, each with a child.
    { pid: 100, ppid: 9, created: at(t0 + 5000) },
    { pid: 600, ppid: 100, created: at(t0 + 6000) },
    { pid: 200, ppid: 9, created: at(t0 + 5500) },
    { pid: 700, ppid: 200, created: at(t0 + 7000) },
  ], t0 + 8000);
  assert.deepEqual(second.map(p => p.pid), [300]);
  // A reused PID 300 is not the tracked process 300.
  assert.deepEqual(tracker.observe([{ pid: 300, ppid: 9, created: at(t0 + 9000) }], t0 + 9500), []);
  assert.deepEqual(tracker.known(), []);
});

test('a vanished process is trusted only up to the last snapshot that contained it', () => {
  const t0 = Date.UTC(2026, 9, 3, 12, 0, 0);
  const tracker = treeTracker(100, t0 + 10);
  assert.deepEqual(tracker.observe([{ pid: 100, ppid: 1, created: at(t0 + 5) }, { pid: 200, ppid: 100, created: at(t0 + 100) }], t0 + 1000).map(p => p.pid), [200]);
  // Between snapshots 200 exits, an unrelated process reuses PID 200 at t0+1600,
  // starts 700 at t0+1700 and exits before the next snapshot: 700 is not ours.
  assert.deepEqual(tracker.observe([{ pid: 100, ppid: 1, created: at(t0 + 5) }, { pid: 700, ppid: 200, created: at(t0 + 1700) }], t0 + 4000), []);
  // A child created while its parent is still listed is proven once a later
  // snapshot shows the parent alive after the child's creation.
  const other = treeTracker(100, t0 + 10);
  other.observe([{ pid: 100, ppid: 1, created: at(t0 + 5) }, { pid: 200, ppid: 100, created: at(t0 + 100) }], t0 + 1000);
  const snap = [{ pid: 100, ppid: 1, created: at(t0 + 5) }, { pid: 200, ppid: 100, created: at(t0 + 100) }, { pid: 800, ppid: 200, created: at(t0 + 1500) }];
  assert.deepEqual(other.observe(snap, t0 + 2000).map(p => p.pid).sort(), [200, 800]);
  // Created during the snapshot itself (after it began): not proven yet.
  assert.deepEqual(other.observe([...snap, { pid: 900, ppid: 200, created: at(t0 + 3100) }], t0 + 3000).map(p => p.pid).sort(), [200, 800]);
  assert.deepEqual(other.known().map(p => p.pid).sort(), [200, 800]);
});

test('before the root is listed, only processes created after the spawn count as its children', () => {
  const t0 = Date.UTC(2026, 9, 3, 12, 0, 0);
  const tracker = treeTracker(100, t0 + 10);
  // The root already exited and is absent; a child of an earlier holder of PID
  // 100 created just before the spawn is not ours, a later child is.
  tracker.exited(t0 + 500);
  const seen = tracker.observe([
    { pid: 300, ppid: 100, created: at(t0 + 8) },
    { pid: 400, ppid: 100, created: at(t0 + 200) },
    { pid: 500, ppid: 100, created: at(t0 + 700) },
  ], t0 + 1000);
  assert.deepEqual(seen.map(p => p.pid), [400]);
  assert.equal(tracker.root.key, null);
});

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-cleanup-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']]) execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}

test('survivors of a failed provider call reach the ledger, the stop reason and core status', async t => {
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'custom', config: { maxAttempts: 1, maxRotations: 0, maxMinutes: 30 }, plan: { decisions: [], tasks: [{
    id: 'T1', title: 'Return two', criteria: ['value equals two'], files: ['value.mjs'], complexity: 'easy', risks: [], after: [],
    checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }],
  }] } });
  const cleanup = { method: 'process_tree', terminated: [41], survivors: [4242, 4343], error: null };
  const run = await drive(root, { log: () => {}, providerCall: async () => ({ code: 1, error: 'provider exited', processCleanup: cleanup }) });
  assert.equal(run.status, 'blocked');
  assert.match(run.failure, /still running after cleanup \(PID 4242, 4343\)/);
  const state = JSON.parse(readFileSync(current(root), 'utf8'));
  const ledger = readFileSync(join(root, '.forja', 'runs', state.run_id, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(ledger.at(-1).process_cleanup, cleanup);
  const status = JSON.parse(spawnSync(process.execPath, [cli, 'core', 'status'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout);
  assert.deepEqual(status.process_cleanup.survivors, [4242, 4343]);
  assert.equal(status.process_cleanup.phase, 'develop');
  assert.equal(status.process_cleanup.task, 'T1');
});
