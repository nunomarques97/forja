// Who drives a run — `RUN.json.driver` (docs/ARCHITECTURE.md §3c).
//
// Two ways of executing a run, and they must never overlap:
//   interactive — the Lead is a conversation the Sponsor has open (the Claude
//                 Code extension in VS Code, or a terminal session). Forja keeps
//                 tasks, decisions, checkpoints and events; NOTHING relaunches a
//                 runner to take the run over.
//   runner      — `forja runner` executes the run unattended, one fresh session
//                 per phase, and the guard (lib/guard.mjs) recovers it when the
//                 runner dies.
// This is a different axis from `RUN.json.visible` (`claude -p` vs `claude --bg`):
// visibility is how a runner launches sessions, the driver is who is in charge.
//
// Why (18 set 2026): `guardPlan` only saw `status: running` + "no runner lock",
// so an interactive run with no runner became a relaunch candidate after two
// minutes — the guard would have started a second executor on top of the
// conversation. The value lives on disk, so it survives restarts, compactions
// and a guard that comes back with an empty state file.
//
// Runs written before this field existed are NOT classified by its absence. A
// run counts as runner-driven only on evidence tied to the SAME run_id: the
// runner lock of this project naming this run, or the per-session logs the
// runner writes as `data/runner/<run_id>-NN-<phase>.log`. A lock of another
// run, or of another project, proves nothing. Without evidence the driver is
// `unknown`, and nothing executes a run whose driver is unknown.
//
// Node core only.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dataDir as defaultDataDir } from './state-files.mjs';
import { LOCK_STALE_MS, lockPath, ownerAlive, readLock } from './runner.mjs';

export const DRIVERS = Object.freeze(['interactive', 'runner']);
export const DRIVER_LABEL = Object.freeze({ interactive: 'conversa interativa', runner: 'runner autónomo', unknown: 'desconhecido' });
// The exact shape `newRunId` writes (lib/state-files.mjs). Evidence is only
// looked up for an id of this shape: a hand-edited "R" or "R-2026" would
// otherwise prefix-match other runs' session logs.
export const RUN_ID_SHAPE = /^R-\d{8}-[0-9a-f]{4}$/;

// The value written on disk, validated. `null` = the field is absent (a run
// from before §3c); `'invalid'` = present but not one of DRIVERS.
export function driverField(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
  if (!Object.hasOwn(run, 'driver') || run.driver === undefined || run.driver === null) return null;
  return DRIVERS.includes(run.driver) ? run.driver : 'invalid';
}

// A value typed by a person (`--driver`, `run driver set <x>`): refused loudly.
export function normalizeDriver(value) {
  const s = String(value ?? '').trim().toLowerCase();
  const map = { interactive: 'interactive', interativo: 'interactive', interativa: 'interactive', conversa: 'interactive', runner: 'runner', autonomo: 'runner', 'autónomo': 'runner' };
  if (!Object.hasOwn(map, s)) throw new Error(`responsável "${value}" desconhecido — usa interactive (conversa) ou runner (autónomo)`);
  return map[s];
}

/**
 * Evidence that a runner executed THIS run of THIS project. Pure I/O reads of
 * the Forja data dir; never throws.
 *   - the project's runner lock names this run_id (written by the runner since
 *     §3c; older locks carry `run_id: null` and do not count);
 *   - a session log `data/runner/<run_id>-NN-<label>.log` exists (the runner
 *     writes one per phase session it launches; nothing else writes that name).
 * The log names carry no project; the run_id itself is `R-<date>-<4 hex>` and
 * is compared against THIS project's RUN.json, so the residual risk is two
 * projects drawing the same 4 hex on the same day — noted in §3c.
 */
export function runnerEvidence(runId, projectPath, dir = defaultDataDir()) {
  if (typeof runId !== 'string' || !RUN_ID_SHAPE.test(runId)) return { found: false, why: 'run_id ilegível' };
  const runnerDir = join(dir, 'runner');
  try {
    const lock = readLock(lockPath(projectPath, runnerDir));
    if (lock && lock.run_id === runId) return { found: true, why: 'lock do runner deste projeto com este run_id' };
  } catch {}
  let names = [];
  try { names = readdirSync(runnerDir); } catch { return { found: false, why: 'sem pasta data/runner' }; }
  const prefix = `${runId}-`;
  const hit = names.find(n => n.startsWith(prefix) && /^\d{2,}-/.test(n.slice(prefix.length)) && n.endsWith('.log'));
  return hit ? { found: true, why: 'registo de sessão do runner com este run_id' } : { found: false, why: 'nenhum registo do runner com este run_id' };
}

/**
 * The driver of a run, as everyone must read it (guard, runner, CLI, API,
 * catalogue): { driver: 'interactive'|'runner'|'unknown', source, request }.
 *   source: 'RUN.json' | 'evidência do runner (run anterior ao campo)' |
 *           'sem evidência (run anterior ao campo)' | 'valor inválido no RUN.json'
 *   request: a pending hand-over asked while a runner was alive (see `run driver
 *            set interactive`), or null.
 */
export function resolveDriver(run, projectPath, dir = defaultDataDir()) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) return { driver: 'unknown', source: 'sem run legível', request: null };
  const request = requestOf(run);
  const field = driverField(run);
  if (field === 'interactive' || field === 'runner') return { driver: field, source: 'RUN.json', request };
  if (field === 'invalid') return { driver: 'unknown', source: 'valor inválido no RUN.json', request };
  const ev = runnerEvidence(run.run_id, projectPath, dir);
  return ev.found
    ? { driver: 'runner', source: `evidência do runner (run anterior ao campo: ${ev.why})`, request }
    : { driver: 'unknown', source: `sem evidência (run anterior ao campo: ${ev.why})`, request };
}

