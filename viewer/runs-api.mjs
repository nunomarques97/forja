// Viewer run API (docs/ARCHITECTURE.md §9): the two endpoints the phone uses to
// start or relaunch a Forja run without a terminal.
//
//   GET  /projects  → { ok, projects: [ { name, bootstrappedAt, run, runnerAlive } ] }
//                     (no `path`: the page identifies a project by name and
//                      nothing else — §10's rule, and the folder of every
//                      project on the PC has no business crossing the tunnel;
//                      500 when data/projects.json exists but cannot be read —
//                      an unreadable registry is never shown as "no projects")
//   POST /runs      → { project, goal }        → { ok, action: 'start',  project, pid }
//                     { project, resume: true } → { ok, action: 'resume', project, pid }
//
// This endpoint launches a process, so it is deliberately narrow:
// - the folder ALWAYS comes from data/projects.json (written by `forja bootstrap`),
//   never from the request: a request names a project, never a path;
// - the goal is one element of argv (`spawn` with an argument array, no shell,
//   no `exec`), validated for length and control characters;
// - the runner is started OUTSIDE the viewer's process tree (`defaultSpawnRunner`,
//   lib/spawn-runner.mjs): stopping, restarting or crashing the viewer never
//   stops a run;
// - the body is capped at 4 KB and must be JSON;
// - one launch per project per 30 s;
// - a cross-site POST is refused (Origin ≠ Host) on top of the token cookie's
//   SameSite=Lax, because this is the one route that has side effects outside
//   the data dir;
// - errors never carry paths, tokens or goal text; every launch is appended to
//   data/runner/spawn.log as status only (project, action, pid, goal length).
//
// Auth (token in ?k= / cookie forja_k) and the Host allow-list are applied by
// viewer/server.mjs BEFORE this handler runs.
import { existsSync } from 'node:fs';
import { coreObservation } from '../lib/core/observe.mjs';
import { listProjectsWithStatus, loadProjects, runSummary, runnerAlive } from '../lib/projects.mjs';
// The launch itself lives in lib/spawn-runner.mjs since the guard (lib/guard.mjs)
// became a second caller: viewer and guard start a runner the same way, or only
// one of them survives a `forja down`. Re-exported here because this is the
// import path the tests (and the viewer) have always used.
import { DETACH_SCRIPT, defaultSpawnRunner, launchRunner } from '../lib/spawn-runner.mjs';
export { DETACH_SCRIPT, defaultSpawnRunner };

export const MAX_BODY = 4 * 1024;
export const GOAL_MIN = 10;
export const GOAL_MAX = 600;
export const THROTTLE_MS = 30_000;
// C0 controls, line separators, and the invisible characters that let a goal read
// as one thing and land in argv and in RUN.json as another: soft hyphen, Arabic
// letter mark, Mongolian vowel separator, zero-width and bidi marks, bidi
// embedding/override, isolates, word joiner, invisible operators, BOM, and the
// tag characters (U+E0000-U+E007F, an invisible ASCII alphabet: the vehicle of
// choice for prompt injection nobody can see in the queue).
// Written as escapes, never as literal control characters in the source; the u
// flag is what makes the astral range a range of code points, not of surrogates.
export const CONTROL_RE = new RegExp('[\u0000-\u001F\u007F\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]', 'u');

// The spaces that arrive by accident and mean exactly what they look like: the
// no-break space (phone keyboards, a paste from a document), its narrow form,
// and the figure/thin spaces of typeset text. Refusing the goal over one of them
// is a dead end the Sponsor cannot diagnose (the text looks right), so they are
// normalised to a plain space before validation and never reach argv or RUN.json
// as anything else. Written as escapes, never as literal characters in the source.
export const normalizeGoal = s => String(s).replace(/[\u00A0\u2007\u2009\u202F]/g, ' ');

const send = (res, status, obj) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
};

// One launch per project per THROTTLE_MS, per data dir (a double tap on a phone
// must not produce two runners racing for the same lock).
const lastLaunch = new Map();
const throttleKey = (dataDir, name) => `${String(dataDir).toLowerCase()}|${name}`;

