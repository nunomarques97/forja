// Dados e ajudantes partilhados pelos três mocks da cena "agentes ligados"
// (D-SCENE-2). Só mock: nada disto é código de produção — o viewer real
// continua em `viewer/`. Os três mocks carregam exatamente os mesmos dez
// papéis, os mesmos estados e as mesmas arestas, para que a comparação seja
// entre desenhos e não entre conteúdos.

// ---- os dez papéis (ordem e chaves do redutor, viewer/assets/viewer.js) ----
export const ROLES = [
  { key: 'lead',              mono: 'Le', name: 'Lead',              c: 'ember',    core: true },
  { key: 'architect',         mono: 'Ar', name: 'Architect',         c: 'slate',    core: true },
  { key: 'frontend-dev',      mono: 'FD', name: 'Frontend Dev',      c: 'patina',   core: true },
  { key: 'backend-dev',       mono: 'BD', name: 'Backend Dev',       c: 'indigo',   core: true },
  { key: 'reviewer',          mono: 'Re', name: 'Reviewer',          c: 'steel',    core: true },
  { key: 'product-manager',   mono: 'PM', name: 'Product Manager',   c: 'wood',     core: false },
  { key: 'product-designer',  mono: 'PD', name: 'Product Designer',  c: 'patina-2', core: false },
  { key: 'technology-scout',  mono: 'TS', name: 'Technology Scout',  c: 'indigo-2', core: false },
  { key: 'qa',                mono: 'QA', name: 'QA',                c: 'slate-2',  core: false },
  { key: 'security-reviewer', mono: 'SR', name: 'Security Reviewer', c: 'steel-2',  core: false },
];
export const byKey = k => ROLES.find(r => r.key === k);
export const coreRoles = ROLES.filter(r => r.core);
export const demandRoles = ROLES.filter(r => !r.core);

// ---- as arestas: FLUXO DE TRABALHO, não chamadas reais ---------------------
// Só o Lead chama alguém (é o único com a ferramenta `Agent`). As arestas
// `hub` são chamadas reais; as arestas `flow` são a representação de quem
// trabalha para quem — o trabalho do Frontend Dev vai ao Reviewer mesmo que o
// caminho passe pelo Lead. Fixas: nunca dependem do estado.
export const EDGES = [
  // hub — o Lead chama toda a gente (9)
  { a: 'lead', b: 'architect',         kind: 'hub' },
  { a: 'lead', b: 'frontend-dev',      kind: 'hub' },
  { a: 'lead', b: 'backend-dev',       kind: 'hub' },
  { a: 'lead', b: 'reviewer',          kind: 'hub' },
  { a: 'lead', b: 'product-manager',   kind: 'hub' },
  { a: 'lead', b: 'product-designer',  kind: 'hub' },
  { a: 'lead', b: 'technology-scout',  kind: 'hub' },
  { a: 'lead', b: 'qa',                kind: 'hub' },
  { a: 'lead', b: 'security-reviewer', kind: 'hub' },
  // fluxo — quem entrega trabalho a quem (10)
  { a: 'architect',        b: 'frontend-dev',      kind: 'flow' },
  { a: 'architect',        b: 'backend-dev',       kind: 'flow' },
  { a: 'frontend-dev',     b: 'reviewer',          kind: 'flow' },
  { a: 'backend-dev',      b: 'reviewer',          kind: 'flow' },
  { a: 'reviewer',         b: 'security-reviewer', kind: 'flow' },
  { a: 'qa',               b: 'lead',              kind: 'flow' },
  { a: 'product-manager',  b: 'architect',         kind: 'flow' },
  { a: 'technology-scout', b: 'frontend-dev',      kind: 'flow' },
  { a: 'technology-scout', b: 'backend-dev',       kind: 'flow' },
  { a: 'product-designer', b: 'frontend-dev',      kind: 'flow' },
];

// ---- estados (palavras exatas do redutor) ----------------------------------
export const TONE = {
  'inativo': 'idle', 'a trabalhar': 'work', 'à espera de review': 'wait', 'à espera de input': 'wait',
  'à espera de quota': 'wait', 'em pausa': 'wait', 'bloqueado': 'alarm', 'precisa do Sponsor': 'sponsor',
  'sem resposta': 'lost', 'morto': 'dead', 'terminado': 'done', 'falhou': 'fail',
};
export const toneOf = s => TONE[s] || 'idle';

