import { statSync } from 'node:fs';
import { join } from 'node:path';
import { loadProjects, readProjects } from '../lib/projects.mjs';
import { coreObservation } from '../lib/core/observe.mjs';
import { decideTechnology, CORE_ROOT } from '../lib/core/engine.mjs';
import { pendingTechnology } from '../lib/core/technology.mjs';
import { crossSite, readBody } from './runs-api.mjs';
import { launchCore } from '../lib/spawn-runner.mjs';
import { projectKey } from '../lib/state-files.mjs';

export function coreSnapshot(dataDir) {
  const registry = loadProjects(dataDir);
  if (registry.corrupt)
    return { ok: false, error: 'Project registry is unreadable.' };
  let legacyOnlyProjects = 0;
  const projects = readProjects(dataDir)
    .map((p) => {
      const core = coreObservation(p.path, { details: true });
      if (core === null) legacyOnlyProjects++;
      return { name: p.name, core };
    })
    .filter((p) => p.core)
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    at: new Date().toISOString(),
    legacy_only_projects: legacyOnlyProjects,
    projects,
  };
}

// Registered projects with a readable Core run, as viewer project keys:
// { status, active, ended_at }. `active` is running or blocked. A terminal run
// (done or failed, which includes abandoned) carries its end time in ms:
// finished_at, else updated_at, else the time the state file was last written.
// The watchdog uses it to stay quiet about sessions that went silent before the
// run ended. An unreadable registry or project only means no entry.
export function coreProjectRuns(dataDir) {
  const runs = new Map();
  let projects = [];
  try { projects = readProjects(dataDir); } catch { return runs; }
  for (const p of projects) {
    try {
      const run = coreObservation(p.path)?.run;
      if (!run) continue;
      const active = run.status === 'running' || run.status === 'blocked';
      let ended_at = null;
      if (!active) {
        ended_at = [run.finished_at, run.updated_at].map(t => Date.parse(t || '')).find(Number.isFinite) ?? null;
        if (ended_at === null) ended_at = statSync(join(p.path, '.forja', 'current.json')).mtimeMs;
      }
      runs.set(projectKey(p.path), { status: run.status, active, ended_at });
    } catch {}
  }
  return runs;
}

// Registered projects whose Core run is running or blocked, as viewer project keys.
export function coreDrivenProjects(dataDir) {
  return new Set([...coreProjectRuns(dataDir)].filter(([, r]) => r.active).map(([key]) => key));
}

// Called only after the server's authentication and Host checks.
export function handleCoreDecision(req, res, ctx) {
  if (req.url.split('?')[0] !== '/api/core/decision') return false;
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST') { send(405, { error: 'Method not allowed.' }); return true; }
  if (crossSite(req)) { send(403, { error: 'Origin not allowed.' }); return true; }
  readBody(req, res, body => {
    let p; try { p = JSON.parse(body); } catch { send(400, { error: 'Invalid request.' }); return; }
    if (!p || typeof p.project !== 'string' || p.project.length > 200 || !/^F-\d+-[a-f0-9]{6}$/.test(p.run || '') || !/^D[1-8]$/.test(p.decision || '') || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(p.option || '')) {
      send(400, { error: 'Invalid choice.' }); return;
    }
    if (loadProjects(ctx.dataDir).corrupt) { send(503, { error: 'Project registry is unavailable.' }); return; }
    const project = readProjects(ctx.dataDir).find(x => x.name === p.project);
    if (!project) { send(404, { error: 'Project not found.' }); return; }
    try {
      const { run, changed } = decideTechnology(project.path, { runId: p.run, decisionId: p.decision, optionId: p.option, resume: true });
      const waiting = pendingTechnology(run).length > 0;
      let pid;
      if (changed && !waiting) {
        try { pid = launchCore({ dataDir: ctx.dataDir, forjaRoot: ctx.forjaRoot || CORE_ROOT, project: { ...project, runId: run.run_id }, spawnRunner: ctx.spawnRunner }); }
        catch { /* The decision stays durable; the guard or CLI can resume. */ }
      }
      send(200, { ok: true, waiting, resumed: Number.isInteger(pid) && pid > 0 });
    } catch { send(409, { error: 'The decision has changed or a worker is active. Refresh the page before choosing.' }); }
  });
  return true;
}
