// Forja viewer — cliente partilhado pelas páginas `/` (desktop) e `/m`
// (telemóvel). Vanilla ES module, sem dependências, sem build.
//
// - Liga-se a `/events` (SSE). Se não chegar `state` em 8 s ou a stream
//   falhar, consulta `GET /state` de 5 em 5 s (túneis podem reter SSE).
// - Guarda o desfasamento entre `generatedAt` e o relógio local; todos os
//   "há X" são calculados no browser e atualizados a cada segundo.
// - Cada secção é uma string HTML posta com innerHTML; uma secção só é
//   re-escrita quando a string muda. Exceção: a fila do Sponsor (`applyQueuePatch`)
//   mantém um nó por bilhete (chave = run + id da pergunta) e só substitui o
//   bloco do formulário quando ele muda de forma (aberto → respondido); enquanto
//   isso não acontece, o texto por enviar e o foco no textarea nunca são tocados.
//   Trocar de run troca a fila inteira: nenhum nó atravessa a troca.
// - Tudo o que vem do instantâneo passa por `esc()`. Sem handlers inline.
//
// As funções de render são puras (recebem o run e o "agora") e exportadas
// para os testes; só `boot()` toca no DOM.

// O elenco (chaves, nomes, papéis, `core`) vem do instantâneo: `roster[]`, na
// ordem do redutor (cinco de núcleo, cinco a pedido). EMPTY_ROSTER serve só
// enquanto não há instantâneo nenhum (os dez cartões nunca se escondem).
export const EMPTY_ROSTER = [
  { key: 'lead', name: 'Lead', role: 'Coordena, delega, verifica em disco, regista', core: true },
  { key: 'architect', name: 'Architect', role: 'O plano de tasks; replaneia quando parte', core: true },
  { key: 'frontend-dev', name: 'Frontend Dev', role: 'Ecrãs, estilo, verificação visual', core: true },
  { key: 'backend-dev', name: 'Backend Dev', role: 'Servidor, dados, scripts', core: true },
  { key: 'reviewer', name: 'Reviewer', role: 'Revisão independente — aprova ou recusa', core: true },
  { key: 'product-manager', name: 'Product Manager', role: 'Perfil de produto, enquadramento, decisões, relatório', core: false },
  { key: 'product-designer', name: 'Product Designer', role: 'Direção visual: mocks, escolha, DESIGN.md', core: false },
  { key: 'technology-scout', name: 'Technology Scout', role: 'Escolha de tecnologia por capacidade', core: false },
  { key: 'qa', name: 'QA', role: 'Validação final: e2e, regressão', core: false },
  { key: 'security-reviewer', name: 'Security Reviewer', role: 'Segunda revisão: auth, segredos, rede, dependências', core: false },
];
// Monogramas de duas letras (docs/design/DESIGN.md); um papel desconhecido usa as iniciais.
export const MONOGRAM = { lead: 'Le', architect: 'Ar', 'frontend-dev': 'FD', 'backend-dev': 'BD', reviewer: 'Re', 'product-manager': 'PM', 'product-designer': 'PD', 'technology-scout': 'TS', qa: 'QA', 'security-reviewer': 'SR' };
export const monogram = card => MONOGRAM[card.key] || String(card.name || '').split(/\s+/).map(w => w[0]).join('').slice(0, 2) || '?';
// Nomes antigos que ainda chegam em `owner`/`by` (runs e fixtures anteriores) → chave do papel.
const LEGACY = { ferreiro: 'lead', tracador: 'architect', lapidador: 'frontend-dev', frontend: 'frontend-dev', fundidor: 'backend-dev', backend: 'backend-dev', contraste: 'reviewer', bigorna: 'product-manager', designer: 'product-designer', scout: 'technology-scout', security: 'security-reviewer' };
export function memberName(run, who) {
  const k = String(who || '').toLowerCase();
  if (!k) return '—';
  const key = LEGACY[k] || k;
  const c = ((run && run.roster) || []).find(c => c.key === key);
  return c ? c.name : String(who);
}
const leadOf = run => ((run && run.roster) || []).find(c => c.key === 'lead') || { name: 'Lead' };

// Tom = família de cor da palavra de estado (docs/design/DESIGN.md, tabela de estados).
// forjalvl do run (docs/ARCHITECTURE.md §6, `run.forja.forjalvl`), em português.
// `Object.hasOwn`, nunca um lookup simples: "constructor" e outras chaves
// herdadas de Object.prototype não podem "resolver-se" a uma função.
export const FORJALVL_LABEL = { max: 'máximo', high: 'alto', eco: 'económico' };
export const levelLabel = v => Object.hasOwn(FORJALVL_LABEL, v) ? FORJALVL_LABEL[v] : String(v ?? '—');
// O snapshot traz `forjalvl` e o alias `modelLevel` (um snapshot de uma versão
// anterior do redutor só traz o segundo).
export const forjalvlOf = run => (run && run.forja ? (run.forja.forjalvl ?? run.forja.modelLevel) : undefined);

