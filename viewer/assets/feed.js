// Feed de eventos-chave — a vista de entrada do viewer (direção C «Voltas»,
// docs/design/DESIGN.md §«Feed de eventos-chave»). Só desenha: o que entra e
// como se agrupa decide-o viewer/lib/feed.mjs no servidor (GET /feed).
// As funções render* são puras (testadas em test/feed-page.test.mjs).

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const hora = ts => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const dia = ts => { const d = new Date(ts); return `${DIAS[d.getDay()]}, ${d.getDate()} de ${MESES[d.getMonth()]}`; };
export function ha(now, ts) {
  const m = Math.max(0, Math.round((now - Date.parse(ts)) / 60e3));
  if (m < 1) return 'agora mesmo';
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `há ${h} h ${r} min` : `há ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'há 1 dia' : `há ${d} dias`;
}
export function dura(a, b) {
  const m = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60e3));
  return m < 1 ? 'menos de 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
const artigo = p => (p === 'QA' ? 'a' : 'o');

// Glifos desenhados (nunca emoji): a forma diz o tipo, a cor diz a banda.
const G = {
  inicio: '<circle cx="8" cy="8" r="4.5" fill="currentColor"/>',
  espera: '<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2.4 2.2"/>',
  aprovou: '<path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  rejeitou: '<path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  escalada: '<path d="M8 2.5 14 13H2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 6.5v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.3" r=".9" fill="currentColor"/>',
  relatorio: '<path d="M4 14V2.5M4 3h8l-2 3 2 3H4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  parado: '<rect x="4" y="4" width="8" height="8" fill="currentColor"/>',
  arrasto: '<path d="M3 5h10M3 8h10M3 11h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};
const glifo = k => `<span class="g"><svg viewBox="0 0 16 16" aria-hidden="true">${G[k]}</svg></span>`;

export const PALAVRA = { parou: ['PAROU', 'parado'], precisa: ['À ESPERA DE TI', 'parado'], pausa: ['EM PAUSA', 'espera'], ativo: ['A TRABALHAR', 'vivo'], terminou: ['TERMINOU', 'neutro'], 'sem-run': ['SEM RUN', 'neutro'] };

// 5 — o que está para acontecer, por projeto.
export function pendenteTexto(p, now) {
  switch (p.tipo) {
    case 'a-trabalhar': return { g: 'inicio', b: 'vivo', t: `${p.papel} a trabalhar`, x: [p.titulo, `desde ${hora(p.desde)} · ${dura(p.desde, new Date(now).toISOString())}`].filter(Boolean).join(' — ') };
    case 'lead-retoma': return { g: 'espera', b: 'espera', t: 'À espera que o Lead retome', x: `o ${p.papel} entregou às ${hora(p.desde)}` };
    case 'lead': return { g: 'espera', b: 'espera', t: 'À espera do próximo passo do Lead', x: p.desde ? `último sinal ${ha(now, p.desde)}` : '' };
    case 'decisao': return { g: 'escalada', b: 'parado', t: 'À espera da tua decisão', x: [p.texto, p.padrao ? `Enquanto não respondes: ${p.padrao}` : ''].filter(Boolean).join(' — ') };
    case 'pausa': return { g: 'espera', b: 'espera', t: 'Em pausa pelo limite de utilização', x: `retoma às ${hora(p.ate)}` };
    case 'parado': return { g: 'parado', b: 'parado', t: 'O runner saiu a meio do run', x: `${ha(now, p.desde)} · o run continua aberto; a guarda dos runners tenta relançá-lo sozinha` };
    case 'plano': return { g: 'espera', b: 'espera', t: 'A seguir no plano', x: [p.titulo, `${p.feitas} de ${p.total} tarefas feitas`].filter(Boolean).join(' — ') };
  }
  return null;
}
export function renderAgora(snap, now) {
  if (!snap.agora.length) return '<h2>Agora</h2><p class="vazio">Nenhum projeto preparado pelo Forja neste PC.</p>';
  return '<h2>Agora</h2>' + snap.agora.map(p => {
    const [palavra, banda] = PALAVRA[p.estado] || PALAVRA['sem-run'];
    const pend = p.pendentes.map(x => pendenteTexto(x, now)).filter(Boolean);
    if (!pend.length) {
      const q = p.terminou ? `terminou ${ha(now, p.terminou)}` : p.ultimo ? `último sinal ${ha(now, p.ultimo)}` : 'nunca correu';
      return `<div class="cp curto b-${banda}"><div class="l1"><span class="nome">${esc(p.projeto)}</span><span class="q">${esc(q)}</span></div></div>`;
    }
    return `<div class="cp b-${banda}"><div class="l1"><span class="nome">${esc(p.projeto)}</span><span class="selo">${palavra}</span></div>${pend.map(x => `<div class="pl b-${x.b}">${glifo(x.g)}<div><b>${esc(x.t)}</b>${x.x ? `<span class="t">${esc(x.x)}</span>` : ''}</div></div>`).join('')}</div>`;
  }).join('');
}

const SELO_FIM = e => (/BLOCKED/.test(e || '') ? ['BLOQUEADO', 'espera'] : /FAILED/.test(e || '') ? ['NÃO CONSEGUIU', 'espera'] : ['ENTREGOU', 'neutro']);
export function renderVolta(v, now) {
  const caiu = v.estado === 'interrompida';
  const passo = (ts, nome, espera, vivo = false) => ts
    ? `<div class="passo feito${vivo ? ' vivo' : ''}"><b>${esc(nome)}</b>${hora(ts)}</div>`
    : v.estado === 'fechada' ? `<div class="passo nada"><b>${esc(nome)}</b>sem registo</div>`
      : `<div class="passo ${caiu ? 'caiu' : 'falta'}"><b>${caiu ? 'não chegou' : esc(espera)}</b>${caiu ? 'interrompida' : 'ainda não'}</div>`;
  let selo;
  if (v.veredito) { const ok = v.veredito.palavra === 'APPROVE'; selo = [ok ? 'APROVADO' : 'REJEITADO', ok ? 'ok' : 'parado']; }
  else if (v.estado === 'a-trabalhar') selo = ['A TRABALHAR', 'vivo'];
  else if (v.estado === 'a-arrancar') selo = ['A ARRANCAR', 'espera'];
  else if (caiu) selo = ['INTERROMPIDA', 'parado'];
  else selo = SELO_FIM(v.fim && v.fim.estado);
  const fim = v.terminou || v.voltou;
  const d = v.comecou && fim ? `demorou ${dura(v.comecou, fim)}` : v.comecou ? `começou ${ha(now, v.comecou)}` : '';
  const porque = v.veredito && v.veredito.texto ? v.veredito.texto
    : v.fim && /BLOCKED|FAILED/.test(v.fim.estado || '') ? v.fim.texto : '';
  return `<article class="volta"><div><div class="quem">${esc(v.de)} <span class="seta" aria-label="chamou">→</span> ${esc(v.para)} <span class="proj">${esc(v.projeto)}</span></div>`
    + `${v.titulo ? `<div class="txt">${esc(v.titulo)}</div>` : ''}${porque ? `<div class="porque">${esc(porque)}</div>` : ''}</div>`
    + `<div class="res"><span class="selo b-${selo[1]}">${selo[0]}</span>${d ? `<div class="d">${esc(d)}</div>` : ''}</div>`
    + `<div class="regua">${passo(v.chamou, 'Chamou', 'chamar')}${passo(v.comecou, 'Começou', 'à espera de começar', v.estado === 'a-trabalhar')}${passo(v.terminou, 'Terminou', `à espera que ${artigo(v.para)} ${v.para} termine`)}${passo(v.voltou, `Voltou ao ${v.de}`, `à espera que o ${v.de} retome`)}</div></article>`;
}
export function marcoTexto(m) {
  switch (m.kind) {
    case 'pergunta': return { g: 'escalada', b: m.respondida ? 'neutro' : 'parado', peso: m.respondida ? 'medio respondida' : '', t: 'Pergunta para ti', selo: m.respondida ? 'RESPONDIDA' : 'PRECISA DE TI', x: m.texto, extra: m.padrao ? `${m.respondida ? 'O run seguiu com' : 'Enquanto não respondes'}: ${m.padrao}` : '' };
    case 'bloqueado': return { g: 'escalada', b: 'parado', peso: '', t: m.run ? 'O run está bloqueado' : 'Tarefa bloqueada', selo: 'BLOQUEADO', x: m.texto };
    case 'arrasto': return { g: 'arrasto', b: 'neutro', peso: 'baixo', t: m.n === 1 ? 'Mais 1 tarefa ficou parada por arrasto — depende de uma que não passou' : `Mais ${m.n} tarefas ficaram paradas por arrasto — dependem de uma que não passou` };
    case 'falhou': return /sess[aã]o terminou/i.test(m.texto || '')
      ? { g: 'parado', b: 'parado', peso: 'medio', t: 'A sessão caiu antes de fechar a tarefa' }
      : { g: 'parado', b: 'parado', peso: m.final ? '' : 'medio', t: m.final ? 'Tarefa falhou de vez' : 'Tarefa falhou — vai ser repetida', selo: m.final ? 'FALHOU' : '', x: m.texto };
    case 'veredito': { const ok = m.veredito.palavra === 'APPROVE'; return { g: ok ? 'aprovou' : 'rejeitou', b: ok ? 'ok' : 'parado', peso: '', t: `${m.papel} ${ok ? 'aprovou' : 'rejeitou'}`, selo: ok ? 'APROVADO' : 'REJEITADO', x: m.veredito.texto }; }
    case 'relatorio': return m.falhou
      ? { g: 'relatorio', b: 'parado', peso: '', t: 'O run falhou', selo: 'FALHOU', x: m.texto }
      : { g: 'relatorio', b: 'fim', peso: '', t: m.sessao ? 'Sessão terminada — relatório entregue' : 'Run terminado — relatório entregue', selo: 'TERMINOU', x: m.texto };
  }
  return null;
}
export function renderMarco(m) {
  const x = marcoTexto(m); if (!x) return '';
  return `<div class="marco ${x.peso} b-${x.b}">${glifo(x.g)}<div><div class="tit">${esc(x.t)}${x.selo ? ` <span class="selo">${x.selo}</span>` : ''}</div>${x.x ? `<div class="txt">${esc(x.x)}</div>` : ''}${x.extra ? `<div class="extra">${esc(x.extra)}</div>` : ''}</div><div class="dir"><span class="hora">${hora(m.ts)}</span><span class="proj">${esc(m.projeto)}</span></div></div>`;
}
export function renderItens(snap, now) {
  if (!snap.itens.length) return '<h2>Voltas e marcos</h2><p class="vazio">Ainda nada aconteceu nos projetos do Forja.</p>';
  let ult = '';
  const out = ['<h2>Voltas e marcos</h2>'];
  for (const i of snap.itens) {
    const d = dia(i.ts);
    if (d !== ult) { out.push(`<div class="dia">${d}</div>`); ult = d; }
    out.push(i.tipo === 'volta' ? renderVolta(i, now) : renderMarco(i));
  }
  return out.join('');
}

// ---------- página ----------
export function bootFeed({ root = document.getElementById('feed'), status = document.getElementById('feed-estado'), every = 5000 } = {}) {
  let snap = null, lastOk = 0, timer = null;
  const paint = () => {
    if (!root || !snap) return;
    const now = Date.now();
    root.innerHTML = `<main class="voltas" id="voltas">${renderItens(snap, now)}</main><aside class="lado" aria-label="Agora">${renderAgora(snap, now)}</aside>`;
  };
  const conn = () => {
    if (!status) return;
    const s = lastOk ? Math.round((Date.now() - lastOk) / 1000) : null;
    status.className = `estado${s !== null && s < 20 ? ' ok' : ''}`;
    status.textContent = s === null ? 'a ligar…' : s < 20 ? `atualizado há ${s} s` : `sem ligação · últimos dados há ${Math.round(s / 60) || 1} min`;
  };
  async function load() {
    try {
      const r = await fetch('/feed', { cache: 'no-store', credentials: 'same-origin' });
      if (r.ok) { snap = await r.json(); lastOk = Date.now(); paint(); }
    } catch {}
    conn();
  }
  load();
  timer = setInterval(() => { if (!document.hidden) load(); else conn(); }, every);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  return { load, stop: () => clearInterval(timer), get snap() { return snap; } };
}

// Duas vistas na mesma página: «Eventos» (esta, por omissão) e «Modelos e
// ligações» (o viewer de sempre, viewer.js), que só arranca quando é aberta.
export function initTabs({ bootHub }) {
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  let hubStarted = false;
  function show(name) {
    for (const t of tabs) {
      const on = t.dataset.view === name;
      t.setAttribute('aria-selected', String(on));
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    }
    if (name === 'modelos' && !hubStarted) { hubStarted = true; bootHub(); }
  }
  const fromHash = () => show(location.hash === '#modelos' ? 'modelos' : 'eventos');
  window.addEventListener('hashchange', fromHash);
  fromHash();
}
