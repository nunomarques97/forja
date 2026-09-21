// Registry of projects the bootstrap prepared — `<forja>/data/projects.json`
// (docs/ARCHITECTURE.md §7b, §9). It is the ONLY source of project paths for
// the viewer's run API: a request from the phone names a project, never a path.
//
// Shape: { version: 1, projects: [ { name, path, bootstrappedAt } ] }
//   name  — unique key used by the API and the UI (basename of the folder,
//           sanitised; a second folder with the same basename gets -2, -3, …)
//   path  — absolute, normalised; written here only by `forja bootstrap`
//
// Node core only; no I/O outside the Forja data dir and reads of
// <project>/docs/forja/RUN.json.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { dataDir, nowIso, readJson } from './state-files.mjs';
import { LOCK_STALE_MS, RUNNER_CMD_RE, lockPath, ownerAlive, pidAlive, readLock } from './runner.mjs';
import { resolveDriver } from './driver.mjs';
import { coreObservation } from './core/observe.mjs';

export const projectsPath = (dir = dataDir()) => join(dir, 'projects.json');

// A folder name is display text and a lookup key: keep it readable, keep it
// harmless (it must never be able to act as a path fragment anywhere).
export function safeName(raw) {
  const s = String(raw || '').replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 64).trim();
  return s || 'projeto';
}
const pathKey = p => resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();

// The registry is the record of the Sponsor's own `forja bootstrap` calls: a
// file that exists but cannot be read is NEVER overwritten. `loadProjects` tells
// "no registry yet" (fine, start empty) from "there is one and it is unreadable"
// (corrupt: readers show nothing, writers refuse), so a bad parse can never wipe
// the Sponsor's projects on the next bootstrap.
export const REGISTRY_UNREADABLE = 'o registo de projetos existe mas está ilegível';
export function loadProjects(dir = dataDir()) {
  const ok = projects => ({ projects, corrupt: false, error: null });
  const bad = why => ({ projects: [], corrupt: true, error: `${REGISTRY_UNREADABLE} (${why})` });
  let text;
  try { text = readFileSync(projectsPath(dir), 'utf8'); }
  catch (err) { return err && err.code === 'ENOENT' ? ok([]) : bad((err && err.code) || 'erro de leitura'); }
  let raw;
  try { raw = JSON.parse(text); } catch { return bad('JSON inválido'); }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray(raw.projects) ? raw.projects : null;
  if (!list) return bad('falta a lista projects');
  return ok(list
    .filter(p => p && typeof p === 'object' && typeof p.name === 'string' && typeof p.path === 'string' && p.name && p.path)
    .map(p => ({ name: p.name, path: p.path, bootstrappedAt: typeof p.bootstrappedAt === 'string' ? p.bootstrappedAt : null })));
}

// Readers (the phone's list, `findProject`, the run API) only see projects whose
// folder is still there: a temp folder from a test run, or one the Sponsor has
// deleted or moved, is not something to offer as "start a run here". The entry
// is NOT removed — the registry is the record of the Sponsor's own `bootstrap`
// calls, and a folder can be on a drive that is merely unplugged. `forja
// projects prune` is the one place that deletes, on purpose and out loud.
export function readProjects(dir = dataDir()) {
  return loadProjects(dir).projects.filter(p => existsSync(p.path));
}

// The entries the registry holds and whose folder is gone (what `prune` removes).
export function missingProjects(dir = dataDir()) {
  return loadProjects(dir).projects.filter(p => !existsSync(p.path));
}

// Removes those entries. Writers go through projectsForWrite, so an unreadable
// registry throws here instead of being replaced by a shorter list.
export function pruneProjects(dir = dataDir()) {
  const list = projectsForWrite(dir);
  // One partition, one `existsSync` per entry: two passes could disagree if a
  // folder appeared or vanished between them, and drop an entry it had kept.
  const kept = []; const removed = [];
  for (const p of list) (existsSync(p.path) ? kept : removed).push(p);
  if (removed.length) writeProjects(kept, dir);
  return { removed: removed.map(p => p.name), kept: kept.length };
}

// Every writer goes through this: an unreadable registry throws instead of being
// silently replaced by the caller's idea of the list.
function projectsForWrite(dir) {
  const reg = loadProjects(dir);
  if (reg.corrupt) { const err = new Error(`${reg.error} — não lhe toquei; corrige-o ou apaga-o à mão`); err.code = 'FORJA_REGISTRY_UNREADABLE'; throw err; }
  return reg.projects;
}