export function requestOf(run) {
  const r = run && run.driver_request;
  if (!r || typeof r !== 'object' || Array.isArray(r) || !DRIVERS.includes(r.to)) return null;
  return { to: r.to, at: typeof r.at === 'string' ? r.at.slice(0, 40) : null };
}

// ---------- the project's runner, read the way a new runner would ----------
// Alive = the lock's owner is alive (pid AND still a `forja runner`, because
// Windows reuses pids) AND its heartbeat is fresh — exactly the terms
// `acquireLock` uses to refuse a second runner.
// A lock file that EXISTS but cannot be parsed (hand-edited, or a write from an
// older Forja caught half-way) counts as a live runner of unknown identity: in
// doubt, alive (the same rule as lib/supervise.mjs) — the answer is then a
// pending request or a refusal, never a takeover.
export function liveRunner(projectPath, dir = defaultDataDir(), { now = Date.now(), alive = ownerAlive } = {}) {
  const path = lockPath(projectPath, join(dir, 'runner'));
  const lock = readLock(path);
  if (!lock) return existsSync(path) ? { pid: null, run_id: null, visible: false, session: null, unreadable: true } : null;
  if (!lock.pid) return null;
  if (!(now - Date.parse(lock.beat || lock.since || 0) < LOCK_STALE_MS)) return null;
  return alive(lock.pid) ? lock : null;
}

// ---------- claim mutex ----------
// Every change of driver, `run start` and the runner's own check-and-claim go
// through this short critical section, so "is there a live runner?" and "write
// the new driver" are one step for everyone. An exclusive create (`wx`) is the
// only atomic primitive the file system gives us on every platform; a mutex
// left behind by a crash is taken over after MUTEX_STALE_MS. The sections it
// guards are short, but `liveRunner` inside them may ask PowerShell for a
// command line (up to 15 s), so the wait and the stale age leave room for that.
// Each holder writes a random token and only ever deletes a file that still
// carries it; a stale file is taken over by renaming it to a unique name first
// (one waiter wins the rename) and checking that what was renamed is the file
// that was judged stale — a fresh mutex renamed by mistake is put back.
export const MUTEX_STALE_MS = 60_000;
export const MUTEX_WAIT_MS = 30_000;
export const mutexPath = (projectPath, dir = defaultDataDir()) =>
  lockPath(projectPath, join(dir, 'runner')).replace(/lock-([^\\/]+)\.json$/, 'claim-$1.lock');
const pause = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };

export function withClaimMutex(projectPath, fn, { dir = defaultDataDir(), waitMs = MUTEX_WAIT_MS, now = () => Date.now() } = {}) {
  const path = mutexPath(projectPath, dir);
  mkdirSync(join(path, '..'), { recursive: true });
  const until = now() + waitMs;
  let fd = null;
  for (;;) {
    try { fd = openSync(path, 'wx'); break; } catch (err) {
      // EPERM/EACCES: on Windows a file another process is deleting ("delete
      // pending") refuses a create for a few milliseconds — busy, not an error
      // (measured by the 8-process test in test/driver.test.mjs).
      const code = err && err.code;
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(code)) throw err;
      if (now() > until) { const e = new Error('outro processo está a mudar o responsável deste run — tenta daqui a uns segundos'); e.code = 'FORJA_CLAIM_BUSY'; throw e; }
      if (code !== 'EEXIST') { pause(10); continue; }
      let age = 0; let seen = null;
      try { age = Date.now() - statSync(path).mtimeMs; seen = readFileSync(path, 'utf8'); } catch { continue; } // vanished between the two calls: try again
      if (age > MUTEX_STALE_MS) { takeOverStale(path, seen); continue; }
      if (now() > until) { const e = new Error('outro processo está a mudar o responsável deste run — tenta daqui a uns segundos'); e.code = 'FORJA_CLAIM_BUSY'; throw e; }
      pause(50);
    }
  }
  const token = `${process.pid} ${randomBytes(8).toString('hex')} ${new Date().toISOString()}\n`;
  try { writeSync(fd, token); } catch {}
  try { closeSync(fd); } catch {}
  try { return fn(); } finally {
    // Only our own file: never the mutex of someone who took over after us.
    try { if (readFileSync(path, 'utf8') === token) unlinkSync(path); } catch {}
  }
}
function takeOverStale(path, seen) {
  const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try { renameSync(path, aside); } catch { return; } // another waiter won the rename
  let got = null;
  try { got = readFileSync(aside, 'utf8'); } catch {}
  if (got === seen) { try { unlinkSync(aside); } catch {} return; }
  // We renamed a FRESH mutex (its holder replaced the stale one between our
  // read and our rename): put it back unless a newer one already sits there.
  try { if (!existsSync(path)) renameSync(aside, path); else unlinkSync(aside); } catch {}
}

// Short human sentence for logs, CLI and catalogue. Never a path.
export function describeDriver(d) {
  if (!d) return 'desconhecido';
  const base = DRIVER_LABEL[d.driver] || 'desconhecido';
  const req = d.request ? ` · transferência pedida para ${DRIVER_LABEL[d.request.to]}` : '';
  return d.source === 'RUN.json' ? `${base}${req}` : `${base} (${d.source})${req}`;
}
