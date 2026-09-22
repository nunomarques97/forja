import { loadProjects, readProjects } from '../lib/projects.mjs';
import { coreObservation } from '../lib/core/observe.mjs';
import { decideTechnology, CORE_ROOT } from '../lib/core/engine.mjs';
import { pendingTechnology } from '../lib/core/technology.mjs';
import { crossSite, readBody } from './runs-api.mjs';
import { launchCore } from '../lib/spawn-runner.mjs';

export function coreSnapshot(dataDir) {
  const registry = loadProjects(dataDir);
  if (registry.corrupt)
    return { ok: false, error: 'Registo de projetos ilegível.' };
  return {
    ok: true,
    at: new Date().toISOString(),
    projects: readProjects(dataDir)
      .map((p) => ({
        name: p.name,
        core: coreObservation(p.path, { details: true }),
      }))
      .filter((p) => p.core)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// Called only after the server's authentication and Host checks.
export function handleCoreDecision(req, res, ctx) {
  if (req.url.split('?')[0] !== '/api/core/decision') return false;
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST') { send(405, { error: 'Método não permitido.' }); return true; }
  if (crossSite(req)) { send(403, { error: 'Origem não permitida.' }); return true; }
  readBody(req, res, body => {
    let p; try { p = JSON.parse(body); } catch { send(400, { error: 'Pedido inválido.' }); return; }
    if (!p || typeof p.project !== 'string' || p.project.length > 200 || !/^F-\d+-[a-f0-9]{6}$/.test(p.run || '') || !/^D[1-8]$/.test(p.decision || '') || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(p.option || '')) {
      send(400, { error: 'Escolha inválida.' }); return;
    }
    if (loadProjects(ctx.dataDir).corrupt) { send(503, { error: 'Registo de projetos indisponível.' }); return; }
    const project = readProjects(ctx.dataDir).find(x => x.name === p.project);
    if (!project) { send(404, { error: 'Projeto não encontrado.' }); return; }
    try {
      const { run, changed } = decideTechnology(project.path, { runId: p.run, decisionId: p.decision, optionId: p.option, resume: true });
      const waiting = pendingTechnology(run).length > 0;
      let pid;
      if (changed && !waiting) {
        try { pid = launchCore({ dataDir: ctx.dataDir, forjaRoot: ctx.forjaRoot || CORE_ROOT, project: { ...project, runId: run.run_id }, spawnRunner: ctx.spawnRunner }); }
        catch { /* The decision stays durable; the guard or CLI can resume. */ }
      }
      send(200, { ok: true, waiting, resumed: Number.isInteger(pid) && pid > 0 });
    } catch { send(409, { error: 'A decisão mudou ou há um trabalhador ativo. Atualiza a página antes de escolher.' }); }
  });
  return true;
}