export const TONE = {
  'inativo': 'idle', 'a trabalhar': 'work', 'à espera de review': 'wait', 'à espera de input': 'wait', 'à espera de quota': 'wait', 'em pausa': 'wait',
  'bloqueado': 'alarm', 'precisa do Sponsor': 'sponsor', 'sem resposta': 'lost', 'morto': 'dead', 'terminado': 'done', 'falhou': 'fail',
};
export const toneOf = s => TONE[s] || 'idle';
export const LOUD = new Set(['bloqueado', 'precisa do Sponsor']);
const TASK_LABEL = { todo: 'por fazer', doing: 'em curso', review: 'em review', done: 'feito', failed: 'falhou', blocked: 'bloqueado' };
const TASK_TONE = { todo: 'idle', doing: 'work', review: 'wait', done: 'done', failed: 'fail', blocked: 'alarm' };
// Primeira linha de um hand-back ou veredicto: boa ou má notícia (a cor só reforça; a palavra está sempre lá).
const BAD_RE = /^\s*(QA FAIL|FAILED|BLOCKED|SECURITY-REJECT|REJECT)\b/i;
const GOOD_RE = /^\s*(QA PASS|DONE|APPROVE|SECURITY-APPROVE|PLAN|FRAME)\b/i;
export const gradeOf = t => BAD_RE.test(String(t || '')) ? 'bad' : GOOD_RE.test(String(t || '')) ? 'good' : '';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
export const clock = ts => { if (!ts) return '—'; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
export const hm = ts => { if (!ts) return '—'; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const firstLine = s => String(s ?? '').split('\n')[0];

// "12 s" · "4 min" · "1 h 12 min"; com `fine`, "1 min 40 s" abaixo de 10 min (sinal de vida, silêncio).
export function dur(ms, fine = false) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return fine && m < 10 && s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${pad(m % 60)} min`;
}
export const ago = (now, ts, fine = false) => ts ? `há ${dur(now - ts, fine)}` : '—';
// Spans que o relógio atualiza a cada segundo sem re-render.
const agoSpan = (now, ts) => ts ? `<span data-ago="${ts}">${ago(now, ts)}</span>` : '—';
const durSpan = (now, ts) => `<span data-dur="${ts}">${dur(now - ts, true)}</span>`;

// Estatística "tempo ligado" de um papel neste run: "12s" · "4 min" · "1 h 12 min".
export function activeDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${pad(m % 60)} min`;
}
// Modelo por agente na estatística: nome curto por família (prefixo, para
// `claude-opus-5[1m]` e `claude-fable-5-1` caírem no mesmo nome que
// `claude-opus-5`); um id de outra família fica tal e qual.
const MODEL_FAMILY = [['claude-opus-5', 'opus'], ['claude-sonnet-5', 'sonnet'], ['claude-fable-5', 'fable'], ['claude-haiku', 'haiku']];
export const shortModel = m => { const s = String(m ?? ''); const f = MODEL_FAMILY.find(([p]) => s.startsWith(p)); return f ? f[1] : s; };
// `models` = { <id do modelo>: ms ligado }: "opus 50 min, sonnet 22 min" (maior primeiro); um só → só o nome; `desconhecido` fica de fora.
export function modelsText(models) {
  const list = Object.entries(models || {}).filter(([m, ms]) => m && m !== 'desconhecido' && Number.isFinite(Number(ms))).sort((a, b) => b[1] - a[1]);
  if (!list.length) return '';
  if (list.length === 1) return shortModel(list[0][0]);
  return list.map(([m, ms]) => `${shortModel(m)} ${activeDur(ms)}`).join(', ');
}
// "ligado: 1 h 12 min · 3 sessões · opus 50 min, sonnet 22 min"; o Lead é a própria sessão, sem contagem; sem instâncias, sem linha.
export function statLine(card) {
  const n = Number(card.sessions) || 0;
  if (!n || card.activeMs == null) return '';
  const models = modelsText(card.models);
  const tail = models ? ` · ${models}` : '';
  if (card.key === 'lead') return `ligado: ${activeDur(card.activeMs)}${tail}`;
  return `ligado: ${activeDur(card.activeMs)} · ${n} ${n === 1 ? 'sessão' : 'sessões'}${tail}`;
}
// "limite de utilização, retoma às HH:MM" — hora local do browser a partir de `resume_at`.
export function pauseText(run) {
  const p = run && run.forja && run.forja.pause;
  if (!p) return null;
  return `${p.reason || 'limite de utilização'}, ${p.resumeAt ? `retoma às ${hm(p.resumeAt)}` : 'retoma quando repuser'}`;
}

// ---------- ligação perdida (T-UI-8) ----------
// O servidor manda `ping` por SSE de 15 em 15 s (viewer/server.mjs, HEARTBEAT_MS)
// e um `state` sempre que há eventos novos; o `fetch('/state')` de recurso conta
// tanto quanto o SSE. "Offline" é só silêncio a sério: 30 s sem nenhum dos dois
// (dois heartbeats perdidos), nunca a primeira falha isolada — evita a faixa a
// piscar num soluço de rede.
export const OFFLINE_MS = 30000;
export const lastContactOf = S => Math.max(S.lastStateAt || 0, S.lastSignal || 0);
export const isOffline = (S, now = Date.now()) => now - lastContactOf(S) > OFFLINE_MS;
// Um `error` do EventSource diz que o canal caiu, não que o servidor morreu: o
// túnel corta SSE longos de tempos a tempos e o browser religa sozinho. Por isso
// marca-se o erro num campo à parte e **nunca** se mexe na hora do último sinal —
// zerá-la punha a faixa no ecrã meio segundo depois de um corte de 3,5 s, e em
// modo SSE o `/state` de recurso só confirma vida a cada 60 s. Quem decide
// continua a ser o relógio: OFFLINE_MS sem `ping`, sem `state` e sem `/state`.
export function markSseError(S) { S.sseError = true; return S; }
// Faixa colada ao topo (tom `--alarm`, texto sempre presente — o significado
// nunca depende só da cor): a hora exata é a última prova de vida, para o Sponsor
// perceber se o link que tem aberto é mesmo o de agora (o túnel muda de endereço
// quando o viewer é relançado). `role="status"`/`aria-live` estão no wrapper
// persistente `#conn-banner` (index.html, mobile.html) e não aqui: uma região ao
// vivo tem de existir antes do texto mudar para o leitor de ecrã a anunciar.
export function renderConnBanner(sinceTs) {
  return `<div class="banner offline">
    <span>Sem ligação ao viewer desde ${esc(hm(sinceTs))} — os runs continuam no PC; se o endereço mudou, abre o link mais recente que recebeste por ntfy</span>
    <button type="button" class="btn" data-action="conn-retry">Tentar de novo</button>
  </div>`;
}
// Enquanto offline os "há X" continuam a contar no relógio local, mas isso não
// prova nada sobre o servidor: o cabeçalho troca essa ilusão de frescura por uma
// hora absoluta, a do último instantâneo que chegou mesmo.
export const asOfText = (offline, snap) => offline && snap ? `dados de ${hm(snap.generatedAt)}` : '';

// "T3 · Fundidor: Exportar CSV" → { id, title }. Ids com hífen também
// (`T-UI-2`, `T-OPS-1`, `D1`, `Q3`, `T12`): letra inicial, pelo menos um
// dígito, só maiúsculas/dígitos/hífens. Uma letra sozinha ("Q · Bigorna: …")
// é o tipo da chamada, não um id: o título separa-se na mesma, sem chip.
export function splitTask(task) {
  if (!task) return { id: null, title: null };
  const m = String(task).match(/^\s*([A-Z][A-Z0-9-]*\d[A-Z0-9-]*|[A-Z]+)\s*[·:]\s*(?:([A-Za-zÀ-ÿ ]+?)\s*:\s*)?(.*)$/);
  if (!m) return { id: null, title: String(task) };
  return { id: /\d/.test(m[1]) ? m[1] : null, title: m[3] || null };
}
export function taskTitle(run, id) {
  if (!id) return null;
  const t = (run.tasks || []).find(t => t.id === id);
  return t && t.title ? t.title : null;
}
function instTask(inst, run) {
  const s = splitTask(inst.task);
  const id = inst.taskId || s.id;
  return { id, title: (id && taskTitle(run, id)) || s.title || inst.task || null };
}

// Última prova de vida de um cartão: o instantâneo só traz lastEventAt por
// instância; o Lead é a sessão principal (mais as instâncias abertas).
export function lastSignalOf(card, run) {
  if (card.key === 'lead') {
    const open = [];
    for (const c of run.roster || []) for (const i of c.instances || []) if (!i.endedAt && (i.state === 'a trabalhar' || i.state === 'bloqueado')) open.push(i.lastEventAt || 0);
    return Math.max(run.main && run.main.lastEventAt || 0, ...open) || null;
  }
  const same = (card.instances || []).filter(i => i.state === card.state).map(i => i.lastEventAt || 0);
  return same.length ? Math.max(...same) : null;
}
// { kind: 'ok'|'quiet'|'lost'|'dead'|'none', at }
export function liveness(card, run, snap) {
  const tone = toneOf(card.state);
  const at = lastSignalOf(card, run) || (card.quiet ? snap.generatedAt - card.quiet : null);
  if (tone === 'work' && card.quiet > 0) return { kind: 'quiet', at };
  if (tone === 'work') return at ? { kind: 'ok', at } : { kind: 'none', at: null };
  if (tone === 'lost' || tone === 'dead') return at ? { kind: tone, at } : { kind: 'none', at: null };
  return { kind: 'none', at: null };
}

// Tudo o que só o Sponsor consegue mover. `pending` fica na fila mas não conta.
export function sponsorItems(run) {
  const items = [];
  const lead = leadOf(run).name;
  for (const q of run.queue || []) if (q.status === 'open' || q.status === 'pending') items.push({ kind: 'pergunta', id: q.id, who: memberName(run, 'product-manager'), title: q.question, fallback: q.default, why: q.why, since: q.ts, status: q.status, answer: q.answer, counts: q.status === 'open' });
  const main = run.roster && run.roster[0];
  if (main && main.state === 'precisa do Sponsor' && !(run.main && run.main.permission)) items.push({ kind: 'sessão principal', id: null, who: lead, title: main.detail || 'a sessão principal parou e precisa do Sponsor no terminal', why: 'só se resolve no terminal', since: main.since, counts: true });
  for (const c of run.roster || []) for (const i of c.instances || []) if (i.permission) items.push({ kind: 'permissão', id: null, who: c.name, title: `${i.permission.tool || 'ferramenta'}: ${i.permission.message || ''}`, why: 'permissão pendente no terminal', since: i.permission.since, task: i.task, counts: true });
  if (run.main && run.main.permission) items.push({ kind: 'permissão', id: null, who: lead, title: `${run.main.permission.tool || 'ferramenta'}: ${run.main.permission.message || ''}`, why: 'permissão pendente no terminal', since: run.main.permission.since, counts: true });
  if (run.main && run.main.quotaWait) items.push({ kind: 'quota', id: null, who: lead, title: run.main.quotaWait.kind === 'quota_auto_resume_stale' ? 'limite reposto enquanto o PC dormia — precisa de Enter no terminal' : 'espera por limite de utilização terminou sem retomar', why: 'só se resolve no terminal', since: run.main.quotaWait.since, counts: true });
  return items.sort((a, b) => (a.since || 0) - (b.since || 0));
}
export const sponsorCount = run => sponsorItems(run).filter(i => i.counts).length;

// Tom do ponto na linha do tempo: pelo tipo do evento; um hand-back de má notícia (REJECT, QA FAIL, BLOCKED…) é alarme.

// Run vazio (sem eventos ainda): os dez cartões inativos, nada escondido.
export function emptyRun() {
  return { id: null, project: '—', goal: null, goalSource: null, status: 'inativo', statusDetail: 'sem eventos ainda', openQuestions: 0, startedAt: null, modelFloor: '—', permissionMode: '—',
    forja: { checkpoints: 0 }, counts: { events: 0, errors: 0, refused: 0 }, main: {}, roster: EMPTY_ROSTER.map(r => ({ ...r, state: 'inativo', since: null, detail: null, quiet: null, instances: [], activeMs: 0, sessions: 0 })),
    native: [], tasks: [], decisions: [], queue: [], reviews: [], timeline: [] };
}

// ---------- cena: agentes ligados (docs/design/DESIGN.md, «Cena: agentes ligados») ----------
// Direção B «constelação» (D-SCENE-2): o Lead ao centro, os quatro papéis de
// núcleo em losango pela ordem do fluxo (Architect, Frontend Dev, Backend Dev,
// Reviewer — as quatro arestas de fluxo são os lados do losango, nenhuma passa
// por cima de um nó) e os cinco a pedido na órbita de fora, cada um encostado
// ao papel a quem entrega. As posições são as escritas no DESIGN: geometria
// fixa, nunca um layout automático. Só SVG + CSS, sem biblioteca, sem SMIL e
// sem `requestAnimationFrame` (docs/forja/TECHNOLOGY.md S1); orçamento de 300
// elementos SVG por render. O texto exato (nome, estado, task, tempos) vive no
// HUD: a cena só leva o monograma de duas letras de cada papel.
export const SCENE = { w: 1440, h: 240 };
export const SCENE_M = { w: 390, h: 230 };
export const SCENE_D = { w: 390, h: 86 };
export const NODES = {
  'lead': { x: 720, y: 120, r: 36 },
  'architect': { x: 438, y: 120, r: 25 },
  'frontend-dev': { x: 720, y: 42, r: 25 },
  'backend-dev': { x: 720, y: 198, r: 25 },
  'reviewer': { x: 1002, y: 120, r: 25 },
  'product-manager': { x: 182, y: 58, r: 18 },
  'product-designer': { x: 464, y: 28, r: 18 },
  'technology-scout': { x: 950, y: 28, r: 18 },
  'qa': { x: 1270, y: 190, r: 18 },
  'security-reviewer': { x: 1270, y: 58, r: 18 },
};
// Telemóvel: o mesmo losango, só o núcleo (os cinco a pedido vão para a barra).
export const NODES_M = {
  'lead': { x: 195, y: 128, r: 28 },
  'architect': { x: 74, y: 128, r: 21 },
  'frontend-dev': { x: 195, y: 54, r: 21 },
  'backend-dev': { x: 195, y: 202, r: 21 },
  'reviewer': { x: 316, y: 128, r: 21 },
};
// A barra «a pedido» aberta: os mesmos cinco nós, no mesmo desenho, numa fila.
export const NODES_D = {
  'product-manager': { x: 39, y: 43, r: 18 },
  'product-designer': { x: 117, y: 43, r: 18 },
  'technology-scout': { x: 195, y: 43, r: 18 },
  'qa': { x: 273, y: 43, r: 18 },
  'security-reviewer': { x: 351, y: 43, r: 18 },
};
// As dezanove arestas são FIXAS: nunca aparecem, desaparecem, mudam de cor ou
// de espessura por causa de um estado (a evidência está nos nós, nunca nas
// linhas). `hub` = chamada real (só o Lead tem a ferramenta `Agent`); `flow` =
// representação de quem entrega trabalho a quem — o caminho real volta sempre
// a passar pelo Lead, e a legenda da página diz isso por escrito.
export const SCENE_EDGES = [
  { a: 'lead', b: 'architect', kind: 'hub' },
  { a: 'lead', b: 'frontend-dev', kind: 'hub' },
  { a: 'lead', b: 'backend-dev', kind: 'hub' },
  { a: 'lead', b: 'reviewer', kind: 'hub' },
  { a: 'lead', b: 'product-manager', kind: 'hub' },
  { a: 'lead', b: 'product-designer', kind: 'hub' },
  { a: 'lead', b: 'technology-scout', kind: 'hub' },
  { a: 'lead', b: 'qa', kind: 'hub' },
  { a: 'lead', b: 'security-reviewer', kind: 'hub' },
  { a: 'architect', b: 'frontend-dev', kind: 'flow' },
  { a: 'architect', b: 'backend-dev', kind: 'flow' },
  { a: 'frontend-dev', b: 'reviewer', kind: 'flow' },
  { a: 'backend-dev', b: 'reviewer', kind: 'flow' },
  { a: 'reviewer', b: 'security-reviewer', kind: 'flow' },
  { a: 'qa', b: 'lead', kind: 'flow' },
  { a: 'product-manager', b: 'architect', kind: 'flow' },
  { a: 'technology-scout', b: 'frontend-dev', kind: 'flow' },
  { a: 'technology-scout', b: 'backend-dev', kind: 'flow' },
  { a: 'product-designer', b: 'frontend-dev', kind: 'flow' },
];
// Curvatura por aresta (desvio máximo = |bow| / 2; o sinal é o lado). Quase
// todas são quase retas; só as que contornam um nó vizinho sobem a 15–18 px.
// Invariante medido (teste): nenhuma aresta chega a menos de um raio do centro
// de um nó de terceiros. `lead>product-manager` leva +36 (18 px de desvio, para
// o lado de fora) e não os -30 do mock: com -30 a curva entrava 7,7 px no disco
// do Architect e lia-se através do nó (DESIGN.md §Geometria).
const BOW = {
  'lead>product-manager': 36, 'lead>security-reviewer': -30, 'lead>product-designer': 12,
  'lead>technology-scout': -12, 'lead>qa': 14, 'lead>architect': 14, 'lead>frontend-dev': -12,
  'lead>backend-dev': -12, 'lead>reviewer': 14,
  'architect>frontend-dev': -16, 'architect>backend-dev': 16, 'frontend-dev>reviewer': -16,
  'backend-dev>reviewer': 16, 'reviewer>security-reviewer': -14, 'qa>lead': -22,
  'product-manager>architect': 14, 'technology-scout>frontend-dev': -14,
  'technology-scout>backend-dev': 16, 'product-designer>frontend-dev': -14,
};
const r1 = v => Math.round(v * 10) / 10;
// Curva quadrática entre dois nós, recortada no raio de cada um para a linha
// nunca entrar no círculo. Devolve o `d` e `at(t)`, o ponto do troço desenhado
// (é sobre ele que assentam os pontos do fluxo de hand-back).
export function curve(a, b, G, bow) {
  const A = G[a], B = G[b];
  const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
  const px = -dy / L, py = dx / L;
  const cxp = (A.x + B.x) / 2 + px * bow, cyp = (A.y + B.y) / 2 + py * bow;
  const t0 = Math.min(.45, (A.r + 3) / L), t1 = 1 - Math.min(.45, (B.r + 3) / L);
  const at = t => ({ x: (1 - t) ** 2 * A.x + 2 * (1 - t) * t * cxp + t * t * B.x,
                     y: (1 - t) ** 2 * A.y + 2 * (1 - t) * t * cyp + t * t * B.y });
  const p0 = at(t0), p1 = at(t1);
  const mid = at((t0 + t1) / 2);
  const c = { x: 2 * mid.x - (p0.x + p1.x) / 2, y: 2 * mid.y - (p0.y + p1.y) / 2 };
  return { d: `M ${r1(p0.x)} ${r1(p0.y)} Q ${r1(c.x)} ${r1(c.y)} ${r1(p1.x)} ${r1(p1.y)}`, at };
}

// Glifo de estado: a forma que torna o estado legível sem cor (DESIGN, tabela
// «Estado de cada nó — cor e forma»). Desenhado num círculo de raio `r`.
export const GLYPH_COLOUR = { 'dot': 'var(--ember)', 'ring-dash': 'var(--amber)', 'bar': 'var(--wood)', 'bang': 'var(--alarm)', 'ring': 'var(--amber)', 'cross': 'var(--alarm)', 'tick': 'var(--patina)', 'cross-small': 'var(--alarm)' };
export function glyph(kind, x, y, r) {
  const col = GLYPH_COLOUR[kind], s = v => Math.round(v * 100) / 100;
  const w = Math.max(1.4, r * .34);
  switch (kind) {
    case 'dot': return `<circle cx="${x}" cy="${y}" r="${s(r * .5)}" fill="${col}"/>`;
    case 'ring-dash': return `<circle cx="${x}" cy="${y}" r="${s(r * .62)}" fill="none" stroke="${col}" stroke-width="${s(w)}" stroke-dasharray="${s(r * .5)} ${s(r * .5)}"/><circle cx="${x}" cy="${y}" r="${s(r * .2)}" fill="${col}"/>`;
    case 'bar': return `<rect x="${s(x - r * .68)}" y="${s(y - w / 2)}" width="${s(r * 1.36)}" height="${s(w)}" rx="${s(w / 2)}" fill="${col}"/>`;
    case 'bang': return `<rect x="${s(x - w / 2)}" y="${s(y - r * .72)}" width="${s(w)}" height="${s(r * .92)}" rx="${s(w / 2)}" fill="${col}"/><circle cx="${x}" cy="${s(y + r * .56)}" r="${s(w * .62)}" fill="${col}"/>`;
    case 'ring': return `<circle cx="${x}" cy="${y}" r="${s(r * .62)}" fill="none" stroke="${col}" stroke-width="${s(w)}"/>`;
    case 'cross': return `<g stroke="${col}" stroke-width="${s(w * 1.15)}" stroke-linecap="round"><line x1="${s(x - r * .6)}" y1="${s(y - r * .6)}" x2="${s(x + r * .6)}" y2="${s(y + r * .6)}"/><line x1="${s(x + r * .6)}" y1="${s(y - r * .6)}" x2="${s(x - r * .6)}" y2="${s(y + r * .6)}"/></g>`;
    case 'cross-small': return `<g stroke="${col}" stroke-width="${s(w)}" stroke-linecap="round"><line x1="${s(x - r * .38)}" y1="${s(y - r * .38)}" x2="${s(x + r * .38)}" y2="${s(y + r * .38)}"/><line x1="${s(x + r * .38)}" y1="${s(y - r * .38)}" x2="${s(x - r * .38)}" y2="${s(y + r * .38)}"/></g>`;
    case 'tick': return `<polyline points="${s(x - r * .55)},${s(y)} ${s(x - r * .12)},${s(y + r * .42)} ${s(x + r * .58)},${s(y - r * .45)}" fill="none" stroke="${col}" stroke-width="${s(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    default: return '';
  }
}

// Tudo o que o desenho de um nó precisa de saber, derivado só do instantâneo.
// `a trabalhar` sem prova de sinal recente conta como silêncio: não pulsa e
// leva o anel tracejado âmbar — a animação exige evidência, nunca a supõe.
export function nodeLook(card, run, snap) {
  const tone = toneOf(card.state);
  const live = liveness(card, run, snap);
  const fresh = tone === 'work' && live.kind === 'ok';
  const quiet = tone === 'work' && !fresh;
  const loud = tone === 'alarm' || tone === 'sponsor';
  const glyphKind = fresh ? 'dot' : quiet ? 'ring-dash' : tone === 'wait' ? 'bar' : loud ? 'bang'
    : tone === 'lost' ? 'ring' : tone === 'dead' ? 'cross' : tone === 'done' ? 'tick' : tone === 'fail' ? 'cross-small' : 'none';
  return {
    tone, fresh, loud, glyph: glyphKind,
    glow: fresh ? 1 : quiet ? .5 : loud ? .55 : tone === 'wait' ? .35 : 0,
    glowCol: loud ? 'var(--alarm)' : 'var(--c)',
    // `body` apaga só a mobília do nó (anel e pontos de instância). O monograma
    // é texto e tem de ficar acima de 4,5:1 (DESIGN.md, Acessibilidade): só o
    // estado `inativo` o apaga, e apaga-o porque o DESIGN manda («sem glifo, nó
    // a 45 %») — em `terminado`, `morto`, `sem resposta` e `falhou` o papel
    // continua a ler-se.
    body: ['idle', 'dead', 'lost', 'fail', 'done'].includes(tone) ? .45 : 1,
    mono: tone === 'idle' ? .45 : 1,
  };
}
// Instâncias em curso deste papel (o mesmo critério de "aberta" que serve a
// prova de vida): até três pontos na coroa de baixo, o número exato no cartão.
export const openInstances = card => (card.instances || []).filter(i => !i.endedAt && ['a trabalhar', 'bloqueado', 'precisa do Sponsor'].includes(i.state)).length;
// Hand-back acabado de acontecer: os três pontos correm sobre a aresta do Lead
// (a chamada real), que é por onde o trabalho volta mesmo. Some com a janela.
export const HANDBACK_FRESH_MS = 90000;
export function freshHandbacks(run, snap) {
  const out = [];
  for (const c of run.roster || []) {
    if (c.key === 'lead') continue;
    for (const i of c.instances || []) {
      const h = i.handback;
      if (h && h.ts && snap.generatedAt - h.ts <= HANDBACK_FRESH_MS && snap.generatedAt >= h.ts) { out.push(c.key); break; }
    }
  }
  return out;
}
// A rede fria: o runner parou ou está morto (DESIGN). Evidência do instantâneo
// — `runner.exit` registado, ou o run sem sinal nenhum. Nunca é a única prova:
// o selo do cabeçalho di-lo por palavras e é ele que manda.
export function sceneCold(run) {
  const r = run && run.forja && run.forja.runner;
  if (r && r.exited) return true;
  return ['morto', 'sem resposta'].includes(run && run.status);
}

function sceneNode(card, g, run, snap, tag) {
  const s = nodeLook(card, run, snap);
  const core = card.core !== false;
  const id = `gl-${card.key}${tag}`;
  const defs = s.glow ? `<defs><radialGradient id="${id}"><stop offset="0" stop-color="${s.glowCol}" stop-opacity=".55"/><stop offset=".38" stop-color="${s.glowCol}" stop-opacity=".22"/><stop offset="1" stop-color="${s.glowCol}" stop-opacity="0"/></radialGradient></defs>` : '';
  const halo = s.glow ? `<circle class="halo" cx="${g.x}" cy="${g.y}" r="${r1(g.r * 2.2)}" fill="url(#${id})" opacity="${s.glow}"/>` : '';
  const gr = core ? 8 : 6.5, a = -Math.PI / 4;   // medalha no quadrante superior direito da coroa
  const badge = s.glyph === 'none' ? ''
    : `<g transform="translate(${r1(g.x + Math.cos(a) * g.r)} ${r1(g.y + Math.sin(a) * g.r)})"><circle r="${gr + 3.5}" fill="var(--bg)" stroke="var(--line)"/>${glyph(s.glyph, 0, 0, gr)}</g>`;
  const n = Math.min(openInstances(card), 3);
  const notches = [...Array(n)].map((_, j) => {
    const ang = Math.PI / 2 + (j - (n - 1) / 2) * .34;
    return `<circle class="notch" cx="${r1(g.x + Math.cos(ang) * g.r)}" cy="${r1(g.y + Math.sin(ang) * g.r)}" r="2.6"/>`;
  }).join('');
  const cross = s.tone === 'dead'   // morto: o X grande por cima do nó inteiro
    ? `<g stroke="var(--alarm)" stroke-width="3" stroke-linecap="round"><line x1="${r1(g.x - g.r * .7)}" y1="${r1(g.y - g.r * .7)}" x2="${r1(g.x + g.r * .7)}" y2="${r1(g.y + g.r * .7)}"/><line x1="${r1(g.x + g.r * .7)}" y1="${r1(g.y - g.r * .7)}" x2="${r1(g.x - g.r * .7)}" y2="${r1(g.y + g.r * .7)}"/></g>` : '';
  const size = g.r >= 30 ? ' lead' : g.r >= 23 ? '' : ' sm';
  const dy = g.r >= 30 ? 9 : g.r >= 23 ? 8 : 6;
  return `<g class="node m-${card.key} t-${s.tone}${core ? '' : ' demand'}${s.fresh ? ' live' : ''}">${defs}${halo}
    <g opacity="${s.body}">
      <circle class="ring${core ? '' : ' demand'}" cx="${g.x}" cy="${g.y}" r="${g.r}"/>
      ${notches}
    </g>
    <text class="mg${size}" x="${g.x}" y="${g.y + dy}"${s.mono < 1 ? ` opacity="${s.mono}"` : ''}>${esc(monogram(card))}</text>
    ${badge}${cross}</g>`;
}

// `aria-label`: os papéis desenhados e o estado de cada um, por palavras.
const sceneLabel = (cards, cold) => `Ligações do elenco. ${cards.map(c => `${c.name}: ${c.state}`).join('. ')}.${cold ? ' O runner parou: a rede está fria.' : ''}`;
function sceneSvg(cards, G, box, run, snap, { tag = '', cold = false } = {}) {
  const set = new Set(cards.map(c => c.key));
  const paths = new Map();
  const draw = kind => SCENE_EDGES.filter(e => e.kind === kind && set.has(e.a) && set.has(e.b)).map(e => {
    const key = `${e.a}>${e.b}`;
    const c = curve(e.a, e.b, G, (BOW[key] || 20) * (box.w < 500 ? .5 : 1));
    paths.set(key, c);
    return `<path class="edge ${kind}" d="${c.d}"/>`;
  }).join('');
  const edges = draw('hub') + draw('flow');
  const hb = cold ? '' : freshHandbacks(run, snap).map(k => {
    const c = paths.get(`lead>${k}`);
    if (!c) return '';
    return [.3, .5, .7].map((t, j) => { const p = c.at(t); return `<circle class="hb hb${j + 1}" cx="${r1(p.x)}" cy="${r1(p.y)}" r="4" fill="var(--patina)"/>`; }).join('');
  }).join('');
  return `<svg class="scene${cold ? ' cold' : ''}" viewBox="0 0 ${box.w} ${box.h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(sceneLabel(cards, cold))}">
    ${edges}${hb}${cards.map(c => sceneNode(c, G[c.key], run, snap, tag)).join('')}
  </svg>`;
}
const sceneCards = (run, G) => (run.roster || []).filter(c => G[c.key]);
export function renderScene(run, snap) {
  return sceneSvg(sceneCards(run, NODES), NODES, SCENE, run, snap, { cold: sceneCold(run) });
}
// Telemóvel: só o grafo do núcleo; os cinco a pedido vão na barra dobrável.
export function renderSceneMobile(run, snap) {
  return sceneSvg(sceneCards(run, NODES_M), NODES_M, SCENE_M, run, snap, { tag: '-m', cold: sceneCold(run) });
}
// A barra «a pedido»: cinco pastilhas com o glifo de estado e o monograma
// (um papel bloqueado ou que precisa do Sponsor mostra o «!» mesmo dobrado) e o
// botão que abre os cinco nós no mesmo desenho.
export function renderDemandBar(run, snap, open = false) {
  const cards = sceneCards(run, NODES_D);
  const cold = sceneCold(run);
  const pills = cards.map(c => {
    const s = nodeLook(c, run, snap);
    return `<span class="pill m-${c.key} t-${s.tone}"><svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true" focusable="false">${glyph(s.glyph, 0, 0, 6)}</svg>${esc(monogram(c))}<span class="sr">${esc(c.name)}: ${esc(c.state)}</span></span>`;
  }).join('');
  return `<div class="fold"><b>a pedido</b>${pills}<button type="button" class="pill open" id="demand-toggle" data-action="demand" aria-expanded="${open}" aria-controls="demand-open">${open ? 'fechar os 5 ▴' : 'abrir os 5 ▾'}</button></div>
    <div id="demand-open" class="stage"${open ? '' : ' hidden'}>${sceneSvg(cards, NODES_D, SCENE_D, run, snap, { tag: '-d', cold })}</div>`;
}
// Legenda literal, por baixo da cena: as formas de estado e o que as duas
// espécies de linha significam (uma é chamada, a outra é representação).
const LEGEND = [['dot', 'a trabalhar'], ['ring-dash', 'silêncio'], ['bar', 'espera / pausa'], ['bang', 'precisa de um humano'], ['ring', 'sem resposta'], ['cross', 'morto'], ['tick', 'terminado'], ['cross-small', 'falhou']];
export const LEGEND_EDGES = 'linha cheia = o Lead chama · tracejado = fluxo de trabalho (representação)';
export const LEGEND_COLD = 'runner parado: a rede está fria';
export function renderLegend(cold = false) {
  const items = LEGEND.map(([k, label]) => `<span><svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true" focusable="false">${glyph(k, 0, 0, 7)}</svg> ${esc(label)}</span>`).join('');
  return `${items}<span><b>${esc(LEGEND_EDGES)}${cold ? ` · ${LEGEND_COLD}` : ''}</b></span>`;
}

