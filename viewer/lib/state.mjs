// Forja state reducer — the viewer's brain. Pure over the event stream
// (data/events.jsonl lines, in arrival order), incremental, no I/O.
//
//   const st = createState();
//   for (const line of lines) applyLine(st, line, lineNo);
//   const snap = snapshot(st, Date.now());   // plain JSON for the UI
//
// Every rule here is documented in docs/ARCHITECTURE.md §8. The one that
// matters most: liveness is EVIDENCE (age of the last event under an
// agent_id or a session), never "saw SubagentStart and no SubagentStop" —
// Claude Code's SubagentStop is a confirmed unreliable boundary (§14).

export const THRESHOLDS = Object.freeze({
  QUIET_MS: 90_000,               // > 90 s silent: still working, amber "silêncio há Xs"
  UNRESPONSIVE_MS: 5 * 60_000,    // > 5 min silent (subagent): "sem resposta"
  MAIN_UNRESPONSIVE_MS: 10 * 60_000, // > 10 min silent (main session): "sem resposta"
  DEAD_MS: 30 * 60_000,           // > 30 min silent, no known end: "morto"
  HANDBACK_SETTLE_MS: 90_000,     // handback seen + 90 s of silence = finished
  PAIR_WINDOW_MS: 120_000,        // PreToolUse(Agent) → SubagentStart pairing window
  PERMISSION_NOTIFY_MS: 2 * 60_000,       // watchdog: a permission pending this long → ntfy
  WATCHDOG_IGNORE_AFTER_MS: 12 * 60 * 60_000, // watchdog: runs silent this long are history, never notified
});

// Every payload field is untyped data: hooks and the CLI are trusted, but a
// corrupt or hand-edited line must never throw inside the reducer.
const str = v => (v === null || v === undefined) ? '' : typeof v === 'string' ? v : typeof v === 'object' ? '' : String(v);

export const STATES = Object.freeze({
  INATIVO: 'inativo',
  TRABALHAR: 'a trabalhar',
  ESPERA_REVIEW: 'à espera de review',
  BLOQUEADO: 'bloqueado',
  SPONSOR: 'precisa do Sponsor',
  SEM_RESPOSTA: 'sem resposta',
  MORTO: 'morto',
  TERMINADO: 'terminado',
  FALHOU: 'falhou',
  ESPERA_INPUT: 'à espera de input',
  ESPERA_QUOTA: 'à espera de quota',
  PAUSA: 'em pausa',
});

// Fixed roster (docs/ARCHITECTURE.md §2): ten roles, plain English names.
// `core` roles take part in every run; the others are woken on trigger and
// shown as idle until then (never hidden). `types` are the agent_type values
// that map to each role; the legacy forge names come from older agent files
// and old event data.
export const ROSTER = Object.freeze([
  { key: 'lead', name: 'Lead', role: 'Coordena, delega, verifica em disco, regista', core: true, types: [] },
  { key: 'architect', name: 'Architect', role: 'O plano de tasks; replaneia quando parte', core: true, types: ['architect', 'tracador'] },
  { key: 'frontend-dev', name: 'Frontend Dev', role: 'Ecrãs, estilo, verificação visual', core: true, types: ['frontend-dev', 'frontend', 'lapidador'] },
  { key: 'backend-dev', name: 'Backend Dev', role: 'Servidor, dados, scripts', core: true, types: ['backend-dev', 'backend', 'fundidor'] },
  { key: 'reviewer', name: 'Reviewer', role: 'Revisão independente — aprova ou recusa', core: true, types: ['reviewer', 'contraste'] },
  { key: 'product-manager', name: 'Product Manager', role: 'Perfil de produto, enquadramento, decisões, relatório', core: false, types: ['product-manager', 'bigorna'] },
  { key: 'product-designer', name: 'Product Designer', role: 'Direção visual: mocks, escolha, DESIGN.md', core: false, types: ['product-designer', 'designer'] },
  { key: 'technology-scout', name: 'Technology Scout', role: 'Escolha de tecnologia por capacidade', core: false, types: ['technology-scout', 'scout'] },
  { key: 'qa', name: 'QA', role: 'Validação final: e2e, regressão', core: false, types: ['qa'] },
  { key: 'security-reviewer', name: 'Security Reviewer', role: 'Segunda revisão: auth, segredos, rede, dependências', core: false, types: ['security-reviewer', 'security'] },
]);
const TYPE_TO_ROLE = new Map();
for (const r of ROSTER) for (const t of r.types) TYPE_TO_ROLE.set(t, r.key);
export const roleOfType = t => TYPE_TO_ROLE.get(String(t || '').toLowerCase()) || 'native';

