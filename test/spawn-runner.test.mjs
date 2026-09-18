// viewer/runs-api.mjs `defaultSpawnRunner` — the seam the "Novo run" button uses
// to launch `forja runner` from the viewer. Every other test replaces it with a
// fake, so the real one (detached child, its own log file, `unref`, a command
// that does not exist) was never exercised. It is here, against a real child
// process; nothing in the viewer is imported for its side effects and no server
// is started. This file only imports runs-api.mjs, never edits it.
// Since T-RUN-2 it also proves the property the whole run depends on: the runner
// does not belong to the tree of whoever launched it (Windows).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSpawnRunner } from '../viewer/runs-api.mjs';

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
      `import { defaultSpawnRunner } from ${JSON.stringify(new URL('../viewer/runs-api.mjs', import.meta.url).href)};`,
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
      `import { defaultSpawnRunner } from ${JSON.stringify(new URL('../viewer/runs-api.mjs', import.meta.url).href)};`,
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
