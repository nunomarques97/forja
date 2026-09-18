// Shared by the three crew-viewer mocks (bancada, oficina, painel): loads a
// state snapshot (viewer/README.md contract), freezes "now" at generatedAt so
// every elapsed value is deterministic, and offers small pure helpers.
// Mock-only code; not the production viewer.

export const STATES = ['inativo', 'a trabalhar', 'à espera de review', 'bloqueado', 'precisa do Sponsor',
  'sem resposta', 'morto', 'terminado', 'falhou', 'à espera de input', 'à espera de quota'];

// Tone = how loud the state is and which colour family it takes.
//   idle    neutral, dim
//   work    ember (member colour lit)
//   wait    indigo — waiting on someone else (review / input / quota)
//   done    patina green
//   fail    alarm red, quiet band
//   lost    alarm red — "sem resposta" (no proof of life)
//   dead    alarm red — "morto"
//   alarm   alarm red, loudest — "bloqueado"
//   sponsor alarm red, loudest — "precisa do Sponsor"
export const TONE = {
  'inativo': 'idle', 'a trabalhar': 'work', 'à espera de review': 'wait', 'à espera de input': 'wait',
  'à espera de quota': 'wait', 'bloqueado': 'alarm', 'precisa do Sponsor': 'sponsor',
  'sem resposta': 'lost', 'morto': 'dead', 'terminado': 'done', 'falhou': 'fail',
};
export const LOUD = new Set(['bloqueado', 'precisa do Sponsor']);
export const toneOf = state => TONE[state] || 'idle';

export const MEMBERS = ['ferreiro', 'bigorna', 'fundidor', 'lapidador', 'contraste'];

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function loadSnapshot() {
  const q = new URLSearchParams(location.search);
  const src = q.get('src') || 'state-all-states.json';
  const snap = await (await fetch(src, { cache: 'no-store' })).json();
  const run = snap.runs.find(r => r.id === snap.current) || snap.runs[0];
  const demo = q.get('demo') === '1';
  if (demo) applyDemo(run);
  return { snap, run, now: snap.generatedAt, demo, src, scene: q.get('scene') !== '0' };
}

// ?demo=1 — the all-states snapshot only carries 3 distinct states; this remaps
// STATES ONLY (never copy) so the loud/dead renderings can be judged. Every
// page shows a "demonstração" banner when it is on.
function applyDemo(run) {
  const set = (card, state, patch = {}) => { if (!card) return; Object.assign(card, { state, ...patch }); };
  const byKey = k => run.roster.find(c => c.key === k);
  const inst = (k, i) => (byKey(k)?.instances || [])[i];
  set(byKey('ferreiro'), 'precisa do Sponsor');
  set(byKey('fundidor'), 'sem resposta', { quiet: 420000 }); set(inst('fundidor', 0), 'sem resposta', { quiet: 420000 }); set(inst('fundidor', 1), 'falhou');
  set(byKey('lapidador'), 'morto', { quiet: 1900000 }); set(inst('lapidador', 0), 'morto', { quiet: 1900000 });
  set(byKey('contraste'), 'à espera de review'); set(inst('contraste', 0), 'à espera de review');
  if (run.native[0]) set(run.native[0], 'à espera de quota');
  run.status = 'precisa do Sponsor';
}

// ---- time -------------------------------------------------------------
const pad = n => String(n).padStart(2, '0');
export const clock = ts => ts ? `${pad(new Date(ts).getHours())}:${pad(new Date(ts).getMinutes())}` : '—';
export const clockS = ts => ts ? clock(ts) + ':' + pad(new Date(ts).getSeconds()) : '—';

// "1 min 40 s", "12 s", "1 h 05 min"
export function dur(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  ms = Math.max(0, ms);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m} min ${pad(s % 60)} s` : `${m} min`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${pad(m % 60)} min`;
}
// "há 4 min"
export const ago = (now, ts) => ts ? `há ${dur(now - ts)}` : '—';

// ---- tasks & copy --------------------------------------------------------
// "T3 · Fundidor: Exportar CSV" → { id: 'T3', who: 'Fundidor', title: 'Exportar CSV' }
export function splitTask(task) {
  if (!task) return { id: null, who: null, title: null };
  const m = String(task).match(/^\s*([A-Z]+\d*)\s*[·:]\s*(?:([A-Za-zÀ-ÿ]+)\s*:\s*)?(.*)$/);
  if (!m) return { id: null, who: null, title: String(task) };
  // A bare letter ("Q · Bigorna: …" is a mid-run question) is not an id.
  return { id: /\d/.test(m[1]) ? m[1] : null, who: m[2] || null, title: m[3] || null, kind: m[1] };
}

export function taskTitle(run, id) {
  if (!id) return null;
  const t = run.tasks.find(t => t.id === id);
  if (t?.title) return t.title;
  for (const c of run.roster) for (const i of c.instances || []) { const s = splitTask(i.task); if (s.id === id && s.title) return s.title; }
  const tl = run.timeline.find(e => e.kind === 'task.add' && new RegExp(`Task ${id} criada: `).test(e.text));
  if (tl) return tl.text.replace(/^Task \w+ criada: /, '');
  return null;
}

export const memberName = key => ({ ferreiro: 'Ferreiro', bigorna: 'Bigorna', fundidor: 'Fundidor', lapidador: 'Lapidador', contraste: 'Contraste', backend: 'Fundidor', frontend: 'Lapidador', reviewer: 'Contraste' }[key] || key);