// ---------- HUD ----------
function instBlock(i, run, now, card = {}) {
  const { id, title } = instTask(i, run);
  const tone = toneOf(i.state);
  const v = i.verdict || (i.handback && i.handback.status) || null;
  const hb = i.handback && i.handback.text ? firstLine(i.handback.text) : null;
  let detail = i.permission ? `permissão pendente — ${i.permission.tool || ''}: ${i.permission.message || ''}` : i.state === 'falhou' ? (i.error || i.detail || 'a chamada falhou') : (i.progress && i.progress.text) || i.detail || i.lastAction || (v ? `entregou ${v}` : '');
  // Terminou: a primeira linha do hand-back diz mais do que a palavra de estado sozinha ("QA FAIL — 2 findings", não "QA").
  if (hb && i.state === 'terminado' && (!detail || detail === v || detail === i.handback.status)) detail = hb;
  const cls = i.state === 'falhou' ? 'err' : i.state === 'terminado' ? `v-${gradeOf(hb || v) || 'plain'}` : '';
  const stateWord = i.state === 'terminado' && i.inferred ? 'terminou (inferido)' : i.state;
  const task = run.tasks.find(t => t.id === id);
  const reviews = card.key === 'reviewer' || card.key === 'security-reviewer';
  const waitChip = !reviews && task && task.status === 'review' && i.state === 'terminado' && !['finished', 'failed'].includes(run.forja && run.forja.status) ? `<span class="chip wait">à espera do ${esc(memberName(run, 'reviewer'))}</span>` : '';
  return `<div class="inst t-${tone}">
    <div class="task">${id ? `<span class="chip">${esc(id)}</span>` : ''}<span class="title" title="${esc(i.task || '')}">${esc(title || i.type || '—')}</span>${waitChip}</div>
    <div class="ist${LOUD.has(i.state) ? ' loud' : ''}">${esc(stateWord)} · ${agoSpan(now, i.since)}</div>
    ${detail ? `<div class="detail ${cls}">${esc(detail)}</div>` : ''}
    <div class="model">modelo <b>${esc(i.resolvedModel || i.requestedModel || '—')}</b> · começou ${clock(i.startedAt)}${i.calls ? ` · ${i.calls} chamada${i.calls === 1 ? '' : 's'}` : ''}${i.background ? ' · em background' : ''}${i.refused ? ` · ${i.refused} sem resposta ou recusadas` : ''}</div>
  </div>`;
}
const roleLine = card => `${card.core === false ? '<em class="tag">a pedido</em> ' : ''}${esc(String(card.role || '').split(' — ')[0])}`;
export function renderCard(card, run, snap, now) {
  const tone = toneOf(card.state);
  const live = liveness(card, run, snap);
  const lead = card.key === 'lead';
  const onDemand = card.core === false;
  const cls = ['card', `m-${card.key}`, `t-${tone}`, LOUD.has(card.state) ? 'loud' : '', tone === 'dead' ? 'dead' : '', tone === 'fail' ? 'fail' : '', tone === 'idle' ? 'idle' : '', onDemand ? 'demand' : ''].filter(Boolean).join(' ');
  let body;
  if (lead) {
    const rt = toneOf(run.status);
    // Numa sessão solta o bloco chama-se «sessão» e não inventa um piso de
    // modelo, que só um run tem: «run terminado» era exatamente a leitura errada
    // que este bilhete todo veio corrigir (T-UI-9).
    const solta = isLooseSession(run);
    const word = solta ? 'sessão' : 'run';
    body = `<div class="inst t-${tone}"><div class="task"><span class="chip">${word}</span><span class="title" title="${esc(run.goal || '')}">${esc(run.goal || (solta ? 'sem prompt registado' : 'sem objetivo registado'))}</span></div>
      <div class="ist t-${rt}${LOUD.has(run.status) ? ' loud' : ''}">${word} ${esc(run.status)}</div>
      <div class="model">modelo <b>da sessão${solta ? '' : ` · mínimo ${esc(run.modelFloor || '—')}`}</b> · ${card.calls || 0} chamada${card.calls === 1 ? '' : 's'}${card.refused ? ` · ${card.refused} sem resposta ou recusadas` : ''}</div></div>`;
  } else if (!card.instances || !card.instances.length) {
    body = `<div class="inst t-idle"><div class="detail">${onDemand ? 'a pedido · ainda não foi preciso neste run' : 'ainda não foi chamado neste run'}</div></div>`;
  } else {
    // Todas as instâncias em curso e as duas mais recentes já terminadas ficam à
    // vista; as anteriores continuam no cartão, uma a uma, atrás de "mais N".
    const over = ['terminado', 'falhou'];
    let pastSeen = 0;
    const shown = [], more = [];
    for (const i of card.instances) { if (over.includes(i.state) && ++pastSeen > 2) more.push(i); else shown.push(i); }
    body = shown.map(i => instBlock(i, run, now, card)).join('');
    if (more.length) body += `<details class="more"><summary>mais ${more.length} instância${more.length === 1 ? '' : 's'} anterior${more.length === 1 ? '' : 'es'}</summary>${more.map(i => instBlock(i, run, now, card)).join('')}</details>`;
  }
  const lifeText = live.kind === 'quiet' ? `silêncio há ${durSpan(now, live.at)}` : live.kind === 'ok' ? `último sinal há ${durSpan(now, live.at)}` : (live.kind === 'lost' || live.kind === 'dead') ? `último sinal há ${durSpan(now, live.at)}` : '';
  // "sem resposta"/"morto": o detail do redutor repete a linha de vida (que aqui conta ao segundo).
  let what = (live.kind === 'lost' || live.kind === 'dead') ? '' : (card.detail || '');
  // em pausa: a palavra de estado já diz EM PAUSA; aqui vai só o porquê e a hora.
  if (lead && card.state === 'em pausa') what = pauseText(run) || card.detail || '';
  const stat = statLine(card);
  return `<article class="${cls}" aria-label="${esc(card.name)}: ${esc(card.state)}">
    <div class="nm"><span class="mo" aria-hidden="true">${esc(monogram(card))}</span><b>${esc(card.name)}</b></div>
    <div class="rl" title="${esc(card.role || '')}">${roleLine(card)}</div>
    <div class="word">${esc(card.state)}</div>
    <div class="since">${card.since ? `<b>${agoSpan(now, card.since)}</b> · desde ${clock(card.since)}` : 'sem instância neste run'}</div>
    ${lifeText ? `<div class="life ${live.kind}">${lifeText}</div>` : ''}
    <div class="what">${esc(what)}</div>
    ${body}
    ${stat ? `<div class="stat">${esc(stat)}</div>` : ''}
  </article>`;
}
export const renderHud = (run, snap, now) => run.roster.map(c => renderCard(c, run, snap, now)).join('');

