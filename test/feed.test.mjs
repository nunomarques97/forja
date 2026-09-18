// Feed de eventos-chave: redutor (viewer/lib/feed.mjs) e desenho (viewer/assets/feed.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createFeed, feedApply, feedSnapshot, tituloLegivel, looksPath, FEED } from '../viewer/lib/feed.mjs';
import * as P from '../viewer/assets/feed.js';

const T0 = Date.parse('2026-09-18T14:00:00Z');
const at = min => new Date(T0 + min * 60e3).toISOString();
const PROJ = [{ name: 'radar', path: '/nao/existe' }];
function play(recs) { const f = createFeed(); for (const r of recs) feedApply(f, r); return f; }
const pre = (min, id, type, desc, extra = {}) => ({ ts: at(min), project: 'radar', session_id: 'lead', hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: id, tool_input: { subagent_type: type, description: desc, ...extra } });
const post = (min, id, status, agentId) => ({ ts: at(min), project: 'radar', session_id: 'lead', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: id, tool_response: { status, agentId } });
const start = (min, aid, type) => ({ ts: at(min), project: 'radar', session_id: 'lead', hook_event_name: 'SubagentStart', agent_id: aid, agent_type: type });
const stop = (min, aid, type, msg) => ({ ts: at(min), project: 'radar', session_id: 'lead', hook_event_name: 'SubagentStop', agent_id: aid, agent_type: type, last_assistant_message: msg });
const lead = min => ({ ts: at(min), project: 'radar', session_id: 'lead', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
const forja = (min, kind, fields = {}) => ({ ts: at(min), project: 'radar', session_id: 'runner', hook_event_name: 'Forja', forja: { kind, run_id: 'R-1', ...fields } });

describe('títulos legíveis: sem caminhos nem códigos de task', () => {
  test('casos reais dos logs', () => {
    assert.equal(tituloLegivel('T022a - radar_v08/domain/integrity.py: regras OC-1 puras, PASS/FAIL/UNKNOWN/N/A por capacidade'), 'Regras OC-1 puras, PASS/FAIL/UNKNOWN/N/A por capacidade');
    assert.equal(tituloLegivel('T10 · Backend Dev: docs/RELEASE.md e docs/USER-GUIDE.md: como se constroi e o que fazer quando corre mal'), 'Como se constroi e o que fazer quando corre mal');
    assert.equal(tituloLegivel('slugify(text) em lib/slug.mjs com testes (acentos, espaços, pontuação)'), 'Slugify(text) com testes (acentos, espaços, pontuação)');
    assert.equal(tituloLegivel('T3 · Reviewer: review'), 'Revisão');
    assert.equal(tituloLegivel('Bloqueador: `viewer/lib/state.mjs:858` ainda conta a sessão'), 'Bloqueador: ainda conta a sessão');
    assert.equal(tituloLegivel(''), '');
  });
  test('o que não é caminho fica', () => {
    assert.equal(looksPath('PASS/FAIL/UNKNOWN/N/A'), false);
    assert.equal(looksPath('e/ou'), false);
    assert.equal(looksPath('https://exemplo.pt/a/b'), false);
    assert.equal(looksPath('C:\\granite\\docs'), true);
    assert.equal(looksPath('TESTING.md:58'), true);
  });
});

describe('a volta: chamou · começou · terminou · voltou num item só', () => {
  test('chamada em fundo: o Post é «async_launched», o regresso é o gesto seguinte do Lead', () => {
    const f = play([
      forja(0, 'run.start', { goal: 'x' }),
      forja(0, 'task.start', { id: 'T2', title: 'T004b - achados legados registados no catalogo' }),
      pre(1, 'u1', 'backend-dev', 'T2 · Backend Dev: T004b - achados legados registados no catalogo', { run_in_background: true }),
      post(1, 'u1', 'async_launched', 'a1'), start(1, 'a1', 'backend-dev'),
      stop(6, 'a1', 'backend-dev', 'DONE T2 — achados registados'),
      lead(7),
    ]);
    const s = feedSnapshot(f, T0 + 8 * 60e3, { projects: PROJ });
    const v = s.itens.filter(x => x.tipo === 'volta');
    assert.equal(v.length, 1, 'quatro eventos, uma linha');
    assert.deepEqual([v[0].chamou, v[0].comecou, v[0].terminou, v[0].voltou], [at(1), at(1), at(6), at(7)]);
    assert.equal(v[0].estado, 'fechada');
    assert.equal(v[0].titulo, 'Achados legados registados no catalogo');
    assert.equal(v[0].fim.estado, 'DONE');
  });
  test('chamada síncrona: o agentId só chega no fim — liga-se ao arranque pela sessão e pelo papel', () => {
    const f = play([pre(1, 'u1', 'qa', 'V · QA: validação final'), start(2, 'a9', 'qa'), stop(5, 'a9', 'qa', 'QA PASS — tudo verde'), post(5, 'u1', 'completed', 'a9')]);
    const v = feedSnapshot(f, T0 + 6 * 60e3, { projects: PROJ }).itens;
    assert.equal(v.length, 1);
    assert.equal(v[0].voltou, at(5));
  });
  test('o que ainda não aconteceu: a trabalhar, à espera que o Lead retome, e interrompida quando a sessão calou', () => {
    const f = play([forja(0, 'run.start'), pre(1, 'u1', 'backend-dev', 'x'), post(1, 'u1', 'async_launched', 'a1'), start(1, 'a1', 'backend-dev')]);
    const a = feedSnapshot(f, T0 + 3 * 60e3, { projects: PROJ });
    assert.equal(a.itens[0].estado, 'a-trabalhar');
    assert.ok(a.agora[0].pendentes.some(p => p.tipo === 'a-trabalhar' && p.papel === 'Backend Dev'));
    feedApply(f, stop(4, 'a1', 'backend-dev', 'DONE T1 — feito'));
    const b = feedSnapshot(f, T0 + 5 * 60e3, { projects: PROJ });
    assert.equal(b.itens[0].estado, 'lead-retoma');
    assert.ok(b.agora[0].pendentes.some(p => p.tipo === 'lead-retoma'));
    const c = feedSnapshot(f, T0 + 4 * 60e3 + FEED.LIVE_MS + 1, { projects: PROJ });
    assert.equal(c.itens[0].estado, 'interrompida');
  });
  test('ferramentas nativas nunca entram', () => {
    const f = play([pre(1, 'u1', 'Explore', 'procura'), start(1, 'n1', 'Explore')]);
    assert.equal(feedSnapshot(f, T0, { projects: PROJ }).itens.length, 0);
  });
});

describe('veredito, escalada e relatório', () => {
  test('o veredito do runner cola-se à volta do Reviewer; o Stop dele não o duplica', () => {
    const f = play([
      forja(0, 'task.start', { id: 'T2', title: 'Achados legados' }),
      pre(1, 'u1', 'reviewer', 'T2 · Reviewer: review'), post(1, 'u1', 'async_launched', 'r1'), start(1, 'r1', 'reviewer'),
      stop(4, 'r1', 'reviewer', 'I approved T2 and sent the verdict to the Lead.'),
      forja(5, 'task.done', { id: 'T2', verdict: 'APPROVE — T004b: both blockers fixed' }),
    ]);
    const it = feedSnapshot(f, T0 + 6 * 60e3, { projects: PROJ }).itens;
    assert.equal(it.length, 1);
    assert.equal(it[0].titulo, 'Revisão · Achados legados', 'o código da task vira o título da task');
    assert.equal(it[0].veredito.palavra, 'APPROVE');
    assert.equal(it[0].veredito.texto, 'Both blockers fixed');
  });
  test('sessão à mão: o veredito vem da primeira linha da última mensagem do Reviewer', () => {
    const f = play([pre(1, 'u1', 'reviewer', 'rever'), post(1, 'u1', 'async_launched', 'r1'), start(1, 'r1', 'reviewer'), stop(3, 'r1', 'reviewer', 'REJECT — falta o teste do caso vazio\nBloqueadores: 1')]);
    assert.equal(feedSnapshot(f, T0, { projects: PROJ }).itens[0].veredito.palavra, 'REJECT');
  });
  test('bloqueios em cascata: a raiz tem peso, o arrasto é uma linha só com a contagem', () => {
    const f = play([
      forja(0, 'task.fail', { id: 'T3', why: 'sessão terminou sem fechar a task (crash ou saída inesperada)', final: true }),
      forja(1, 'task.block', { id: 'T4', why: 'dependência T3 falhou' }),
      forja(1, 'task.block', { id: 'T5', why: 'dependência T4 está bloqueada' }),
      forja(4, 'task.block', { id: 'T6', why: 'dependência T5 está bloqueada' }),
      forja(5, 'task.block', { id: 'T7', why: 'precisa do Sponsor: rm recusado' }),
    ]);
    const it = feedSnapshot(f, T0 + 6 * 60e3, { projects: PROJ }).itens;
    assert.deepEqual(it.map(x => x.kind), ['bloqueado', 'arrasto', 'falhou']);
    assert.equal(it[1].n, 3);
    const html = P.renderMarco(it[1]);
    assert.match(html, /class="marco baixo b-neutro"/, 'o arrasto é visualmente secundário');
    assert.match(html, /Mais 3 tarefas ficaram paradas por arrasto/);
    assert.match(P.renderMarco(it[0]), /class="marco  b-parado"/, 'a raiz leva o peso todo');
  });
  test('pergunta ao Sponsor, respondida depois; relatório do run e da sessão à mão', () => {
    const f = play([
      forja(0, 'run.start'),
      forja(1, 'ask', { id: 'Q1', text: 'Publicar a página?', default: 'não publicar' }),
      forja(2, 'answer.pending', { id: 'Q1', text: 'não' }),
      forja(3, 'run.finish', { note: 'fechado pelo runner' }),
      { ts: at(4), project: 'radar', session_id: 'mao', hook_event_name: 'Forja', forja: { kind: 'report', run_id: null, text: 'Feed entregue' } },
    ]);
    const s = feedSnapshot(f, T0 + 5 * 60e3, { projects: PROJ });
    assert.deepEqual(s.itens.map(x => x.kind), ['relatorio', 'relatorio', 'pergunta']);
    assert.equal(s.itens[2].respondida, true);
    assert.equal(s.itens[0].sessao, true);
    assert.equal(s.agora[0].estado, 'terminou');
    assert.match(P.renderMarco(s.itens[0]), /Sessão terminada — relatório entregue/);
  });
});

describe('estado dos projetos («Agora»)', () => {
  test('runner saiu a meio: PAROU, com o próximo passo do plano, e primeiro na lista', () => {
    const f = play([forja(0, 'run.start'), forja(1, 'runner.exit', { note: 'fecho falhou duas vezes' }),
      { ts: at(2), project: 'outro', session_id: 'z', hook_event_name: 'Forja', forja: { kind: 'run.start', run_id: 'R-2' } }]);
    const s = feedSnapshot(f, T0 + 3 * 60e3, { projects: [{ name: 'outro', path: '/x' }, ...PROJ], tasksOf: p => (p.name === 'radar' ? [{ status: 'done', title: 'a' }, { status: 'todo', title: 'T5 - scripts/run.py: teste do alinhamento' }] : []) });
    assert.deepEqual(s.agora.map(a => [a.projeto, a.estado]), [['radar', 'parou'], ['outro', 'ativo']]);
    const plano = s.agora[0].pendentes.find(p => p.tipo === 'plano');
    assert.deepEqual([plano.titulo, plano.feitas, plano.total], ['Teste do alinhamento', 1, 2]);
    assert.match(P.renderAgora(s, T0 + 3 * 60e3), /<span class="selo">PAROU<\/span>/);
    assert.ok(s.agora[1].pendentes.some(p => p.tipo === 'lead'), 'um run vivo sem mais nada está à espera do Lead');
  });
});

describe('a página: só desenha, e escapa tudo', () => {
  test('tudo o que vem dos logs é escapado', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const v = { tipo: 'volta', projeto: evil, ts: at(0), de: 'Lead', para: 'Reviewer', titulo: evil, chamou: at(0), comecou: at(1), terminou: at(2), voltou: null, fim: null, veredito: { palavra: 'REJECT', texto: evil }, estado: 'interrompida' };
    const snap = { agora: [{ projeto: evil, estado: 'precisa', pendentes: [{ tipo: 'decisao', texto: evil, padrao: evil, desde: at(0) }] }], itens: [v, { tipo: 'marco', kind: 'pergunta', projeto: evil, ts: at(0), texto: evil, padrao: evil }] };
    for (const html of [P.renderItens(snap, T0), P.renderAgora(snap, T0)]) {
      assert.ok(!html.includes('<img'), 'sem HTML cru');
      assert.ok(html.includes('&lt;img'));
    }
    assert.match(P.renderVolta(v, T0), /REJEITADO/);
    assert.match(P.renderVolta(v, T0), /não chegou/);
  });
  test('a régua diz o que falta no sítio onde vai acontecer', () => {
    const v = { tipo: 'volta', projeto: 'radar', ts: at(0), de: 'Lead', para: 'Backend Dev', titulo: 'x', chamou: at(0), comecou: at(1), terminou: null, voltou: null, fim: null, veredito: null, estado: 'a-trabalhar' };
    const html = P.renderVolta(v, T0 + 5 * 60e3);
    assert.match(html, /A TRABALHAR/);
    assert.match(html, /à espera que o Backend Dev termine/);
    assert.match(html, /à espera que o Lead retome/);
    assert.match(html, /passo feito vivo/);
  });
});
