// Cabeçalho + HUD partilhados pelos três mocks de "agentes ligados".
// É o desenho que já existe (DESIGN.md §1 e §3), reproduzido aqui sem mudanças
// para que a única variável entre as três direções seja a cena. Mock, não produção.
import { esc, wordColour, toneOf, glyph, glyphOf } from './agentes-dados.js';

export function renderHeader(sc, dirName) {
  const loud = sc.members.filter(m => ['bloqueado', 'precisa do Sponsor'].includes(m.state)).length;
  return `<header>
    <div>
      <div class="brand">FORJA <span class="dirname">· ${esc(dirName)}</span></div>
      <div class="sub">forja · ${esc(sc.goal)} · começou há 38 min · 214 eventos · piso de modelo <b>opus</b></div>
    </div>
    <div class="seal ${sc.runTone}">${esc(sc.runState)}<small>${loud} para o Sponsor · ${sc.runnerAlive ? 'último sinal há 4 s' : 'sem sinal do runner há 12 min'}</small></div>
  </header>`;
}

export function renderHud(sc) {
  return `<div class="hud">${sc.members.map(card).join('')}</div>`;
}

function card(m) {
  const t = toneOf(m.state);
  const loud = ['bloqueado', 'precisa do Sponsor'].includes(m.state);
  return `<article class="card m-${m.key} ${t === 'idle' ? 'idle' : ''} ${loud ? 'loud' : ''}" style="--t:${wordColour(m.state)}">
    <div class="nm"><span class="mo">${esc(m.mono)}</span><b>${esc(m.name)}</b>${m.core ? '' : '<em class="tag">a pedido</em>'}</div>
    <div class="word">${esc(m.state)}</div>
    <div class="detail">${esc(m.detail || '')}</div>
    ${(m.tasks || []).length ? `<div class="chips">${m.tasks.map(t2 => `<span class="chip">${esc(t2)}</span>`).join('')}</div>` : ''}
  </article>`;
}

// Legenda das formas de estado: o que garante que nada depende só da cor.
const LEGEND = [
  ['dot', 'a trabalhar'], ['ring-dash', 'silêncio'], ['bar', 'espera / pausa'],
  ['bang', 'precisa de um humano'], ['ring', 'sem resposta'], ['cross', 'morto'],
  ['tick', 'terminado'], ['cross-small', 'falhou'],
];
export function renderLegend(extra = '') {
  const items = LEGEND.map(([k, label]) =>
    `<span><svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">${glyph(k, 0, 0, 7)}</svg> ${esc(label)}</span>`).join('');
  return `<div class="legend">${items}${extra ? `<span><b>${esc(extra)}</b></span>` : ''}</div>`;
}

export const elementCount = sel => document.querySelectorAll(`${sel} *`).length;
export { glyphOf };
