// Feed de eventos-chave (direção C, «Voltas» — docs/design/DESIGN.md §«Feed de
// eventos-chave»). Pure: no fs, no clock. The server feeds it every parsed
// line of data/events*.jsonl and asks for a snapshot; the page only renders.
//
// Only eight things reach the feed, all from real hook/CLI events (the data
// check is in docs/design/mocks/README-feed.md):
//   1 chamou   PreToolUse Agent            2 começou  SubagentStart
//   3 terminou SubagentStop (1.ª linha)    4 voltou   PostToolUse Agent `completed`, or — for
//                                                     background calls, whose Post is `async_launched`
//                                                     at launch — the Lead's next own tool call
//   5 o que falta: derived at snapshot time (never an event)
//   6 veredito task.done/task.fail of the runner, else the Reviewer's first line
//   7 escalada ask · task.block · run.block (cascades collapse into one «arrasto» line)
//   8 relatório run.finish · run.fail · report (`forja report`, sessões à mão)
// Events 1–4 of one delegation are ONE item, the «volta», keyed by the agent id.

import { ROSTER } from './state.mjs';

// agent_type → role name, from the one roster (legacy forge names included).
export const ROLE_BY_TYPE = Object.freeze(Object.fromEntries(ROSTER.flatMap(r => r.types.map(t => [t, r.name]))));
export const FEED = {
  WINDOW_MS: 30 * 3600e3,      // what the feed shows by default
  MIN_ITEMS: 20,               // a quiet day still shows the last 20 items
  MAX_ITEMS: 160,
  LIVE_MS: 15 * 60e3,          // a session with no event for 15 min is not «a trabalhar»
  CASCADE_MS: 60 * 60e3,       // cascade blocks of one run within an hour collapse into one line
  VERDICT_ATTACH_MS: 30 * 60e3,
  KEEP_PER_PROJECT: 600,       // memory bound: older items are dropped
};

