// Registry of projects the bootstrap prepared — `<forja>/data/projects.json`
// (docs/ARCHITECTURE.md §9). It is the ONLY source of project paths for
// the viewer's /core panel and the guard: a request names a project, never a path.
//
// Shape: { version: 1, projects: [ { name, path, bootstrappedAt } ] }
//   name  — unique key used by the API and the UI (basename of the folder,
//           sanitised; a second folder with the same basename gets -2, -3, …)
//   path  — absolute, normalised; written here only by `forja bootstrap`
//
// Node core only; no I/O outside the Forja data dir and reads of each
// project's Core state (<project>/.forja/, through lib/core/observe.mjs).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { dataDir, nowIso } from './state-files.mjs';
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

// Readers (the /core panel, the guard, `findProject`) only see projects whose
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
// "unreadable registry" apart uses `loadProjects`.
export const findProject = (name, dir = dataDir()) =>
  (typeof name === 'string' && name ? readProjects(dir).find(p => p.name === name) : undefined) || null;

// ---------- live status ----------
// Status comes from each project's Core state only (lib/core/observe.mjs):
// `run` is the Core run summary (driver 'core') or null when the project has no
// Core run, and `runnerAlive` is whether its Core controller or worker is still
// alive. A legacy docs/forja/RUN.json is history and is never read here, so the
// guard can never act on it. Corrupt Core state keeps `run: null` with the
// observation's own fail-closed liveness.
export function runSummary(projectPath) {
  const core = coreObservation(String(projectPath));
  return core ? core.run : null;
}

export function projectStatus(p) {
  const core = coreObservation(String(p.path));
  return core ? { run: core.run, runnerAlive: core.runnerAlive } : { run: null, runnerAlive: false };
}

// ---------- CLI (`forja projects list|prune`) ----------
// Only the PC sees this: here the folder IS the useful information (which is why
// it never crosses the tunnel).
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
  const list = reg.projects.map(p => ({ name: p.name, path: p.path, exists: existsSync(p.path), bootstrappedAt: p.bootstrappedAt, run: runSummary(p.path) }));
  console.log(JSON.stringify({ ok: true, projects: list, missing: list.filter(p => !p.exists).length }, null, 2));
}

export function listProjectsWithStatus(dir = dataDir()) {
  return readProjects(dir)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt'))
    .map(p => ({ name: p.name, path: p.path, bootstrappedAt: p.bootstrappedAt, ...projectStatus(p) }));
}
