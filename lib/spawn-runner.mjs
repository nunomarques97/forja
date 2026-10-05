// The one place that starts a Forja process from another Forja process
// (docs/ARCHITECTURE.md §9, §12): the guard (lib/guard.mjs) resumes a dead Core
// controller, and the guard and the viewer relaunch each other
// (lib/supervise.mjs). Every launch goes the same way, or the callers would
// drift and only one of them would survive a `forja down`.
//
// The exports that do the work:
//   defaultSpawnRunner(command, args, { logPath, ...options }) — the seam the
//     tests replace; same shape as child_process.spawn plus logPath.
//   launchCore({ dataDir, forjaRoot, project, spawnRunner }) — runs
//     `forja core resume --expected-run <id>` for a Core run that is still
//     `running` with a dead controller; returns its pid (or undefined).
//   launchForja({ dataDir, forjaRoot, args, logPath, via, spawnRunner }) —
//     `forja up` or `forja guard run`, for the mutual supervision.
//
// Node core only; nothing here reads or writes outside the Forja data dir.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { safeName } from './projects.mjs';
import { coreObservation } from './core/observe.mjs';
import { usageLimitDue } from './core/recovery.mjs';

// Windows has no "leave the process tree": `detached: true` + `unref()` only
// frees the parent's event loop — the child keeps the caller as its
// ParentProcessId, and `forja down` walks exactly that (taskkill /T on the
// up.pid tree, lib/up.mjs). Real incident, 17 set 2026 05:15:22Z: one `down`
// stopped the viewer and, in the same millisecond, the two runners started from
// the phone and their `claude -p` sessions; a runner started from another tree
// survived. So on Windows the child is started by a go-between that exits at
// once: by the time anyone walks a tree, the child's parent is gone and it
// hangs off no tree of ours. The go-between is Node itself — the runtime is
// already here, argv goes through as an array (no shell, no quoting rules, no
// `start` parsing the first quoted token as a window title), it opens the same
// log file for the child's stdout/stderr, and it prints the child's real pid
// so spawn.log and the phone still get it instead of the go-between's.
// (`forja down` also spares live Core controllers by command line — lib/up.mjs — so this
// holds even for a controller started some other way; two defences, one incident.)
const GO_BETWEEN_MS = 20_000;
export const DETACH_SCRIPT = [
  "const cp=require('node:child_process'),fs=require('node:fs');",
  'const [log,cmd,...rest]=process.argv.slice(1);',
  "let fd;try{fd=fs.openSync(log,'a')}catch{}",
  "const note=m=>{try{fs.appendFileSync(log,new Date().toISOString()+' '+m+'\\n')}catch{}};",
  "const io=fd===undefined?'ignore':fd;",
  "const c=cp.spawn(cmd,rest,{detached:true,windowsHide:true,stdio:['ignore',io,io]});",
  "c.on('error',e=>{note('spawn falhou: '+(e&&e.message));process.stdout.write('pid=0\\n')});",
  "c.on('spawn',()=>{c.unref();process.stdout.write('pid='+c.pid+'\\n')});",
].join('');