export function renderNative(run, now) {
  const rows = (run.native || []).map(n => `<div class="row t-${toneOf(n.state)}"><b>${esc(n.type)}</b><span class="s">${esc(n.state)} · ${agoSpan(now, n.since)}</span><span class="tk">${esc(n.task || '')}${n.detail ? ` — ${esc(n.detail)}` : ''}</span><span class="md">${esc(n.resolvedModel || n.requestedModel || '')}</span></div>`).join('');
  return `<div class="lbl">Ferramentas nativas<small>não são elenco</small></div><div>${rows || 'nenhuma neste run'}</div>`;
}

// ---------- fila do Sponsor ----------
// Chave estável de um item da fila, SEMPRE dentro do run a que pertence. Dois
// runs vivos ao mesmo tempo têm ambos uma `Q1` aberta (caso real): sem o run na
// chave, trocar de run no seletor reaproveitava o nó do bilhete do run anterior
// e o `<form data-project>` ficava com o projeto antigo — a resposta era gravada
// no projeto errado. Item sem id (permissão, sessão principal, quota):
// tipo+quem+desde, que não chega quando dois pedidos do mesmo membro têm o mesmo
// instante; por isso é `queueKeys` que gera as chaves, com sufixo de ordem nos
// repetidos.
export const queueKey = (q, runId = '') => q.id ? `q:${runId}:${q.id}` : `x:${runId}:${q.kind}:${q.who}:${q.since}`;
export function queueKeys(items, runId = '') {
  const seen = new Map();
  return items.map(q => {
    const base = queueKey(q, runId);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}
// Chave de uma resposta local (escrita e enviada, a enviar, falhada): projeto +
// id da pergunta, que é exatamente o par com que o servidor grava
// (`POST /answers` → `data/answers/<projeto>.jsonl`). Indexada só por id, a
// `Q1` enviada num projeto seria dada como respondida na `Q1` do outro.
// Comprimento do projeto à cabeça: sem ambiguidade e sem escapes.
export const answerKey = (project, id) => `${String(project ?? '').length}|${project ?? ''}|${id ?? ''}`;

// Uma pergunta com resposta já enviada (confirmado pelo servidor em `pending`,
// ou aceite localmente antes de o instantâneo chegar) mostra o selo, não o formulário.
export function ticketPending(q, local = {}) {
  const sent = local.sent || new Map();
  return q.status === 'pending' || !!(q.id && sent.has(answerKey(local.project, q.id)) && q.status === 'open');
}
// Forma do bloco de resposta: só muda quando a pergunta passa de aberta a
// respondida (uma vez, depois de um envio com sucesso) — nunca por causa do
// relógio, de `sending` ou de um erro de envio. Enquanto a forma não muda,
// `applyQueuePatch` não toca no nó do formulário: o textarea, o texto por
// enviar e o foco ficam como estavam.
export function ticketFormState(q, local = {}) {
  if (q.kind !== 'pergunta' || !q.id) return 'other';
  return ticketPending(q, local) ? 'pending' : 'open';
}
function ticketHead(q, now) {
  return `<div class="k"><span>${esc(q.kind)}${q.id ? ` ${esc(q.id)}` : ''}</span><span>${agoSpan(now, q.since)} · ${clock(q.since)}</span></div>
      <div class="q">${esc(q.title)}</div>
      ${q.fallback ? `<div class="d"><b>Se não responder:</b> ${esc(q.fallback)}</div>` : ''}
      ${q.why ? `<div class="d"><b>Porquê:</b> ${esc(q.why)}</div>` : ''}
      ${q.task ? `<div class="d"><b>Task:</b> ${esc(q.task)}</div>` : ''}`;
}
// `local.project` é a única fonte do projeto do bilhete (é o que vai no
// `data-project` e o que indexa as respostas locais): quem chama passa sempre o
// projeto do run que está a desenhar.
function ticketForm(q, lead, local = {}) {
  const sent = local.sent || new Map(), sending = local.sending || new Set(), errors = local.errors || new Map();
  if (q.kind !== 'pergunta' || !q.id) return `<div class="only">só se resolve no terminal do ${lead}</div>`;
  const pending = ticketPending(q, local);
  const ak = answerKey(local.project, q.id);
  const answer = q.status === 'pending' ? q.answer : sent.get(ak) || '';
  const busy = sending.has(ak);
  const fid = `ans-${esc(q.id)}`;
  return pending
    ? `<div class="seal">resposta enviada · à espera do ${lead}</div><div><label for="${fid}">Resposta</label><textarea id="${fid}" disabled>${esc(answer)}</textarea></div>`
    : `<form data-action="answer" data-id="${esc(q.id)}" data-project="${esc(local.project)}"><label for="${fid}">Resposta</label><textarea id="${fid}" name="answer" data-q="${esc(q.id)}" required ${busy ? 'disabled' : ''}></textarea>
       <div class="row"><button class="btn" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'a enviar…' : 'Enviar'}</button><span class="err" aria-live="polite">${esc(errors.get(ak) || '')}</span></div></form>`;
}
// Assinatura da forma do bloco do formulário. Enquanto não muda, o bloco não é
// tocado (é isso que salva o foco e o texto por enviar). Um bilhete `other`
// (permissão, quota, sessão principal) não tem forma que mude, mas tem texto
// que pode mudar (o nome do Lead), por isso a assinatura é o próprio HTML — não
// há lá nada com foco.
function formSig(q, lead, local) {
  const s = ticketFormState(q, local);
  return s === 'other' ? `other:${ticketForm(q, lead, local)}` : s;
}
// Bilhete completo: usado no primeiro render de um bilhete novo e por
// `renderQueue` (o render "de uma vez", sem reconciliação — testes e o
// primeiro paint). `t-head`/`t-form` são os dois blocos que `applyQueuePatch`
// atualiza em separado.
function renderTicket(q, key, now, lead, local = {}) {
  return `<article class="ticket${ticketPending(q, local) ? ' pending' : ''}" data-key="${esc(key)}">
    <div class="t-head">${ticketHead(q, now)}</div>
    <div class="t-form">${ticketForm(q, lead, local)}</div>
    <div class="who">pedido por ${esc(q.who)}</div>
  </article>`;
}
export function renderQueue(run, now, local = {}) {
  const items = sponsorItems(run);
  if (!items.length) return `<div class="none">Nada pendente para o Sponsor.</div>`;
  const lead = esc(leadOf(run).name);
  const l = { ...local, project: run.project };
  const keys = queueKeys(items, run.id ?? '');
  return items.map((q, i) => renderTicket(q, keys[i], now, lead, l)).join('');
}

// Reconciliação por chave (docs/design/DESIGN.md, ciclo de um bilhete): a fila
// muda de string a cada poll só porque o "há X s" avança, mas isso não pode
// arrancar o textarea de resposta a meio de uma frase — perde-se o foco e o
// teclado do telemóvel fecha. Por isso o nó de cada bilhete é permanente
// enquanto o bilhete existir: a cabeça (tempo, título, motivo) é sempre
// reescrita — não tem nada com foco — e o formulário só é reconstruído quando
// `ticketFormState` muda (aberta → respondida, uma vez); enquanto fica aberto,
// só se ajustam os controlos (desativado, rótulo do botão, erro) por
// propriedade, nunca por `innerHTML`. `state` é `{ sent, sending, errors,
// queueNodes: Map<chave, nó>, queueForm: Map<chave, assinatura da forma>,
// queueEmptyShown, queueRun }`, guardado em `S` por `boot()`.
export function applyQueuePatch(container, doc, run, now, state) {
  if (!container) return;
  const items = sponsorItems(run);
  const lead = esc(leadOf(run).name);
  const runId = run.id ?? '';
  const local = { sent: state.sent, sending: state.sending, errors: state.errors, project: run.project };
  // Trocar de run no seletor troca a fila inteira. As chaves já incluem o run
  // (nenhum nó do run anterior é reaproveitado), mas a fila é esvaziada à
  // cabeça para nenhum bilhete do run antigo ficar no ecrã à espera da
  // varredura do fim — e para os selos de "forma" não sobreviverem à troca.
  // (`answerKey` está aqui só como codificação sem ambiguidade de projeto+run.)
  const scope = answerKey(run.project, runId);
  if (state.queueRun !== scope) {
    state.queueRun = scope;
    if (state.queueNodes.size || state.queueEmptyShown) {
      container.innerHTML = '';
      state.queueNodes.clear(); state.queueForm.clear(); state.queueEmptyShown = false;
    }
  }
  if (!items.length) {
    if (state.queueNodes.size || !state.queueEmptyShown) {
      container.innerHTML = `<div class="none">Nada pendente para o Sponsor.</div>`;
      state.queueNodes.clear(); state.queueForm.clear(); state.queueEmptyShown = true;
    }
    return;
  }
  if (state.queueEmptyShown) { container.innerHTML = ''; state.queueNodes.clear(); state.queueForm.clear(); }
  state.queueEmptyShown = false;
  const keys = queueKeys(items, runId);
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const q = items[i], key = keys[i];
    seen.add(key);
    let node = state.queueNodes.get(key);
    if (!node) {
      const wrap = doc.createElement('div');
      wrap.innerHTML = renderTicket(q, key, now, lead, local);
      node = wrap.children[0];
      state.queueNodes.set(key, node);
      state.queueForm.set(key, formSig(q, lead, local));
      container.appendChild(node);
      continue;
    }
    const headEl = node.querySelector('.t-head'); if (headEl) headEl.innerHTML = ticketHead(q, now);
    const whoEl = node.querySelector('.who'); if (whoEl) whoEl.textContent = `pedido por ${q.who}`;
    node.classList.toggle('pending', ticketPending(q, local));
    const formState = ticketFormState(q, local);
    const sig = formSig(q, lead, local);
    const formEl = node.querySelector('.t-form');
    if (sig !== state.queueForm.get(key)) {
      state.queueForm.set(key, sig);
      if (formEl) formEl.innerHTML = ticketForm(q, lead, local);
    } else if (formState === 'open' && formEl) {
      const ak = answerKey(local.project, q.id);
      const sendingNow = !!(q.id && state.sending.has(ak));
      const ta = formEl.querySelector('textarea[data-q]'); if (ta) ta.disabled = sendingNow;
      const btn = formEl.querySelector('button[type="submit"]'); if (btn) { btn.disabled = sendingNow; btn.textContent = sendingNow ? 'a enviar…' : 'Enviar'; }
      const err = formEl.querySelector('.err'); if (err) err.textContent = state.errors.get(ak) || '';
    }
  }
  for (const [key, node] of state.queueNodes) if (!seen.has(key)) { node.remove(); state.queueNodes.delete(key); state.queueForm.delete(key); }
  // Reordena só quem está no sítio errado: `appendChild`/`insertBefore` num
  // nó já corretamente colocado ainda conta como remover+inserir e um
  // Chrome real tira-lhe o foco — por isso um bilhete que já está na posição
  // certa nunca é tocado (é o que garante o foco de Q1 quando só Q2 se mexe).
  let at = 0;
  for (const key of keys) {
    const node = state.queueNodes.get(key);
    if (!node) continue;
    if (container.children[at] !== node) container.insertBefore(node, container.children[at] || null);
    at++;
  }
}

// O que o `POST /answers` leva sai SEMPRE do formulário que está no ecrã — o
// `data-project` do bilhete, nunca o run selecionado no momento do envio (com
// dois runs vivos podem divergir). Devolve também a chave local da resposta.
export function answerSubmission(form) {
  if (!form) return null;
  const project = form.dataset.project || '';
  const id = form.dataset.id || '';
  const ta = form.querySelector('textarea[name="answer"]');
  const answer = String((ta && ta.value) || '').trim();
  if (!id || !answer) return null;
  return { project, id, answer, key: answerKey(project, id) };
}

// ---------- novo run (bilhete claro: o Sponsor arranca ou relança um run) ----------
// Contrato do servidor (`viewer/runs-api.mjs`): GET /projects → { ok, projects:
// [{ name, path, bootstrappedAt, run: { run_id, status, goal, started_at } | null,
// runnerAlive }] }; POST /runs { project, goal } → 200 { ok, action, project, pid },
// { project, resume: true } idem; 400/403/404/409/500 → { error }.
// `path` nunca aparece na página — só `name`.
//
// `runnerAlive` é de topo e INDEPENDENTE de `run`: o runner escreve o lock ao
// arrancar e o RUN.json só existe segundos a minutos depois (é a sessão do Lead
// que o escreve). Entre os dois há uma janela real de `run: null, runnerAlive:
// true` — o estado "a arrancar" — em que um arranque novo levaria 409.
export const NEWRUN_GOAL_MIN = 10;
export const NEWRUN_GOAL_MAX = 600;
// Sem escapes unicode no ficheiro: os mesmos caracteres que o servidor recusa
// (controlo, DEL e os separadores de linha/parágrafo).
const hasControl = s => {
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 127 || c === 8232 || c === 8233) return true; }
  return false;
};
const NEWRUN_WORD = { running: 'run a correr', finished: 'terminado', failed: 'falhou', blocked: 'bloqueado' };