const TASK_RE = /\b(T\d+)\b/;
const HANDBACK_RE = /^\s*(DONE|BLOCKED|FAILED|SECURITY-APPROVE|SECURITY-REJECT|APPROVE|REJECT|QA|PLAN|FRAME)\b/i;
const FALLBACK_ERR_RE = /rate.?limit|usage.?limit|quota|overloaded|\b429\b|\b529\b/i;
const FORJA_CLI_RE = /forja\.mjs["']?\s+(progress|task|decide|ask|run|fallback)\b/;

export function projectKey(cwd) {
  return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const clip = (s, n = 160) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const firstLine = s => String(s ?? '').split('\n')[0];

// One short Portuguese line: what an event is doing.
export function describe(rec) {
  const t = rec.tool_input && typeof rec.tool_input === 'object' ? rec.tool_input : {};
  switch (rec.tool_name) {
    case 'Read': return `a ler ${base(t.file_path)}`;
    case 'Write': return `a escrever ${base(t.file_path)}`;
    case 'Edit': case 'NotebookEdit': return `a editar ${base(t.file_path || t.notebook_path)}`;
    case 'Bash': case 'PowerShell': return `a correr: ${clip(t.description || t.command || '', 90)}`;
    case 'Glob': case 'Grep': return `a procurar ${clip(t.pattern || '', 60)}`;
    case 'Agent': case 'Task': return `a delegar: ${clip(t.description || 'subagente', 90)}`;
    case 'SubagentHandback': return `a entregar: ${clip(firstLine(t.message), 90)}`;
    case 'WebFetch': case 'WebSearch': return `a pesquisar ${clip(t.url || t.query || '', 60)}`;
    case 'TaskOutput': case 'TaskStop': case 'SendMessage': return `${rec.tool_name.toLowerCase()} ${clip(t.to || t.task_id || '', 30)}`;
    case 'Skill': return `skill ${clip(t.skill || '', 40)}`;
    default:
      if (rec.tool_name) return clip(`${rec.tool_name}`, 60);
      return rec.hook_event_name ? `evento ${rec.hook_event_name}` : 'evento';
  }
}

export function createState() {
  // runs: keyed by run key — the Forja run_id once a session ran `forja run
  // start`/`run resume`, else the session_id. sessionToRun maps every
  // session_id to its run key so a run can span several sessions (§3).
  // `runnerSessions`: session id -> the `runner.session` that launched it. The
  // runner emits that event from the session it is replacing, so in visible mode
  // it lands in a different run object than the session it describes (§3b).
  return { runs: new Map(), sessionToRun: new Map(), runnerSessions: new Map(), lines: 0, badLines: 0, lastTs: 0, latestRunId: null, latestSessionId: null };
}

function ts(rec, state) {
  const t = Date.parse(rec.ts);
  return Number.isFinite(t) ? t : state.lastTs;
}

function newRun(id, rec, t) {
  return {
    id, sessions: [rec.session_id || 'sem-sessao'], project: rec.project || base(rec.cwd) || '?', cwd: rec.cwd || null, cwdKey: projectKey(rec.cwd),
    startedAt: t, lastEventAt: t, endedAt: null, endReason: null, source: null, permissionMode: rec.permission_mode || null,
    goal: null, goalSource: null, synthetic: rec.session_id === 'test-session-id',
    // T-UI-9. `announced`: esta sessão (ou outra do mesmo run) correu `forja run
    // start`/`run resume` — é o que separa um run verdadeiro de uma sessão solta
    // do Claude Code no mesmo projeto, que o redutor também guarda aqui (§3).
    // `interactive`: alguém escreveu mesmo um prompt nesta sessão (um prompt
    // injetado pelo harness ou pelo runner não conta).
    announced: false, interactive: false,
    main: { lastEventAt: t, lastAction: null, turnEndedAt: null, turnEndedMessage: null, turnEndedByRunner: false, permission: null, stopFailure: null, quotaWait: null, compactions: 0, lastPromptAt: null, calls: 0, effort: null, sessionId: rec.session_id || null, refused: 0, pendingTools: new Map() },
    instances: new Map(), latestByAgentId: new Map(), pending: [],
    tasks: new Map(), decisions: [], queue: [], reviews: [], fallbacks: [], modelSwitches: [], progress: null,
    forja: { status: null, runId: null, modelFloor: 'fable', forjalvl: 'high', modelLevel: 'high', autonomy: 'normal', checkpoints: 0, lastCheckpointAt: null, phase: null, fallbackReviewed: [], pause: null, runner: null, runnerSession: null },
    timeline: [], counts: { events: 0, errors: 0, denied: 0 },
  };
}

function getRun(state, rec, t) {
  const sid = str(rec.session_id) || 'sem-sessao';
  let key = state.sessionToRun.get(sid);
  let run = key ? state.runs.get(key) : null;
  if (!run && state.runs.has(sid)) {
    // A run already sits under this key (a run_id used as a session id, or a
    // stale mapping): join it rather than overwrite it.
    run = state.runs.get(sid);
    state.sessionToRun.set(sid, sid);
    if (!run.sessions.includes(sid)) run.sessions.push(sid);
  }
  if (!run) {
    run = newRun(sid, rec, t);
    state.runs.set(sid, run);
    state.sessionToRun.set(sid, sid);
  }
  return run;
}

// A session announced `forja run start`/`run resume` with a run_id: the
// session's run is re-keyed to that id, or merged into the run that already
// carries it (a resumed run keeps its tasks, decisions, queue and history;
// the newest session becomes its live main session).
function attachRun(state, run, runId, rec, t) {
  runId = str(runId);
  if (!runId || run.forja.runId === runId) return run;
  const sid = str(rec.session_id) || 'sem-sessao';
  const existing = state.runs.get(runId);
  if (run.forja.runId) {
    // This session already belongs to a different run (e.g. `run finish`
    // then `run start` in the same session): the session moves on, the old
    // run keeps its identity and history untouched.
    const target = existing || newRun(runId, rec, t);
    target.forja.runId = runId;
    if (!target.sessions.includes(sid)) target.sessions.push(sid);
    state.runs.set(runId, target);
    state.sessionToRun.set(sid, runId);
    return target;
  }
  if (existing && existing !== run) {
    mergeRun(existing, run, t);
    state.runs.delete(run.id);
    for (const s of run.sessions) state.sessionToRun.set(s, runId);
    return existing;
  }
  state.runs.delete(run.id);
  run.id = runId; run.forja.runId = runId;
  state.runs.set(runId, run);
  state.sessionToRun.set(sid, runId);
  return run;
}

function mergeRun(target, source, t) {
  for (const s of source.sessions) if (!target.sessions.includes(s)) target.sessions.push(s);
  for (const [k, v] of source.instances) target.instances.set(k, v);
  for (const [k, v] of source.latestByAgentId) target.latestByAgentId.set(k, v);
  target.pending.push(...source.pending);
  for (const [k, v] of source.tasks) { const cur = target.tasks.get(k); if (!cur || v.updatedAt >= cur.updatedAt) target.tasks.set(k, v); }
  for (const f of ['decisions', 'queue', 'reviews', 'fallbacks', 'modelSwitches', 'timeline']) { target[f].push(...source[f]); target[f].sort((a, b) => a.ts - b.ts); }
  target.counts.events += source.counts.events; target.counts.errors += source.counts.errors; target.counts.denied += source.counts.denied;
  const compactions = target.main.compactions + source.main.compactions;
  const model = source.main.model || target.main.model || null; // the runner's Lead model survives a session change
  target.main = { ...source.main, compactions, model }; // the newest session is the live one
  target.lastEventAt = Math.max(target.lastEventAt, source.lastEventAt);
  target.startedAt = Math.min(target.startedAt, source.startedAt);
  target.announced = target.announced || source.announced;
  target.interactive = target.interactive || source.interactive;
  target.endedAt = null; target.endReason = null; // the run is alive again
  if (!target.goal && source.goal) { target.goal = source.goal; target.goalSource = source.goalSource; }
  if (source.progress && (!target.progress || source.progress.ts > target.progress.ts)) target.progress = source.progress;
  target.forja.modelFloor = source.forja.modelFloor || target.forja.modelFloor;
  target.timeline.push({ ts: t, kind: 'session', text: `Run retomado numa sessão nova (${str(source.sessions[0]).slice(0, 8)})` });
}

function note(run, t, kind, text, extra = {}) {
  run.timeline.push({ ts: t, kind, text, ...extra });
  if (run.timeline.length > 2000) run.timeline.splice(0, run.timeline.length - 2000);
}

function newInstance(run, rec, t, agentId, agentType, origin) {
  const type = agentType || 'desconhecido';
  const role = roleOfType(type);
  const suffix = run.instances.has(agentId) ? `#${[...run.instances.keys()].filter(k => k.startsWith(agentId)).length + 1}` : '';
  const key = agentId + suffix;
  const inst = {
    key, agentId, type, role, sessionId: str(rec.session_id) || null, startedAt: t, lastEventAt: t, endedAt: null, endReason: null, error: null,
    task: null, taskId: null, prompt: null, requestedModel: null, resolvedModel: null, background: null, toolUseId: null,
    calls: 0, lastAction: null, handback: null, verdict: null, progress: null, permission: null, denied: 0, refused: 0, origin,
    reannounced: 0, sawStart: origin === 'start', pendingTools: new Map(),
  };
  run.instances.set(key, inst);
  run.latestByAgentId.set(agentId, key);
  return inst;
}

function instanceFor(run, agentId) {
  const key = run.latestByAgentId.get(agentId);
  return key ? run.instances.get(key) : null;
}

function pairPending(run, inst, t) {
  const idx = run.pending.findIndex(p => !p.agentId && sameType(p.subagentType, inst.type) && t - p.ts <= THRESHOLDS.PAIR_WINDOW_MS && t >= p.ts - 2000);
  if (idx === -1) return;
  const p = run.pending[idx];
  p.agentId = inst.agentId;
  adoptCall(inst, p);
}
function sameType(a, b) {
  a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase();
  return a === b || roleOfType(a) === roleOfType(b) && roleOfType(a) !== 'native';
}
function adoptCall(inst, p) {
  const desc = str(p.description);
  inst.task = inst.task || desc || null;
  inst.taskId = inst.taskId || (desc.match(TASK_RE) || [])[1] || null;
  inst.prompt = inst.prompt || str(p.prompt) || null;
  inst.requestedModel = inst.requestedModel || str(p.model) || null;
  inst.background = inst.background ?? (typeof p.background === 'boolean' ? p.background : null);
  inst.toolUseId = inst.toolUseId || str(p.toolUseId) || null;
}

function endInstance(inst, t, reason, extra = {}) {
  if (inst.endedAt) return;
  inst.endedAt = t;
  inst.endReason = reason;
  Object.assign(inst, extra);
  if (inst.permission) inst.permission = null;
}

// A tool call whose PostToolUse never came before the actor's turn ended was
// refused (hard deny: no PermissionDenied hook fires in headless/-p mode —
// verified 16 set 2026), errored without a failure hook, or is still hanging
// when the turn closed. Counted at turn boundaries only, never on the next
// PreToolUse: Claude issues parallel tool calls inside one message, so
// "Pre B before Post A" is normal, "turn ended with A open" is not.
function settlePendingTools(run, actor, t, label, agentId = null) {
  const pend = actor.pendingTools;
  if (!pend || !pend.size) return;
  for (const p of pend.values()) {
    if (p.tool === 'SubagentHandback' || p.tool === 'Agent' || p.tool === 'Task') continue;
    actor.refused = (actor.refused || 0) + 1;
    note(run, t, 'tool.refused', `${label}: ${p.action} — ficou sem resposta (recusada ou falhada)`, { agentId, tool: p.tool });
  }
  pend.clear();
}

// A Reviewer hand-back and the lead's later `task done`/`task fail` describe
// the same verdict: merge them into one review entry instead of two.
function addReview(run, review) {
  const last = run.reviews.at(-1);
  if (last && last.taskId && last.taskId === review.taskId && last.verdict === review.verdict && review.ts - last.ts < 15 * 60_000 && last.source !== review.source) {
    Object.assign(last, { text: review.text || last.text, final: review.final || last.final, confirmedAt: review.ts });
    return last;
  }
  run.reviews.push(review);
  return review;
}

function setTask(run, id, patch, t) {
  id = str(id);
  if (!id) return null;
  let task = run.tasks.get(id);
  if (!task) { task = { id, title: null, owner: null, status: 'todo', attempts: 0, criteria: null, after: null, createdAt: t, updatedAt: t, evidence: null, verdicts: [], why: null }; run.tasks.set(id, task); }
  // Only defined, scalar-ish fields are applied: a `task.start` without a
  // title must not erase the title `task.add` gave, and a malformed field
  // never lands in the task as an object.
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    task[k] = (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) ? v : str(v) || null;
  }
  task.updatedAt = t;
  return task;
}

// ---------- Forja CLI events (hook_event_name: "Forja") ----------
// O forjalvl do run (docs/ARCHITECTURE.md §6) chega no `run.start` e em cada
// `runner.session`, com os dois nomes aceites: `forjalvl` (desde a decisão do
// Sponsor de 17 set 2026) e o antigo `model_level`, para um stream gravado antes
// da mudança reproduzir na mesma. O snapshot expõe os dois — `modelLevel` é só
// um alias do `forjalvl`.
// `keepWhenMissing`: um evento que não traz nenhum dos dois não apaga o que já
// se sabia (só o `run.start` decide o valor por omissão, `high` — regra do
// Sponsor, 18 set 2026; lib/models.mjs é a fonte, isto só espelha o mesmo default).
function setForjalvl(run, f, { keepWhenMissing = false } = {}) {
  const v = str(f.forjalvl) || str(f.model_level);
  if (!v && keepWhenMissing) return;
  run.forja.forjalvl = v || 'high';
  run.forja.modelLevel = run.forja.forjalvl;
}

// A autonomia do run (docs/ARCHITECTURE.md §6b) chega no `run.start` e em cada
// `runner.session`. Um evento gravado antes desta funcionalidade não a traz e lê
// como `normal`, que foi o que esses runs fizeram; `keepWhenMissing` serve ao
// `runner.session`, que não apaga o que já se sabia (só o `run.start` decide o
// valor por omissão). Só `normal` e `total` são aceites: tudo o resto lê como
// `normal` (ver abaixo).
const AUTONOMY_VALUES = new Set(['normal', 'total']);
function setAutonomy(run, f, { keepWhenMissing = false } = {}) {
  const v = str(f.autonomy);
  if (!v && keepWhenMissing) return;
  // Ao contrário do forjalvl, aqui o redutor não é um espelho cego do stream:
  // só `normal` e `total` existem, e qualquer outra coisa (evento adulterado,
  // stream de uma versão futura, valor corrompido) lê como `normal` — o valor
  // estrito. Um campo estranho nunca pode fazer a UI dizer que o run corre com
  // mais liberdade do que o Sponsor deu.
  run.forja.autonomy = AUTONOMY_VALUES.has(v) ? v : 'normal';
}

function applyForja(state, run, rec, t) {
  const f = rec.forja || {};
  const k = f.kind;
  // Um run_id no payload é prova de pertença, venha no evento que vier: as sessões
  // de fase do runner nunca correm `run start`/`run resume`, mas carimbam o run_id
  // em `task.*`, `run.checkpoint` e `runner.session` — medido nos três runs reais
  // de 17 set 2026. Sem isto ficavam de fora do run, como falsas «sessões soltas».
  if (f.run_id) run = attachRun(state, run, str(f.run_id), rec, t);
  switch (k) {
    case 'run.start':
      run.announced = true; // anunciou-se: é um run, nunca uma sessão solta (T-UI-9)
      run.forja.status = 'running'; run.forja.runId = f.run_id || run.forja.runId || rec.session_id; run.goal = f.goal || run.goal; run.goalSource = 'forja';
      if (f.model_floor) run.forja.modelFloor = f.model_floor;
      setForjalvl(run, f); // forjalvl do run (docs/ARCHITECTURE.md §6)
      setAutonomy(run, f); // autonomia do run (docs/ARCHITECTURE.md §6b)
      note(run, t, 'run.start', `Run começou: ${clip(f.goal || '', 120)}`); break;
    case 'run.resume':
      run.announced = true; // idem: retomar um run é anunciá-lo (T-UI-9)
      if (run.forja.status !== 'finished' && run.forja.status !== 'failed') run.forja.status = 'running';
      if (f.goal && !run.goal) { run.goal = f.goal; run.goalSource = 'forja'; }
      note(run, t, 'run.resume', `Run retomado: ${clip(f.note || run.goal || '', 120)}`); break;
    case 'run.checkpoint':
      run.forja.checkpoints += 1; run.forja.lastCheckpointAt = t; note(run, t, 'checkpoint', `Checkpoint ${run.forja.checkpoints}: ${clip(f.note || 'handover atualizado', 100)}`); break;
    case 'run.finish': run.forja.status = 'finished'; note(run, t, 'run.finish', `Run terminou: ${clip(f.note || '', 120)}`); break;
    case 'run.fail': run.forja.status = 'failed'; note(run, t, 'run.fail', `Run falhou: ${clip(f.why || '', 120)}`); break;
    case 'run.block': run.forja.status = 'blocked'; run.forja.why = clip(str(f.why), 160) || null; note(run, t, 'run.block', `Run bloqueado: ${clip(f.why || '', 120)}`); break;
    case 'run.pause': { const at = Number.isFinite(Date.parse(str(f.resume_at))) ? Date.parse(str(f.resume_at)) : null; run.forja.pause = { since: t, resumeAt: at, reason: str(f.reason) || 'limite de utilização', message: clip(str(f.message), 160) }; note(run, t, 'run.pause', `Em pausa: ${run.forja.pause.reason}${at ? `, retoma às ${new Date(at).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })}` : ''}`); break; }
    case 'run.unpause': run.forja.pause = null; note(run, t, 'run.unpause', `Retomou depois da pausa${f.note ? `: ${clip(f.note, 100)}` : ''}`); break;
    case 'runner.session':
      if (f.model) run.main.model = str(f.model);
      setForjalvl(run, f, { keepWhenMissing: true });
      setAutonomy(run, f, { keepWhenMissing: true });
      // A new runner session replaces the previous one: its subagents are gone with it
      // (the runner kills the whole tree), so they must not linger as "sem resposta"/"morto".
      if (str(f.session_id)) for (const i of run.instances.values()) if (!i.endedAt && i.sessionId && i.sessionId !== str(f.session_id)) endInstance(i, t, 'sessão substituída pelo runner');
      run.forja.runner = { phase: str(f.phase), task: str(f.task) || null, attempt: f.attempt ?? null, session: str(f.session_id) || null, ts: t };
      // The session this event says the runner launched is a runner session even
      // if its own events land in another run object (visible mode, §3b).
      if (str(f.session_id)) {
        state.runnerSessions.set(str(f.session_id), run.forja.runner);
        const owner = state.runs.get(state.sessionToRun.get(str(f.session_id)));
        if (owner && owner !== run) owner.forja.runnerSession = run.forja.runner;
      }
      note(run, t, 'runner', `Runner: sessão ${str(f.phase)}${f.task ? ` ${str(f.task)}` : ''}${f.attempt ? ` (tentativa ${f.attempt})` : ''}`); break;
    case 'runner.timeout': note(run, t, 'runner', `Runner: ${str(f.task) || 'sessão'} excedeu ${f.minutes ?? '?'} min — sessão terminada, tentativa falhada`); break;
    case 'runner.exit':
      run.forja.runner = { ...(run.forja.runner || {}), exited: true, why: str(f.why) || null, exitedAt: t };
      for (const i of run.instances.values()) if (!i.endedAt) endInstance(i, t, 'runner terminou'); // the tree died with it
      note(run, t, 'runner', `Runner terminou: ${clip(str(f.why), 100)}`); break;
    case 'task.add': setTask(run, f.id, { title: f.title, owner: f.owner || null, complexity: f.complexity || null, criteria: f.criteria || null, after: f.after || null, status: 'todo' }, t); note(run, t, 'task.add', `Task ${f.id} criada: ${clip(f.title, 100)}`); break;
    case 'task.start': { const task = setTask(run, f.id, { status: 'doing', attempts: f.attempts ?? undefined, title: f.title ?? undefined }, t); if (task && f.attempts != null) task.attempts = f.attempts; note(run, t, 'task.start', `Task ${f.id} em curso${f.attempts ? ` (tentativa ${f.attempts})` : ''}`); break; }
    case 'task.review': setTask(run, f.id, { status: 'review' }, t); note(run, t, 'task.review', `Task ${f.id} à espera de review`); break;
    case 'task.done': { const task = setTask(run, f.id, { status: 'done', evidence: f.evidence || null }, t); if (task) task.verdicts.push({ ts: t, verdict: 'APPROVE', text: f.verdict || null }); addReview(run, { ts: t, taskId: str(f.id), verdict: 'APPROVE', text: str(f.verdict) || null, by: 'reviewer', source: 'cli' }); note(run, t, 'task.done', `Task ${f.id} aprovada e fechada`); break; }
    case 'task.fail': {
      // `--no-attempt` (runner recovery after a usage-limit pause): the task goes back to
      // todo without a verdict and without spending an attempt.
      if (f.no_attempt) { const task = setTask(run, f.id, { status: 'todo', why: f.why || null }, t); if (task && f.attempts != null) task.attempts = f.attempts; note(run, t, 'task.fail', `Task ${f.id} devolvida sem gastar tentativa: ${clip(f.why, 100)}`); break; }
      const task = setTask(run, f.id, { status: f.final ? 'failed' : 'todo', why: f.why || null }, t); if (task) { task.attempts = f.attempts ?? task.attempts + 1; task.verdicts.push({ ts: t, verdict: 'REJECT', text: f.why || null }); } addReview(run, { ts: t, taskId: str(f.id), verdict: 'REJECT', text: str(f.why) || null, by: (/^segurança:/i.test(str(f.why)) ? 'security-reviewer' : 'reviewer'), final: !!f.final, source: 'cli' }); note(run, t, 'task.fail', f.final ? `Task ${f.id} falhou 3 vezes — fechada com evidência` : `Task ${f.id} recusada (tentativa ${f.attempts ?? '?'}): ${clip(f.why, 100)}`); break; }
    case 'task.block': setTask(run, f.id, { status: 'blocked', why: f.why || null }, t); note(run, t, 'task.block', `Task ${f.id} bloqueada: ${clip(f.why, 100)}`); break;
    case 'decision': run.decisions.push({ ts: t, id: f.id || null, text: f.text, why: f.why || null, reversible: f.reversible ?? null, by: f.by || 'Product Manager', superseded: null }); note(run, t, 'decision', `Decisão ${f.id || ''}: ${clip(f.text, 110)}`); break;
    case 'ask': run.queue.push({ ts: t, id: f.id || null, question: f.text, default: f.default || null, why: f.why || null, status: 'open', answer: null, answeredAt: null }); note(run, t, 'ask', `Pergunta para o Sponsor ${f.id || ''}: ${clip(f.text, 100)}`); break;
    case 'answer.pending': { const q = run.queue.find(x => x.id === f.id); if (q && q.status === 'open') { q.status = 'pending'; q.answer = f.text || null; q.answeredAt = t; } note(run, t, 'answer', `Sponsor respondeu ${f.id || ''} pelo viewer (à espera de recolha): ${clip(f.text, 100)}`); break; }
    case 'answer': { const q = run.queue.find(x => x.id === f.id) || run.queue.find(x => x.status === 'open' || x.status === 'pending'); if (q) { q.status = 'answered'; q.answer = f.text || null; q.answeredAt = t; } note(run, t, 'answer', `Sponsor respondeu ${f.id || ''}: ${clip(f.text, 100)}`); break; }
    case 'fallback': run.fallbacks.push({ ts: t, role: f.role || null, from: f.from || null, to: f.to || null, why: f.why || null }); if (f.to) run.forja.modelFloor = f.to; note(run, t, 'fallback', `Fallback de modelo (${f.role || '?'}): ${f.from || '?'} → ${f.to || '?'}`); break;
    case 'progress': run.progress = { ts: t, text: f.text, role: f.role || null }; if (f.agent_id) { const inst = instanceFor(run, f.agent_id); if (inst) inst.progress = { ts: t, text: f.text }; } break;
    case 'notify': note(run, t, 'notify', `Notificação: ${clip(f.text, 100)}`); break;
    default: note(run, t, 'forja', `${k || 'evento forja'}: ${clip(JSON.stringify(f), 100)}`);
  }
}

