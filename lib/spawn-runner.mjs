// The one place that starts a `forja runner` process from another Forja process
// (docs/ARCHITECTURE.md §3b, §9, §12). It was born inside viewer/runs-api.mjs —
// the "Novo run" button of the phone — and moved here unchanged when the guard
// (lib/guard.mjs) became a second caller: the viewer and the guard must launch a
// runner in exactly the same way, or the two would drift and only one of them
// would survive a `forja down`.
//
// Two exports do the work:
//   defaultSpawnRunner(command, args, { logPath, ...options }) — the seam the
//     tests replace; same shape as child_process.spawn plus logPath.
//   launchRunner({ dataDir, forjaRoot, project, goal, extraArgs, via, action,
//     spawnRunner }) — resolves argv, env, the per-launch log file and the
//     status-only line in data/runner/spawn.log, and returns the runner's pid
//     (or undefined).
//
// Node core only; nothing here reads or writes outside the Forja data dir.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { safeName } from './projects.mjs';

// Windows has no "leave the process tree": `detached: true` + `unref()` only
// frees the parent's event loop — the child keeps the caller as its
// ParentProcessId, and `forja down` walks exactly that (taskkill /T on the
// up.pid tree, lib/up.mjs). Real incident, 17 set 2026 05:15:22Z: one `down`
// stopped the viewer and, in the same millisecond, the two runners started from
// the phone and their `claude -p` sessions; a runner started from another tree
// survived. So on Windows the runner is started by a go-between that exits at
// once: by the time anyone walks a tree, the runner's parent is gone and it
// hangs off no tree of ours. The go-between is Node itself — the runtime is
// already here, argv goes through as an array (no shell, no quoting rules, no
// `start` parsing the first quoted token as a window title), it opens the same
// log file for the runner's stdout/stderr, and it prints the runner's real pid
// so spawn.log and the phone still get it instead of the go-between's.
// (`forja down` also spares live runners by command line — lib/up.mjs — so this
// holds even for a runner started some other way; two defences, one incident.)
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

/**
 * Starts `forja runner` in `project.path`, out of this process's tree.
 * `via` is who asked (`viewer`, `guard`) and goes in the spawn.log line;
 * `extraArgs` are flags appended after `runner` (the guard passes `--visivel`).
 * Returns the runner's pid, or undefined when the spawn produced none.
 */
export function launchRunner({ dataDir, forjaRoot, project, goal = null, extraArgs = [], via = 'cli', action = goal ? 'start' : 'resume', spawnRunner = defaultSpawnRunner } = {}) {
  const runnerDir = join(dataDir, 'runner');
  mkdirSync(runnerDir, { recursive: true });
  const env = { ...process.env, FORJA_DATA_DIR: dataDir };
  // The caller may itself have been started from a Claude Code session or with a
  // project pinned: neither may leak into the run the runner is about to start.
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.FORJA_PROJECT_ROOT;
  const args = [join(forjaRoot, 'bin', 'forja.mjs'), 'runner', ...extraArgs, ...(goal ? ['--goal', goal] : [])];
  const logPath = join(runnerDir, `spawn-${safeName(project.name)}-${stamp()}.log`);
  const { pid } = spawnRunner(process.execPath, args, { cwd: project.path, env, logPath }) || {};
  // Status only, never the goal text and never a full path (§10's rule applied
  // to logs). The name goes through safeName like the log file's: a registry
  // entry with a newline or a separator in it must not forge a log line.
  try { appendFileSync(join(runnerDir, 'spawn.log'), `${new Date().toISOString()} project=${safeName(project.name)} action=${action} pid=${pid ?? '?'} goal_chars=${goal ? goal.length : 0} via=${via}\n`); } catch {}
  return pid;
}

/**
 * Starts another long-lived Forja process of THIS repo — `forja up` or
 * `forja guard run` — for the mutual supervision of docs/ARCHITECTURE.md §12
 * (lib/supervise.mjs decides when; this only does it).
 *
 * It goes through the SAME Windows go-between as `launchRunner`, and for the
 * same reason, one step further: a guard launched by the viewer must not hang
 * off the viewer's process tree, or the next `forja down` would take it with it
 * — `planKillTree` (lib/up.mjs) spares live runners by command line, and only
 * those. Out of the tree, `down` has nothing of ours to walk.
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