// `busy: true` = um arranque agora levaria 409 do servidor; o botão fica desativado.
export function projectRunState(p) {
  const r = p && p.run && typeof p.run === 'object' ? p.run : null;
  const alive = !!(p && p.runnerAlive);
  const word = r ? NEWRUN_WORD[r.status] || String(r.status || 'run') : null;
  // Palavras de estado exatas do DESIGN §Novo run, com vírgula a separar as duas metades.
  if (alive && !r) return { kind: 'starting', label: 'a arrancar', busy: true };
  if (alive) return { kind: 'live', label: `${word}, runner vivo`, busy: true };
  if (!r) return { kind: 'none', label: 'sem run', busy: false };
  if (r.status === 'running') return { kind: 'stale', label: 'run em curso, runner parado', busy: false };
  const kind = ['finished', 'failed', 'blocked'].includes(r.status) ? r.status : 'none';
  return { kind, label: word, busy: false };
}

export const newRunInit = () => ({ project: null, goal: '', confirmArmed: false, phase: 'idle', error: '', loaded: false, startedProject: null, startedRunId: null, startedGoal: '', startedResume: false, startedAt: null });
// O selo "run a arrancar" expira ao fim disto sem prova (/projects) de que o
// runner arrancou ou de um run novo (DESIGN §Novo run + B5): volta ao formulário.
export const NEWRUN_EXPIRE_MS = 90000;
export const NEWRUN_EXPIRED_TEXT = 'o runner não arrancou — vê o computador (o motivo fica no registo do runner)';

// Tudo o que a secção precisa de decidir, sem DOM e sem rede.
export function newRunView(projects, state = {}) {
  const list = Array.isArray(projects) ? projects : [];
  const phase = state.phase === 'submitting' || state.phase === 'started' ? state.phase : 'idle';
  const wanted = phase === 'started' ? state.startedProject || state.project : state.project;
  const sel = list.find(p => p.name === wanted) || list[0] || null;
  const info = sel ? projectRunState(sel) : null;
  const isResume = !!(info && info.kind === 'stale');
  const busy = !!(info && info.busy);
  const goal = typeof state.goal === 'string' ? state.goal : '';
  const trimmed = goal.trim(); // o servidor apara antes de validar: o contador conta o mesmo
  const len = trimmed.length;
  const badDash = trimmed.startsWith('-'); // `--goal <texto>`: um "-" à cabeça seria lido como flag
  const ctl = hasControl(trimmed); // uma textarea aceita Enter e o servidor recusa-o: é preciso dizê-lo
  const validGoal = len >= NEWRUN_GOAL_MIN && len <= NEWRUN_GOAL_MAX && !badDash && !ctl;
  const locked = phase !== 'idle';
  const canSubmit = !!sel && !busy && !locked && (isResume || validGoal);
  return { list, sel, info, phase, isResume, busy, goal, trimmed, len, badDash, ctl, validGoal, locked, canSubmit, armed: !!state.confirmArmed && canSubmit, loaded: !!state.loaded };
}
export const NEWRUN_HINT = 'toca outra vez para arrancar';
export const NEWRUN_SENT = 'a arrancar · pedido enviado';
// Runner vivo: não há ação nenhuma a oferecer — diz-se porquê, em palavras.
const NEWRUN_NOTHING = {
  starting: 'nada a fazer: o run aparece nesta página assim que o Lead escrever o primeiro evento.',
  live: 'nada a fazer: já há um run a correr neste projeto.',
};
// Um erro do servidor a seco ("espera 24 s") não diz o que falhou: leva sempre o prefixo.
export const newRunErrText = m => {
  const t = String(m || '').trim();
  return !t ? 'não foi possível arrancar — tenta outra vez' : /^não foi possível arrancar/.test(t) ? t : `não foi possível arrancar — ${t}`;
};
export const newRunButtonLabel = v => v.phase === 'submitting' ? 'a arrancar…' : v.armed ? 'Confirmar' : v.isResume ? 'Relançar o runner' : 'Arrancar';
export const newRunCountText = v =>
  `${v.len}/${NEWRUN_GOAL_MAX}` + (v.badDash ? ' · não pode começar por «-»' : v.ctl ? ' · tudo numa linha, sem quebras' : v.len < NEWRUN_GOAL_MIN ? ` · mínimo ${NEWRUN_GOAL_MIN}` : v.len > NEWRUN_GOAL_MAX ? ' · demasiado longo' : '');

// Máquina de estados do bilhete: idle → submitting → started, e só um /projects
// posterior que confirme o runner (ou um run novo) a traz de volta a idle.
export function newRunReducer(state, event) {
  const s = { ...newRunInit(), ...state };
  const type = event && event.type;
  if (type === 'select') return { ...s, project: event.project || null, confirmArmed: false, error: '' };
  if (type === 'goal') return { ...s, goal: typeof event.goal === 'string' ? event.goal : '', confirmArmed: false, error: '' };
  if (type === 'tap') {
    const v = newRunView(event.projects, s);
    if (!v.canSubmit) return s;
    if (!s.confirmArmed) return { ...s, confirmArmed: true, error: '' }; // o segundo toque é que arranca
    return { ...s, confirmArmed: false, phase: 'submitting', error: '' };
  }
  if (type === 'sent') return { ...s, phase: 'started', project: event.project || s.project, startedProject: event.project || s.project, startedRunId: event.runId || null, startedGoal: event.resume ? '' : (s.goal || '').trim(), startedResume: !!event.resume, goal: '', confirmArmed: false, error: '', startedAt: typeof event.now === 'number' ? event.now : Date.now() };
  if (type === 'failed') return { ...s, phase: 'idle', confirmArmed: false, error: newRunErrText(event.error) };
  // O relógio (chamado de 1 em 1 s no browser): se o bilhete está "started" e
  // já passou o prazo sem prova, volta a idle com o objetivo mantido no campo.
  if (type === 'tick') {
    if (s.phase !== 'started' || s.startedAt == null) return state;
    const t = typeof event.now === 'number' ? event.now : Date.now();
    if (t - s.startedAt < NEWRUN_EXPIRE_MS) return state;
    return { ...s, phase: 'idle', error: NEWRUN_EXPIRED_TEXT, goal: s.startedGoal || '', confirmArmed: false,
      startedProject: null, startedRunId: null, startedGoal: '', startedResume: false, startedAt: null };
  }
  if (type === 'projects') {
    const next = { ...s, loaded: true };
    if (s.phase !== 'started') return next;
    const p = (Array.isArray(event.projects) ? event.projects : []).find(x => x && x.name === s.startedProject);
    if (!p) return next;
    // Confirmação = o runner deu sinal de vida (lock) ou já existe um run novo.
    const newRun = !!(p.run && p.run.run_id && p.run.run_id !== s.startedRunId);
    if (!p.runnerAlive && !newRun) return next;
    return { ...next, phase: 'idle', startedProject: null, startedRunId: null, startedGoal: '', startedResume: false, startedAt: null };
  }
  return s;
}