// ---------- hook events ----------
export function applyEvent(state, rec, lineNo = null) {
  if (!rec || typeof rec !== 'object') return;
  state.lines += 1;
  const t = ts(rec, state);
  state.lastTs = Math.max(state.lastTs, t);
  // A record without a session (a corrupt line, a hook fed garbage) belongs
  // to whatever session was last seen, never to a run keyed by run_id.
  if (!str(rec.session_id) && state.latestSessionId) rec.session_id = state.latestSessionId;
  if (str(rec.session_id)) state.latestSessionId = str(rec.session_id);
  const run = getRun(state, rec, t);
  // This session was launched by the runner for one phase (T-VIS-2): the end of
  // its turn is the normal end of the phase, never a person's cue.
  const launched = state.runnerSessions.get(str(rec.session_id));
  if (launched) run.forja.runnerSession = launched;
  run.lastEventAt = Math.max(run.lastEventAt, t);
  run.counts.events += 1;
  state.latestRunId = run.id;
  if (rec.permission_mode) run.permissionMode = rec.permission_mode;
  if (rec.parse_error) { state.badLines += 1; run.counts.errors += 1; note(run, t, 'bad-line', `Linha ${lineNo ?? '?'} corrompida no stream (ignorada)`); return; }
  const name = rec.hook_event_name;
  if (name === 'Forja') { applyForja(state, run, rec, t); return; }

  const agentId = typeof rec.agent_id === 'string' ? rec.agent_id : (rec.agent_id == null ? null : str(rec.agent_id));
  const inSub = Boolean(agentId && rec.agent_type !== undefined);

  // --- session-level events (main session only) ---
  if (name === 'SessionStart') {
    run.source = rec.source || run.source;
    if (run.endedAt) { run.endedAt = null; run.endReason = null; }
    run.main.lastEventAt = Math.max(run.main.lastEventAt, t);
    note(run, t, 'session', rec.source === 'resume' ? 'Sessão retomada' : rec.source === 'compact' ? 'Sessão continuou depois de compactar' : rec.source === 'clear' ? 'Sessão limpa (clear)' : 'Sessão começou');
    return;
  }
  if (name === 'SessionEnd') {
    run.endedAt = t; run.endReason = rec.reason || null; run.main.permission = null;
    for (const inst of run.instances.values()) if (!inst.endedAt) endInstance(inst, t, 'session-ended');
    note(run, t, 'session.end', `Sessão terminou (${rec.reason || 'sem motivo'})`);
    return;
  }
  if (name === 'UserPromptSubmit') {
    run.main.lastEventAt = Math.max(run.main.lastEventAt, t); run.main.turnEndedAt = null; run.main.turnEndedByRunner = false; run.main.lastPromptAt = t; run.main.stopFailure = null; run.main.quotaWait = null;
    // Harness-injected turns (subagent hand-backs, task notifications) also
    // arrive as UserPromptSubmit; they start with '<' or '[' and are never
    // the Sponsor's goal.
    const promptText = str(rec.prompt).trim();
    const injected = /^[<[]/.test(promptText);
    if (promptText && !injected) run.interactive = true; // alguém escreveu aqui (T-UI-9)
    if (!run.goal && promptText && !injected) { run.goal = clip(promptText, 400); run.goalSource = 'prompt'; }
    note(run, t, 'prompt', injected ? `Mensagem interna entregue à sessão principal: ${clip(promptText, 80)}` : `Prompt do Sponsor: ${clip(promptText, 100)}`);
    return;
  }
  if (name === 'Stop') {
    settlePendingTools(run, run.main, t, 'Lead');
    run.main.turnEndedAt = t; run.main.turnEndedMessage = clip(firstLine(rec.last_assistant_message), 160); run.main.lastEventAt = Math.max(run.main.lastEventAt, t); run.main.permission = null;
    // Whether THIS session — the one that just ended its turn — was launched by
    // the runner for a phase (T-VIS-2). Never "the run has a runner somewhere":
    // with the runner dead and the Sponsor opening an interactive session in the
    // same run, the end of his turn is a real ticket for him.
    run.main.turnEndedByRunner = state.runnerSessions.has(str(rec.session_id));
    note(run, t, 'stop', `Sessão principal terminou o turno${run.main.turnEndedMessage ? `: ${run.main.turnEndedMessage}` : ''}`);
    return;
  }
  if (name === 'StopFailure') {
    run.main.stopFailure = { ts: t, type: rec.type || rec.error_type || 'unknown', message: clip(rec.message || rec.error || '', 160) };
    run.main.lastEventAt = Math.max(run.main.lastEventAt, t);
    note(run, t, 'stop.failure', `Sessão principal parou com erro: ${run.main.stopFailure.type}`);
    return;
  }
  if (name === 'PreCompact' || name === 'PostCompact') {
    if (name === 'PreCompact') run.main.compactions += 1;
    run.main.lastEventAt = Math.max(run.main.lastEventAt, t);
    note(run, t, 'compact', name === 'PreCompact' ? `Contexto a compactar (${rec.trigger || 'auto'})` : 'Contexto compactado');
    return;
  }
  if (name === 'PreModelSwitch' || name === 'PostModelSwitch') {
    if (name === 'PostModelSwitch') { run.modelSwitches.push({ ts: t, from: rec.from_model || rec.previous_model || null, to: rec.to_model || rec.model || null, reason: rec.reason || null }); note(run, t, 'model.switch', `Modelo mudou: ${rec.from_model || rec.previous_model || '?'} → ${rec.to_model || rec.model || '?'}`); }
    run.main.lastEventAt = Math.max(run.main.lastEventAt, t);
    return;
  }
  if (name === 'Notification') {
    const kind = str(rec.notification_type) || str(rec.type);
    const msg = clip(str(rec.message), 160);
    if (kind === 'permission_prompt') {
      const target = inSub ? instanceFor(run, agentId) : null;
      const perm = { since: t, tool: rec.tool_name || null, message: msg };
      if (target) target.permission = perm; else run.main.permission = perm;
      note(run, t, 'permission', `Pedido de permissão pendente${msg ? `: ${msg}` : ''}`);
    } else if (kind === 'idle_prompt') {
      // Claude Code sends this ~60 s after Stop: it confirms the turn ended,
      // it is never proof of work.
      run.main.turnEndedAt = Math.max(run.main.turnEndedAt || 0, t);
      run.main.lastEventAt = Math.max(run.main.lastEventAt, t);
    } else if (kind.startsWith('quota_auto_resume')) {
      run.main.quotaWait = kind === 'quota_auto_resume_fired' ? null : { since: t, kind };
      run.main.stopFailure = null;
      note(run, t, 'quota', kind === 'quota_auto_resume_fired' ? 'Limite de utilização reposto — sessão retomou' : kind === 'quota_auto_resume_stale' ? 'Limite reposto enquanto o PC dormia — precisa de Enter no terminal' : 'Espera por limite de utilização terminou sem retomar');
    } else if (kind === 'agent_needs_input') {
      note(run, t, 'permission', `Um agente precisa de input${msg ? `: ${msg}` : ''}`);
    }
    // Notifications are about waiting, never proof that the main session is
    // working: they do not advance main.lastEventAt (idle_prompt handled above).
    return;
  }
  if (name === 'PermissionRequest') {
    const perm = { since: t, tool: rec.tool_name || null, message: clip(describe(rec), 120) };
    if (inSub) { const inst = instanceFor(run, agentId); if (inst) inst.permission = perm; } else run.main.permission = perm;
    note(run, t, 'permission', `Permissão pedida: ${describe(rec)}`);
    return;
  }
  if (name === 'PermissionDenied') {
    run.counts.denied += 1;
    const tuid = str(rec.tool_use_id);
    // The denied call must not also be counted as "refused" at turn end. With
    // a tool_use_id the match is exact; without one (payload shape unverified
    // in real data), drop the most recent pending call of the same tool name.
    const settleDenied = actor => {
      if (tuid && actor.pendingTools.has(tuid)) { actor.pendingTools.delete(tuid); return; }
      const tool = str(rec.tool_name);
      let last = null;
      for (const [k, p] of actor.pendingTools) if (!tool || p.tool === tool) last = k;
      if (last) actor.pendingTools.delete(last);
    };
    if (inSub) { const inst = instanceFor(run, agentId); if (inst) { inst.permission = null; inst.denied += 1; inst.lastEventAt = Math.max(inst.lastEventAt, t); settleDenied(inst); } }
    else { run.main.permission = null; settleDenied(run.main); }
    note(run, t, 'denied', `Permissão negada: ${describe(rec)}`, { agentId: agentId || null });
    return;
  }

  // --- subagent lifecycle ---
  if (name === 'SubagentStart') {
    if (!agentId) return;
    if (typeof rec.agent_type !== 'string') return; // never build an instance on a malformed type
    const existing = instanceFor(run, agentId);
    if (existing && !existing.endedAt && t - existing.lastEventAt <= THRESHOLDS.DEAD_MS) {
      if (!existing.sawStart) {
        // The instance was created from an earlier Agent result / activity
        // event (out-of-order delivery); this is its real Start, not a repeat.
        existing.sawStart = true; existing.lastEventAt = Math.max(existing.lastEventAt, t);
        if (existing.origin === 'agent-result' && !existing.endedAt) existing.startedAt = t; // the real start beats the launch ack
        if (!existing.task) pairPending(run, existing, t);
        return;
      }
      // Same instance re-announcing itself (SendMessage nudge re-fires the hook — §14).
      existing.reannounced += 1; existing.lastEventAt = Math.max(existing.lastEventAt, t);
      return;
    }
    const inst = newInstance(run, rec, t, agentId, rec.agent_type, 'start');
    pairPending(run, inst, t);
    note(run, t, 'subagent.start', `${labelOf(inst)} começou${inst.task ? `: ${clip(inst.task, 90)}` : ''}`, { agentId, role: inst.role });
    return;
  }
  if (name === 'SubagentStop') {
    if (!agentId) return;
    let inst = instanceFor(run, agentId);
    if (!inst) {
      if (!rec.agent_type || !Number.isFinite(rec.duration_ms)) return; // orphan Stop: discard (§8)
      inst = newInstance(run, rec, t - rec.duration_ms, agentId, rec.agent_type, 'stop-only');
    }
    if (inst.endedAt) return; // duplicate Stop
    settlePendingTools(run, inst, t, labelOf(inst), agentId);
    const last = clip(firstLine(rec.last_assistant_message), 160);
    endInstance(inst, t, 'stop', { lastMessage: last });
    if (!inst.verdict) inst.verdict = verdictOf(last);
    if (!inst.handback) { const m = last.match(HANDBACK_RE); if (m) inst.handback = { ts: t, status: m[1].toUpperCase(), text: last, fromStop: true }; }
    note(run, t, 'subagent.end', `${labelOf(inst)} terminou${last ? `: ${last}` : ''}`, { agentId, role: inst.role });
    return;
  }

  // --- tool events ---
  const isAgentTool = rec.tool_name === 'Agent' || rec.tool_name === 'Task';
  if (inSub) {
    let inst = instanceFor(run, agentId);
    if (!inst) inst = newInstance(run, rec, t, agentId, rec.agent_type, 'activity'); // Start hook lost
    inst.lastEventAt = Math.max(inst.lastEventAt, t);
    if (name === 'PreToolUse') { inst.calls += 1; inst.lastAction = describe(rec); inst.permission = null;
      if (rec.tool_use_id) inst.pendingTools.set(rec.tool_use_id, { tool: rec.tool_name, ts: t, action: describe(rec) });
      if (rec.tool_name === 'Bash') { const m = String(rec.tool_input?.command || '').match(/forja\.mjs["']?\s+progress\s+"([^"]+)"/); if (m) inst.progress = { ts: t, text: clip(m[1], 120) }; } }
    if (name === 'PostToolUse') {
      inst.permission = null;
      if (rec.tool_use_id) inst.pendingTools.delete(rec.tool_use_id);
      if (rec.tool_name === 'SubagentHandback') {
        settlePendingTools(run, inst, t, labelOf(inst), agentId);
        const msg = String(rec.tool_input?.message || '');
        const m = msg.match(HANDBACK_RE);
        inst.handback = { ts: t, status: m ? m[1].toUpperCase() : null, text: clip(firstLine(msg), 200) };
        inst.verdict = inst.verdict || verdictOf(msg);
        note(run, t, 'handback', `${labelOf(inst)} entregou: ${clip(firstLine(msg), 120)}`, { agentId, role: inst.role, status: inst.handback.status });
        if ((inst.role === 'reviewer' || inst.role === 'security-reviewer') && inst.verdict) addReview(run, { ts: t, taskId: inst.taskId, verdict: inst.verdict, text: clip(firstLine(msg), 200), by: inst.role, agentId, source: 'handback' });
      }
    }
    if (name === 'PostToolUseFailure') { if (rec.tool_use_id) inst.pendingTools.delete(str(rec.tool_use_id)); inst.error = clip(rec.error || rec.message || '', 160); note(run, t, 'tool.error', `${labelOf(inst)}: erro em ${rec.tool_name}`, { agentId }); }
    return;
  }

  // main session tool events
  run.main.lastEventAt = Math.max(run.main.lastEventAt, t);
  if (rec.effort && rec.effort.level) run.main.effort = rec.effort.level;
  if (name === 'PreToolUse') {
    run.main.calls += 1; run.main.lastAction = describe(rec); run.main.permission = null; run.main.turnEndedAt = null;
    if (rec.tool_use_id) run.main.pendingTools.set(rec.tool_use_id, { tool: rec.tool_name, ts: t, action: describe(rec) });
    if (isAgentTool) {
      const ti = rec.tool_input && typeof rec.tool_input === 'object' ? rec.tool_input : {};
      run.pending.push({ toolUseId: str(rec.tool_use_id) || null, ts: t, subagentType: str(ti.subagent_type) || null, description: str(ti.description) || null, prompt: ti.prompt ? clip(str(ti.prompt), 4000) : null, model: str(ti.model) || null, background: typeof ti.run_in_background === 'boolean' ? ti.run_in_background : null, agentId: null, resolved: false });
      if (run.pending.length > 200) run.pending.splice(0, run.pending.length - 200);
    } else if (rec.tool_name === 'Bash') {
      const m = String(rec.tool_input?.command || '').match(/forja\.mjs["']?\s+progress\s+"([^"]+)"/);
      if (m) run.progress = { ts: t, text: clip(m[1], 120), role: 'lead' };
    }
    return;
  }
  if (name === 'PostToolUse') {
    run.main.permission = null;
    if (rec.tool_use_id) run.main.pendingTools.delete(rec.tool_use_id);
    if (isAgentTool) {
      const tr = rec.tool_response && typeof rec.tool_response === 'object' && !Array.isArray(rec.tool_response) ? rec.tool_response : {};
      const ti = rec.tool_input && typeof rec.tool_input === 'object' ? rec.tool_input : {};
      const trAgentId = str(tr.agentId) || null;
      const p = run.pending.find(x => x.toolUseId && x.toolUseId === str(rec.tool_use_id)) || (trAgentId && run.pending.find(x => x.agentId === trAgentId)) || null;
      if (p) p.resolved = true;
      const aid = trAgentId || (p && p.agentId);
      let inst = aid ? instanceFor(run, aid) : null;
      const status = str(tr.status);
      if (!inst && aid) {
        const dur = Number.isFinite(rec.duration_ms) ? rec.duration_ms : 0;
        const startAt = status === 'completed' ? t - dur : t;
        inst = newInstance(run, rec, startAt, aid, str(tr.agentType) || str(ti.subagent_type), 'agent-result');
      }
      if (inst) {
        adoptCall(inst, { description: ti.description, prompt: ti.prompt ? clip(str(ti.prompt), 4000) : null, model: ti.model, background: ti.run_in_background, toolUseId: rec.tool_use_id });
        if (str(tr.resolvedModel)) inst.resolvedModel = str(tr.resolvedModel);
        if (status === 'async_launched') inst.background = true;
        else if (status === 'completed') { endInstance(inst, t, 'agent-completed'); note(run, t, 'subagent.end', `${labelOf(inst)} devolveu o resultado`, { agentId: inst.agentId, role: inst.role }); }
        else if (status) { endInstance(inst, t, 'agent-failed', { error: clip(status + (str(tr.error) ? `: ${str(tr.error)}` : ''), 160) }); note(run, t, 'subagent.fail', `${labelOf(inst)} falhou: ${status}`, { agentId: inst.agentId, role: inst.role }); }
      }
    }
    return;
  }
  if (name === 'PostToolUseFailure') {
    run.counts.errors += 1;
    if (rec.tool_use_id) run.main.pendingTools.delete(rec.tool_use_id);
    const err = clip(rec.error || rec.message || rec.tool_response?.error || '', 200);
    if (isAgentTool) {
      const p = run.pending.find(x => x.toolUseId === rec.tool_use_id);
      if (p) { p.resolved = true; p.error = err; const inst = p.agentId ? instanceFor(run, p.agentId) : null; if (inst) endInstance(inst, t, 'agent-failed', { error: err }); }
      if (FALLBACK_ERR_RE.test(err)) run.fallbacks.push({ ts: t, role: p ? roleOfType(p.subagentType) : null, from: p?.model || null, to: null, why: err, signal: true });
      note(run, t, 'subagent.fail', `Chamada a subagente falhou: ${err}`);
    } else {
      note(run, t, 'tool.error', `Erro em ${rec.tool_name}: ${err}`);
    }
  }
}

function labelOf(inst) {
  const r = ROSTER.find(x => x.key === inst.role);
  return r ? r.name : `ferramenta nativa (${inst.type})`;
}
export function verdictOf(text) {
  const m = String(text || '').match(/^\s*((?:SECURITY-)?(?:APPROVE|REJECT))\b/i);
  return m ? m[1].toUpperCase() : null;
}

export function applyLine(state, line, lineNo = null) {
  const text = String(line).replace(/\r$/, '');
  if (!text.trim()) return null;
  let rec;
  try { rec = JSON.parse(text); } catch { rec = { parse_error: true, ts: null, session_id: state.latestSessionId || 'sem-sessao' }; }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) rec = { parse_error: true, ts: null, session_id: state.latestSessionId || 'sem-sessao' };
  try {
    applyEvent(state, rec, lineNo);
  } catch (err) {
    // The reducer must never take the viewer down: a line it cannot make
    // sense of is counted and noted, and the stream goes on.
    state.badLines += 1;
    try { const run = state.runs.get(state.sessionToRun.get(str(rec.session_id) || 'sem-sessao')); if (run) note(run, state.lastTs, 'bad-line', `Linha ${lineNo ?? '?'} ignorada: ${clip(err && err.message, 80)}`); } catch {}
  }
  return rec;
}

// ---------- derived states (evaluated at `now`) ----------
export function instanceState(inst, now) {
  if (inst.endedAt) {
    if (inst.endReason === 'agent-failed') return { state: STATES.FALHOU, since: inst.endedAt, detail: inst.error || 'a chamada falhou' };
    if (inst.endReason === 'session-ended') return { state: STATES.TERMINADO, since: inst.endedAt, detail: 'sessão fechada' };
    return { state: STATES.TERMINADO, since: inst.endedAt, detail: inst.verdict || (inst.handback && inst.handback.status) || null };
  }
  const age = now - inst.lastEventAt;
  if (inst.handback && age > THRESHOLDS.HANDBACK_SETTLE_MS) return { state: STATES.TERMINADO, since: inst.handback.ts, detail: inst.verdict || inst.handback.status || 'entregou', inferred: true };
  // (endReason 'handback' is never stored: the settle rule above is evaluated at read time only.)
  if (inst.permission) return { state: STATES.BLOQUEADO, since: inst.permission.since, detail: `permissão pendente: ${inst.permission.message || inst.permission.tool || ''}`.trim() };
  if (age > THRESHOLDS.DEAD_MS) return { state: STATES.MORTO, since: inst.lastEventAt, detail: `sem qualquer evento há ${fmtAge(age)}` };
  if (age > THRESHOLDS.UNRESPONSIVE_MS) return { state: STATES.SEM_RESPOSTA, since: inst.lastEventAt, detail: `último sinal há ${fmtAge(age)}` };
  if (age > THRESHOLDS.QUIET_MS) return { state: STATES.TRABALHAR, since: inst.startedAt, detail: inst.progress?.text || inst.lastAction || null, quiet: age };
  return { state: STATES.TRABALHAR, since: inst.startedAt, detail: inst.progress?.text || inst.lastAction || null };
}

// The runner that drives this run, as far as the stream proves it: either a
// `runner.session` recorded in this run, or — the visible mode of §3b — a
// `runner.session` elsewhere in the stream that named THIS session as the one it
// launched (`forja.session_id`; the runner emits it from the session it is
// replacing, so the event and the session it describes can land in different
// run objects). Measured on the gearlift run of 17 set 2026.
function runnerOf(run) {
  return run.forja.runner || run.forja.runnerSession || null;
}
// A phase session that ended (its turn or the session itself) with the run still
// going: the runner launches the next one, so this is normal work, not a person's
// cue. Evidence-based all the same — a runner that exited or went quiet escalates.
function betweenRunnerSessions(run, since, now) {
  const rr = runnerOf(run);
  const last = rr.phase ? `${rr.phase}${rr.task ? ` ${rr.task}` : ''}` : '?';
  const silence = now - Math.max(since, run.lastEventAt || 0);
  if (rr.exited) return { state: STATES.SPONSOR, since: rr.exitedAt || since, detail: `o runner parou (${rr.why || 'sem motivo registado'}) — relançar o runner no PC (forja runner)` };
  if (silence > THRESHOLDS.DEAD_MS) return { state: STATES.MORTO, since, detail: `runner sem sinal há ${fmtAge(silence)} (última sessão: ${last})` };
  if (silence > THRESHOLDS.MAIN_UNRESPONSIVE_MS) return { state: STATES.SEM_RESPOSTA, since, detail: `runner sem sessão nova há ${fmtAge(silence)} (última: ${last})` };
  return { state: STATES.TRABALHAR, since, detail: `entre sessões do runner (última: ${last})`, quiet: silence > THRESHOLDS.QUIET_MS ? silence : undefined };
}

export function mainState(run, now) {
  const m = run.main;
  const openInst = [...run.instances.values()].filter(i => !i.endedAt && !(i.handback && now - i.lastEventAt > THRESHOLDS.HANDBACK_SETTLE_MS) && !(now - i.lastEventAt > THRESHOLDS.DEAD_MS));
  const lastProof = Math.max(m.lastEventAt, ...openInst.map(i => i.lastEventAt));
  // Under the runner a run spans many short sessions: a closed session with
  // the run still running is "between sessions", not the end of the run.
  if (run.endedAt && run.forja.pause) return pauseState(run, now);
  if (run.endedAt && runnerOf(run) && ['running', 'blocked'].includes(run.forja.status)) return betweenRunnerSessions(run, run.endedAt, now);
  if (run.endedAt) return { state: run.forja.status === 'failed' ? STATES.FALHOU : STATES.TERMINADO, since: run.endedAt, detail: `sessão fechada (${run.endReason || '?'})` };
  if (run.forja.status === 'finished') return { state: STATES.TERMINADO, since: m.lastEventAt, detail: 'run terminado' };
  if (run.forja.status === 'failed') return { state: STATES.FALHOU, since: m.lastEventAt, detail: 'run falhou' };
  if (run.forja.pause) return pauseState(run, now);
  if (m.permission) return { state: STATES.SPONSOR, since: m.permission.since, detail: `permissão pendente: ${m.permission.message || m.permission.tool || ''}`.trim() };
  if (m.quotaWait) return { state: STATES.ESPERA_QUOTA, since: m.quotaWait.since, detail: m.quotaWait.kind === 'quota_auto_resume_stale' ? 'limite reposto; precisa de Enter no terminal' : 'espera por limite terminou sem retomar' };
  if (m.stopFailure) return { state: m.stopFailure.type === 'rate_limit' || m.stopFailure.type === 'overloaded' ? STATES.ESPERA_QUOTA : STATES.SPONSOR, since: m.stopFailure.ts, detail: `parou com erro: ${m.stopFailure.type}` };
  if (m.turnEndedAt && m.turnEndedAt >= m.lastEventAt && openInst.length === 0) {
    // Under the runner, ending the turn IS the end of a phase session: the next
    // one is launched by the runner, nobody has to type anything (§3b, T-VIS-2).
    // Only the Sponsor's own session raises the "só se resolve no terminal" ticket.
    if (run.forja.status === 'running' && m.turnEndedByRunner && runnerOf(run)) return betweenRunnerSessions(run, m.turnEndedAt, now);
    if (run.forja.status === 'running' || run.forja.status === 'blocked') return { state: STATES.SPONSOR, since: m.turnEndedAt, detail: run.forja.status === 'blocked' ? 'run bloqueado — só o Sponsor desbloqueia' : 'terminou o turno com o run em curso' };
    return { state: STATES.ESPERA_INPUT, since: m.turnEndedAt, detail: m.turnEndedMessage || 'à espera do próximo prompt' };
  }
  const age = now - lastProof;
  if (age > THRESHOLDS.DEAD_MS) return { state: STATES.MORTO, since: lastProof, detail: `sem qualquer evento há ${fmtAge(age)}` };
  if (age > THRESHOLDS.MAIN_UNRESPONSIVE_MS) return { state: STATES.SEM_RESPOSTA, since: lastProof, detail: `último sinal há ${fmtAge(age)}` };
  const detail = openInst.length ? `à espera de ${openInst.map(labelOf).join(', ')}` : (run.progress?.text || m.lastAction || null);
  if (age > THRESHOLDS.QUIET_MS) return { state: STATES.TRABALHAR, since: m.lastPromptAt || run.startedAt, detail, quiet: age };
  return { state: STATES.TRABALHAR, since: m.lastPromptAt || run.startedAt, detail };
}

const PRIORITY = [STATES.BLOQUEADO, STATES.SPONSOR, STATES.TRABALHAR, STATES.SEM_RESPOSTA, STATES.MORTO, STATES.ESPERA_REVIEW, STATES.FALHOU, STATES.TERMINADO, STATES.INATIVO];

export function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}`;
}

function instanceView(inst, now) {
  const st = instanceState(inst, now);
  return {
    key: inst.key, agentId: inst.agentId, type: inst.type, role: inst.role,
    state: st.state, since: st.since, detail: st.detail, quiet: st.quiet || null, inferred: !!st.inferred,
    task: inst.task, taskId: inst.taskId, startedAt: inst.startedAt, lastEventAt: inst.lastEventAt, endedAt: inst.endedAt, endReason: inst.endReason,
    requestedModel: inst.requestedModel, resolvedModel: inst.resolvedModel, background: inst.background,
    calls: inst.calls, lastAction: inst.lastAction, progress: inst.progress, handback: inst.handback, verdict: inst.verdict,
    permission: inst.permission, denied: inst.denied, refused: inst.refused, error: inst.error, reannounced: inst.reannounced,
  };
}

function rosterView(run, now) {
  const insts = [...run.instances.values()];
  const cards = [];
  for (const r of ROSTER) {
    if (r.key === 'lead') {
      const st = mainState(run, now);
      cards.push({ key: r.key, name: r.name, role: r.role, core: r.core, state: st.state, since: st.since, detail: st.detail, quiet: st.quiet || null, instances: [], calls: run.main.calls, lastAction: run.main.lastAction, progress: run.progress, refused: run.main.refused, activeMs: Math.max(0, (run.endedAt || now) - run.startedAt), sessions: run.sessions.length, models: run.main.model ? { [run.main.model]: Math.max(0, (run.endedAt || now) - run.startedAt) } : {} });
      continue;
    }
    const mine = insts.filter(i => i.role === r.key).map(i => instanceView(i, now)).sort((a, b) => b.startedAt - a.startedAt);
    // Statistics only: how long this role was switched on in this run — the sum of
    // its instances' lifetimes (a live instance counts up to now; a silent one up
    // to its last signal). Evidence-based like everything else here.
    const lifetime = i => Math.max(0, (i.endedAt || (i.state === STATES.TRABALHAR ? now : (i.lastEventAt || i.startedAt))) - i.startedAt);
    const activeMs = mine.reduce((s, i) => s + lifetime(i), 0);
    // Statistics only: time switched on per model actually used (resolvedModel from
    // the Agent result, else the requested model), so the Sponsor sees which model
    // each role ran on and for how long.
    const models = {};
    for (const i of mine) { const m = i.resolvedModel || i.requestedModel || 'desconhecido'; models[m] = (models[m] || 0) + lifetime(i); }
    let card = { key: r.key, name: r.name, role: r.role, core: r.core, state: STATES.INATIVO, since: null, detail: null, quiet: null, instances: mine, activeMs, sessions: mine.length, models };
    if (mine.length) {
      const active = mine.filter(i => [STATES.TRABALHAR, STATES.BLOQUEADO, STATES.SEM_RESPOSTA, STATES.MORTO].includes(i.state));
      const pick = (active.length ? active : mine).slice().sort((a, b) => PRIORITY.indexOf(a.state) - PRIORITY.indexOf(b.state) || b.startedAt - a.startedAt)[0];
      card.state = pick.state; card.since = pick.since; card.detail = pick.detail; card.quiet = pick.quiet;
      if (active.length > 1 && pick.state === STATES.TRABALHAR) card.detail = `${active.length} instâncias em paralelo`;
      // A specialist whose last task now waits for the Reviewer (only while the run is alive).
      if (!active.length && pick.taskId && r.key !== 'reviewer' && r.key !== 'security-reviewer' && !run.endedAt && !['finished', 'failed'].includes(run.forja.status)) {
        const task = run.tasks.get(pick.taskId);
        if (task && task.status === 'review') { card.state = STATES.ESPERA_REVIEW; card.detail = `${pick.taskId} entregue, à espera do Reviewer`; card.since = task.updatedAt; }
      }
    }
    cards.push(card);
  }
  const native = insts.filter(i => i.role === 'native').map(i => instanceView(i, now)).sort((a, b) => b.startedAt - a.startedAt);
  return { cards, native };
}

// A pause is evidence too: the runner promised to be back at `resumeAt` (which
// already includes its 5-min margin) — or within its 30-min fallback wait (+5)
// when the reset time was unreadable. Past that plus the main-session silence
// threshold, the runner did not come back.
function pauseState(run, now) {
  const p = run.forja.pause;
  const due = p.resumeAt ?? (p.since + 35 * 60_000);
  const hhmm = p.resumeAt ? new Date(p.resumeAt).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }) : null;
  if (now - due > THRESHOLDS.MAIN_UNRESPONSIVE_MS) {
    return { state: STATES.SPONSOR, since: due, detail: `a pausa devia ter acabado${hhmm ? ` às ${hhmm}` : ''} e o runner não voltou (há ${fmtAge(now - due)}) — relançar o runner no PC (forja runner)` };
  }
  return { state: STATES.PAUSA, since: p.since, detail: `${p.reason}${hhmm ? `, retoma às ${hhmm}` : ', retoma quando repuser'}` };
}

export function runStatus(run, roster, now) {
  const main = roster.cards[0];
  const openQ = run.queue.filter(q => q.status === 'open').length;
  // Under the runner the run outlives its sessions: a closed session with the run
  // still running is "between sessions" or "em pausa", never the end of the run.
  const underRunner = !!(runnerOf(run) && ['running', 'blocked'].includes(run.forja.status));
  if (run.forja.pause && run.forja.status === 'running' && main.state === STATES.PAUSA) return { status: STATES.PAUSA, detail: main.detail, openQuestions: openQ };
  if (run.forja.status === 'blocked' && run.endedAt) return { status: STATES.BLOQUEADO, detail: `run bloqueado${run.forja.why ? `: ${run.forja.why}` : ''}`, openQuestions: openQ };
  if (run.endedAt && !underRunner) return { status: run.forja.status === 'failed' ? STATES.FALHOU : STATES.TERMINADO, detail: main.detail, openQuestions: openQ };
  if (run.forja.status === 'finished') return { status: STATES.TERMINADO, detail: 'run terminado', openQuestions: openQ };
  if (run.forja.status === 'failed') return { status: STATES.FALHOU, detail: 'run falhou', openQuestions: openQ };
  const states = roster.cards.map(c => c.state);
  if ([STATES.SPONSOR, STATES.ESPERA_QUOTA, STATES.PAUSA].includes(main.state)) return { status: main.state, detail: main.detail, openQuestions: openQ };
  if (states.includes(STATES.BLOQUEADO)) return { status: STATES.BLOQUEADO, detail: roster.cards.find(c => c.state === STATES.BLOQUEADO).detail, openQuestions: openQ };
  if (main.state === STATES.MORTO) return { status: STATES.MORTO, detail: main.detail, openQuestions: openQ };
  if (main.state === STATES.SEM_RESPOSTA) return { status: STATES.SEM_RESPOSTA, detail: main.detail, openQuestions: openQ };
  if (main.state === STATES.ESPERA_INPUT) return { status: STATES.ESPERA_INPUT, detail: main.detail, openQuestions: openQ };
  const working = roster.cards.filter(c => c.state === STATES.TRABALHAR);
  return { status: STATES.TRABALHAR, detail: working.length > 1 ? working.slice(1).map(c => `${c.name}: ${c.detail || ''}`).join(' · ') : main.detail, openQuestions: openQ };
}

export function snapshot(state, now = Date.now(), { timelineLimit = 120, includeSynthetic = true } = {}) {
  const runs = [];
  for (const run of state.runs.values()) {
    if (!includeSynthetic && run.synthetic) continue;
    const roster = rosterView(run, now);
    const status = runStatus(run, roster, now);
    const tasks = [...run.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
    runs.push({
      id: run.id, runId: run.forja.runId, sessions: run.sessions, project: run.project, projectKey: run.cwdKey, cwd: run.cwd, synthetic: run.synthetic,
      // T-UI-9: o que é mesmo um run e o que é uma sessão solta do mesmo projeto.
      kind: (run.announced || !!run.forja.runId) ? 'run' : 'session', interactive: !!run.interactive,
      startedAt: run.startedAt, lastEventAt: run.lastEventAt, endedAt: run.endedAt, endReason: run.endReason, source: run.source, permissionMode: run.permissionMode,
      goal: run.goal, goalSource: run.goalSource,
      status: status.status, statusDetail: status.detail, openQuestions: status.openQuestions,
      forja: { ...run.forja }, modelFloor: run.forja.modelFloor,
      roster: roster.cards, native: roster.native,
      tasks, decisions: run.decisions, queue: run.queue, reviews: run.reviews.slice(-50), fallbacks: run.fallbacks, modelSwitches: run.modelSwitches,
      timeline: run.timeline.slice(-timelineLimit),
      counts: { ...run.counts, instances: run.instances.size, compactions: run.main.compactions, refused: run.main.refused + [...run.instances.values()].reduce((n, i) => n + (i.refused || 0), 0) },
      main: { lastEventAt: run.main.lastEventAt, turnEndedAt: run.main.turnEndedAt, permission: run.main.permission, stopFailure: run.main.stopFailure, quotaWait: run.main.quotaWait, effort: run.main.effort, refused: run.main.refused },
    });
  }
  runs.sort((a, b) => b.lastEventAt - a.lastEventAt);
  // O run por omissão volta a ser o run ATIVO mais recente, como sempre foi — mas
  // nunca uma sessão solta, que foi o que fez o Sponsor concluir, com três runs
  // vivos a emitir eventos, que estavam todos parados (17 set 2026). Só um stream
  // sem um único run cai na sessão mais recente, e aí a página diz por palavras
  // que é uma sessão solta. A pertença a um run é sempre prova do stream (um
  // run_id emitido), nunca uma sobreposição de horas.
  const ACTIVE = new Set([STATES.TRABALHAR, STATES.BLOQUEADO, STATES.SPONSOR, STATES.SEM_RESPOSTA, STATES.ESPERA_QUOTA, STATES.PAUSA]);
  const real = runs.filter(r => r.kind === 'run');
  const current = real.find(r => ACTIVE.has(r.status)) || real[0] || runs[0] || null;
  return { generatedAt: now, thresholds: THRESHOLDS, lines: state.lines, badLines: state.badLines, current: current ? current.id : null, runs };
}

export function reduceLines(lines, now = Date.now(), opts) {
  const st = createState();
  let n = 0;
  for (const line of lines) applyLine(st, line, ++n);
  return snapshot(st, now, opts);
}