// A browser sends Origin on every POST, including a cross-site form post; the
// Host header was already checked against the allow-list by the server.
// No Origin at all is a non-browser client (curl, tests) and passes. `Origin:
// null` is refused here (`/runs` launches a process): it is what a sandboxed
// iframe, a data: document or a redirected cross-origin post sends, and no page
// of this viewer produces it once the visitor is in. The one caller that must
// accept it is `POST /login` (`allowNull`): the entry page sends
// `Referrer-Policy: no-referrer`, and by the Fetch spec a non-GET navigation
// under no-referrer carries `Origin: null` — refusing it there locks the
// Sponsor out with the right token in his hand, and a forged login proves
// nothing anyway (whoever posts the token already has it).
export function crossSite(req, { allowNull = false } = {}) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (origin === 'null') return !allowNull;
  try { return new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase(); } catch { return true; }
}

// The body arrives in chunks whose boundaries fall wherever TCP puts them —
// over the tunnel a goal past ~1,4 KB always arrives split. Decoding each chunk
// on its own turns a character cut in half into two U+FFFD (the goal would reach
// argv corrupted, with a 200 OK), so the chunks are kept as bytes and decoded
// once at the end; the cap is counted in bytes for the same reason.
export function readBody(req, res, onDone) {
  const chunks = []; let bytes = 0; let refused = false;
  req.on('data', d => {
    const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
    bytes += buf.length;
    if (refused) { if (bytes > 1024 * 1024) req.destroy(); return; } // answer 400 and drain; a body past 1 MB is dropped outright
    if (bytes > MAX_BODY) { refused = true; chunks.length = 0; send(res, 400, { error: 'pedido demasiado grande' }); return; }
    chunks.push(buf);
  });
  req.on('end', () => { if (!refused) onDone(Buffer.concat(chunks).toString('utf8')); });
  req.on('error', () => { refused = true; });
}

// Pure: the request body → { name, goal, resume } or { error } (400).
function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: 'objeto JSON com project e goal' };
  const name = payload.project;
  if (typeof name !== 'string' || !name.trim() || name.length > 200) return { error: 'falta o nome do projeto' };
  const resume = payload.resume === true;
  if (!resume) {
    if (typeof payload.goal !== 'string') return { error: 'falta o objetivo' };
    const goal = normalizeGoal(payload.goal).trim();
    if (CONTROL_RE.test(goal)) return { error: 'o objetivo tem caracteres de controlo ou invisíveis' };
    // `forja runner --goal <texto>` reads the next argv element: one that starts
    // with "-" would be taken for a flag and the run would start with no goal.
    if (goal.startsWith('-')) return { error: 'o objetivo não pode começar por "-"' };
    if (goal.length < GOAL_MIN) return { error: `o objetivo tem de ter pelo menos ${GOAL_MIN} caracteres` };
    if (goal.length > GOAL_MAX) return { error: `o objetivo não pode passar de ${GOAL_MAX} caracteres` };
    return { name: name.trim(), goal, resume: false };
  }
  return { name: name.trim(), goal: null, resume: true };
}

// `ctx.spawnRunner` stays the seam the viewer's own tests replace.
const launch = (ctx, project, action, goal) => launchRunner({
  dataDir: ctx.dataDir, forjaRoot: ctx.forjaRoot, project, goal, action, via: 'viewer', spawnRunner: ctx.spawnRunner || defaultSpawnRunner,
});

// An unreadable registry is never reported as "no projects": that reads like an
// empty machine, and the Sponsor would keep tapping. It is a 500 with a message
// that names the problem and no path (§10: errors carry no paths).
const REGISTRY_ERROR = 'o registo de projetos está ilegível — corrige-o no computador';

function handleProjects(req, res, ctx) {
  if (loadProjects(ctx.dataDir).corrupt) { send(res, 500, { error: REGISTRY_ERROR }); return; }
  // `path` is dropped here, not in lib/projects.mjs, where the registry is read
  // by code that runs on the PC and legitimately needs the folder. Over the
  // tunnel the project is a name and nothing else (the page never showed it).
  send(res, 200, { ok: true, projects: listProjectsWithStatus(ctx.dataDir).map(({ path, ...p }) => p) });
}