export function renderNewRun(projects, state = {}) {
  const v = newRunView(projects, state);
  const { sel, info, list } = v;
  if (!v.loaded && !list.length) return `<article class="ticket newrun"><div class="k"><span>novo run</span></div><div class="q">Arrancar ou relançar um run</div><div class="only">a carregar os projetos preparados…</div></article>`;
  // Enquanto o selo está no ecrã, o estado do projeto seria o de ANTES do
  // arranque ("sem run") e contradiria o selo: diz-se o que já se sabe.
  const started = p => v.locked && p === (state.startedProject || (sel && sel.name));
  const options = list.length
    ? list.map(p => {
        const label = started(p.name) ? NEWRUN_SENT : projectRunState(p).label;
        return `<option value="${esc(p.name)}"${sel && sel.name === p.name ? ' selected' : ''}>${esc(p.name)} · ${esc(label)}</option>`;
      }).join('')
    : `<option value="">nenhum projeto preparado</option>`;
  // A palavra de estado vai no seletor E por baixo dele (DESIGN §Novo run): a
  // caixa do seletor corta o texto, e a palavra não pode depender da largura.
  const note = !info ? `<div class="only">nenhum projeto foi preparado com <span class="mono">forja bootstrap</span> — só o Sponsor o pode fazer, no terminal.</div>`
    : `<div class="d state"><b>${esc(started(sel.name) ? NEWRUN_SENT : info.label)}</b>${NEWRUN_NOTHING[info.kind] && !v.locked ? ` — ${NEWRUN_NOTHING[info.kind]}` : ''}</div>`;
  // Projeto ocupado (runner vivo): nada a fazer é um estado legítimo, não um
  // botão desativado a meio (DESIGN §Novo run) — fica só o seletor e a linha do estado.
  const field = v.phase === 'started'
    ? `<div class="d"><b>${state.startedResume ? 'Relançado:' : 'Objetivo enviado:'}</b> ${esc(state.startedResume ? 'o run em curso, do ponto onde ficou' : state.startedGoal || '')}</div>`
    : v.busy ? ''
    : v.isResume
      ? `<div class="d clamp"><b>Objetivo do run em curso:</b> ${esc((sel.run && sel.run.goal) || 'sem objetivo registado')}</div>`
      : sel
        ? `<label for="newrun-goal">Objetivo</label><textarea id="newrun-goal" placeholder="o que queres que fique feito, em uma a três frases"${v.locked ? ' disabled' : ''}>${esc(v.goal)}</textarea><div class="count mono${v.validGoal ? '' : ' bad'}" id="newrun-count">${esc(newRunCountText(v))}</div>`
        : '';
  const action = v.phase === 'started'
    ? `<div class="seal">run a arrancar — a notificação chega em menos de um minuto</div>
       <div class="only">o bilhete volta ao normal quando o runner der sinal de vida.</div>
       <div class="row"><button class="btn" type="button" data-action="newrun-recheck">Verificar de novo</button></div>`
    : v.busy ? ''
    : `<div class="row"><button class="btn" type="button" id="newrun-submit" data-action="newrun-submit"${v.canSubmit ? '' : ' disabled'}>${esc(newRunButtonLabel(v))}</button><span class="only" id="newrun-hint">${v.armed ? NEWRUN_HINT : ''}</span></div>`;
  return `<article class="ticket newrun${v.locked ? ' pending' : ''}">
    <div class="k"><span>novo run</span></div>
    <div class="q">Arrancar ou relançar um run</div>
    <div><label for="newrun-project">Projeto</label><select id="newrun-project" data-action="newrun-project"${!list.length || v.locked ? ' disabled' : ''}>${options}</select></div>
    ${note}
    ${field}
    <div class="err" id="newrun-err">${esc(state.error || '')}</div>
    ${action}
  </article>`;
}

// Chamadas de rede sem DOM (testáveis com um `fetch` simulado); só `boot()` liga isto ao browser real.
export async function fetchProjects(fetchImpl) {
  try {
    const r = await fetchImpl('/projects', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) throw new Error(String(r.status));
    const body = await r.json();
    return Array.isArray(body.projects) ? body.projects : [];
  } catch { return null; }
}
// goal === null → relançar o run em curso; senão arrancar com o objetivo aparado.
export async function postRun(project, goal, fetchImpl) {
  const name = project && project.name;
  const body = goal === null ? { project: name, resume: true } : { project: name, goal: String(goal).trim() };
  try {
    const r = await fetchImpl('/runs', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {}; try { data = await r.json(); } catch {}
    if (!r.ok) return { ok: false, error: newRunErrText((data && data.error) || `HTTP ${r.status}`) };
    return { ok: true, action: data.action || (goal === null ? 'resume' : 'start'), project: data.project || name, pid: data.pid };
  } catch { return { ok: false, error: newRunErrText('sem ligação ao viewer') }; }
}

export function renderDecisions(run, limit = 0) {
  let ds = run.decisions || [];
  if (limit) ds = ds.slice(-limit).reverse();
  if (!ds.length) return `<div class="none">sem decisões</div>`;
  return ds.map(d => `<div class="dec"><b>${esc(d.id || '—')}</b><span>${esc(d.text)}<small>${d.reversible === true ? 'reversível' : d.reversible === false ? 'irreversível' : ''}${d.why ? ` · ${esc(d.why)}` : ''} · ${clock(d.ts)}</small></span></div>`).join('');
}

// Livro-razão dos veredictos: APPROVE/REJECT do Reviewer e SECURITY-APPROVE/SECURITY-REJECT do Security Reviewer.
export function renderReviews(run) {
  const rs = (run.reviews || []).slice().reverse();
  if (!rs.length) return `<div class="none">sem veredictos</div>`;
  return rs.map(r => {
    const v = String(r.verdict || '');
    const by = /^SECURITY-/.test(v) ? memberName(run, 'security-reviewer') : memberName(run, r.by);
    return `<div class="rev"><span class="t">${clock(r.ts)}</span><span class="v ${esc(v)} g-${gradeOf(v) || 'plain'}">${esc(v)}</span><span class="x">${r.taskId ? `<b>${esc(r.taskId)}</b> · ` : ''}${esc(String(r.text || '').replace(/^(?:SECURITY-)?(?:APPROVE|REJECT)\s*—\s*/, ''))}<small>por ${esc(by)}${r.final ? ' · final' : ''}</small></span></div>`;
  }).join('');
}

export function renderTasks(run) {
  const ts = run.tasks || [];
  if (!ts.length) return `<div class="none">sem tasks</div>`;
  return ts.map(t => {
    const last = t.verdicts && t.verdicts.length ? t.verdicts[t.verdicts.length - 1] : null;
    const reason = t.why || (last && last.text) || '';
    return `<div class="task-r t-${TASK_TONE[t.status] || 'idle'}"><b>${esc(t.id)}</b><span>${esc(t.title || '—')}<small>${esc(memberName(run, t.owner))} · tentativas ${t.attempts || 0}${last ? ` · último veredicto ${esc(last.verdict)}` : ''}${reason ? ` · ${esc(reason)}` : ''}</small></span><span class="s">${esc(TASK_LABEL[t.status] || t.status)}</span></div>`;
  }).join('');
}

// ---------- telemóvel: dez linhas compactas (núcleo primeiro, a pedido com o rótulo) ----------
export function renderRows(run, snap, now, expanded = new Set()) {
  return run.roster.map(c => {
    const tone = toneOf(c.state);
    const live = liveness(c, run, snap);
    const open = expanded.has(c.key);
    const ag = live.kind === 'quiet' ? `<span class="ag quiet">silêncio há ${durSpan(now, live.at)}</span>` : (live.kind === 'lost' || live.kind === 'dead') ? `<span class="ag ${live.kind}">sinal há ${durSpan(now, live.at)}</span>` : c.since ? `<span class="ag">${agoSpan(now, c.since)}</span>` : '';
    const cls = ['row-btn', `m-${c.key}`, `t-${tone}`, LOUD.has(c.state) ? 'loud' : '', tone === 'dead' ? 'dead' : '', tone === 'idle' ? 'idle' : '', c.core === false ? 'demand' : ''].filter(Boolean).join(' ');
    const stat = statLine(c);
    return `<button type="button" class="${cls}" data-action="toggle" data-key="${esc(c.key)}" aria-expanded="${open}" aria-controls="exp-${esc(c.key)}">
      <span class="mo" aria-hidden="true">${esc(monogram(c))}</span>
      <span class="who"><b>${esc(c.name)}</b><span class="rl">${roleLine(c)}</span>${stat ? `<span class="stat">${esc(stat)}</span>` : ''}</span>
      <span class="st"><span class="sw">${esc(c.state)}</span>${ag}</span>
    </button>
    <div id="exp-${esc(c.key)}" ${open ? '' : 'hidden'}>${renderCard(c, run, snap, now)}</div>`;
  }).join('');
}

// ---------- seletor de run: runs verdadeiros e sessões soltas (T-UI-9) ----------
// Um run verdadeiro anunciou-se (`forja run start`/`run resume`, `kind: 'run'` no
// instantâneo); uma sessão solta é uma sessão do Claude Code no mesmo projeto que
// nunca o fez. Ler uma sessão solta morta como se fosse um run foi o que fez o
// Sponsor concluir, com três runs vivos a emitir eventos, que estavam todos
// parados (17 set 2026). Por isso: o seletor mostra por omissão só runs,
// agrupados por projeto e do evento mais recente para o mais antigo, e as
// sessões soltas ficam dobradas numa secção com um rótulo que não finge.
export const isLooseSession = r => !!r && r.kind === 'session';
// No telemóvel a caixa do seletor corta o texto, e o que não pode faltar é a
// palavra de estado: aí o id do run vai abreviado (`R-…1c81`), nunca o estado.
const shortRunId = (r, compact) => {
  const id = String((r && (r.runId || r.id)) || '');
  if (compact && id.length > 8) return `${id.slice(0, 2)}…${id.slice(-4)}`;
  return id.length > 18 ? `${id.slice(0, 12)}…` : id;
};
export const runLabel = (r, compact = false) => `${r.project || '?'} · ${shortRunId(r, compact)} · ${r.status || '?'}`;
export const looseLabel = r => `${r.project || '?'} · ${r.interactive ? 'sessão interativa' : 'sessão sem run'} · ${r.status || '?'}`;
const sortedRuns = snap => (snap && Array.isArray(snap.runs) ? snap.runs.slice() : []).sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));

export function runSelectorModel(snap, selected = null, { compact = false } = {}) {
  const all = sortedRuns(snap);
  const groups = []; const byProject = new Map(); const loose = [];
  for (const r of all) {
    if (isLooseSession(r)) { loose.push({ id: r.id, project: r.project || '?', label: looseLabel(r) }); continue; }
    const key = r.project || '?';
    let g = byProject.get(key);
    if (!g) { g = { project: key, options: [] }; byProject.set(key, g); groups.push(g); }
    g.options.push({ id: r.id, label: runLabel(r, compact) });
  }
  // O seletor nunca mente sobre o que está a mostrar: escolhida uma sessão
  // solta, ela aparece no próprio seletor, dita pelo nome.
  const chosen = all.find(r => r.id === selected);
  if (chosen && isLooseSession(chosen)) groups.unshift({ project: 'sessão solta', options: [{ id: chosen.id, label: looseLabel(chosen) }] });
  return { groups, loose, selected, show: all.length > 1 };
}

// A escolha por omissão é a do instantâneo (`snap.current`: o run ativo mais
// recente, nunca uma sessão solta — regra do redutor). Aqui só se decide o que
// fazer com uma escolha DO SPONSOR: mantém-se enquanto existir no instantâneo,
// mesmo depois de o run terminar (a página nunca salta sozinha debaixo dos
// olhos); `null` devolve o comando ao `current`.
export function pickRunId(snap, pinned) {
  const all = snap && Array.isArray(snap.runs) ? snap.runs : [];
  return pinned && all.some(r => r.id === pinned) ? pinned : null;
}

// ---------- pausa das atualizações (adenda T-UI-9) ----------
// Rede de segurança pedida pelo Sponsor: em pausa — à mão pelo botão, ou sozinha
// porque um campo, um seletor ou uma caixa de texto tem o foco — um instantâneo
// novo não re-escreve nada; fica guardado e entra ao retomar.
export const isFormField = el => !!el && ['select', 'textarea', 'input'].includes(String(el.tagName || '').toLowerCase());
export const framePaused = ui => !!(ui && (ui.paused || ui.focusPaused));
export function gateSnapshot(ui, snap) {
  if (framePaused(ui)) { ui.pending = snap; return false; }
  ui.pending = null;
  return true;
}
export function resumeSnapshot(ui) {
  if (framePaused(ui)) return null;
  const snap = (ui && ui.pending) || null;
  if (ui) ui.pending = null;
  return snap;
}
export const pauseLabel = paused => (paused ? 'retomar atualizações' : 'pausar atualizações');
export const pauseNote = (since, auto = false) => `atualizações em pausa desde ${hm(since)} — ${auto ? 'enquanto escreves ou escolhes' : 'o ecrã só muda quando retomares'}`;
export const pauseShort = (since, auto = false) => (auto ? `em pausa enquanto escolhes · ${hm(since)}` : `em pausa desde ${hm(since)}`);

