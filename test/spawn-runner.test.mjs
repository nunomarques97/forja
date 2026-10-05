// lib/spawn-runner.mjs `defaultSpawnRunner` — the seam the viewer's Core decision
// resume and the guard use to launch a detached process. Every other test replaces
// it with a fake, so the real one (detached child, its own log file, `unref`, a
// command that does not exist) was never exercised. It is here, against a real
// child process; nothing in the viewer is imported for its side effects and no
// server is started. This file only imports lib/spawn-runner.mjs, never edits it.
// Since T-RUN-2 it also proves the property the whole run depends on: the child
// does not belong to the tree of whoever launched it (Windows).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSpawnRunner, launchCore, launchCoreQueue, DETACH_SCRIPT } from '../lib/spawn-runner.mjs';

const root = mkdtempSync(join(tmpdir(), 'forja-spawn-'));
after(() => rmSync(root, { recursive: true, force: true }));

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Polls a condition instead of guessing a delay: a detached child on Windows can
// take a second to start.
async function waitFor(fn, what, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let v; try { v = fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() > until) throw new Error(`timeout à espera de: ${what}`);
    await sleep(100);
  }
}
const readLog = p => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

describe('defaultSpawnRunner', () => {
  test('launches the command, returns its real pid, and creates the log file (and its folder) with stdout and stderr', async () => {
    const dir = join(root, 'ok');
    const marker = join(dir, 'filho.txt');
    const logPath = join(dir, 'ainda', 'nao', 'existe', 'spawn.log');
    const code = `const fs=require('fs');fs.mkdirSync(${JSON.stringify(dir)},{recursive:true});fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));console.log('olá do filho');console.error('erro do filho');`;
    const r = defaultSpawnRunner(process.execPath, ['-e', code], { logPath, env: process.env });
    assert.ok(Number.isInteger(r.pid) && r.pid > 0, `pid: ${r.pid}`);
    const written = await waitFor(() => existsSync(marker) && readFileSync(marker, 'utf8'), 'o filho escrever o ficheiro');
    assert.equal(written, String(r.pid), 'the pid returned is the pid of the process that really ran');
    await waitFor(() => readLog(logPath).includes('olá do filho') && readLog(logPath).includes('erro do filho'), 'stdout e stderr no log');
    assert.ok(existsSync(logPath), 'the log folder was created even though it did not exist');
  });

  test('the child is detached and unref\'d: the parent process exits without waiting for it', async () => {
    const dir = join(root, 'unref');
    const pidFile = join(dir, 'neto.pid');
    // A parent Node process that spawns a 60-second child through the real seam
    // and then has nothing left to do. With `unref` it exits at once; without it
    // it would stay alive for the whole minute.
    const parent = join(root, 'parent.mjs');
    const child = `const fs=require('fs');fs.mkdirSync(${JSON.stringify(dir)},{recursive:true});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},60000);`;
    writeFileSync(parent, [
      `import { defaultSpawnRunner } from ${JSON.stringify(new URL('../lib/spawn-runner.mjs', import.meta.url).href)};`,
      `const { pid } = defaultSpawnRunner(process.execPath, ['-e', ${JSON.stringify(child)}], { logPath: ${JSON.stringify(join(dir, 'spawn.log'))}, env: process.env });`,
      `console.log('pid=' + pid);`,
    ].join('\n'));
    const started = Date.now();
    const r = spawnSync(process.execPath, [parent], { encoding: 'utf8', timeout: 30_000 });
    const elapsed = Date.now() - started;
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /pid=\d+/);
    assert.ok(elapsed < 15_000, `o pai saiu em ${elapsed} ms, sem esperar pelo filho de 60 s`);
    // Clean up the grandchild: it is detached, so nothing else would.
    const pid = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'o neto escrever o pid'));
    try { process.kill(pid, 'SIGKILL'); } catch {}
  });

  test('a command that does not exist: no throw, a pid-less result, and the reason in the log', async () => {
    const logPath = join(root, 'falha', 'spawn.log');
    const r = defaultSpawnRunner(join(root, 'nao-existe-mesmo.exe'), ['--x'], { logPath, env: process.env });
    assert.ok(r && typeof r === 'object', 'returns a result instead of throwing');
    const line = await waitFor(() => { const t = readLog(logPath); return t.includes('spawn falhou') ? t : false; }, 'a linha de falha no log');
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z spawn falhou: /m);
    assert.equal(/nao-existe-mesmo/.test(line) || /ENOENT/.test(line), true, 'the log says what failed');
    // The 'error' listener is what keeps the failure from throwing inside the
    // viewer's request handler: give the event loop a turn and stay alive.
    await sleep(50);
    assert.ok(true, 'the process survived the failed spawn');
  });
});