// Opacidade do brilho/halo por tom — igual para núcleo e a pedido: a hierarquia
// visual apaga a mobília, nunca o estado.
export function glowOpacity(m) {
  const t = toneOf(m.state);
  if (t === 'work') return m.quiet ? .5 : 1;
  if (t === 'alarm' || t === 'sponsor') return .55;
  if (t === 'wait') return .35;
  return 0;
}
// Cor do halo: quem precisa de um humano rouba a cor de identidade.
export const glowColour = m => ['alarm', 'sponsor'].includes(toneOf(m.state)) ? 'var(--alarm)' : `var(--${byKey(m.key).c})`;
// Opacidade do corpo do nó.
export const bodyOpacity = m => ['idle', 'dead', 'lost', 'fail', 'done'].includes(toneOf(m.state)) ? .45 : 1;
// Anima? Só com evidência: a trabalhar e com sinal recente (`quiet` falso).
export const isLive = m => toneOf(m.state) === 'work' && !m.quiet;

// ---- glifo de estado: a forma que torna o estado legível sem cor -----------
// Desenhado num quadrado de 20×20 centrado em (0,0); cada mock escala-o.
// dot ● a trabalhar · ring-dash ◌ silêncio · bar ▬ espera/pausa · bang ! precisa
// de um humano · ring ○ sem resposta · cross ✕ morto · tick ✓ terminado ·
// cross-small ✕ falhou · (vazio) inativo.
export function glyphOf(m) {
  const t = toneOf(m.state);
  if (t === 'work') return m.quiet ? 'ring-dash' : 'dot';
  if (t === 'wait') return 'bar';
  if (t === 'alarm' || t === 'sponsor') return 'bang';
  if (t === 'lost') return 'ring';
  if (t === 'dead') return 'cross';
  if (t === 'done') return 'tick';
  if (t === 'fail') return 'cross-small';
  return 'none';
}
export const glyphColour = {
  'dot': 'var(--ember)', 'ring-dash': 'var(--amber)', 'bar': 'var(--wood)', 'bang': 'var(--alarm)',
  'ring': 'var(--amber)', 'cross': 'var(--alarm)', 'tick': 'var(--patina)', 'cross-small': 'var(--alarm)', 'none': 'var(--dim)',
};
// SVG do glifo, centrado em (x,y), num círculo de raio r.
export function glyph(kind, x, y, r) {
  const col = glyphColour[kind], s = v => Math.round(v * 100) / 100;
  const w = Math.max(1.4, r * .34);
  switch (kind) {
    case 'dot':         return `<circle cx="${x}" cy="${y}" r="${s(r * .5)}" fill="${col}"/>`;
    case 'ring-dash':   return `<circle cx="${x}" cy="${y}" r="${s(r * .62)}" fill="none" stroke="${col}" stroke-width="${s(w)}" stroke-dasharray="${s(r * .5)} ${s(r * .5)}"/><circle cx="${x}" cy="${y}" r="${s(r * .2)}" fill="${col}"/>`;
    case 'bar':         return `<rect x="${s(x - r * .68)}" y="${s(y - w / 2)}" width="${s(r * 1.36)}" height="${s(w)}" rx="${s(w / 2)}" fill="${col}"/>`;
    case 'bang':        return `<rect x="${s(x - w / 2)}" y="${s(y - r * .72)}" width="${s(w)}" height="${s(r * .92)}" rx="${s(w / 2)}" fill="${col}"/><circle cx="${x}" cy="${s(y + r * .56)}" r="${s(w * .62)}" fill="${col}"/>`;
    case 'ring':        return `<circle cx="${x}" cy="${y}" r="${s(r * .62)}" fill="none" stroke="${col}" stroke-width="${s(w)}"/>`;
    case 'cross':       return `<g stroke="${col}" stroke-width="${s(w * 1.15)}" stroke-linecap="round"><line x1="${s(x - r * .6)}" y1="${s(y - r * .6)}" x2="${s(x + r * .6)}" y2="${s(y + r * .6)}"/><line x1="${s(x + r * .6)}" y1="${s(y - r * .6)}" x2="${s(x - r * .6)}" y2="${s(y + r * .6)}"/></g>`;
    case 'cross-small': return `<g stroke="${col}" stroke-width="${s(w)}" stroke-linecap="round"><line x1="${s(x - r * .38)}" y1="${s(y - r * .38)}" x2="${s(x + r * .38)}" y2="${s(y + r * .38)}"/><line x1="${s(x + r * .38)}" y1="${s(y - r * .38)}" x2="${s(x - r * .38)}" y2="${s(y + r * .38)}"/></g>`;
    case 'tick':        return `<polyline points="${s(x - r * .55)},${s(y)} ${s(x - r * .12)},${s(y + r * .42)} ${s(x + r * .58)},${s(y - r * .45)}" fill="none" stroke="${col}" stroke-width="${s(w)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    default:            return '';
  }
}

// ---- dois cenários de demonstração ----------------------------------------
// `padrao`: um run normal a meio. `estados`: o resto da tabela de estados,
// incluindo `em pausa` no Lead e o runner morto.
const S = (key, state, extra = {}) => ({ key, state, ...extra });
export const SCENARIOS = {
  padrao: {
    label: 'run a correr, runner vivo',
    runState: 'run a correr, runner vivo', runTone: 'work', runnerAlive: true,
    goal: 'Trocar a cena da forja por um grafo de agentes ligados',
    members: [
      S('lead', 'a trabalhar', { detail: 'à espera de Frontend Dev, Reviewer', tasks: [] }),
      S('architect', 'terminado', { detail: 'PLAN — 7 tasks', tasks: [] }),
      S('frontend-dev', 'a trabalhar', { detail: 'a escrever a cena em SVG', tasks: ['T12', 'T14'] }),
      S('backend-dev', 'a trabalhar', { quiet: true, detail: 'silêncio há 3 min', tasks: ['T13'] }),
      S('reviewer', 'terminado', { detail: 'APPROVE — T11', tasks: [] }),
      S('product-manager', 'precisa do Sponsor', { detail: 'Q3 — confirmar direção da cena', tasks: ['Q3'] }),
      S('product-designer', 'a trabalhar', { detail: 'três direções em mocks', tasks: ['D2'] }),
      S('technology-scout', 'inativo', { detail: 'a pedido · ainda não foi preciso' }),
      S('qa', 'inativo', { detail: 'a pedido · ainda não foi preciso' }),
      S('security-reviewer', 'inativo', { detail: 'a pedido · ainda não foi preciso' }),
    ],
    // hand-back acabado de acontecer: a única coisa que se move além do pulso
    handbacks: [{ a: 'frontend-dev', b: 'reviewer' }],
  },
  estados: {
    label: 'run em curso, runner parado',
    runState: 'run em curso, runner parado', runTone: 'dead', runnerAlive: false,
    goal: 'Demonstração de todos os estados do elenco',
    members: [
      S('lead', 'em pausa', { detail: 'limite de utilização, retoma às 14:20', tasks: [] }),
      S('architect', 'bloqueado', { detail: 'precisa de decisão de tecnologia', tasks: ['T7'] }),
      S('frontend-dev', 'a trabalhar', { quiet: true, detail: 'silêncio há 6 min', tasks: ['T9'] }),
      S('backend-dev', 'sem resposta', { detail: 'último sinal há 9 min', tasks: ['T8'] }),
      S('reviewer', 'falhou', { detail: 'a chamada falhou', tasks: ['T6'] }),
      S('product-manager', 'precisa do Sponsor', { detail: 'Q4 — nova dependência', tasks: ['Q4'] }),
      S('product-designer', 'à espera de review', { detail: 'à espera do Reviewer', tasks: ['D1'] }),
      S('technology-scout', 'morto', { detail: 'último sinal há 41 min', tasks: ['S2'] }),
      S('qa', 'terminado', { detail: 'QA FAIL — 2 findings', tasks: [] }),
      S('security-reviewer', 'inativo', { detail: 'a pedido · ainda não foi preciso' }),
    ],
    handbacks: [],
  },
};

export function scenario() {
  const q = new URLSearchParams(location.search);
  const name = q.get('cenario') === 'estados' ? 'estados' : 'padrao';
  const sc = SCENARIOS[name];
  const map = new Map(sc.members.map(m => [m.key, m]));
  return { name, ...sc, map, members: ROLES.map(r => ({ ...r, ...map.get(r.key) })), folded: q.get('aberto') !== '1' };
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Cor da palavra de estado (a mesma tabela do DESIGN.md).
export const wordColour = s => {
  const t = toneOf(s);
  return t === 'work' ? 'var(--ember)' : t === 'done' ? 'var(--patina)' : t === 'wait' ? 'var(--wood)'
    : t === 'lost' ? 'var(--amber)' : ['alarm', 'sponsor', 'dead', 'fail'].includes(t) ? 'var(--alarm)' : 'var(--dim)';
};