// O seletor é um nó estável: as `<option>` são reconciliadas in-place (chave = id
// do run, como os bilhetes da T-UI-6) e o `<select>` nunca é substituído —
// substituí-lo fechava o menu aberto no telemóvel a cada instantâneo de 5 s.
// Enquanto o `<select>` tem o foco nem as opções se tocam: a atualização fica
// pendente e entra no `blur`/`change` (`ui.force`).
const setText = (n, t) => { if (n && n.textContent !== t) n.textContent = t; };
function mk(doc, tag, cls, attrs = {}) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function buildSelector(host, doc) {
  const label = mk(doc, 'label', 'runsel', { for: 'run-select' });
  label.appendChild(mk(doc, 'span', 'rl')).textContent = 'run';
  label.appendChild(mk(doc, 'select', 'sel', { id: 'run-select', 'data-action': 'run', 'aria-label': 'Escolher run' }));
  host.appendChild(label);
  host.appendChild(mk(doc, 'button', 'loose-toggle', { type: 'button', 'data-action': 'loose', 'aria-controls': 'loose-list', 'aria-expanded': 'false' }));
  const pause = host.appendChild(mk(doc, 'button', 'pause-btn', { type: 'button', 'data-action': 'pause', 'aria-pressed': 'false' }));
  pause.appendChild(mk(doc, 'span', 'pb-label'));
  // A mesma informação da nota, dentro do botão: no telemóvel é o que evita uma
  // terceira linha na barra (a nota à parte fica só no desktop, por CSS).
  pause.appendChild(mk(doc, 'small', 'pb-note'));
  host.appendChild(mk(doc, 'span', 'pause-note'));
  host.appendChild(mk(doc, 'div', 'loose-list', { id: 'loose-list' })).hidden = true;
}
function syncOptions(sel, doc, groups) {
  let gi = 0;
  for (const g of groups) {
    let grp = sel.children[gi];
    if (!grp || String(grp.tagName).toLowerCase() !== 'optgroup') { grp = mk(doc, 'optgroup'); sel.insertBefore(grp, sel.children[gi] || null); }
    if (grp.getAttribute('label') !== g.project) grp.setAttribute('label', g.project);
    let oi = 0;
    for (const o of g.options) {
      let opt = grp.children[oi];
      if (!opt || opt.getAttribute('value') !== o.id) {
        opt = Array.from(sel.querySelectorAll('option')).find(x => x.getAttribute('value') === o.id) || mk(doc, 'option', null, { value: o.id });
        grp.insertBefore(opt, grp.children[oi] || null);
      }
      setText(opt, o.label);
      oi += 1;
    }
    while (grp.children.length > oi) grp.children[grp.children.length - 1].remove();
    gi += 1;
  }
  while (sel.children.length > gi) sel.children[sel.children.length - 1].remove();
}
function syncLoose(list, doc, items, selected) {
  let i = 0;
  for (const s of items) {
    let b = list.children[i];
    if (!b || b.getAttribute('data-run') !== s.id) {
      b = Array.from(list.children).find(x => x.getAttribute('data-run') === s.id) || mk(doc, 'button', 'loose-item', { type: 'button', 'data-action': 'pick-run', 'data-run': s.id });
      list.insertBefore(b, list.children[i] || null);
    }
    setText(b, s.label);
    b.setAttribute('aria-current', String(s.id === selected));
    b.classList.toggle('on', s.id === selected);
    i += 1;
  }
  while (list.children.length > i) list.children[list.children.length - 1].remove();
}
export function patchRunSelector(host, doc, model, ui = {}) {
  if (!host) return { applied: false, pending: false };
  if (!host.querySelector('select[data-action="run"]')) buildSelector(host, doc);
  const sel = host.querySelector('select[data-action="run"]');
  const label = host.querySelector('.runsel');
  const toggle = host.querySelector('button[data-action="loose"]');
  const pause = host.querySelector('button[data-action="pause"]');
  const note = host.querySelector('.pause-note');
  const list = host.querySelector('.loose-list');
  // O botão de pausa e a sua nota nunca dependem do foco do seletor: são a saída
  // de emergência do Sponsor e estão sempre certos.
  const paused = !!ui.paused;
  setText(host.querySelector('.pb-label'), pauseLabel(paused));
  setText(host.querySelector('.pb-note'), ui.frozenAt ? pauseShort(ui.frozenAt, !paused) : '');
  pause.setAttribute('aria-pressed', String(paused));
  // A nota vale para as duas pausas: a do botão e a automática (foco num campo).
  setText(note, ui.frozenAt ? pauseNote(ui.frozenAt, !paused) : '');
  label.hidden = !model.show;
  if (doc.activeElement === sel && !ui.force) return { applied: false, pending: true }; // com o menu aberto não se toca em nada
  syncOptions(sel, doc, model.groups);
  if (model.selected != null && sel.value !== model.selected) sel.value = model.selected;
  const n = model.loose.length;
  const open = !!ui.looseOpen && n > 0;
  toggle.hidden = n === 0;
  setText(toggle, `sessões soltas (${n})`);
  toggle.setAttribute('aria-expanded', String(open));
  list.hidden = !open;
  syncLoose(list, doc, model.loose, model.selected);
  return { applied: true, pending: false };
}
export function renderHeader(run, snap, now, mode) {
  const c = run.counts || {};
  const goal = `<h1 title="${esc(run.goal || '')}">${run.goalSource === 'prompt' ? '<span class="src">último prompt · </span>' : ''}${esc(run.goal || 'sem objetivo registado')}</h1>`;
  // O seletor de run não vem nesta string: é um nó estável na barra `#runsel`,
  // logo por baixo do cabeçalho (`patchRunSelector`). Uma sessão solta diz o que
  // é, aqui, em palavras — nunca mais pode ler-se como um run parado (T-UI-9).
  const loose = isLooseSession(run) ? `<div class="loose-note">sessão solta — não é um run<small>${esc(run.interactive ? 'sessão do Claude Code neste projeto onde alguém escreveu; nunca anunciou um run' : 'sessão do Claude Code neste projeto que nunca anunciou um run')}</small></div>` : '';
  // Junto do piso, nunca item à parte (DESIGN §13: cabeçalho de 1 linha + 1
  // subtítulo) — sem dois pontos, coerente com "piso fable" / "permissões
  // auto", e o par nunca quebra a meio (.meta .nowrap).
  const level = `<span class="nowrap">forjalvl <b>${esc(levelLabel(forjalvlOf(run)))}</b></span>`;
  if (mode === 'mobile') {
    return `<div class="brand">Forja<small>${esc(run.project)}</small></div><div class="goal">${goal}${loose}<div class="meta">${run.startedAt ? `começou ${agoSpan(now, run.startedAt)}` : 'sem eventos'} · ${c.events || 0} eventos${isLooseSession(run) ? '' : ` · ${level}`}</div></div>`;
  }
  // Numa sessão solta não há piso de modelo, forjalvl, checkpoints nem fila do
  // Sponsor: são campos de um run, e um run é o que isto não é (T-UI-9).
  const meta = [
    run.startedAt ? `começou ${agoSpan(now, run.startedAt)}` : 'sem eventos',
    `${c.events || 0} eventos · ${c.errors || 0} erros · ${c.refused || 0} sem resposta ou recusadas`,
    ...(isLooseSession(run) ? [] : [`piso <b>${esc(run.modelFloor || '—')}</b> · ${level}`]),
    `permissões <b>${esc(run.permissionMode || '—')}</b>`,
    ...(isLooseSession(run) ? [] : [`checkpoints <b>${(run.forja && run.forja.checkpoints) || 0}</b>`, `perguntas abertas <b>${run.openQuestions || 0}</b>`]),
  ];
  return `<div class="brand">Forja<small>${esc(run.project)}</small></div><div class="goal">${goal}${loose}<div class="meta">${meta.map(m => `<span>${m}</span>`).join('')}</div></div>`;
}
// Texto por baixo do selo do run; em pausa diz o mesmo que o cartão do Lead (hora local do browser).
export const runDetail = run => run.status === 'em pausa' ? (pauseText(run) || run.statusDetail || '') : (run.statusDetail || '');