export function writeProjects(list, dir = dataDir()) {
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify({ version: 1, projects: list }, null, 2) + '\n';
  const tmp = projectsPath(dir) + '.tmp';
  writeFileSync(tmp, body);
  renameSync(tmp, projectsPath(dir)); // atomic-ish: a crash never leaves half a registry
  return list;
}

// Registers (or refreshes) one project. The path is the identity: the same
// folder bootstrapped twice keeps its entry and gets a new bootstrappedAt.
export function upsertProject({ name, path } = {}, dir = dataDir()) {
  if (!path) throw new Error('upsertProject: falta o caminho do projeto');
  const abs = resolve(String(path));
  const list = projectsForWrite(dir);
  const at = nowIso();
  const mine = list.find(p => pathKey(p.path) === pathKey(abs));
  if (mine) { mine.path = abs; mine.bootstrappedAt = at; writeProjects(list, dir); return { ...mine }; }
  const wanted = safeName(name || basename(abs));
  let final = wanted;
  for (let n = 2; list.some(p => p.name.toLowerCase() === final.toLowerCase()); n++) final = `${wanted}-${n}`;
  const entry = { name: final, path: abs, bootstrappedAt: at };
  list.push(entry);
  writeProjects(list, dir);
  return { ...entry };
}

export function removeProject(name, dir = dataDir()) {
  const list = projectsForWrite(dir);
  const kept = list.filter(p => p.name.toLowerCase() !== String(name || '').toLowerCase());
  if (kept.length === list.length) return false;
  writeProjects(kept, dir);
  return true;
}

// Convenience for callers that only need "this name or nothing". A corrupt
// registry reads as null here too: whoever has to tell "unknown project" from
// "unreadable registry" apart (the run API does) uses `loadProjects`.
export const findProject = (name, dir = dataDir()) =>
  (typeof name === 'string' && name ? readProjects(dir).find(p => p.name === name) : undefined) || null;

// ---------- live status ----------
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

// The fields the phone needs from <project>/docs/forja/RUN.json, capped, plus
// `visible`: the guard (lib/guard.mjs) relaunches a dead runner with the same
// mode the run started in — a `--visivel` run relaunched in default `-p` mode
// would leave the dead runner's `claude --bg` sessions alive for ever, because
// only the visible path sweeps them (`cleanupOrphanVisible`).
// `driver` is who is in charge of the run (lib/driver.mjs, docs/ARCHITECTURE.md
// §3c), already resolved: 'interactive' | 'runner' | 'unknown'. A run written
// before the field existed is 'runner' only on evidence tied to its own run_id;
// the guard acts on 'runner' and nothing else.
function observedRuns(projectPath) {
  const core = coreObservation(String(projectPath));
  const run = readJson(join(String(projectPath), 'docs', 'forja', 'RUN.json'), null);
  const legacy = run && typeof run === 'object' && !Array.isArray(run) ? run : null;
  const terminal = status => ['done', 'finished', 'failed', 'abandoned'].includes(status);
  // A retained Core snapshot is history once a subsequent legacy run owns the project.
  // Corrupt Core state and live Core workers still fail closed.
  const useLegacy = core?.run && terminal(core.run.status) && !core.runnerAlive && legacy &&
    ['running', 'blocked', 'done', 'finished', 'failed', 'abandoned'].includes(legacy.status) &&
    (!terminal(legacy.status) || Date.parse(legacy.started_at) > Date.parse(core.run.started_at));
  return { core: useLegacy ? null : core, legacy };
}

function legacySummary(run, projectPath, dir) {
  if (!run) return null;
  const d = resolveDriver(run, String(projectPath), dir);
  return {
    run_id: str(run.run_id, 64), status: str(run.status, 32), goal: str(run.goal, 600), started_at: str(run.started_at, 40), visible: run.visible === true,
    driver: d.driver, driver_source: d.source, driver_request: d.request ? d.request.to : null,
  };
}

export function runSummary(projectPath, dir = dataDir()) {
  const { core, legacy } = observedRuns(projectPath);
  return core ? core.run : legacySummary(legacy, projectPath, dir);
}

// Same answer as `ownerAlive` (pid alive AND the command line is still a runner,
// because Windows reuses pids), without blocking the event loop: the PowerShell
// call costs ~300 ms and the viewer also serves SSE. Same safe default as the
// synchronous version: an unknown command line counts as alive.
export function ownerAliveAsync(pid) {
  return new Promise(resolve => {
    if (!pidAlive(pid)) return resolve(false);
    if (process.platform !== 'win32') {
      readFile(`/proc/${Number(pid)}/cmdline`, 'utf8')
        .then(s => resolve(RUNNER_CMD_RE.test(s.replace(/\0/g, ' ').trim())))
        .catch(() => resolve(true));
      return;
    }
    let done = false; let out = '';
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return finish(true); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(true); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { if (out.length < 8192) out += d; });
    child.on('error', () => { clearTimeout(timer); finish(true); });
    child.on('close', code => { clearTimeout(timer); finish(code === 0 ? RUNNER_CMD_RE.test(out.trim()) : true); });
  });
}