function handleRuns(req, res, ctx) {
  if (crossSite(req)) { send(res, 403, { error: 'pedido de outra origem' }); return; }
  readBody(req, res, body => {
    try {
      let payload;
      try { payload = JSON.parse(body); } catch { return send(res, 400, { error: 'JSON inválido' }); }
      const v = validate(payload);
      if (v.error) return send(res, 400, { error: v.error });

      const registry = loadProjects(ctx.dataDir);
      if (registry.corrupt) return send(res, 500, { error: REGISTRY_ERROR });
      // A pasta tem de existir mesmo: uma entrada antiga (pasta apagada, disco
      // desligado) não é um sítio onde arrancar um processo — e some da lista
      // do telemóvel pela mesma regra (lib/projects.mjs, readProjects).
      const project = registry.projects.find(p => p.name === v.name && existsSync(p.path));
      if (!project) return send(res, 404, { error: 'projeto desconhecido' });

      if (runnerAlive(project.path, ctx.dataDir)) return send(res, 409, { error: 'já há um runner vivo neste projeto' });
      const run = runSummary(project.path, ctx.dataDir);
      if (run?.driver === 'core' || (!run && coreObservation(project.path))) return send(res, 409, { error: 'projeto Core: usa forja core resume ou forja start no terminal; acompanha em /core' });
      const running = !!run && run.status === 'running';
      if (v.resume && !running) return send(res, 409, { error: 'não há run em curso para relançar' });
      // Only a runner-driven run is relaunched (docs/ARCHITECTURE.md §3c): a run
      // a conversation conducts, or one whose driver is unknown, never gets a
      // runner from the phone either — that is the second executor §3c forbids.
      // (The runner itself would refuse it; this answers before a process exists.)
      if (v.resume && run.driver !== 'runner') {
        return send(res, 409, { error: run.driver === 'interactive' ? 'este run é conduzido por uma conversa no computador — o runner não o assume' : 'não sei quem conduz este run — confirma-o no computador antes de o relançar' });
      }
      if (!v.resume && running) return send(res, 409, { error: 'há um run em curso — relança-o em vez de arrancar outro' });

      const key = throttleKey(ctx.dataDir, project.name);
      const now = Date.now();
      const last = lastLaunch.get(key) || 0;
      if (now - last < THROTTLE_MS) return send(res, 409, { error: `espera ${Math.ceil((THROTTLE_MS - (now - last)) / 1000)} s` });
      lastLaunch.set(key, now);

      let pid;
      try { pid = launch(ctx, project, v.resume ? 'resume' : 'start', v.goal); }
      catch (err) {
        lastLaunch.delete(key);
        console.error(`runs api: spawn falhou: ${err && err.message}`);
        return send(res, 500, { error: 'não consegui arrancar o runner' });
      }
      if (!pid) { lastLaunch.delete(key); return send(res, 500, { error: 'não consegui arrancar o runner' }); }
      return send(res, 200, { ok: true, action: v.resume ? 'resume' : 'start', project: project.name, pid });
    } catch (err) {
      console.error(`runs api: ${err && err.message}`);
      try { send(res, 400, { error: 'pedido inválido' }); } catch {}
    }
  });
}

// Returns true when it took the request (and will answer it), false otherwise.
// Synchronous on purpose: viewer/server.mjs routes inside a try/catch that an
// async handler would no longer cover; the POST finishes in its own callbacks.
export function handleRunsApi(req, res, ctx) {
  let pathname;
  try { pathname = new URL(req.url, 'http://forja.invalid').pathname; } catch { return false; }
  if (pathname === '/projects') {
    if (req.method !== 'GET') { send(res, 405, { error: 'método não permitido' }); return true; }
    handleProjects(req, res, ctx); return true;
  }
  if (pathname === '/runs') {
    if (req.method !== 'POST') { send(res, 405, { error: 'método não permitido' }); return true; }
    handleRuns(req, res, ctx); return true;
  }
  return false;
}