// The 17 set 2026 incident (05:15:22Z): `forja down` stopped the viewer and, in
// the same millisecond, the two runners started from the phone and their
// `claude -p` sessions — on Windows `detached` does not take a child out of the
// tree that `taskkill /T` walks. These two tests are that incident.
describe('the runner leaves the caller\'s process tree (T-RUN-2)', () => {
  const alive = pid => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(` ${pid} `);
  const parentOf = pid => spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`], { encoding: 'utf8' }).stdout.trim();

  test('the immediate parent of the runner is not the process that launched it', async () => {
    const dir = join(root, 'fora-da-arvore');
    const marker = join(dir, 'vivo.txt');
    const code = `const fs=require('fs');fs.mkdirSync(${JSON.stringify(dir)},{recursive:true});fs.writeFileSync(${JSON.stringify(marker)},'1');setTimeout(function(){},60000);`;
    const { pid } = defaultSpawnRunner(process.execPath, ['-e', code], { logPath: join(dir, 'spawn.log'), env: process.env });
    await waitFor(() => existsSync(marker), 'o runner arrancar');
    try {
      assert.equal(alive(pid), true, 'the runner is running');
      const ppid = parentOf(pid);
      assert.match(ppid, /^\d+$/, `ParentProcessId legível: ${ppid}`);
      assert.notEqual(ppid, String(process.pid), 'o pai do runner não é quem o lançou — está fora da sua árvore');
    } finally { spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8' }); }
  });

  test('the caller\'s whole tree is killed (taskkill /T, what `forja down` does) and the runner survives', async () => {
    const dir = join(root, 'sobrevive');
    const pidFile = join(dir, 'runner.pid');
    const caller = join(root, 'caller.mjs');
    const runner = `const fs=require('fs');fs.mkdirSync(${JSON.stringify(dir)},{recursive:true});fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(function(){},60000);`;
    // A stand-in for the viewer: launches the runner through the real seam and
    // stays alive, like a server would.
    writeFileSync(caller, [
      `import { defaultSpawnRunner } from ${JSON.stringify(new URL('../lib/spawn-runner.mjs', import.meta.url).href)};`,
      `defaultSpawnRunner(process.execPath, ['-e', ${JSON.stringify(runner)}], { logPath: ${JSON.stringify(join(dir, 'spawn.log'))}, env: process.env });`,
      `setTimeout(function(){}, 60000);`,
    ].join('\n'));
    const callerProc = spawn(process.execPath, [caller], { stdio: 'ignore', windowsHide: true });
    const runnerPid = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'o runner escrever o pid'));
    try {
      assert.equal(alive(callerProc.pid), true, 'the caller is up');
      spawnSync('taskkill', ['/PID', String(callerProc.pid), '/T', '/F'], { encoding: 'utf8' });
      await waitFor(() => !alive(callerProc.pid), 'o chamador morrer');
      await sleep(1000); // give the tree walk time to reach a child, if it had one
      assert.equal(alive(runnerPid), true, 'o runner continua vivo depois de a árvore do chamador ser morta');
    } finally { spawnSync('taskkill', ['/PID', String(runnerPid), '/F', '/T'], { encoding: 'utf8' }); }
  });
});

// launchCore (lib/spawn-runner.mjs): the guard's only way into a Core run. It
// resumes a running run whose controller died, or a due usage-limit wait of the
// same run_id; every other blocked run is refused before anything is spawned.
describe('launchCore and the usage-limit wait', () => {
  const RUN = 'F-1791068167545-6aaf68';
  const MIN = 60_000;
  // Fixed instant passed to launchCore: due or not is judged against it, never
  // against how long the test took.
  const T0 = Date.parse('2026-10-04T03:00:00.000Z');
  const project = (state, lock = null) => {
    const path = mkdtempSync(join(root, 'core-'));
    mkdirSync(join(path, '.forja'), { recursive: true });
    writeFileSync(join(path, '.forja', 'current.json'), JSON.stringify({ version: 1, run_id: RUN, status: 'blocked', provider: 'claude', goal: 'Goal', tasks: [], invocations: 1, config: {}, ...state }));
    if (lock) writeFileSync(join(path, '.forja', 'lock.json'), JSON.stringify(lock));
    return path;
  };
  const due = (over = {}) => ({ stopCode: 'provider_limit', usageLimitWait: { reset_at: new Date(T0 - 5 * MIN).toISOString(), source: 'provider', recorded_at: new Date(T0 - 70 * MIN).toISOString(), resumes: 0 }, ...over });
  const launch = (path, runId = RUN) => {
    const calls = [];
    const pid = launchCore({ dataDir: join(root, 'data'), forjaRoot: root, project: { name: 'Project', path, ...(runId ? { runId } : {}) }, now: T0,
      spawnRunner: (...args) => { calls.push(args); return { pid: 77 }; } });
    return { pid, calls };
  };

  test('a due wait of the same run_id starts core resume --expected-run, hidden through the default spawner', () => {
    const { pid, calls } = launch(project(due()));
    assert.equal(pid, 77);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].slice(1), ['core', 'resume', '--expected-run', RUN]);
    assert.equal(calls[0][2].env.CLAUDECODE, undefined);
    // The default spawner hides every child on Windows (go-between and runner).
    assert.match(DETACH_SCRIPT, /windowsHide:true/);
  });

  test('refuses a wait that is not due, opted out, capped, of another run_id, without run_id or under a live lock', () => {
    const later = due(); later.usageLimitWait.reset_at = new Date(T0 + 30 * MIN).toISOString();
    const margin = due(); margin.usageLimitWait.reset_at = new Date(T0 - 20_000).toISOString();
    for (const [label, path, runId] of [
      ['not due', project(later)],
      ['inside the margin', project(margin)],
      ['opt-out', project(due({ config: { usageLimitResume: false } }))],
      ['cap', project(due({ usageLimitResumes: 6 }))],
      ['other run', project(due()), 'F-1-abcdef'],
      ['no run id', project(due()), null],
      ['live lock', project(due(), { pid: process.pid, token: 'x' })],
      ['malformed wait', project(due({ usageLimitWait: { reset_at: 'soon', source: 'provider' } }))],
    ]) {
      const { pid, calls } = launch(path, runId === undefined ? RUN : runId);
      assert.equal(pid, undefined, label);
      assert.equal(calls.length, 0, label);
    }
  });

  test('refuses every other blocked run, even with a forged due wait', () => {
    for (const stopCode of ['timeout', 'provider', 'output', 'attempts', 'operator_stop', 'inspect', 'check_writes', 'check_timeout', 'sessions', undefined]) {
      const { pid, calls } = launch(project(due({ stopCode })));
      assert.equal(pid, undefined, String(stopCode));
      assert.equal(calls.length, 0, String(stopCode));
    }
    for (const status of ['done', 'failed']) assert.equal(launch(project(due({ status }))).pid, undefined, status);
  });
});

describe('launchCoreQueue and the goal queue after a done run', () => {
  const RUN = 'F-1791068167545-6aaf68';
  const GOAL = 'Secret queued goal text';
  const entry = { id: 'Q-1791068167545-abcdef', added_at: '2026-10-04T00:00:00.000Z', provider: 'claude', goal: GOAL, config: null, budgets: {} };
  const project = (state = {}, { queue = { version: 1, entries: [entry] }, lock = null } = {}) => {
    const path = mkdtempSync(join(root, 'queue-'));
    mkdirSync(join(path, '.forja'), { recursive: true });
    writeFileSync(join(path, '.forja', 'current.json'), JSON.stringify({ version: 1, run_id: RUN, status: 'done', provider: 'claude', goal: 'Goal', tasks: [], invocations: 1, config: {}, ...state }));
    if (queue !== null) writeFileSync(join(path, '.forja', 'queue.json'), typeof queue === 'string' ? queue : JSON.stringify(queue));
    if (lock) writeFileSync(join(path, '.forja', 'lock.json'), JSON.stringify(lock));
    return path;
  };
  const launch = (path, runId = RUN) => {
    const calls = [];
    const pid = launchCoreQueue({ dataDir: join(root, 'data'), forjaRoot: root, project: { name: 'Project', path, ...(runId ? { runId } : {}) },
      spawnRunner: (...args) => { calls.push(args); return { pid: 88 }; } });
    return { pid, calls };
  };

  test('a done run of the same run_id with a queued goal starts core queue start --expected-run, without the goal in argv', () => {
    const { pid, calls } = launch(project());
    assert.equal(pid, 88);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].slice(1), ['core', 'queue', 'start', '--expected-run', RUN]);
    assert.doesNotMatch(JSON.stringify(calls[0][1]), /Secret queued goal/);
    assert.equal(calls[0][2].env.CLAUDECODE, undefined);
    assert.equal(calls[0][2].env.FORJA_PROJECT_ROOT, undefined);
    assert.match(calls[0][2].logPath, /queue-Project-/);
    assert.match(DETACH_SCRIPT, /windowsHide:true/);
  });

  test('refuses blocked, failed, running, another run_id, no run_id, a live lock, an empty or corrupt queue', () => {
    for (const [label, path, runId] of [
      ['blocked', project({ status: 'blocked', stopCode: 'inspect' })],
      ['due usage-limit wait', project({ status: 'blocked', stopCode: 'provider_limit', usageLimitWait: { reset_at: new Date(Date.now() - 600000).toISOString(), source: 'provider', resumes: 0 } })],
      ['failed', project({ status: 'failed' })],
      ['running', project({ status: 'running' })],
      ['other run', project(), 'F-1-abcdef'],
      ['no run id', project(), null],
      ['live lock', project({}, { lock: { pid: process.pid, token: 'x' } })],
      ['empty queue', project({}, { queue: { version: 1, entries: [] } })],
      ['no queue file', project({}, { queue: null })],
      ['corrupt queue', project({}, { queue: '{oops' })],
    ]) {
      const { pid, calls } = launch(path, runId === undefined ? RUN : runId);
      assert.equal(pid, undefined, label);
      assert.equal(calls.length, 0, label);
    }
  });
});