// One entry per pid: the last known value, when it was taken, and whether a
// background refresh is in flight. Only the FIRST sighting of a pid is
// synchronous (so the first answer is measured, not guessed); after that a stale
// entry answers with the last known value and refreshes itself off the request.
const aliveCache = new Map();
export const ALIVE_TTL_MS = 3000;
const ALIVE_EVICT_MS = 60_000;
// Drops every cached liveness answer. The tests use it to make a pid's state
// readable again, and so does the guard (lib/guard.mjs) at the top of every
// pass and of `forja guard status`: a decision that is about to START A PROCESS
// is never taken from a value measured up to ALIVE_TTL_MS ago by someone else.
export const resetAliveCache = () => aliveCache.clear();
export function ownerAliveCached(pid, now = Date.now(), alive = ownerAlive, aliveAsync = ownerAliveAsync) {
  const hit = aliveCache.get(pid);
  if (!hit) {
    const value = alive(pid);
    aliveCache.set(pid, { at: now, value, pending: false });
    return value;
  }
  if (!hit.pending && now - hit.at >= ALIVE_TTL_MS) {
    hit.pending = true;
    Promise.resolve()
      .then(() => aliveAsync(pid))
      .then(value => aliveCache.set(pid, { at: Date.now(), value, pending: false }),
        () => aliveCache.set(pid, { at: Date.now(), value: hit.value, pending: false }));
  }
  if (aliveCache.size > 64) for (const [k, v] of aliveCache) if (!v.pending && now - v.at >= ALIVE_EVICT_MS) aliveCache.delete(k);
  return hit.value;
}

// A runner counts as alive on exactly the terms `acquireLock` uses (live owner
// AND a fresh heartbeat), so "runner vivo" here means "a new runner would refuse".
export function runnerAlive(projectPath, dir = dataDir(), now = Date.now(), alive = ownerAlive, aliveAsync = ownerAliveAsync) {
  const lock = readLock(lockPath(projectPath, join(dir, 'runner')));
  if (!lock || !lock.pid) return false;
  if (!(now - Date.parse(lock.beat || lock.since || 0) < LOCK_STALE_MS)) return false;
  return !!ownerAliveCached(lock.pid, now, alive, aliveAsync);
}

export function projectStatus(p, dir = dataDir(), now = Date.now(), alive = ownerAlive, aliveAsync = ownerAliveAsync) {
  const { core, legacy } = observedRuns(p.path);
  if (core) return { run: core.run, runnerAlive: core.runnerAlive };
  return { run: legacySummary(legacy, p.path, dir), runnerAlive: runnerAlive(p.path, dir, now, alive, aliveAsync) };
}

// ---------- CLI (`forja projects list|prune`) ----------
// Only the PC sees this: here the folder IS the useful information (which is why
// it never crosses the tunnel — `GET /projects` drops `path`).
export async function projects({ pos = [] } = {}) {
  const dir = dataDir();
  const sub = pos[0] || 'list';
  if (sub === 'prune') {
    const { removed, kept } = pruneProjects(dir);
    console.log(JSON.stringify({ ok: true, removed: removed.length, names: removed, kept }, null, 2));
    return;
  }
  if (sub !== 'list') { console.error('uso: forja projects [list|prune]'); process.exitCode = 2; return; }
  const reg = loadProjects(dir);
  if (reg.corrupt) { console.error(reg.error); process.exitCode = 1; return; }
  const list = reg.projects.map(p => ({ name: p.name, path: p.path, exists: existsSync(p.path), bootstrappedAt: p.bootstrappedAt, run: runSummary(p.path, dir) }));
  console.log(JSON.stringify({ ok: true, projects: list, missing: list.filter(p => !p.exists).length }, null, 2));
}

export function listProjectsWithStatus(dir = dataDir(), now = Date.now(), alive = ownerAlive, aliveAsync = ownerAliveAsync) {
  return readProjects(dir)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt'))
    .map(p => ({ name: p.name, path: p.path, bootstrappedAt: p.bootstrappedAt, ...projectStatus(p, dir, now, alive, aliveAsync) }));
}