// ---------- arranque (só aqui há DOM) ----------
export function boot(mode = 'desktop') {
  // `sent`/`sending`/`errors` são indexados por `answerKey(projeto, id)`, nunca
  // só pelo id: dois runs vivos têm ambos uma `Q1` aberta.
  const S = { snap: null, runId: null, offset: 0, lastStateAt: 0, lastSignal: Date.now(), gotState: false, sseError: false, mode: 'connecting', pollOk: false, bannerHtml: '',
    expanded: new Set(), demandOpen: false, html: new Map(), sent: new Map(), sending: new Set(), errors: new Map(),
    queueNodes: new Map(), queueForm: new Map(), queueEmptyShown: false, queueRun: null,
    projects: [], newrun: newRunInit(), newrunPending: false, newrunExpiryChecking: false,
    // T-UI-9: a dobra das sessões soltas, a pausa das atualizações (à mão e por
    // foco num campo) e o instantâneo que ficou à espera da retoma.
    looseOpen: false, paused: false, pausedAt: null, focusPaused: false, focusPausedAt: null, pending: null };
  const $ = id => document.getElementById(id);
  const now = () => Date.now() + S.offset;

  function currentRun() {
    if (!S.snap || !S.snap.runs.length) return emptyRun();
    // Sem escolha do Sponsor manda o instantâneo (`current`: o run ativo mais
    // recente, nunca uma sessão solta). Com escolha dele, manda a escolha — mesmo
    // depois de o run terminar (T-UI-9).
    return S.snap.runs.find(r => r.id === S.runId) || S.snap.runs.find(r => r.id === S.snap.current) || S.snap.runs[0];
  }
  function setSection(id, html) {
    const el = $(id); if (!el) return false;
    if (S.html.get(id) === html) return false;
    S.html.set(id, html); el.innerHTML = html; return true;
  }

  // O seletor de run é o único pedaço de página que NUNCA se re-escreve por
  // string (adenda T-UI-9): substituir o nó fechava o menu aberto no telemóvel a
  // cada instantâneo. Aqui só se reconciliam as opções, e nem isso enquanto o
  // <select> tem o foco — nesse caso fica pendente e entra no blur/change.
  function paintSelector(force = false) {
    const host = $('runsel'); if (!host) return;
    patchRunSelector(host, document, runSelectorModel(S.snap || { runs: [] }, currentRun().id, { compact: mode === 'mobile' }),
      { looseOpen: S.looseOpen, paused: S.paused, pausedAt: S.pausedAt, force,
        frozenAt: S.paused ? S.pausedAt : (S.focusPaused ? S.focusPausedAt : null) });
  }
  // Pausa à mão (o botão do cabeçalho): ao retomar entra o último instantâneo guardado.
  function setPaused(on) {
    S.paused = on; S.pausedAt = on ? Date.now() : null;
    const next = on ? null : resumeSnapshot(S);
    if (next) applySnapshot(next); else render();
  }
  // Pausa automática enquanto um campo, um seletor ou uma caixa de texto tem o foco.
  function releaseFocusPause() {
    if (isFormField(document.activeElement)) return; // o foco só saltou para outro campo
    S.focusPaused = false; S.focusPausedAt = null;
    const next = resumeSnapshot(S);
    if (next) applySnapshot(next); else paintSelector();
  }

  // "Novo run". A secção NÃO depende do instantâneo: só se re-escreve quando
  // muda o projeto, a fase do bilhete ou a lista de projetos. Escrever nunca
  // re-escreve o HTML (recriar a textarea parte a composição de acentos no
  // Android): aí só se atualizam o contador, o botão e a linha de erro.
  function renderNewRunSection() {
    const a = document.activeElement;
    // Com o campo de objetivo em foco (a pessoa está a escrever) nunca se
    // re-escreve o HTML: adia-se para o blur e entretanto só se corrigem os
    // controlos, que é o que pode ter mudado de estado (ex.: o projeto ficou ocupado).
    if (a && a.id === 'newrun-goal' && S.newrun.phase === 'idle') { S.newrunPending = true; patchNewRun(); return; }
    S.newrunPending = false;
    const id = a && a.id, selStart = a && 'selectionStart' in a ? a.selectionStart : null;
    if (setSection('newrun', renderNewRun(S.projects, S.newrun)) && (id === 'newrun-goal' || id === 'newrun-project')) {
      const el = $(id);
      if (el) { el.focus(); if (selStart != null && el.setSelectionRange) el.setSelectionRange(selStart, selStart); }
    }
  }
  function patchNewRun() {
    const v = newRunView(S.projects, S.newrun);
    const c = $('newrun-count'); if (c) { c.textContent = newRunCountText(v); c.classList.toggle('bad', !v.validGoal); }
    const b = $('newrun-submit'); if (b) { b.disabled = !v.canSubmit; b.textContent = newRunButtonLabel(v); }
    const h = $('newrun-hint'); if (h) h.textContent = v.armed ? NEWRUN_HINT : '';
    const e = $('newrun-err'); if (e) e.textContent = S.newrun.error || '';
    S.html.delete('newrun'); // o DOM já não é a última string: força o próximo render completo
  }
  async function loadProjects() {
    const list = await fetchProjects(fetch);
    if (list) S.projects = list;
    S.newrun = newRunReducer(S.newrun, { type: 'projects', projects: list || S.projects });
    renderNewRunSection();
  }
  // Depois de um arranque o runner leva alguns segundos a escrever o lock: dois
  // pedidos pontuais, nunca um poll (o selo fica até um deles confirmar).
  const NEWRUN_RECHECKS_MS = [3000, 15000];

  function render() {
    const snap = S.snap || { runs: [], generatedAt: Date.now(), lines: 0, current: null };
    const run = currentRun();
    const t = now();
    // selo e contador: elementos fixos (aria-live), só o texto muda
    const badge = $('run-badge');
    if (badge) { badge.className = `badge t-${toneOf(run.status)}${LOUD.has(run.status) ? ' loud' : ''}${toneOf(run.status) === 'dead' ? ' dead' : ''}`; badge.textContent = `${isLooseSession(run) ? 'sessão' : 'run'} ${run.status}`; }
    const n = sponsorCount(run);
    const sn = $('sponsor-n'); if (sn) sn.textContent = n ? `${n} para o Sponsor` : '';
    const det = $('run-detail'); if (det) { const d = runDetail(run); det.textContent = d; det.title = d; }
    setSection('head-main', renderHeader(run, snap, t, mode));
    paintSelector();
    if (mode === 'mobile') {
      setSection('scene', renderSceneMobile(run, snap));
      setSection('demand-bar', renderDemandBar(run, snap, S.demandOpen));
      setSection('scene-legend', renderLegend(sceneCold(run)));
      setSection('rows', renderRows(run, snap, t, S.expanded));
      applyQueuePatch($('queue'), document, run, t, S);
      setSection('queue-n', `${n} pendente${n === 1 ? '' : 's'}`);
      setSection('tasks', renderTasks(run));
      setSection('decisions', renderDecisions(run, 5));
      setSection('native', renderNative(run, t));
    } else {
      setSection('scene', renderScene(run, snap));
      setSection('scene-legend', renderLegend(sceneCold(run)));
      setSection('hud', renderHud(run, snap, t));
      setSection('native', renderNative(run, t));
      applyQueuePatch($('queue'), document, run, t, S);
      setSection('queue-n', `${n} pendente${n === 1 ? '' : 's'}`);
      setSection('decisions', renderDecisions(run));
      setSection('reviews', renderReviews(run));
      setSection('tasks', renderTasks(run));
      setSection('reviews-n', String((run.reviews || []).length));
      setSection('tasks-n', String((run.tasks || []).length));
    }
    tick();
  }

  // O selo só expira depois de uma prova FRESCA (um /projects pedido agora),
  // nunca por inferência sobre a última lista conhecida (que pode ter dezenas
  // de segundos, já que os recheques pontuais param aos 15 s e o poll seguinte
  // só vem aos 60 s): ao bater o prazo, primeiro confirma-se com o servidor e
  // só depois se decide — `loadProjects` já despacha `projects`, que resolve o
  // bilhete sozinho se entretanto houver prova; só resta o `tick` para o caso
  // sem prova nenhuma.
  function checkNewRunExpiry() {
    if (S.newrun.phase !== 'started' || S.newrunExpiryChecking) return;
    const startedAt = S.newrun.startedAt;
    if (startedAt == null || Date.now() - startedAt < NEWRUN_EXPIRE_MS) return;
    S.newrunExpiryChecking = true;
    loadProjects().finally(() => {
      S.newrunExpiryChecking = false;
      if (S.newrun.phase !== 'started') return; // a prova fresca já resolveu o bilhete
      const next = newRunReducer(S.newrun, { type: 'tick', now: Date.now() });
      if (next !== S.newrun) { S.newrun = next; renderNewRunSection(); }
    });
  }
  function tick() {
    const t = now();
    checkNewRunExpiry();
    for (const el of document.querySelectorAll('[data-ago]')) el.textContent = ago(t, Number(el.dataset.ago));
    for (const el of document.querySelectorAll('[data-dur]')) el.textContent = dur(t - Number(el.dataset.dur), true);
    const conn = $('conn');
    if (conn) {
      const since = S.lastStateAt ? dur(Date.now() - S.lastStateAt, true) : null;
      if (S.mode === 'sse' && since) { conn.className = 'conn ok'; conn.textContent = `ligado · atualizado há ${since}`; }
      else if (S.mode === 'poll' && S.pollOk && since) { conn.className = 'conn poll'; conn.textContent = `ligado por consulta (5 em 5 s) · atualizado há ${since}`; }
      else { conn.className = 'conn'; conn.textContent = `a tentar ligar… (a consultar de 5 em 5 s)${since ? ` · último instantâneo há ${since}` : ''}`; }
    }
    // Faixa de ligação perdida + "dados de HH:MM" no cabeçalho: fora do fluxo de
    // `render()` de propósito — têm de aparecer e sumir ao segundo mesmo sem
    // nenhum instantâneo novo (é exatamente isso que "offline" quer dizer).
    const offline = isOffline(S, Date.now());
    const banner = $('conn-banner');
    if (banner) { const html = offline ? renderConnBanner(lastContactOf(S)) : ''; if (S.bannerHtml !== html) { S.bannerHtml = html; banner.innerHTML = html; } }
    const asof = $('asof'); if (asof) asof.textContent = asOfText(offline, S.snap);
  }

  function accept(snap) {
    if (!snap || !Array.isArray(snap.runs)) return;
    // Em pausa nada se re-escreve: o instantâneo fica guardado para a retoma
    // (só o botão de pausa e a sua nota se mantêm certos).
    if (!gateSnapshot(S, snap)) { paintSelector(); return; }
    applySnapshot(snap);
  }
  function applySnapshot(snap) {
    S.snap = snap; S.offset = snap.generatedAt - Date.now(); S.lastStateAt = Date.now(); S.gotState = true;
    // Só o que o Sponsor escolheu fica preso: o que ele escolheu mantém-se mesmo
    // depois de o run terminar, e só se larga se desaparecer do instantâneo. Sem
    // escolha dele nada se fixa — manda o `current` do instantâneo.
    S.runId = pickRunId(snap, S.runId);
    // Uma pergunta que o instantâneo já diz pending/answered deixa de precisar
    // do registo local — varrida por run, nunca por id solto (um `flatMap` por
    // todos os runs apagava o registo da `Q1` deste projeto por causa da `Q1`
    // do outro).
    for (const r of snap.runs) for (const q of r.queue || []) {
      if (q.status === 'open') continue;
      const k = answerKey(r.project, q.id);
      S.sent.delete(k); S.errors.delete(k);
    }
    render();
  }

  // ---------- ligação: SSE com consulta de recurso ----------
  let es = null;
  function connect() {
    try { es = new EventSource('/events'); } catch { S.sseError = true; return; }
    es.addEventListener('open', () => { S.sseError = false; S.lastSignal = Date.now(); });
    es.addEventListener('ping', () => { S.lastSignal = Date.now(); if (S.gotState) S.mode = 'sse'; });
    es.addEventListener('state', e => {
      S.lastSignal = Date.now(); S.sseError = false; S.mode = 'sse';
      try { accept(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('error', () => { markSseError(S); tick(); });
  }
  async function poll() {
    try { const r = await fetch('/state', { cache: 'no-store', credentials: 'same-origin' }); if (!r.ok) throw new Error(String(r.status)); S.pollOk = true; accept(await r.json()); }
    catch { S.pollOk = false; tick(); }
  }
  connect();
  renderNewRunSection(); // placeholder "a carregar" até o primeiro /projects
  loadProjects();
  setInterval(() => {
    const silent = Date.now() - S.lastSignal > (S.gotState ? 40000 : 8000);
    if (S.sseError || silent) { S.mode = 'poll'; poll(); }
  }, 5000);
  // Os estados derivados do tempo (silêncio, sem resposta, morto) só mudam no
  // servidor; sem eventos novos não há push, por isso um pedido por minuto.
  setInterval(() => { if (S.mode === 'sse') poll(); }, 60000);
  setInterval(tick, 1000);

  // ---------- interação (sem handlers inline) ----------
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    if (b.dataset.action === 'toggle') {
      const k = b.dataset.key; const open = !S.expanded.has(k);
      if (open) S.expanded.add(k); else S.expanded.delete(k);
      b.setAttribute('aria-expanded', String(open));
      const panel = $(`exp-${k}`); if (panel) panel.hidden = !open;
      // a próxima render gera a string com o estado de expansão novo, por isso re-escreve a secção
    } else if (b.dataset.action === 'demand') {
      // A barra «a pedido» abre e fecha os cinco nós; a secção é re-escrita a
      // partir do estado (nada de DOM à mão) e o foco volta ao próprio botão.
      S.demandOpen = !S.demandOpen;
      render();
      const t = $('demand-toggle'); if (t) t.focus();
    } else if (b.dataset.action === 'loose') {
      // A dobra «sessões soltas (N)»: o foco fica no próprio botão, que não é recriado.
      S.looseOpen = !S.looseOpen; paintSelector();
    } else if (b.dataset.action === 'pick-run') { S.runId = b.dataset.run; render(); }
    else if (b.dataset.action === 'pause') setPaused(!S.paused);
    else if (b.dataset.action === 'newrun-recheck') loadProjects();
    else if (b.dataset.action === 'conn-retry') location.reload();
    else if (b.dataset.action === 'newrun-submit') {
      const before = S.newrun;
      const v = newRunView(S.projects, before);
      const next = newRunReducer(before, { type: 'tap', projects: S.projects });
      S.newrun = next;
      if (next.phase !== 'submitting') { if (next !== before) patchNewRun(); return; } // 1.º toque: só o rótulo do botão
      renderNewRunSection();
      postRun(v.sel, v.isResume ? null : v.trimmed, fetch).then(res => {
        S.newrun = newRunReducer(S.newrun, res.ok
          ? { type: 'sent', project: v.sel.name, runId: v.sel.run && v.sel.run.run_id, resume: v.isResume, now: Date.now() }
          : { type: 'failed', error: res.error });
        renderNewRunSection();
        if (res.ok) for (const ms of NEWRUN_RECHECKS_MS) setTimeout(loadProjects, ms);
      });
    }
  });
  document.addEventListener('change', e => {
    if (e.target.matches('select[data-action="run"]')) { S.runId = e.target.value; render(); paintSelector(true); }
    else if (e.target.matches('select[data-action="newrun-project"]')) { S.newrun = newRunReducer(S.newrun, { type: 'select', project: e.target.value }); renderNewRunSection(); }
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'newrun-goal') { S.newrun = newRunReducer(S.newrun, { type: 'goal', goal: e.target.value }); patchNewRun(); }
  });
  // Re-escrita adiada enquanto se escrevia: faz-se ao sair do campo.
  document.addEventListener('focusout', e => { if (e.target && e.target.id === 'newrun-goal' && S.newrunPending) setTimeout(renderNewRunSection, 0); });
  // Pausa automática: com o foco num seletor, campo ou caixa de texto, um
  // instantâneo novo espera pela saída do campo (adenda T-UI-9).
  document.addEventListener('focusin', e => { if (isFormField(e.target) && !S.focusPaused) { S.focusPaused = true; S.focusPausedAt = Date.now(); paintSelector(); } });
  document.addEventListener('focusout', e => { if (isFormField(e.target)) setTimeout(releaseFocusPause, 0); });
  document.addEventListener('submit', async e => {
    const f = e.target.closest('form[data-action="answer"]'); if (!f) return;
    e.preventDefault();
    const sub = answerSubmission(f);
    if (!sub) return;
    const { project, id, answer, key } = sub;
    S.sending.add(key); S.errors.delete(key); render();
    try {
      const r = await fetch('/answers', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, id, answer }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      S.sent.set(key, answer);
    } catch { S.errors.set(key, 'não foi possível enviar — tenta outra vez'); }
    finally { S.sending.delete(key); render(); }
  });

  render();
  return { render, tick, state: S };
}
