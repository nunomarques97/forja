// Process locks and liveness for the long-lived Forja processes (the guard,
// `forja up`) and for the mutual supervision between them (lib/supervise.mjs).
//
// A lock is a small JSON file in the Forja data dir holding the owner's pid and
// a heartbeat refreshed every loop. A live owner (alive by the caller's own
// predicate, heartbeat fresh) makes a second process refuse; a dead or silent
// owner is taken over. The predicate is the caller's because Windows reuses pids
// within minutes: "alive" means "this pid is still the same kind of process",
// which only the caller can tell from the command line.
//
// Node core only.
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { nowIso, writeJson } from './state-files.mjs';

export const LOCK_STALE_MS = 15 * 60_000;

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The command line of a live pid, or null when it cannot be read (a timeout,
// no PowerShell, no /proc). Callers treat null as "unknown" and stay safe.
export function commandLineOf(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      return r.status === 0 ? String(r.stdout || '').trim() : null;
    }
    return readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch { return null; }
}

export function readLock(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function acquireLock(path, { pid = process.pid, runId = null, project = null, now = Date.now(), alive = pidAlive } = {}) {
  const cur = readLock(path);
  if (cur && cur.pid !== pid && alive(cur.pid) && now - Date.parse(cur.beat || cur.since || 0) < LOCK_STALE_MS) {
    return { ok: false, owner: cur };
  }
  const lock = { pid, run_id: runId, project, since: new Date(now).toISOString(), beat: new Date(now).toISOString(), tookOverFrom: cur && cur.pid !== pid ? cur.pid : null };
  // Written by tmp + rename: a reader that caught half a lock would read "no
  // owner" and fail open.
  writeJson(path, lock);
  return { ok: true, lock };
}

export function beatLock(path, pid = process.pid) {
  const cur = readLock(path);
  if (!cur || cur.pid !== pid) return false;
  cur.beat = nowIso();
  try { writeJson(path, cur); return true; } catch { return false; }
}

export function releaseLock(path, pid = process.pid) {
  const cur = readLock(path);
  if (cur && cur.pid === pid) { try { unlinkSync(path); } catch {} }
}