// ---------- títulos legíveis ----------
const EXT = 'py|mjs|cjs|js|ts|tsx|jsx|md|json|jsonl|css|html|txt|toml|ya?ml|sql|sh|ps1|rs|kt|kts|dart|go|java|swift|lock|cfg|ini|env|sqlite|db|docx|pdf|png|svg';
const FILE_RE = new RegExp(`^[\\w.~-]+\\.(${EXT})(:\\d+(-\\d+)?)?$`, 'i');
// A word is a path when it has a separator and lower-case letters (so PASS/FAIL/N/A
// stays), or when it is a bare file name with a known extension.
export function looksPath(w) {
  const x = String(w || '').replace(/^[("'«[]+|[)"'»\],;.:]+$/g, '');
  if (!x) return false;
  if (FILE_RE.test(x)) return true;
  if (!/[\\/]/.test(x) || !/[a-z]/.test(x) || /^https?:/i.test(x)) return false;
  return /^[\w.~:-]*[\\/][\w.~\\/:-]*$/.test(x) && (/[_.\\]/.test(x) || x.split('/').filter(Boolean).length >= 3);
}
const COMMON = { review: 'revisão', 'validação final': 'validação final', 'relatório do run': 'relatório do run' };
export function tituloLegivel(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/^[A-Z]\w{0,4}\s*·\s*[A-Za-z ]+:\s*/, '');                          // «T9 · Frontend Dev: »
  t = t.replace(/`([^`]*)`/g, (_, x) => (looksPath(x) ? '' : x));
  t = t.replace(/\*\*/g, '');
  t = t.replace(/^(?:(?:TASK|Task|task)\s+\d+\w*\s*|[A-Z]{1,2}\d+[a-z]?\s*(?:[-—:·]\s*|\s+(?=[a-zà-ú])))+/, '');   // «T022a - », «TASK 019 »
  const colon = t.indexOf(': ');
  if (colon > 0) { const head = t.slice(0, colon), tail = t.slice(colon + 2).trim(); if (head.split(' ').some(looksPath) && tail.length >= 8) t = tail; }
  t = t.replace(/\s+(?:em|no|na|nos|nas|do|da|dos|das|de|in|on|at|to|from)\s+(\S+)/g, (m, w) => (looksPath(w) ? (/[,;:.)]$/.test(w) ? w.slice(-1) : '') : m));
  t = t.split(' ').filter(w => !looksPath(w)).join(' ');
  t = t.replace(/\s+([,;:.)])/g, '$1').replace(/\(\s*\)/g, '').replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  if (COMMON[t.toLowerCase()]) t = COMMON[t.toLowerCase()];
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}
const cap = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const firstLine = s => (String(s || '').trim().split('\n').find(x => x.trim()) || '').trim();
const HANDBACK_RE = /^\W*(SECURITY-APPROVE|SECURITY-REJECT|APPROVE|REJECT|DONE|BLOCKED|FAILED|QA|PLAN|FRAME)\b\W*(.*)$/;
const CASCADE_RE = /^depend[eê]ncia\s+\S+\s+(?:está\s+bloqueada|falhou)/i;

// ---------- reducer ----------
export function createFeed() {
  return { items: [], pre: new Map(), byAgent: new Map(), stopBySession: new Map(), taskTitles: new Map(), lastBySession: new Map(), lastByProject: new Map(), runs: new Map(), asks: new Map() };
}
function run(feed, project) {
  let r = feed.runs.get(project);
  if (!r) { r = { alive: false, runId: null, pause: null, stopped: null, finishedAt: null }; feed.runs.set(project, r); }
  return r;
}
function add(feed, item) {
  feed.items.push(item);
  if (feed.items.length > FEED.KEEP_PER_PROJECT * 12) feed.items.splice(0, feed.items.length - FEED.KEEP_PER_PROJECT * 10);
  return item;
}
function volta(feed, rec, para, de = 'Lead') {
  return add(feed, { tipo: 'volta', projeto: rec.project, ts: rec.ts, de, para, titulo: '', sessao: rec.session_id, chamou: null, comecou: null, terminou: null, voltou: null, fim: null, veredito: null, agente: null });
}
// The runner names a call «T3 · Reviewer: review» or «X · Security Reviewer: T5»: the
// words say nothing, the task id does — use that task's title when we know it.
function tituloDaChamada(feed, project, desc) {
  const raw = String(desc || '');
  const code = (raw.match(/^\s*([A-Z]\w{0,4})\s*·/) || [])[1];
  const t = tituloLegivel(raw);
  const bare = (t.match(/^T\d+\w*$/i) || [])[0];
  const id = bare ? bare.toUpperCase() : code;
  const known = id && feed.taskTitles.get(`${project}|${id}`);
  if (known && (bare || t.length < 24)) return bare || !t ? known : `${t} · ${known}`;
  return t;
}
function verdictFrom(word, text) {
  return { palavra: /REJECT/.test(word) ? 'REJECT' : 'APPROVE', seguranca: /^SECURITY/.test(word), texto: cap(tituloLegivel(String(text || '').replace(/^\W*(T\w+\s*[—:-]\s*)+/, '')), 220) };
}

export function feedApply(feed, rec) {
  if (!rec || typeof rec !== 'object' || !rec.project || !rec.ts) return;
  const h = rec.hook_event_name;
  feed.lastByProject.set(rec.project, rec.ts);
  if (rec.session_id) feed.lastBySession.set(rec.session_id, rec.ts);
  const caller = rec.agent_type ? ROLE_BY_TYPE[rec.agent_type] || null : 'Lead';

  if (h === 'PreToolUse' && rec.tool_name === 'Agent') {
    const para = ROLE_BY_TYPE[rec.tool_input?.subagent_type];
    if (!para || !caller) return;                        // ferramentas nativas nunca entram no feed
    const v = volta(feed, rec, para, caller);
    v.chamou = rec.ts; v.titulo = cap(tituloDaChamada(feed, rec.project, rec.tool_input?.description), 160);
    feed.pre.set(rec.tool_use_id, v);
    return;
  }
  if ((h === 'PostToolUse' || h === 'PostToolUseFailure') && rec.tool_name === 'Agent') {
    const v = feed.pre.get(rec.tool_use_id); if (!v) return;
    feed.pre.delete(rec.tool_use_id);
    const id = rec.tool_response?.agentId;
    if (id && !v.agente) { v.agente = id; feed.byAgent.set(id, v); }
    if (h === 'PostToolUseFailure') { v.terminou ||= rec.ts; v.voltou ||= rec.ts; v.fim ||= { estado: 'FAILED', texto: 'A chamada falhou' }; }
    else if (rec.tool_response?.status === 'completed') { v.terminou ||= rec.ts; v.voltou ||= rec.ts; }
    return;
  }
  if (h === 'SubagentStart' && ROLE_BY_TYPE[rec.agent_type]) {
    const para = ROLE_BY_TYPE[rec.agent_type];
    let v = feed.byAgent.get(rec.agent_id);
    if (!v) {
      // A synchronous call only learns its agent id when it returns: pair it by session and role.
      for (let i = feed.items.length - 1; i >= 0 && i >= feed.items.length - 60; i--) {
        const x = feed.items[i];
        if (x.tipo === 'volta' && !x.agente && !x.comecou && x.sessao === rec.session_id && x.para === para) { v = x; break; }
      }
      if (!v) v = volta(feed, rec, para);
      v.agente = rec.agent_id; feed.byAgent.set(rec.agent_id, v);
    }
    v.comecou ||= rec.ts;
    return;
  }
  if (h === 'SubagentStop' && ROLE_BY_TYPE[rec.agent_type]) {
    const v = feed.byAgent.get(rec.agent_id) || (() => { const x = volta(feed, rec, ROLE_BY_TYPE[rec.agent_type]); x.agente = rec.agent_id; feed.byAgent.set(rec.agent_id, x); return x; })();
    if (v.terminou && v.fim) return;                      // Stop repeats; the first one counts
    v.terminou ||= rec.ts;
    const l1 = firstLine(rec.last_assistant_message);
    const m = l1.match(HANDBACK_RE);
    if (m && /APPROVE|REJECT/.test(m[1])) v.veredito ||= verdictFrom(m[1], m[2]);
    v.fim = { estado: m ? m[1] : null, texto: cap(tituloLegivel(m ? m[2] : l1), 200) };
    if (!v.voltou) feed.stopBySession.set(rec.session_id, v);
    return;
  }
  if (h === 'PreToolUse' && !rec.agent_id && feed.stopBySession.has(rec.session_id)) {
    const v = feed.stopBySession.get(rec.session_id); feed.stopBySession.delete(rec.session_id);
    v.voltou ||= rec.ts;
    return;
  }
  if (h !== 'Forja') return;
  const f = rec.forja || {};
  const r = run(feed, rec.project);
  const marco = extra => add(feed, { tipo: 'marco', projeto: rec.project, ts: rec.ts, runId: f.run_id || null, ...extra });
  if ((f.kind === 'task.add' || f.kind === 'task.start') && f.id && f.title) feed.taskTitles.set(`${rec.project}|${f.id}`, tituloLegivel(f.title));
  switch (f.kind) {
    case 'run.start': Object.assign(r, { alive: true, runId: f.run_id, pause: null, stopped: null, finishedAt: null }); break;
    case 'run.resume': case 'runner.session': r.pause = null; r.stopped = null; if (f.run_id) { r.alive = r.alive || f.kind === 'run.resume'; r.runId ||= f.run_id; } break;
    case 'run.pause': r.pause = f.resume_at || null; break;
    case 'runner.exit': if (r.alive) r.stopped = rec.ts; break;
    case 'ask': {
      const m = marco({ kind: 'pergunta', texto: cap(tituloLegivel(f.text), 240), padrao: cap(tituloLegivel(f.default), 160), respondida: false });
      feed.asks.set(`${rec.project}|${f.run_id}|${f.id}`, m);
      break;
    }
    case 'answer': case 'answer.pending': { const k = `${rec.project}|${f.run_id}|${f.id}`; const m = feed.asks.get(k); if (m) m.respondida = true; feed.asks.delete(k); break; }
    case 'task.done': if (f.verdict) { const m = String(f.verdict).match(/^\W*(SECURITY-APPROVE|APPROVE)\b\W*(.*)$/); attachVerdict(feed, rec, marco, m ? m[1] : 'APPROVE', m ? m[2] : f.verdict); } break;
    case 'task.fail': {
      const m = String(f.why || '').match(/^\W*(SECURITY-REJECT|REJECT)\b\W*(.*)$/);
      if (m) attachVerdict(feed, rec, marco, m[1], m[2]);
      else marco({ kind: 'falhou', final: !!f.final, texto: cap(tituloLegivel(f.why), 200) });
      break;
    }
    case 'task.block': {
      if (CASCADE_RE.test(String(f.why || ''))) {
        // Root blocker keeps its weight; everything blocked «por arrasto» is one quiet line.
        for (let i = feed.items.length - 1; i >= 0; i--) {
          const x = feed.items[i];
          if (Date.parse(rec.ts) - Date.parse(x.ts) > FEED.CASCADE_MS) break;
          if (x.tipo === 'marco' && x.kind === 'arrasto' && x.projeto === rec.project && x.runId === (f.run_id || null)) { x.n += 1; x.ate = rec.ts; return; }
        }
        marco({ kind: 'arrasto', n: 1, ate: rec.ts });
      } else marco({ kind: 'bloqueado', texto: cap(tituloLegivel(f.why), 240) });
      break;
    }
    case 'run.block': marco({ kind: 'bloqueado', texto: cap(tituloLegivel(f.why), 240), run: true }); break;
    case 'run.finish': case 'run.fail':
      Object.assign(r, { alive: false, finishedAt: rec.ts, pause: null, stopped: null });
      marco({ kind: 'relatorio', falhou: f.kind === 'run.fail', texto: cap(tituloLegivel(f.note || f.why), 280) });
      break;
    case 'report': marco({ kind: 'relatorio', falhou: false, sessao: true, texto: cap(tituloLegivel(f.text || f.note), 280) }); break;
  }
}
function attachVerdict(feed, rec, marco, word, text) {
  const who = /^SECURITY/.test(word) ? 'Security Reviewer' : 'Reviewer';
  const t = Date.parse(rec.ts);
  for (let i = feed.items.length - 1; i >= 0; i--) {
    const x = feed.items[i];
    if (t - Date.parse(x.ts) > FEED.VERDICT_ATTACH_MS) break;
    if (x.tipo === 'volta' && x.projeto === rec.project && x.para === who) { x.veredito = verdictFrom(word, text); return; }
  }
  marco({ kind: 'veredito', papel: who, veredito: verdictFrom(word, text) });
}

// ---------- snapshot ----------
// `projects` = data/projects.json entries; `tasksOf(project)` = that project's TASKS.json array (or []).
export function feedSnapshot(feed, now, { projects = [], tasksOf = () => [], windowMs = FEED.WINDOW_MS } = {}) {
  const names = new Set(projects.map(p => p.name));
  const live = s => s && now - Date.parse(feed.lastBySession.get(s) || 0) < FEED.LIVE_MS;
  const agora = [];
  for (const p of projects) {
    const r = feed.runs.get(p.name) || { alive: false };
    const pend = [];
    if (r.alive && r.stopped) pend.push({ tipo: 'parado', desde: r.stopped });
    else if (r.alive && r.pause && Date.parse(r.pause) > now) pend.push({ tipo: 'pausa', ate: r.pause });
    const mine = feed.items.filter(x => x.projeto === p.name && x.tipo === 'volta');
    const newestStart = new Map();
    for (const v of mine) if (v.comecou) newestStart.set(v.para, v.comecou);
    // Liveness is the session's own evidence, never the project's: a hands-on
    // session in a project whose runner stopped is still working.
    for (const v of mine) {
      if (v.comecou && !v.terminou && live(v.sessao) && newestStart.get(v.para) === v.comecou) pend.push({ tipo: 'a-trabalhar', papel: v.para, titulo: v.titulo, desde: v.comecou });
      else if (v.terminou && !v.voltou && live(v.sessao)) pend.push({ tipo: 'lead-retoma', papel: v.para, desde: v.terminou });
    }
    for (const m of feed.asks.values()) if (m.projeto === p.name && r.alive) pend.push({ tipo: 'decisao', texto: m.texto, padrao: m.padrao, desde: m.ts });
    if (r.alive && !pend.length) pend.push({ tipo: 'lead', desde: feed.lastByProject.get(p.name) || null });
    if (r.alive) {
      const tasks = tasksOf(p) || [];
      const next = tasks.find(t => t && (t.status === 'todo' || t.status === 'pending'));
      if (next) pend.push({ tipo: 'plano', titulo: cap(tituloLegivel(next.title), 140), feitas: tasks.filter(t => t.status === 'done').length, total: tasks.length });
    }
    const estado = pend.some(x => x.tipo === 'parado') ? 'parou'
      : pend.some(x => x.tipo === 'decisao') ? 'precisa'
        : pend.some(x => x.tipo === 'pausa') ? 'pausa'
          : r.alive ? 'ativo' : r.finishedAt ? 'terminou' : 'sem-run';
    agora.push({ projeto: p.name, estado, ultimo: feed.lastByProject.get(p.name) || null, terminou: r.finishedAt || null, pendentes: pend });
  }
  const ORDER = { parou: 0, precisa: 1, pausa: 2, ativo: 3, terminou: 4, 'sem-run': 5 };
  agora.sort((a, b) => ORDER[a.estado] - ORDER[b.estado] || String(b.ultimo).localeCompare(String(a.ultimo)));

  const since = now - windowMs;
  const all = feed.items.filter(x => names.has(x.projeto));
  let chosen = all.filter(x => Date.parse(x.ts) >= since);
  if (chosen.length < FEED.MIN_ITEMS) chosen = all.slice(-FEED.MIN_ITEMS);
  chosen = chosen.slice(-FEED.MAX_ITEMS).reverse();
  const itens = chosen.map(x => {
    if (x.tipo === 'marco') { const { runId, ...o } = x; return o; }
    const aberta = !x.voltou;
    const estado = !aberta ? 'fechada'
      : !live(x.sessao) ? 'interrompida'
        : !x.comecou ? 'a-arrancar' : !x.terminou ? 'a-trabalhar' : 'lead-retoma';
    return { tipo: 'volta', projeto: x.projeto, ts: x.ts, de: x.de, para: x.para, titulo: x.titulo, chamou: x.chamou, comecou: x.comecou, terminou: x.terminou, voltou: x.voltou, fim: x.fim, veredito: x.veredito, estado };
  });
  return { generatedAt: now, janelaHoras: Math.round(windowMs / 3600e3), agora, itens };
}