// The seam the tests replace: same shape as child_process.spawn plus logPath.
export function defaultSpawnRunner(command, args, { logPath, ...options } = {}) {
  try { mkdirSync(join(logPath, '..'), { recursive: true }); } catch {}
  const note = msg => { try { appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`); } catch {} };
  if (process.platform === 'win32') {
    // Synchronous on purpose: the go-between lives ~100 ms and the pid it prints
    // is what the POST answers with. Its own failures never throw here.
    const r = spawnSync(process.execPath, ['-e', DETACH_SCRIPT, logPath, command, ...args], {
      ...options, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, timeout: GO_BETWEEN_MS,
    });
    const m = /\bpid=(\d+)\b/.exec(String(r.stdout || ''));
    // pid=0 means the go-between already wrote the reason in the log.
    if (m) return Number(m[1]) > 0 ? { pid: Number(m[1]) } : {};
    note(`spawn falhou: ${(r.error && r.error.message) || String(r.stderr || '').trim().split('\n')[0] || `código ${r.status}`}`);
    return {};
  }
  let fd;
  try { fd = openSync(logPath, 'a'); } catch { fd = undefined; }
  try {
    // POSIX: `detached` already puts the child in its own session (setsid), out
    // of reach of a group kill on the viewer.
    const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'], windowsHide: true });
    // A detached child that fails to start emits 'error': without a listener it
    // would throw inside the server.
    child.on('error', err => note(`spawn falhou: ${err && err.message}`));
    child.unref();
    return { pid: child.pid };
  } finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Resumes a Core run whose controller died, or whose usage-limit wait is due.
// Any other blocked run is left alone; the engine re-checks both under its lock.
export function launchCore({ dataDir, forjaRoot, project, spawnRunner = defaultSpawnRunner, now = Date.now() } = {}) {
  const state = coreObservation(project.path);
  const run = state?.run;
  const resumable = run?.status === 'running' || (run?.status === 'blocked' && run.stop_code === 'provider_limit' && usageLimitDue(run.usage_limit_wait, now) && project.runId === run.run_id);
  if (!resumable || state.runnerAlive || (project.runId && run.run_id !== project.runId)) return undefined;
  const dir = join(dataDir, 'core');
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, FORJA_DATA_DIR: dataDir };
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'FORJA_PROJECT_ROOT', 'FORJA_RUNNER']) delete env[key];
  const args = [join(forjaRoot, 'bin/forja.mjs'), 'core', 'resume', '--expected-run', state.run.run_id];
  const logPath = join(dir, `resume-${safeName(project.name)}-${stamp()}.log`);
  const { pid } = spawnRunner(process.execPath, args, { cwd: project.path, env, logPath }) || {};
  return pid;
}

// Starts the next queued goal of a Core project whose run `project.runId` is
// done with no live controller. Only the run id goes in argv: the child reads
// the goal from .forja/queue.json under the project and queue locks, and the
// engine re-checks identity, status and the queue there.
export function launchCoreQueue({ dataDir, forjaRoot, project, spawnRunner = defaultSpawnRunner } = {}) {
  const state = coreObservation(project.path);
  const run = state?.run;
  if (!run || run.status !== 'done' || state.runnerAlive || !project.runId || run.run_id !== project.runId ||
      !Number.isSafeInteger(run.queue_length) || run.queue_length < 1) return undefined;
  const dir = join(dataDir, 'core');
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, FORJA_DATA_DIR: dataDir };
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'FORJA_PROJECT_ROOT', 'FORJA_RUNNER']) delete env[key];
  const args = [join(forjaRoot, 'bin/forja.mjs'), 'core', 'queue', 'start', '--expected-run', run.run_id];
  const logPath = join(dir, `queue-${safeName(project.name)}-${stamp()}.log`);
  const { pid } = spawnRunner(process.execPath, args, { cwd: project.path, env, logPath }) || {};
  return pid;
}

/**
 * Starts another long-lived Forja process of THIS repo — `forja up` or
 * `forja guard run` — for the mutual supervision of docs/ARCHITECTURE.md §12
 * (lib/supervise.mjs decides when; this only does it).
 *
 * It goes through the SAME Windows go-between as `launchCore`, and for the
 * same reason, one step further: a guard launched by the viewer must not hang
 * off the viewer's process tree, or the next `forja down` would take it with it
 * — `planKillTree` (lib/up.mjs) spares live Core controllers by command line,
 * and only those. Out of the tree, `down` has nothing of ours to walk.
 *
 * `args` is fixed argv written in code (`['up']`, `['guard', 'run']`), never
 * text read from a file; `cwd` is the Forja repo (not a project); the env
 * carries FORJA_DATA_DIR and loses the caller's session/project pins.
 * Returns the pid, or undefined when the spawn produced none.
 */
export function launchForja({ dataDir, forjaRoot, args = [], logPath = null, via = 'peer', spawnRunner = defaultSpawnRunner } = {}) {
  const runnerDir = join(dataDir, 'runner');
  mkdirSync(runnerDir, { recursive: true });
  const env = { ...process.env, FORJA_DATA_DIR: dataDir };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.FORJA_PROJECT_ROOT;
  const argv = [join(forjaRoot, 'bin', 'forja.mjs'), ...args.map(String)];
  const what = safeName(String(args[0] ?? '?'));
  const log = logPath || join(dataDir, `spawn-${what}-${stamp()}.log`);
  const { pid } = spawnRunner(process.execPath, argv, { cwd: forjaRoot, env, logPath: log }) || {};
  // Same ledger, same discipline: status only, no paths, no ports.
  try { appendFileSync(join(runnerDir, 'spawn.log'), `${new Date().toISOString()} peer=${what} action=relaunch pid=${pid ?? '?'} via=${via}\n`); } catch {}
  return pid;
}