// ---- liveness ---------------------------------------------------------------
// What proves life: age of the last event under the actor. Returns
// { kind: 'ok'|'quiet'|'silent'|'none', ms, text }.
export function liveness(actor, run, now) {
  // A roster card carries no lastEventAt of its own: take the freshest of the
  // instances that share its state (Ferreiro = the main session).
  let last = actor.lastEventAt ?? null;
  if (last == null && actor.instances?.length) last = Math.max(...actor.instances.filter(i => i.state === actor.state).map(i => i.lastEventAt || 0)) || null;
  if (last == null && actor.key === 'ferreiro') last = run.main?.lastEventAt ?? null;
  const tone = toneOf(actor.state);
  if (tone === 'work' && actor.quiet > 0) return { kind: 'quiet', ms: actor.quiet, text: `silêncio há ${dur(actor.quiet)}` };
  if (tone === 'work') return last ? { kind: 'ok', ms: now - last, text: `último sinal há ${dur(now - last)}` } : { kind: 'none', ms: null, text: 'sem sinal registado' };
  if (tone === 'lost' || tone === 'dead') { const ms = actor.quiet ?? (last ? now - last : null); return { kind: 'silent', ms, text: ms != null ? `sem sinal há ${dur(ms)}` : 'sem sinal' }; }
  return { kind: 'none', ms: null, text: '' };
}

// ---- Sponsor queue -----------------------------------------------------------
// Everything that only the Sponsor can move: open questions, permission
// prompts, "precisa do Sponsor" / quota states of the main session.
export function sponsorQueue(run, now) {
  const items = [];
  for (const q of run.queue || []) if (q.status !== 'answered') items.push({ kind: 'pergunta', id: q.id, who: 'Bigorna', title: q.question, fallback: q.default, why: q.why, since: q.ts, status: q.status });
  for (const c of run.roster) {
    if (c.state === 'precisa do Sponsor' && c.key === 'ferreiro') items.push({ kind: 'sessão', id: null, who: 'Ferreiro', title: c.detail || 'a sessão principal precisa do Sponsor no terminal', since: c.since });
    for (const i of c.instances || []) if (i.permission) items.push({ kind: 'permissão', id: splitTask(i.task).id, who: memberName(c.key), title: `${i.permission.tool}: ${i.permission.message}`, why: 'permissão pendente no terminal', since: i.permission.since, task: i.task });
  }
  if (run.main?.permission) items.push({ kind: 'permissão', id: null, who: 'Ferreiro', title: `${run.main.permission.tool}: ${run.main.permission.message}`, since: run.main.permission.since });
  if (run.main?.quotaWait) items.push({ kind: 'quota', id: null, who: 'Ferreiro', title: run.main.quotaWait.text || 'à espera de quota — Enter no terminal', since: run.main.quotaWait.since });
  return items.sort((a, b) => (a.since || 0) - (b.since || 0));
}

// ---- kanban -----------------------------------------------------------------
export const KANBAN = [['todo', 'por fazer'], ['doing', 'em curso'], ['review', 'em review'], ['done', 'feito'], ['failed', 'falhou'], ['blocked', 'bloqueado']];
export function kanban(run) {
  const cols = Object.fromEntries(KANBAN.map(([k]) => [k, []]));
  for (const t of run.tasks || []) (cols[t.status] || cols.todo).push({ ...t, title: t.title || taskTitle(run, t.id) });
  return cols;
}

// Reviews: the CLI echo (final:false) duplicates the handback within seconds.
export function reviews(run) {
  const out = [];
  for (const r of run.reviews || []) {
    const dup = out.find(o => o.taskId === r.taskId && o.verdict === r.verdict && Math.abs(o.ts - r.ts) < 10000);
    if (dup) { dup.echo = true; continue; }
    out.push({ ...r });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export const roleOfEvent = e => e.role ? memberName(e.role) : null;

// Timeline kinds that a stranger cares about first.
export const KIND_LABEL = {
  'run.start': 'run', 'run.resume': 'run', 'run.finish': 'run', 'run.fail': 'run', 'run.block': 'run', 'checkpoint': 'checkpoint',
  'task.add': 'task', 'task.start': 'task', 'task.review': 'task', 'task.done': 'task', 'task.fail': 'task', 'task.block': 'task',
  'decision': 'decisão', 'ask': 'Sponsor', 'answer': 'Sponsor', 'permission': 'permissão', 'denied': 'permissão', 'quota': 'quota',
  'subagent.start': 'início', 'subagent.end': 'fim', 'subagent.fail': 'falha', 'handback': 'entrega', 'tool.error': 'erro',
  'session': 'sessão', 'session.end': 'sessão', 'prompt': 'prompt', 'stop': 'stop', 'stop.failure': 'stop', 'compact': 'compactação',
  'model.switch': 'modelo', 'fallback': 'fallback', 'notify': 'aviso', 'bad-line': 'linha má',
};
export const kindTone = k => /fail|error|denied|block|bad/.test(k) ? 'alarm' : /ask|permission|quota|stop/.test(k) ? 'sponsor' : /done|finish|handback|end/.test(k) ? 'done' : /start|decision/.test(k) ? 'work' : 'idle';
