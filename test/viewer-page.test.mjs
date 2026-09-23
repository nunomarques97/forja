// The viewer pages (desktop `/`, phone `/m`) and their assets, served by the
// real server against a temp data dir; plus the pure render functions of
// viewer/assets/viewer.js on real snapshots (happy-path through the server,
// all-roles through the reducer). Never touches data/events.jsonl.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FakeDocument } from './helpers/fake-dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'forja-viewer-page-test-'));
const dataDir = join(dir, 'data');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'events.jsonl'), readFileSync(join(here, 'fixtures', 'happy-path.jsonl'), 'utf8'));
const port = 44000 + Math.floor(Math.random() * 300);
let server; let token;
// Ten roles, fixed order: five core, five on demand (docs/design/DESIGN.md).
const NAMES = ['Lead', 'Architect', 'Frontend Dev', 'Backend Dev', 'Reviewer', 'Product Manager', 'Product Designer', 'Technology Scout', 'QA', 'Security Reviewer'];
const KEYS = ['lead', 'architect', 'frontend-dev', 'backend-dev', 'reviewer', 'product-manager', 'product-designer', 'technology-scout', 'qa', 'security-reviewer'];
const MONOS = ['Le', 'Ar', 'FD', 'BD', 'Re', 'PM', 'PD', 'TS', 'QA', 'SR'];
const BASE = Date.parse('2026-09-17T09:00:00.000Z'); // test/fixtures/build-fixtures.mjs

const http = (path, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, resp => {
    let data = ''; resp.on('data', d => { data += d; }); resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: data }));
  });
  req.on('error', reject); req.end();
});
const auth = () => ({ Cookie: `forja_k=${token}` });
const count = (html, re) => (html.match(re) || []).length;

before(async () => {
  server = spawn(process.execPath, [join(here, '..', 'viewer', 'server.mjs')], { env: { ...process.env, PORT: String(port), FORJA_DATA_DIR: dataDir, FORJA_NO_WATCHDOG: '1', FORJA_NTFY_SERVER: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Forja viewer')) resolve(); }); server.on('exit', c => reject(new Error(`server exited early ${c}`))); });
  token = readFileSync(join(dataDir, 'viewer-token.txt'), 'utf8').trim();
});
after(() => { server.kill(); rmSync(dir, { recursive: true, force: true }); });

describe('pages', () => {
  for (const [path, mode] of [['/legacy', 'desktop'], ['/legacy/m', 'mobile']]) {
    test(`${path} needs the cookie, is Portuguese, lists the ten roster names with the "a pedido" label, has no template leftovers and no token`, async () => {
      // T-SEC-1: sem cookie estas duas rotas dão a página de entrada (o link do
      // ntfy já não leva o token), nunca a página real. O contrato completo da
      // entrada está em test/server.test.mjs.
      const anon = await http(path);
      assert.equal(anon.status, 200);
      assert.match(anon.body, /<form method="post" action="\/login">/);
      assert.ok(!anon.body.includes('data-mode='), 'a página real só vem com o cookie');
      assert.ok(!anon.body.includes(token), 'a página de entrada não mostra o token');
      const r = await http(path, auth());
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.match(r.body, /<html lang="pt-PT">/);
      assert.match(r.body, new RegExp(`<body data-mode="${mode}">`));
      const order = NAMES.map(n => r.body.indexOf(`<b>${n}</b>`));
      assert.ok(order.every(i => i >= 0), `${path} lists all ten names`);
      assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'fixed order: core first, then on demand');
      for (const k of KEYS) assert.ok(r.body.includes(`m-${k}`), `${path} has the identity class m-${k}`);
      assert.equal(count(r.body, /<em class="tag">a pedido<\/em>/g), 5, 'five on-demand roles carry the label');
      for (const old of ['Ferreiro', 'Bigorna', 'Fundidor', 'Lapidador', 'Contraste']) assert.ok(!r.body.includes(old), `${path} has no legacy name ${old}`);
      for (const bad of ['${', '{{', 'TODO', 'lorem', 'undefined', 'NaN', '[object']) assert.ok(!r.body.includes(bad), `${path} has no "${bad}"`);
      assert.ok(!r.body.includes(token), 'the token never appears in the page');
      assert.ok(!r.body.includes('onclick='), 'no inline handlers');
      assert.match(r.body, /\/assets\/viewer\.css/); assert.match(r.body, /\/assets\/viewer\.js/);
      assert.match(r.body, /fonts\.googleapis\.com.*Barlow\+Condensed.*IBM\+Plex\+Mono/, 'the DESIGN.md fonts and nothing else external');
      assert.ok(!/<script[^>]+src="https?:/.test(r.body), 'no external scripts');
      assert.match(r.body, /aria-live="polite"/);
      assert.match(r.body, /<h2 class="label" id="newrun-h">Novo run<\/h2>/);
      assert.match(r.body, /<div id="newrun">/);
      const newrunIdx = r.body.indexOf('id="newrun-h"'), queueIdx = r.body.indexOf('id="queue-h"');
      if (mode === 'mobile') assert.ok(newrunIdx > 0 && newrunIdx < queueIdx, '/m: "Novo run" right after the ten rows, before "Precisa do Sponsor"');
      else assert.ok(newrunIdx > queueIdx, '/: "Novo run" at the bottom of the "Precisa do Sponsor" column');
    });
  }
  test('assets are served with the right type; the new identity tokens exist; traversal is refused', async () => {
    const css = await http('/assets/viewer.css', auth());
    assert.equal(css.status, 200); assert.match(css.headers['content-type'], /text\/css/); assert.match(css.body, /--ember: #FF7A2F/);
    for (const t of ['--indigo-2: #C3C9FF', '--patina-2: #A8E3D0', '--steel-2: #9AA6B2', '--slate-2: #B9D3E3', '--slate: #8FB3C9']) assert.ok(css.body.includes(t), `token ${t}`);
    for (const k of KEYS) assert.ok(css.body.includes(`.m-${k} {`), `identity rule for ${k}`);
    const js = await http('/assets/viewer.js', auth());
    assert.equal(js.status, 200); assert.match(js.headers['content-type'], /javascript/); assert.match(js.body, /export function boot/);
    assert.equal((await http('/assets/viewer.css')).status, 401);
    assert.equal((await http('/assets/..%5Cserver.mjs', auth())).status, 400);
    assert.equal((await http('/assets/nope.css', auth())).status, 404);
  });
});

describe('render functions on a real snapshot (happy-path through the server)', () => {
  let V; let snap; let run;
  before(async () => {
    V = await import(pathToFileURL(join(here, '..', 'viewer', 'assets', 'viewer.js')).href);
    snap = JSON.parse((await http('/state', auth())).body);
    run = snap.runs.find(r => r.id === snap.current);
  });
  test('the HUD has the ten cards in order (keys, names, core from the snapshot) with the exact state words, monograms and the task chip', () => {
    const html = V.renderHud(run, snap, snap.generatedAt);
    const order = NAMES.map(n => html.indexOf(`<b>${n}</b>`));
    assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'fixed order');
    assert.ok(order.every(i => i >= 0));
    assert.equal(count(html, /<article class="card /g), 10);
    assert.deepEqual(run.roster.map(c => c.key), KEYS, 'the keys come from the reducer');
    for (const [i, m] of MONOS.entries()) assert.ok(html.includes(`<span class="mo" aria-hidden="true">${m}</span><b>${NAMES[i]}</b>`), `monogram ${m}`);
    for (const c of run.roster) assert.ok(html.includes(`<div class="word">${c.state}</div>`), `state word "${c.state}" is printed as-is`);
    assert.equal(count(html, /<em class="tag">a pedido<\/em>/g), 5, 'the five on-demand cards carry the label next to the role');
    assert.match(html, /<span class="chip">T1<\/span>/);
    assert.match(html, /modelo <b>claude-fable-5-1<\/b>/);
    const idleCore = V.renderCard({ ...run.roster[1], state: 'inativo', since: null, detail: null, quiet: null, instances: [], sessions: 0, activeMs: 0 }, run, snap, snap.generatedAt);
    assert.match(idleCore, /<div class="word">inativo<\/div>/);
    assert.match(idleCore, /ainda não foi chamado neste run/, 'an inactive core member is shown as a state, never hidden');
    assert.match(idleCore, /class="card m-architect t-idle idle"/);
    assert.ok(!idleCore.includes('ligado:'), 'no stat line without instances');
    const idleDemand = V.renderCard(run.roster[8], run, snap, snap.generatedAt); // QA: never called in happy-path
    assert.equal(run.roster[8].state, 'inativo');
    assert.match(idleDemand, /a pedido · ainda não foi preciso neste run/);
    assert.match(idleDemand, /class="card m-qa t-idle idle demand"/);
  });
  test('the Lead card shows the run block, the run seal, the session model line and "ligado:" without a session count', () => {
    const html = V.renderCard(run.roster[0], run, snap, snap.generatedAt);
    assert.match(html, /<span class="chip">run<\/span>/);
    assert.match(html, new RegExp(`run ${run.status}`));
    assert.match(html, /modelo <b>da sessão · mínimo fable<\/b> · \d+ chamadas?/);
    assert.match(html, /<div class="stat">ligado: [^<]+<\/div>/);
    assert.ok(!/ligado: [^<]*sess/.test(html), 'the Lead is the session itself: no "sessões"');
  });
  test('the stat line: "ligado: <tempo> · N sessões · <modelos>" per role, exact format, omitted without instances', () => {
    assert.equal(V.activeDur(12_000), '12s');
    assert.equal(V.activeDur(59_400), '59s');
    assert.equal(V.activeDur(4 * 60_000), '4 min');
    assert.equal(V.activeDur(59 * 60_000), '59 min');
    assert.equal(V.activeDur(72 * 60_000), '1 h 12 min');
    assert.equal(V.activeDur(3_600_000), '1 h 00 min');
    assert.equal(V.statLine({ key: 'backend-dev', activeMs: 72 * 60_000, sessions: 3 }), 'ligado: 1 h 12 min · 3 sessões', 'no models → no model part');
    assert.equal(V.statLine({ key: 'backend-dev', activeMs: 72 * 60_000, sessions: 3, models: { 'claude-sonnet-5': 22 * 60_000, 'claude-opus-5': 50 * 60_000 } }), 'ligado: 1 h 12 min · 3 sessões · opus 50 min, sonnet 22 min', 'two models: short names with time, longest first');
    assert.equal(V.statLine({ key: 'qa', activeMs: 40_000, sessions: 1, models: { 'claude-fable-5-1': 40_000 } }), 'ligado: 40s · 1 sessão · fable', 'one model: just its name');
    assert.equal(V.statLine({ key: 'qa', activeMs: 40_000, sessions: 1, models: { desconhecido: 40_000 } }), 'ligado: 40s · 1 sessão', '"desconhecido" is omitted');
    assert.equal(V.statLine({ key: 'qa', activeMs: 90_000, sessions: 2, models: { desconhecido: 40_000, 'claude-opus-5[1m]': 50_000 } }), 'ligado: 1 min · 2 sessões · opus', 'the context variant of an id falls in the same family (and 90 s floors to 1 min)');
    assert.equal(V.shortModel('claude-opus-5[1m]'), 'opus');
    assert.equal(V.shortModel('claude-sonnet-5-20260514'), 'sonnet');
    assert.equal(V.shortModel('claude-fable-5-1'), 'fable');
    assert.equal(V.shortModel('claude-haiku-4-5'), 'haiku');
    assert.equal(V.shortModel('gpt-qualquer-coisa'), 'gpt-qualquer-coisa', 'another family is shown raw');
    assert.equal(V.statLine({ key: 'lead', activeMs: 5 * 60_000, sessions: 1, models: {} }), 'ligado: 5 min', 'the Lead without a known session model');
    assert.equal(V.statLine({ key: 'lead', activeMs: 5 * 60_000, sessions: 1, models: { 'claude-fable-5-1': 5 * 60_000 } }), 'ligado: 5 min · fable');
    assert.equal(V.statLine({ key: 'qa', activeMs: 0, sessions: 0 }), '');
    assert.equal(V.modelsText({ 'claude-opus-5': 1, 'claude-sonnet-5': 3_600_000 }), 'sonnet 1 h 00 min, opus 0s');
    const bd = run.roster[3]; // Backend Dev has one running instance in happy-path: requested "fable", not resolved yet
    assert.equal(bd.sessions, 1);
    assert.deepEqual(Object.keys(bd.models), ['fable']);
    assert.equal(V.shortModel('fable'), 'fable', 'a requested alias passes through as-is');
    assert.match(V.renderCard(bd, run, snap, snap.generatedAt), /<div class="stat">ligado: \d+(s| min) · 1 sessão · fable<\/div>/);
  });
  test('the Sponsor queue: open question → light ticket with a labelled field and "Enviar"; pending → seal, disabled field, not counted', () => {
    const q = run.queue[0];
    assert.equal(q.id, 'Q1');
    const open = V.renderQueue({ ...run, queue: [{ ...q, status: 'open' }] }, snap.generatedAt);
    assert.match(open, /<label for="ans-Q1">Resposta<\/label><textarea id="ans-Q1"/);
    assert.match(open, /<button class="btn" type="submit" >Enviar<\/button>/);
    assert.match(open, /Se não responder:<\/b> não publicar; fica só no repo/);
    assert.match(open, /pedido por Product Manager/);
    assert.equal(V.sponsorCount({ ...run, queue: [{ ...q, status: 'open' }] }), 1);
    const pending = V.renderQueue({ ...run, queue: [{ ...q, status: 'pending', answer: 'não' }] }, snap.generatedAt);
    assert.match(pending, /resposta enviada · à espera do Lead/);
    assert.match(pending, /<textarea id="ans-Q1" disabled>não<\/textarea>/);
    assert.equal(V.sponsorCount({ ...run, queue: [{ ...q, status: 'pending', answer: 'não' }] }), 0);
    const answered = V.renderQueue({ ...run, queue: [{ ...q, status: 'answered' }] }, snap.generatedAt);
    assert.match(answered, /Nada pendente para o Sponsor/);
    const failed = V.renderQueue({ ...run, queue: [{ ...q, status: 'open' }] }, snap.generatedAt, { errors: new Map([[V.answerKey(run.project, 'Q1'), 'não foi possível enviar — tenta outra vez']]) });
    assert.match(failed, /não foi possível enviar — tenta outra vez/);
    // O erro pertence a um par projeto+pergunta: a mesma `Q1` noutro projeto não o herda.
    const other = V.renderQueue({ ...run, project: 'outro-projeto', queue: [{ ...q, status: 'open' }] }, snap.generatedAt, { errors: new Map([[V.answerKey(run.project, 'Q1'), 'não foi possível enviar — tenta outra vez']]) });
    assert.ok(!other.includes('não foi possível enviar'), 'o erro não passa para a Q1 do outro projeto');
  });
  // T-UI-6: a fila re-renderizava por inteiro a cada poll de 5 s (o "há X s"
  // do bilhete muda), o que arrancava o textarea de resposta a meio de uma
  // frase — perde-se o foco e o teclado do telemóvel fecha (bug real do
  // Sponsor no `/m`). `applyQueuePatch` mantém um nó por bilhete e só
  // reconstrói o formulário quando ele muda de forma; sem DOM real disponível
  // (Node não traz um, o projeto fica a zero dependências), os testes usam o
  // FakeDocument de `test/helpers/fake-dom.mjs`.
  describe('queue reconciliation keeps focus while typing (T-UI-6)', () => {
    const freshState = () => ({ sent: new Map(), sending: new Set(), errors: new Map(), queueNodes: new Map(), queueForm: new Map(), queueEmptyShown: false, queueRun: null });
    // A chave de um bilhete é sempre `q:<run>:<id>` (tentativa 2: sem o run, o
    // nó da `Q1` do run anterior era reaproveitado ao trocar de run).
    const kq = (r, id = 'Q1') => `q:${r.id}:${id}`;
    test('a new snapshot while the Q1 textarea has focus and unsent text "abc" keeps the same node, the value and the focus', () => {
      const doc = new FakeDocument();
      const container = doc.createElement('div');
      const q = run.queue[0];
      const S = freshState();
      const runA = { ...run, queue: [{ ...q, status: 'open' }] };
      V.applyQueuePatch(container, doc, runA, snap.generatedAt, S);
      const node = S.queueNodes.get(kq(runA));
      const ta = node.querySelector('textarea[data-q]');
      ta.value = 'abc';
      ta.focus();
      // novo snapshot: só o tempo avançou, como a cada poll de 5 s
      V.applyQueuePatch(container, doc, runA, snap.generatedAt + 5000, S);
      assert.equal(S.queueNodes.get(kq(runA)), node, 'mesmo nó do bilhete');
      assert.equal(node.querySelector('textarea[data-q]'), ta, 'mesmo nó do textarea — nunca recriado');
      assert.equal(ta.value, 'abc', 'o texto escrito não se perde');
      assert.equal(doc.activeElement, ta, 'o foco (e por isso o teclado do telemóvel) não se perde');
    });
    test('a sent answer clears the field: the form is rebuilt into the disabled, sealed state', () => {
      const doc = new FakeDocument();
      const container = doc.createElement('div');
      const q = run.queue[0];
      const S = freshState();
      const runA = { ...run, queue: [{ ...q, status: 'open' }] };
      V.applyQueuePatch(container, doc, runA, snap.generatedAt, S);
      const ta = S.queueNodes.get(kq(runA)).querySelector('textarea[data-q]');
      ta.value = 'sim';
      S.sent.set(V.answerKey(run.project, 'Q1'), 'sim'); // o que o handler de submit faz ao ter sucesso
      V.applyQueuePatch(container, doc, { ...run, queue: [{ ...q, status: 'pending', answer: 'sim' }] }, snap.generatedAt + 1000, S);
      const formEl = S.queueNodes.get(kq(runA)).querySelector('.t-form');
      assert.match(formEl.innerHTML, /resposta enviada · à espera do Lead/);
      assert.match(formEl.innerHTML, /<textarea id="ans-Q1" disabled>sim<\/textarea>/);
      assert.ok(!formEl.innerHTML.includes('<form'), 'o formulário editável desaparece — o campo fica limpo/selado');
    });
    test('a question that closes elsewhere disappears without breaking another one\'s focus', () => {
      const doc = new FakeDocument();
      const container = doc.createElement('div');
      const q = run.queue[0];
      const q2 = { ...q, id: 'Q2', question: 'Outra pergunta?', ts: q.ts + 1000 };
      const S = freshState();
      const runA = { ...run, queue: [{ ...q, status: 'open' }, { ...q2, status: 'open' }] };
      V.applyQueuePatch(container, doc, runA, snap.generatedAt, S);
      const node1 = S.queueNodes.get(kq(runA));
      const ta1 = node1.querySelector('textarea[data-q]');
      ta1.value = 'abc'; ta1.focus();
      assert.equal(S.queueNodes.size, 2);
      // Q2 é respondida ou expira noutro sítio e sai do instantâneo seguinte
      V.applyQueuePatch(container, doc, { ...run, queue: [{ ...q, status: 'open' }] }, snap.generatedAt + 3000, S);
      assert.equal(S.queueNodes.size, 1, 'Q2 desapareceu');
      assert.ok(!S.queueNodes.has(kq(runA, 'Q2')));
      assert.equal(S.queueNodes.get(kq(runA)), node1, 'Q1 continua o mesmo nó');
      assert.equal(node1.querySelector('textarea[data-q]'), ta1);
      assert.equal(ta1.value, 'abc');
      assert.equal(doc.activeElement, ta1, 'o foco de Q1 não é afetado por Q2 desaparecer');
    });
    // O bloqueador da tentativa 1: com dois runs vivos, ambos com uma `Q1`
    // aberta (caso real de hoje), a chave era só `q:Q1` — trocar de run no
    // seletor reaproveitava o nó do bilhete do run anterior e o `<form
    // data-project>` ficava com o projeto antigo; a resposta era gravada no
    // projeto errado (`data/answers/<projeto errado>.jsonl`).
    describe('two live runs, both with Q1 open (T-UI-6 attempt 2)', () => {
      const twoRuns = () => {
        const q = run.queue[0];
        return [
          { ...run, id: 'run-aaaa-0001', project: 'projeto-a', queue: [{ ...q, status: 'open' }] },
          { ...run, id: 'run-bbbb-0002', project: 'projeto-b', queue: [{ ...q, status: 'open', question: 'Publicar o projeto B?' }] },
        ];
      };
      test('switching run rebuilds the queue: the form carries the new run\'s project, and that is what the POST /answers body uses', () => {
        const doc = new FakeDocument();
        const container = doc.createElement('div');
        const [runA, runB] = twoRuns();
        const S = freshState();
        V.applyQueuePatch(container, doc, runA, snap.generatedAt, S);
        const nodeA = S.queueNodes.get('q:run-aaaa-0001:Q1');
        assert.ok(nodeA, 'a chave do bilhete inclui o run');
        assert.equal(container.children.length, 1);
        assert.equal(container.querySelector('form[data-action="answer"]').dataset.project, 'projeto-a');
        // o Sponsor escreve em A e troca de run antes de enviar
        const taA = nodeA.querySelector('textarea[data-q]');
        taA.value = 'sim, publica A'; taA.focus();
        V.applyQueuePatch(container, doc, runB, snap.generatedAt + 5000, S);
        assert.equal(container.children.length, 1, 'só o bilhete do run selecionado fica no ecrã');
        assert.equal(S.queueNodes.size, 1);
        assert.ok(!S.queueNodes.has('q:run-aaaa-0001:Q1'), 'o nó do run anterior não sobrevive à troca');
        const nodeB = S.queueNodes.get('q:run-bbbb-0002:Q1');
        assert.notEqual(nodeB, nodeA, 'bilhete novo, não o de A reaproveitado');
        assert.match(nodeB.querySelector('.t-head').textContent, /Publicar o projeto B\?/);
        const formB = container.querySelector('form[data-action="answer"]');
        assert.equal(formB.dataset.project, 'projeto-b', 'o data-project é o do run selecionado agora');
        assert.equal(formB.querySelector('textarea[data-q]').value, '', 'o texto escrito em A não aparece no bilhete de B');
        // o corpo do POST sai do formulário no ecrã: é o que o handler de submit usa
        formB.querySelector('textarea[name="answer"]').value = ' não publicar ';
        assert.deepEqual(V.answerSubmission(formB), { project: 'projeto-b', id: 'Q1', answer: 'não publicar', key: V.answerKey('projeto-b', 'Q1') });
        // e voltar a A traz o bilhete de A, com o projeto de A
        V.applyQueuePatch(container, doc, runA, snap.generatedAt + 10000, S);
        assert.equal(container.querySelector('form[data-action="answer"]').dataset.project, 'projeto-a');
      });
      test('an answer sent in one project never seals the Q1 of the other', () => {
        const doc = new FakeDocument();
        const container = doc.createElement('div');
        const [runA, runB] = twoRuns();
        const S = freshState();
        S.sent.set(V.answerKey('projeto-a', 'Q1'), 'sim, publica A'); // envio com sucesso em A
        V.applyQueuePatch(container, doc, runA, snap.generatedAt, S);
        assert.match(container.querySelector('.t-form').textContent, /resposta enviada · à espera do Lead/);
        V.applyQueuePatch(container, doc, runB, snap.generatedAt + 1000, S);
        const formB = container.querySelector('form[data-action="answer"]');
        assert.ok(formB, 'a Q1 de B continua por responder, com o campo ativo');
        assert.equal(formB.dataset.project, 'projeto-b');
        assert.equal(V.ticketPending({ id: 'Q1', status: 'open' }, { sent: S.sent, project: 'projeto-b' }), false);
        assert.equal(V.ticketPending({ id: 'Q1', status: 'open' }, { sent: S.sent, project: 'projeto-a' }), true);
      });
    });
    test('two identical pending permissions (same member, same instant) are two tickets, not one', () => {
      const doc = new FakeDocument();
      const container = doc.createElement('div');
      const at = snap.generatedAt - 30000;
      const perm = { tool: 'Bash', message: 'apagar a pasta build', since: at };
      const permRun = {
        id: 'run-perm', project: 'projeto-p', queue: [], main: {},
        roster: [{ key: 'lead', name: 'Lead', state: 'a trabalhar', instances: [] },
          { key: 'backend-dev', name: 'Backend Dev', state: 'a trabalhar', instances: [{ task: 'T2', permission: perm }, { task: 'T2', permission: { ...perm } }] }],
      };
      const S = freshState();
      V.applyQueuePatch(container, doc, permRun, snap.generatedAt, S);
      assert.equal(V.sponsorItems(permRun).length, 2);
      assert.equal(container.children.length, 2, 'dois pedidos com tipo+quem+desde iguais não colidem na mesma chave');
      assert.equal(S.queueNodes.size, 2);
      assert.deepEqual([...S.queueNodes.keys()], ['x:run-perm:permissão:Backend Dev:' + at, 'x:run-perm:permissão:Backend Dev:' + at + '#1']);
      // e mantêm-se os mesmos nós no poll seguinte
      const nodes = [...container.children];
      V.applyQueuePatch(container, doc, permRun, snap.generatedAt + 5000, S);
      assert.deepEqual([...container.children], nodes);
    });
    test('a ticket with no form ("só se resolve no terminal do X") rewrites its block when the text changes', () => {
      const doc = new FakeDocument();
      const container = doc.createElement('div');
      const at = snap.generatedAt - 30000;
      const base = {
        id: 'run-perm', project: 'projeto-p', queue: [], main: {},
        roster: [{ key: 'lead', name: 'Lead', state: 'a trabalhar', instances: [] },
          { key: 'backend-dev', name: 'Backend Dev', state: 'a trabalhar', instances: [{ task: 'T2', permission: { tool: 'Bash', message: 'apagar a pasta build', since: at } }] }],
      };
      const S = freshState();
      V.applyQueuePatch(container, doc, base, snap.generatedAt, S);
      const node = container.children[0];
      assert.equal(node.querySelector('.t-form').textContent, 'só se resolve no terminal do Lead');
      const renamed = { ...base, roster: [{ ...base.roster[0], name: 'Lead 2' }, base.roster[1]] };
      V.applyQueuePatch(container, doc, renamed, snap.generatedAt + 5000, S);
      assert.equal(container.children[0], node, 'o bilhete é o mesmo nó');
      assert.equal(node.querySelector('.t-form').textContent, 'só se resolve no terminal do Lead 2');
    });
  });
  test('Novo run: a "projects" tick while idle (the 5 s poll) never clears the goal already typed', () => {
    const projects = [{ name: 'demo', path: '/x', run: null, runnerAlive: false }];
    let state = V.newRunReducer(V.newRunInit(), { type: 'select', project: 'demo' });
    state = V.newRunReducer(state, { type: 'goal', goal: 'Construir X e verificar Y, em três frases.' });
    const polled = V.newRunReducer(state, { type: 'projects', projects });
    assert.equal(polled.goal, state.goal, 'o objetivo escrito sobrevive ao poll de /projects');
    assert.equal(polled.project, 'demo');
  });
  test('legacy owner/by names (fundidor, contraste…) resolve to the roster names from the snapshot', () => {
    assert.equal(V.memberName(run, 'fundidor'), 'Backend Dev');
    assert.equal(V.memberName(run, 'contraste'), 'Reviewer');
    assert.equal(V.memberName(run, 'bigorna'), 'Product Manager');
    assert.equal(V.memberName(run, 'security-reviewer'), 'Security Reviewer');
    assert.equal(V.memberName(run, 'someone-else'), 'someone-else');
    assert.match(V.renderTasks(run), /Backend Dev · tentativas/);
    assert.match(V.renderReviews(run), /por Reviewer/);
  });
  test('every snapshot string is escaped, including task titles and verdict text', () => {
    const evil = '<script>alert(1)</script>"';
    const r2 = { ...run, goal: evil, tasks: [{ id: 'T9', title: evil, owner: 'x', status: 'doing', attempts: 1, verdicts: [] }], reviews: [{ ts: 1, taskId: 'T9', verdict: 'REJECT', text: evil, by: 'contraste' }], timeline: [{ ts: 1, kind: 'ask', text: evil }], decisions: [{ ts: 1, id: 'D9', text: evil }] };
    for (const html of [V.renderHeader(r2, snap, 1, 'desktop'), V.renderTasks(r2), V.renderReviews(r2), V.renderDecisions(r2), V.renderHud({ ...r2, roster: r2.roster.map(c => ({ ...c, detail: evil, instances: c.instances.map(i => ({ ...i, task: evil, detail: evil })) })) }, snap, 1), V.renderRows({ ...r2, roster: r2.roster.map(c => ({ ...c, name: evil, role: evil })) }, snap, 1)]) {
      assert.ok(!html.includes('<script>'), 'no raw <script>');
      assert.ok(html.includes('&lt;script&gt;'), 'escaped');
    }
  });
  test('task ids with hyphens (this repo\'s own runs) get the chip and the title; a bare letter is a kind, not an id', () => {
    assert.deepEqual(V.splitTask('T-UI-2 · Lapidador: construir o viewer'), { id: 'T-UI-2', title: 'construir o viewer' });
    assert.deepEqual(V.splitTask('T-OPS-1 · Fundidor: forja up'), { id: 'T-OPS-1', title: 'forja up' });
    assert.deepEqual(V.splitTask('T2 · Frontend Dev: Cena com dez estações'), { id: 'T2', title: 'Cena com dez estações' });
    assert.deepEqual(V.splitTask('D1 · Contraste: review da decisão'), { id: 'D1', title: 'review da decisão' });
    assert.deepEqual(V.splitTask('Q3 · Bigorna: pergunta'), { id: 'Q3', title: 'pergunta' });
    assert.deepEqual(V.splitTask('T12 · Fundidor: x'), { id: 'T12', title: 'x' });
    assert.deepEqual(V.splitTask('Q · Bigorna: paginação ou scroll infinito'), { id: null, title: 'paginação ou scroll infinito' });
    assert.deepEqual(V.splitTask('sem formato'), { id: null, title: 'sem formato' });
    const inst = { ...run.roster[3].instances[0], task: 'T-UI-2 · Lapidador: construir o viewer', taskId: null };
    const html = V.renderCard({ ...run.roster[3], instances: [inst] }, run, snap, snap.generatedAt);
    assert.match(html, /<span class="chip">T-UI-2<\/span><span class="title" title="[^"]*">construir o viewer<\/span>/);
  });
  test('times and elapsed are Portuguese and HH:MM:SS local; "terminou (inferido)" when inferred', () => {
    assert.equal(V.dur(12_000), '12 s');
    assert.equal(V.dur(4 * 60_000), '4 min');
    assert.equal(V.dur(100_000, true), '1 min 40 s');
    assert.equal(V.dur(72 * 60_000), '1 h 12 min');
    assert.equal(V.ago(1_000_000, 760_000), 'há 4 min');
    assert.match(V.clock(Date.now()), /^\d{2}:\d{2}:\d{2}$/);
    assert.match(V.hm(Date.now()), /^\d{2}:\d{2}$/);
    const inst = { ...run.roster[3].instances[0], state: 'terminado', inferred: true };
    assert.match(V.renderCard({ ...run.roster[3], instances: [inst] }, run, snap, snap.generatedAt), /terminou \(inferido\)/);
  });
  test('the forjalvl (run.forja.forjalvl) shows right next to the floor, in the same item so the pair never wraps, in Portuguese', () => {
    assert.equal(run.forja.forjalvl, 'high', 'happy-path run.start carries no forjalvl: the reducer defaults it to "high"');
    const desk = V.renderHeader(run, snap, snap.generatedAt, 'desktop');
    assert.match(desk, /<span>piso <b>fable<\/b> · <span class="nowrap">forjalvl <b>alto<\/b><\/span><\/span>/, 'same meta item as the floor, no colon (coherent with "piso fable" / "permissões auto")');
    const phone = V.renderHeader(run, snap, snap.generatedAt, 'mobile');
    assert.match(phone, /eventos · <span class="nowrap">forjalvl <b>alto<\/b><\/span>/, 'same meta line as the phone header, wrapped so label and value never split');
    assert.equal(V.levelLabel('max'), 'máximo'); assert.equal(V.levelLabel('high'), 'alto'); assert.equal(V.levelLabel('eco'), 'económico');
    // "constructor" and friends must never resolve through the prototype chain to a function
    assert.equal(V.levelLabel('constructor'), 'constructor');
    assert.equal(V.levelLabel('toString'), 'toString');
    // A snapshot from a reducer older than the rename only carries `modelLevel`.
    const legacy = V.renderHeader({ ...run, forja: { ...run.forja, forjalvl: undefined, modelLevel: 'eco' } }, snap, snap.generatedAt, 'desktop');
    assert.match(legacy, /forjalvl <b>económico<\/b>/, 'modelLevel is still read as the alias');
    const weird = V.renderHeader({ ...run, forja: { ...run.forja, forjalvl: '<script>x</script>' } }, snap, snap.generatedAt, 'desktop');
    assert.ok(!weird.includes('<script>') && weird.includes('&lt;script&gt;'), 'an unknown forjalvl is shown raw, escaped');
  });
  test('a big run renders fast: 450 instances + 120 timeline entries, whole page as strings', () => {
    const inst = run.roster[3].instances[0];
    const many = { ...run, roster: run.roster.map((c, i) => i === 0 ? c : ({ ...c, instances: Array.from({ length: 50 }, (_, k) => ({ ...inst, key: `${c.key}-${k}`, task: `T${k} · ${c.name}: tarefa ${k}`, taskId: `T${k}` })) })),
      timeline: Array.from({ length: 120 }, (_, k) => ({ ts: snap.generatedAt - k * 1000, kind: 'task.start', text: `entrada ${k}` })) };
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) { V.renderHud(many, snap, snap.generatedAt); V.renderScene(many, snap); V.renderQueue(many, snap.generatedAt); V.renderTasks(many); V.renderReviews(many); V.renderRows(many, snap, snap.generatedAt); }
    const ms = (performance.now() - t0) / 10;
    assert.ok(ms < 80, `render strings in ${ms.toFixed(1)} ms (< 80 ms)`);
    const html = V.renderHud(many, snap, snap.generatedAt);
    assert.equal(count(html, /class="inst /g), 451, 'every instance is a block, never a count (9 × 50 + the run block)');
  });
});

describe('the ten roles, the pause and the new verdicts (all-roles fixture through the reducer)', () => {
  let V; let R; const lines = readFileSync(join(here, 'fixtures', 'all-roles.jsonl'), 'utf8').split('\n');
  const live = { now: BASE + 1616_000, snap: null, run: null };   // events up to 1596 s: every role alive
  const paused = { now: BASE + 1630_000, snap: null, run: null }; // the whole stream: run.pause at 1610 s
  before(async () => {
    V = await import(pathToFileURL(join(here, '..', 'viewer', 'assets', 'viewer.js')).href);
    R = await import(pathToFileURL(join(here, '..', 'viewer', 'lib', 'state.mjs')).href);
    const cut = lines.filter(l => { try { return Date.parse(JSON.parse(l).ts) <= BASE + 1596_000; } catch { return false; } });
    live.snap = R.reduceLines(cut, live.now); live.run = live.snap.runs[0];
    paused.snap = R.reduceLines(lines, paused.now); paused.run = paused.snap.runs[0];
  });
  test('every role has an instance, states differ, the HUD prints them all and the label sits on the five on-demand cards', () => {
    const { run, snap, now } = live;
    assert.deepEqual(run.roster.map(c => c.key), KEYS);
    assert.deepEqual(run.roster.map(c => c.core), [true, true, true, true, true, false, false, false, false, false]);
    const byKey = Object.fromEntries(run.roster.map(c => [c.key, c]));
    assert.equal(byKey.lead.state, 'a trabalhar');
    assert.equal(byKey['backend-dev'].state, 'a trabalhar');
    assert.equal(byKey.reviewer.state, 'a trabalhar');
    assert.equal(byKey['frontend-dev'].state, 'à espera de review');
    assert.equal(byKey['product-designer'].state, 'sem resposta');
    for (const k of ['architect', 'product-manager', 'technology-scout', 'qa', 'security-reviewer']) assert.equal(byKey[k].state, 'terminado', k);
    const html = V.renderHud(run, snap, now);
    assert.equal(count(html, /<article class="card /g), 10);
    for (const c of run.roster) assert.ok(html.includes(`<div class="word">${c.state}</div>`), c.key);
    assert.equal(count(html, /<em class="tag">a pedido<\/em>/g), 5);
    assert.ok(!html.includes('ainda não foi'), 'no idle text: all ten were called');
    assert.match(html, /<div class="stat">ligado: \d+ min · 2 sessões · fable<\/div>/, 'Backend Dev ran twice, on fable');
    assert.match(html, /<div class="stat">ligado: \d+ min · 2 sessões · opus<\/div>/, 'Reviewer: claude-opus-5[1m] is the opus family');
    assert.match(html, /<div class="stat">ligado: 2\d min<\/div>/, 'the Lead: run duration, no session count');
    assert.equal(count(html, /<div class="stat">ligado: /g), 10, 'every card has its stat line');
  });
  test('hand-backs QA FAIL / FRAME / PLAN / DONE S<n> are shown as-is on the instance, with the good/bad grade', () => {
    const { run, snap, now } = live;
    const html = V.renderHud(run, snap, now);
    assert.match(html, /<div class="detail v-bad">QA FAIL — 2 findings: o selo do run não muda em pausa; estatística sem sessões<\/div>/);
    assert.match(html, /<div class="detail v-good">FRAME — 1 decisão, 1 pergunta para o Sponsor<\/div>/);
    assert.match(html, /<div class="detail v-good">PLAN — 4 tasks, 0 replaneadas<\/div>/);
    assert.match(html, /<div class="detail v-good">DONE S1 — sem biblioteca: SVG inline \+ CSS da plataforma<\/div>/);
    assert.match(html, /<div class="detail v-bad">SECURITY-REJECT — o token do viewer aparece em claro num log de erro<\/div>/);
    assert.match(html, /<span class="chip wait">à espera do Reviewer<\/span>/, 'T2 delivered, in review');
    assert.equal(V.gradeOf('QA PASS — tudo verde'), 'good');
    assert.equal(V.gradeOf('BLOCKED T3 — falta decisão'), 'bad');
    assert.equal(V.gradeOf('relatório'), '');
  });
  test('the reviews ledger shows SECURITY-REJECT (same red as REJECT, credited to the Security Reviewer) ', () => {
    const { run } = live;
    const rev = V.renderReviews(run);
    assert.match(rev, /<span class="v SECURITY-REJECT g-bad">SECURITY-REJECT<\/span><span class="x"><b>T1<\/b> · o token do viewer aparece em claro num log de erro<small>por Security Reviewer/);
    assert.match(rev, /<span class="v APPROVE g-good">APPROVE<\/span><span class="x"><b>T1<\/b> · critérios cumpridos, 28 testes verdes<small>por Reviewer/);
    assert.match(V.renderReviews({ ...run, reviews: [{ ts: 1, taskId: 'T5', verdict: 'SECURITY-APPROVE', text: 'SECURITY-APPROVE — sem segredos', by: 'contraste' }] }), /<span class="v SECURITY-APPROVE g-good">SECURITY-APPROVE<\/span><span class="x"><b>T5<\/b> · sem segredos<small>por Security Reviewer/);
    assert.match(V.renderTasks(run), /<b>T1<\/b><span>Redutor: dez papéis e pausa<small>Backend Dev · tentativas 2 · último veredicto REJECT/);
  });
  // Contagem de elementos SVG (orçamento de 300, TECHNOLOGY.md S1).
  const els = h => count(h, /<(rect|ellipse|circle|line|polygon|polyline|path|text|g|filter|radialGradient|linearGradient|stop|defs|svg)\b/g);
  // Todos os pontos desenhados de cada aresta (a quadrática já recortada) e os
  // dois papéis que ela liga (os nós mais próximos das duas pontas).
  const edgePoints = (svg, G = V.NODES) => [...svg.matchAll(/<path class="edge (hub|flow)" d="M ([-\d.]+) ([-\d.]+) Q ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/g)].map(m => {
    const [x0, y0, cx, cy, x1, y1] = m.slice(2).map(Number);
    const pts = [];
    for (let t = 0; t <= 1.0001; t += .004) pts.push([(1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * x1, (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * y1]);
    const nearest = ([x, y]) => Object.entries(G).map(([k, g]) => [k, Math.hypot(x - g.x, y - g.y)]).sort((p, q) => p[1] - q[1])[0][0];
    return { kind: m[1], pts, a: nearest(pts[0]), b: nearest(pts[pts.length - 1]) };
  });
  test('the scene is the constellation graph: ten nodes on the DESIGN geometry, a monogram and a state glyph on each, and no edge over a node', () => {
    const { run, snap } = live;
    const svg = V.renderScene(run, snap);
    // Geometria: as posições são as escritas no DESIGN («Cena: agentes ligados»), nunca um layout automático.
    assert.deepEqual(Object.keys(V.NODES), KEYS, 'os dez papéis, na ordem do redutor');
    assert.deepEqual(V.NODES.lead, { x: 720, y: 120, r: 36 }, 'o Lead ao centro e o maior');
    assert.deepEqual([V.NODES.architect, V.NODES['frontend-dev'], V.NODES['backend-dev'], V.NODES.reviewer],
      [{ x: 438, y: 120, r: 25 }, { x: 720, y: 42, r: 25 }, { x: 720, y: 198, r: 25 }, { x: 1002, y: 120, r: 25 }],
      'losango pela ordem do fluxo: Architect à esquerda, Frontend Dev em cima, Backend Dev em baixo, Reviewer à direita');
    for (const k of KEYS.slice(5)) assert.equal(V.NODES[k].r, 18, `${k}: órbita de fora, mais pequeno`);
    assert.match(svg, /^<svg class="scene" viewBox="0 0 1440 240" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Ligações do elenco\. /);
    // O aria-label enumera os dez papéis e o estado de cada um, por palavras.
    const label = svg.match(/aria-label="([^"]*)"/)[1];
    for (const c of run.roster) assert.ok(label.includes(`${c.name}: ${c.state}`), `${c.key} no aria-label`);
    // Dez nós: identidade pela classe e pelo monograma, núcleo/a pedido pela forma do contorno e pelo tamanho.
    assert.equal(count(svg, /<g class="node /g), 10);
    for (const m of MONOS) assert.ok(svg.includes(`>${m}</text>`), `monograma ${m}`);
    assert.equal(count(svg, /<text class="mg lead"/g), 1, 'o Lead leva o monograma grande');
    assert.equal(count(svg, /<text class="mg sm"/g), 5, 'os cinco a pedido levam o monograma pequeno');
    assert.equal(count(svg, /class="ring demand"/g), 5, 'a pedido: contorno tracejado');
    assert.equal(count(svg, /class="node [^"]*demand/g), 5);
    assert.ok(!/>(Lead|Architect|Reviewer|a trabalhar|terminado)</.test(svg), 'nada de nomes, papéis ou palavras de estado dentro da cena');
    // Estado: classe de tom por nó e glifo por estado (a cor nunca anda sozinha).
    assert.match(svg, /<g class="node m-lead t-work live">/);
    assert.match(svg, /<g class="node m-frontend-dev t-wait">/);
    assert.match(svg, /<g class="node m-product-designer t-lost demand">/);
    assert.match(svg, /<g class="node m-qa t-done demand">/);
    assert.equal(count(svg, /class="node [^"]* live"/g), 3, 'Lead, Backend Dev e Reviewer trabalham com sinal recente');
    const look = k => V.nodeLook(run.roster.find(c => c.key === k), run, snap);
    assert.deepEqual(['lead', 'backend-dev', 'frontend-dev', 'product-designer', 'qa'].map(k => look(k).glyph), ['dot', 'dot', 'bar', 'ring', 'tick']);
    assert.deepEqual(['lead', 'frontend-dev', 'qa'].map(k => look(k).glow), [1, .35, 0], 'halo por estado, igual no núcleo e na órbita de fora');
    const card = k => run.roster.find(c => c.key === k);
    assert.equal(V.nodeLook({ ...card('qa'), state: 'a trabalhar', quiet: 60_000 }, run, snap).glyph, 'ring-dash', 'a trabalhar em silêncio: anel tracejado, sem pulso');
    assert.equal(V.nodeLook({ ...card('qa'), state: 'bloqueado' }, run, snap).glyph, 'bang');
    assert.equal(V.nodeLook({ ...card('qa'), state: 'precisa do Sponsor' }, run, snap).glowCol, 'var(--alarm)', 'quem precisa de um humano rouba a cor de identidade ao halo');
    assert.equal(V.nodeLook({ ...card('qa'), state: 'morto' }, run, snap).glyph, 'cross');
    assert.equal(V.nodeLook({ ...card('qa'), state: 'falhou' }, run, snap).glyph, 'cross-small');
    assert.equal(V.nodeLook({ ...card('qa'), state: 'inativo' }, run, snap).glyph, 'none', 'inativo: sem glifo, nó a 45 %');
    assert.equal(V.nodeLook({ ...card('qa'), state: 'inativo' }, run, snap).body, .45);
    assert.equal(count(svg, /<circle r="11.5" fill="var\(--bg\)" stroke="var\(--line\)"\/>/g), 5, 'medalha do glifo nos cinco de núcleo');
    assert.equal(count(svg, /<circle r="10" fill="var\(--bg\)" stroke="var\(--line\)"\/>/g), 5, 'medalha mais pequena nos cinco a pedido (todos com estado neste instantâneo)');
    const idle = { ...run, roster: run.roster.map(c => c.key === 'qa' ? { ...c, state: 'inativo' } : c) };
    assert.equal(count(V.renderScene(idle, snap), /<circle r="10" fill="var\(--bg\)"/g), 4, 'um papel inativo não leva medalha nenhuma');
    // Instâncias em curso: até três pontos na coroa, nunca um algarismo.
    const three = { ...run, roster: run.roster.map(c => c.key === 'qa' ? { ...c, instances: Array.from({ length: 5 }, () => ({ state: 'a trabalhar', endedAt: null })) } : c) };
    assert.equal(V.openInstances(three.roster.find(c => c.key === 'qa')), 5);
    const qaNode = h => h.match(/<g class="node m-qa[^]*?<\/g>\s*<\/g>/)[0];
    assert.equal(count(qaNode(V.renderScene(three, snap)), /class="notch"/g), 3, 'quatro ou mais instâncias continuam três pontos');
    assert.ok(!/[0-9]<\/text>/.test(V.renderScene(three, snap)), 'nunca um algarismo dentro da cena');
    // NENHUMA aresta entra num nó de terceiros (DESIGN §Geometria, invariante):
    // o afastamento ao centro é sempre maior do que o raio, para todas as
    // dezanove contra todos os dez nós. Um limiar mais frouxo deixava passar a
    // Lead→Product Manager, que com o `bow` do mock entrava 7,7 px no Architect.
    const edges = edgePoints(svg);
    assert.equal(edges.length, 19);
    assert.ok(svg.lastIndexOf('<path class="edge') < svg.indexOf('<g class="node '), 'as arestas vêm todas antes dos nós');
    let tightest = { near: Infinity };
    for (const e of edges) for (const [k, g] of Object.entries(V.NODES)) {
      if (e.a === k || e.b === k) continue;   // os dois extremos: a curva já é recortada no raio
      const near = Math.min(...e.pts.map(([x, y]) => Math.hypot(x - g.x, y - g.y)));
      assert.ok(near > g.r, `a aresta ${e.a}→${e.b} passa a ${near.toFixed(1)} px do centro de ${k} (raio ${g.r}): entra no disco e lê-se através do nó`);
      if (near - g.r < tightest.near) tightest = { near: near - g.r, k, e: `${e.a}→${e.b}` };
    }
    assert.ok(tightest.near > 15, `folga mínima medida: ${tightest.near.toFixed(1)} px (${tightest.e} contra ${tightest.k})`);
    assert.ok(Math.abs(tightest.near - 17.6) < .5, `a aresta mais apertada é lead→qa contra o Reviewer, a 17,6 px do disco: ${tightest.e} a ${tightest.near.toFixed(1)} px de ${tightest.k}`);
    // O monograma é texto: a hierarquia apaga a mobília (anel, pontos), nunca o
    // texto — só `inativo` o apaga, porque é o que o DESIGN manda.
    const monoBits = h => h.split('<g class="node ').slice(1).map(chunk => {
      const [, key, tone] = chunk.match(/^m-([a-z-]+) t-([a-z]+)/);
      const before = chunk.slice(0, chunk.indexOf('<text class="mg'));
      const tag = chunk.slice(chunk.indexOf('<text class="mg')).match(/^<text[^>]*>/)[0];
      return { key, tone, depth: (before.match(/<g\b/g) || []).length - (before.match(/<\/g>/g) || []).length, op: Number((tag.match(/opacity="([\d.]+)"/) || [, 1])[1]) };
    });
    for (const b of monoBits(svg)) {
      assert.equal(b.depth, 0, `${b.key}: o monograma está dentro de um grupo aninhado (e apanha a opacidade dele)`);
      assert.equal(b.op, b.tone === 'idle' ? .45 : 1, `${b.key} (${b.tone}): opacidade do monograma`);
    }
    const dimmed = { ...run, roster: run.roster.map(c => ({ ...c, state: 'terminado' })) };
    assert.equal(count(V.renderScene(dimmed, snap), /<text class="mg[^>]*opacity=/g), 0, 'dez papéis terminados: nenhum monograma apagado');
    assert.equal(count(V.renderScene(dimmed, snap), /<g opacity="0.45">/g), 10, 'o anel e os pontos é que ficam a 45 %');
    const allIdle = { ...run, roster: run.roster.map(c => ({ ...c, state: 'inativo' })) };
    assert.equal(count(V.renderScene(allIdle, snap), /<text class="mg[^>]*opacity="0.45"/g), 10, 'inativo: o nó inteiro a 45 %, como o DESIGN manda');
    assert.ok(!svg.includes('<animate'), 'sem SMIL: o movimento é só CSS sobre opacity');
    assert.ok(!svg.includes('<filter'), 'sem filtros na cena nova');
    assert.equal(els(svg), 116, 'os mesmos 116 elementos medidos no mock (orçamento 300)');
  });
  test('the nineteen edges are fixed: nine solid calls from the Lead, ten dashed flow edges, and no state ever changes them', () => {
    const { run, snap } = live;
    const svg = V.renderScene(run, snap);
    assert.equal(V.SCENE_EDGES.length, 19);
    assert.deepEqual(V.SCENE_EDGES.filter(e => e.kind === 'hub').map(e => `${e.a}>${e.b}`), KEYS.slice(1).map(k => `lead>${k}`), 'o Lead chama cada um dos outros nove');
    assert.deepEqual(V.SCENE_EDGES.filter(e => e.kind === 'flow').map(e => `${e.a}>${e.b}`), [
      'architect>frontend-dev', 'architect>backend-dev', 'frontend-dev>reviewer', 'backend-dev>reviewer',
      'reviewer>security-reviewer', 'qa>lead', 'product-manager>architect', 'technology-scout>frontend-dev',
      'technology-scout>backend-dev', 'product-designer>frontend-dev'], 'as dez arestas de fluxo da tabela do DESIGN');
    assert.equal(count(svg, /<path class="edge hub"/g), 9);
    assert.equal(count(svg, /<path class="edge flow"/g), 10);
    const paths = h => h.match(/<path class="edge [^/]*\/>/g);
    const allStates = ['bloqueado', 'morto', 'terminado', 'a trabalhar', 'falhou', 'inativo', 'precisa do Sponsor', 'sem resposta', 'em pausa', 'à espera de review'];
    const other = { ...run, roster: run.roster.map((c, i) => ({ ...c, state: allStates[i] })) };
    assert.deepEqual(paths(V.renderScene(other, snap)), paths(svg), 'trocar todos os estados não mexe numa única aresta');
  });
  test('everything in the scene comes from the snapshot and is escaped', () => {
    const { run, snap } = live;
    const evil = { ...run, roster: run.roster.map(c => c.key === 'architect' ? { ...c, name: 'Ar "<script>x</script>"', state: 'a & b' } : c) };
    const svg = V.renderScene(evil, snap);
    assert.ok(!svg.includes('<script>'), 'nada de HTML vindo do instantâneo');
    assert.ok(svg.includes('Ar &quot;&lt;script&gt;x&lt;/script&gt;&quot;: a &amp; b'), 'o nome e o estado entram escapados no aria-label');
    // Um papel que o instantâneo não traga simplesmente não é desenhado (nem ele nem as suas arestas).
    const short = { ...run, roster: run.roster.filter(c => c.key !== 'qa') };
    const s2 = V.renderScene(short, snap);
    assert.equal(count(s2, /<g class="node /g), 9);
    assert.equal(count(s2, /<path class="edge /g), 17, 'caem as duas arestas do QA (lead>qa e qa>lead)');
    assert.equal(count(V.renderScene(V.emptyRun(), { generatedAt: Date.now() }), /<g class="node /g), 10, 'sem instantâneo nenhum, os dez nós inativos');
  });
  test('the hand-back flow only moves with evidence: three dots on the Lead edge while the hand-back is fresh', () => {
    const { run, snap } = live;
    const hb = ts => ({ ...run, roster: run.roster.map(c => c.key === 'reviewer'
      ? { ...c, instances: [{ ...(c.instances[0] || {}), handback: { ts, status: 'APPROVE', text: 'APPROVE — T1' } }] } : { ...c, instances: [] }) });
    const fresh = hb(snap.generatedAt - 5000);
    assert.deepEqual(V.freshHandbacks(fresh, snap), ['reviewer']);
    const svg = V.renderScene(fresh, snap);
    const dots = [...svg.matchAll(/<circle class="hb hb(\d)" cx="([\d.]+)" cy="([\d.]+)" r="4"/g)];
    assert.equal(dots.length, 3, 'três pontos, em cascata (os atrasos são CSS)');
    for (const d of dots) {
      const x = Number(d[2]), y = Number(d[3]);
      assert.ok(x > V.NODES.lead.x && x < V.NODES.reviewer.x, `o ponto ${x} está entre o Lead e o Reviewer`);
      assert.ok(Math.abs(y - 120) < 30, 'sobre a aresta lead>reviewer');
    }
    assert.deepEqual(V.freshHandbacks(hb(snap.generatedAt - V.HANDBACK_FRESH_MS - 1000), snap), [], 'fora da janela o fluxo some');
    assert.equal(count(V.renderScene(hb(snap.generatedAt - V.HANDBACK_FRESH_MS - 1000), snap), /class="hb /g), 0);
  });
  test('runner stopped or dead: the whole network goes cold, the legend says it in words and the nodes keep their own state', () => {
    const { run, snap } = live;
    assert.equal(V.sceneCold(run), false);
    assert.equal(V.sceneCold({ ...run, forja: { ...run.forja, runner: { exited: true, why: 'terminou' } } }), true, 'runner.exit registado');
    assert.equal(V.sceneCold({ ...run, status: 'morto' }), true);
    assert.equal(V.sceneCold({ ...run, status: 'sem resposta' }), true);
    assert.equal(V.sceneCold({ ...run, status: 'em pausa' }), false, 'em pausa o runner prometeu voltar');
    const cold = { ...run, status: 'morto' };
    const svg = V.renderScene(cold, snap);
    assert.match(svg, /^<svg class="scene cold"/, 'a opacidade das arestas é CSS: a cena inteira fica fria');
    assert.equal(count(svg, /<path class="edge /g), 19, 'as dezanove arestas continuam lá');
    assert.match(svg, /<g class="node m-lead t-work live">/, 'os nós mantêm o seu estado');
    assert.match(svg, /aria-label="[^"]*O runner parou: a rede está fria\."/);
    assert.equal(count(svg, /class="hb /g), 0, 'com a rede fria nada corre nas arestas');
    assert.ok(V.renderLegend(true).includes('linha cheia = o Lead chama · tracejado = fluxo de trabalho (representação) · runner parado: a rede está fria'));
    assert.ok(!V.renderLegend(false).includes('runner parado'), 'com o runner vivo a legenda não inventa a frase');
    assert.equal(count(V.renderLegend(false), /<svg width="16"/g), 8, 'as oito formas de estado, com a palavra ao lado');
  });
  test('the element budget holds in the worst case: ten roles working, three instances each and a fresh hand-back on every edge of the Lead', () => {
    const { run, snap } = live;
    const worst = { ...run, roster: run.roster.map(c => ({ ...c, state: 'a trabalhar', quiet: 0,
      instances: Array.from({ length: 4 }, () => ({ state: 'a trabalhar', endedAt: null, lastEventAt: snap.generatedAt, handback: { ts: snap.generatedAt - 1000, status: 'DONE', text: 'DONE T1' } })) })) };
    const svg = V.renderScene(worst, snap);
    assert.equal(count(svg, /class="hb /g), 27, 'nove hand-backs frescos × três pontos');
    assert.equal(count(svg, /class="notch"/g), 30);
    assert.ok(els(svg) <= 300, `orçamento de elementos SVG (TECHNOLOGY.md S1): ${els(svg)}`);
  });
  test('the phone scene: the core diamond only, the five on-demand folded into a bar that never hides an alarm', () => {
    const { run, snap } = live;
    const svg = V.renderSceneMobile(run, snap);
    assert.match(svg, /viewBox="0 0 390 230"/);
    assert.equal(count(svg, /<g class="node /g), 5, 'só o núcleo');
    assert.equal(count(svg, /<path class="edge hub"/g), 4);
    assert.equal(count(svg, /<path class="edge flow"/g), 4, 'os quatro lados do losango; as arestas dos a pedido ficam de fora');
    assert.deepEqual(Object.keys(V.NODES_M), KEYS.slice(0, 5));
    assert.deepEqual(V.NODES_M.lead, { x: 195, y: 128, r: 28 });
    for (const e of edgePoints(svg, V.NODES_M)) for (const [k, g] of Object.entries(V.NODES_M)) {
      if (e.a === k || e.b === k) continue;
      const near = Math.min(...e.pts.map(([x, y]) => Math.hypot(x - g.x, y - g.y)));
      assert.ok(near > g.r, `telemóvel: a aresta ${e.a}→${e.b} passa a ${near.toFixed(1)} px do centro de ${k} (raio ${g.r})`);
    }
    const bar = V.renderDemandBar(run, snap, false);
    assert.match(bar, /<div class="fold"><b>a pedido<\/b>/);
    assert.equal(count(bar, /<span class="pill m-/g), 5, 'uma pastilha por papel a pedido');
    for (const m of MONOS.slice(5)) assert.ok(bar.includes(`${m}<span class="sr">`), `pastilha ${m} com o nome e o estado para quem ouve a página`);
    assert.match(bar, /<button type="button" class="pill open" id="demand-toggle" data-action="demand" aria-expanded="false" aria-controls="demand-open">abrir os 5 ▾<\/button>/);
    assert.match(bar, /<div id="demand-open" class="stage" hidden>/);
    assert.equal(count(bar, /<g class="node /g), 5, 'os cinco nós ficam no DOM, escondidos até se abrir a barra');
    const open = V.renderDemandBar(run, snap, true);
    assert.match(open, /aria-expanded="true"[^>]*>fechar os 5 ▴<\/button>/);
    assert.match(open, /<div id="demand-open" class="stage">/);
    // Um papel a pedido bloqueado nunca fica escondido: o «!» aparece na pastilha dobrada.
    const loud = { ...run, roster: run.roster.map(c => c.key === 'qa' ? { ...c, state: 'precisa do Sponsor' } : c) };
    const pill = V.renderDemandBar(loud, snap, false).match(/<span class="pill m-qa[^]*?<\/span><\/span>/)[0];
    assert.match(pill, /class="pill m-qa t-sponsor"/);
    assert.ok(pill.includes('var(--alarm)'), 'o glifo «!» em alarme, mesmo com a barra dobrada');
    assert.ok(pill.includes('QA<span class="sr">QA: precisa do Sponsor</span>'));
  });
  test('run paused by a usage limit: the run status, the badge text and the Lead card say "em pausa" with the local resume time', () => {
    const { run, snap, now } = paused;
    assert.equal(run.status, 'em pausa');
    assert.equal(run.roster[0].state, 'em pausa');
    assert.equal(V.toneOf('em pausa'), 'wait', 'wood, low glow');
    const at = V.hm(run.forja.pause.resumeAt);
    assert.match(at, /^\d{2}:\d{2}$/);
    assert.equal(V.pauseText(run), `limite de utilização, retoma às ${at}`);
    assert.equal(V.runDetail(run), `limite de utilização, retoma às ${at}`);
    const card = V.renderCard(run.roster[0], run, snap, now);
    assert.match(card, /<div class="word">em pausa<\/div>/);
    assert.ok(card.includes(`<div class="what">limite de utilização, retoma às ${at}</div>`), 'the Lead card text: the reason only, the state word already says EM PAUSA');
    assert.ok(!card.includes('em pausa: limite'), 'no "em pausa:" prefix repeating the state word');
    assert.match(card, /<div class="ist t-wait">run em pausa<\/div>/, 'the run seal inside the card');
    const svg = V.renderScene(run, snap);
    assert.match(svg, /<g class="node m-lead t-wait">/, 'em pausa: o nó do Lead no tom de espera, sem pulso');
    assert.equal(count(svg, /class="node [^"]* live"/g), 0, 'nothing pulses while paused (the designer is silent, the native tool is not a node)');
    const leadLook = V.nodeLook(run.roster[0], run, snap);
    assert.equal(leadLook.glyph, 'bar', 'espera/pausa: barra horizontal, para o estado não depender só da cor');
    assert.equal(leadLook.glow, .35);
    assert.equal(V.sceneCold(run), false, 'em pausa o runner prometeu voltar: a rede não fica fria');
    assert.equal(V.pauseText({ forja: { pause: { reason: 'limite de utilização', resumeAt: null } } }), 'limite de utilização, retoma quando repuser');
    assert.equal(V.pauseText({ forja: { pause: null } }), null);
  });
  test('the phone: ten compact rows, core first, monograms, the label on the five on-demand rows and the stat line; each row expands to the full card', () => {
    const { run, snap, now } = live;
    const rows = V.renderRows(run, snap, now, new Set(['qa']));
    assert.equal(count(rows, /<button type="button" class="row-btn /g), 10);
    const order = KEYS.map(k => rows.indexOf(`data-key="${k}"`));
    assert.deepEqual(order.slice().sort((a, b) => a - b), order);
    for (const m of MONOS) assert.ok(rows.includes(`<span class="mo" aria-hidden="true">${m}</span>`), `monogram ${m}`);
    assert.equal(count(rows, /class="row-btn [^"]*demand"/g), 5);
    assert.equal(count(rows, /<span class="who"><b>[^<]+<\/b><span class="rl"><em class="tag">a pedido<\/em> /g), 5);
    assert.equal(count(rows, /<span class="stat">ligado: /g), 10);
    assert.match(rows, /<span class="stat">ligado: \d+ min · 2 sessões · fable<\/span>/);
    for (const c of run.roster) assert.ok(rows.includes(`<span class="sw">${c.state}</span>`), c.key);
    assert.match(rows, /<div id="exp-qa" ><article class="card m-qa t-done demand"/);
    assert.match(rows, /<div id="exp-lead" hidden>/);
    const prow = V.renderRows(paused.run, paused.snap, paused.now);
    assert.match(prow, /<span class="sw">em pausa<\/span>/);
  });
});

// "Novo run": UI do contrato de `viewer/runs-api.mjs` — GET /projects (com
// `runnerAlive` de topo, independente de `run`) e POST /runs. Sem DOM: a máquina
// de estados do bilhete é o redutor puro `newRunReducer`, que é exatamente o que
// `boot()` chama em cada toque, e as chamadas de rede levam um `fetch` simulado.
describe('"Novo run" — arrancar/relançar um run do telemóvel', () => {
  let V;
  before(async () => { V = await import(pathToFileURL(join(here, '..', 'viewer', 'assets', 'viewer.js')).href); });
  const P = (name, run, runnerAlive) => ({ name, path: `C:\\secret\\path\\${name}`, bootstrappedAt: 1, run, runnerAlive });
  const PROJECTS = [
    P('sample-project', null, false),
    P('starting-one', null, true),
    P('live-one', { run_id: 'R1', status: 'running', goal: 'objetivo do run vivo', started_at: 1 }, true),
    P('stale-one', { run_id: 'R2', status: 'running', goal: 'objetivo do run parado', started_at: 1 }, false),
    P('done-one', { run_id: 'R3', status: 'finished', goal: 'já feito', started_at: 1 }, false),
    P('failed-one', { run_id: 'R4', status: 'failed', goal: 'falhou', started_at: 1 }, false),
    P('blocked-one', { run_id: 'R5', status: 'blocked', goal: 'bloqueado', started_at: 1 }, false),
  ];
  const st = (over = {}) => ({ ...V.newRunInit(), loaded: true, ...over });
  const GOAL = 'objetivo com mais de dez caracteres';

  test('projectRunState: runnerAlive is read on its own, not only when the run says "running"', () => {
    assert.deepEqual(PROJECTS.map(p => V.projectRunState(p).kind), ['none', 'starting', 'live', 'stale', 'finished', 'failed', 'blocked']);
    assert.deepEqual(PROJECTS.map(p => V.projectRunState(p).label),
      ['sem run', 'a arrancar', 'run a correr, runner vivo', 'run em curso, runner parado', 'terminado', 'falhou', 'bloqueado'],
      'as palavras exatas do DESIGN §Novo run, com vírgula a separar as duas metades');
    // "busy" = o servidor responderia 409 a um arranque agora
    assert.deepEqual(PROJECTS.map(p => V.projectRunState(p).busy), [false, true, true, false, false, false, false]);
    // um runner vivo com um run já terminado continua a impedir um arranque
    assert.deepEqual(V.projectRunState(P('x', { run_id: 'R9', status: 'finished' }, true)), { kind: 'live', label: 'terminado, runner vivo', busy: true });
  });

  test('the ticket lists the projects with their state and never prints a path', () => {
    const html = V.renderNewRun(PROJECTS, st({ project: 'sample-project' }));
    for (const p of PROJECTS) assert.ok(!html.includes(p.path), `path of ${p.name} never appears`);
    for (const p of PROJECTS) assert.ok(html.includes(`${p.name} · ${V.projectRunState(p).label}`), `${p.name} option carries its state`);
    assert.ok(!/aria-live/.test(html), 'DESIGN §Acessibilidade: aria-live is reserved for the run badge and the queue counter');
  });

  test('goal validation uses the trimmed text, like the server: only spaces, 9 chars, 601 chars or a leading "-" keep the button disabled', () => {
    const btn = html => html.match(/<button class="btn" type="button" id="newrun-submit" data-action="newrun-submit"( disabled)?>([^<]*)<\/button>/);
    const spaces = V.renderNewRun(PROJECTS, st({ project: 'sample-project', goal: '            ' }));
    assert.deepEqual(btn(spaces).slice(1), [' disabled', 'Arrancar']);
    // fora do intervalo o contador passa a âmbar (classe "bad"), dentro volta ao normal
    assert.match(spaces, /<div class="count mono bad" id="newrun-count">0\/600 · mínimo 10<\/div>/);
    const short = V.renderNewRun(PROJECTS, st({ project: 'sample-project', goal: `  ${'x'.repeat(9)}  ` }));
    assert.deepEqual(btn(short).slice(1), [' disabled', 'Arrancar']);
    assert.match(short, />9\/600 · mínimo 10</);
    const dash = V.renderNewRun(PROJECTS, st({ project: 'sample-project', goal: '-arranca isto tudo por favor' }));
    assert.deepEqual(btn(dash).slice(1), [' disabled', 'Arrancar']);
    assert.match(dash, />28\/600 · não pode começar por «-»</, 'the server refuses a goal starting with "-" (it would be read as a flag)');
    // uma textarea aceita Enter; o servidor recusa caracteres de controlo — o botão desativado tem de dizer porquê
    const multi = V.renderNewRun(PROJECTS, st({ project: 'sample-project', goal: `${GOAL}\numa segunda linha` }));
    assert.deepEqual(btn(multi).slice(1), [' disabled', 'Arrancar']);
    assert.match(multi, /· tudo numa linha, sem quebras</);
    const long = V.renderNewRun(PROJECTS, st({ project: 'sample-project', goal: 'x'.repeat(601) }));
    assert.deepEqual(btn(long).slice(1), [' disabled', 'Arrancar']);
    assert.match(long, />601\/600 · demasiado longo</);
    const okMin = V.renderNewRun(PROJECTS, st({ project: 'sample-project', goal: `  ${'x'.repeat(10)}  ` }));
    assert.deepEqual(btn(okMin).slice(1), [undefined, 'Arrancar'], 'trailing spaces do not count: 10 real characters are enough');
    assert.match(okMin, /<div class="count mono" id="newrun-count">10\/600<\/div>/, 'a valid goal never shows the amber counter');
    const okMax = V.renderNewRun(PROJECTS, st({ project: 'sample-project', goal: 'x'.repeat(600) }));
    assert.deepEqual(btn(okMax).slice(1), [undefined, 'Arrancar']);
    assert.match(okMax, /<div class="count mono" id="newrun-count">600\/600<\/div>/);
    assert.equal(V.NEWRUN_GOAL_MIN, 10); assert.equal(V.NEWRUN_GOAL_MAX, 600);
  });

  test('confirmation is a second tap on the button itself ("Confirmar"), never a native confirm()', () => {
    const armed = V.newRunReducer(st({ project: 'sample-project', goal: GOAL }), { type: 'tap', projects: PROJECTS });
    assert.equal(armed.confirmArmed, true); assert.equal(armed.phase, 'idle');
    const html = V.renderNewRun(PROJECTS, armed);
    assert.match(html, /data-action="newrun-submit">Confirmar<\/button>/);
    assert.match(html, /toca outra vez para arrancar/);
    // escrever desarma: um toque perdido nunca arranca o run que a pessoa já mudou
    const typed = V.newRunReducer(armed, { type: 'goal', goal: `${GOAL} e mais isto` });
    assert.equal(typed.confirmArmed, false);
    assert.match(V.renderNewRun(PROJECTS, typed), /data-action="newrun-submit">Arrancar<\/button>/);
  });

  test('a project whose runner is alive WITHOUT a run yet ("a arrancar") shows no action at all — nothing to do is a legitimate state', () => {
    const html = V.renderNewRun(PROJECTS, st({ project: 'starting-one', goal: GOAL }));
    // a palavra de estado aparece no seletor E por baixo dele (a caixa do seletor corta o texto)
    assert.match(html, /<div class="d state"><b>a arrancar<\/b> — nada a fazer: o run aparece nesta página assim que o Lead escrever o primeiro evento\.<\/div>/);
    assert.match(html, /<select id="newrun-project" data-action="newrun-project">/, 'the selector stays: it is how one looks at another project');
    assert.ok(!html.includes('newrun-submit'), 'DESIGN §Novo run: no disabled "Arrancar" half-way, no button at all');
    assert.ok(!html.includes('newrun-goal'), 'no empty disabled field either');
    assert.ok(!html.includes('id="newrun-count"'), 'no character counter when nothing can be sent');
    const tapped = V.newRunReducer(st({ project: 'starting-one', goal: GOAL }), { type: 'tap', projects: PROJECTS });
    assert.equal(tapped.confirmArmed, false, 'the tap does nothing at all');
    assert.equal(tapped.phase, 'idle');
  });

  test('a project with a live runner and a running run shows only the note — no field and no button, even with a valid goal', () => {
    const html = V.renderNewRun(PROJECTS, st({ project: 'live-one', goal: GOAL }));
    assert.match(html, /<div class="d state"><b>run a correr, runner vivo<\/b> — nada a fazer: já há um run a correr neste projeto\.<\/div>/);
    assert.ok(!html.includes('newrun-submit') && !html.includes('newrun-goal'));
    assert.match(html, /<option value="live-one" selected>live-one · run a correr, runner vivo<\/option>/);
  });

  test('a stale runner (running, not alive) shows "Relançar o runner" and the goal of the run in progress, no textarea', () => {
    const html = V.renderNewRun(PROJECTS, st({ project: 'stale-one' }));
    assert.match(html, /data-action="newrun-submit">Relançar o runner<\/button>/);
    assert.match(html, /<div class="d state"><b>run em curso, runner parado<\/b><\/div>/, 'the state word is readable under the selector, which clips it');
    assert.match(html, /<b>Objetivo do run em curso:<\/b> objetivo do run parado/);
    assert.ok(!html.includes('id="newrun-goal"'), 'no goal textarea when resuming');
  });

  test('before the first /projects the ticket says it is loading; with an empty registry it says no project is prepared', () => {
    assert.match(V.renderNewRun([], V.newRunInit()), /a carregar os projetos preparados…/);
    const empty = V.renderNewRun([], st());
    assert.match(empty, /<option value="">nenhum projeto preparado<\/option>/);
    assert.match(empty, /<select id="newrun-project" data-action="newrun-project" disabled>/);
    assert.match(empty, /data-action="newrun-submit" disabled>Arrancar<\/button>/);
    assert.match(empty, /forja bootstrap/);
  });

  // O caminho de sucesso: o selo tem de durar até haver prova de que o runner
  // arrancou — nunca 20 ms (o runner escreve o lock segundos depois e o RUN.json
  // só existe quando o Lead começa; até lá /projects devolve run: null).
  test('success path: the seal stays through a /projects that still shows nothing, and only clears when the runner is alive', async () => {
    let state = st({ project: 'sample-project', goal: `  ${GOAL}  ` });
    state = V.newRunReducer(state, { type: 'tap', projects: PROJECTS });      // arma
    state = V.newRunReducer(state, { type: 'tap', projects: PROJECTS });      // confirma
    assert.equal(state.phase, 'submitting');
    const submitting = V.renderNewRun(PROJECTS, state);
    assert.match(submitting, /data-action="newrun-submit" disabled>a arrancar…<\/button>/);
    assert.match(submitting, /<select id="newrun-project" data-action="newrun-project" disabled>/);

    const calls = [];
    const fakeFetch = async (url, opts) => { calls.push([url, opts]); return { ok: true, status: 200, json: async () => ({ ok: true, action: 'start', project: 'sample-project', pid: 4321 }) }; };
    const res = await V.postRun(PROJECTS[0], V.newRunView(PROJECTS, state).trimmed, fakeFetch);
    assert.deepEqual(res, { ok: true, action: 'start', project: 'sample-project', pid: 4321 });
    assert.equal(calls[0][0], '/runs');
    assert.equal(calls[0][1].method, 'POST');
    assert.equal(calls[0][1].credentials, 'same-origin');
    assert.deepEqual(calls[0][1].headers, { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(calls[0][1].body), { project: 'sample-project', goal: GOAL }, 'the goal goes trimmed, exactly as the server validates it');

    state = V.newRunReducer(state, { type: 'sent', project: 'sample-project', runId: null, resume: false });
    assert.equal(state.phase, 'started');
    const started = V.renderNewRun(PROJECTS, state);
    assert.match(started, /run a arrancar — a notificação chega em menos de um minuto/);
    assert.match(started, /<b>Objetivo enviado:<\/b> objetivo com mais de dez caracteres/);
    assert.ok(!started.includes('data-action="newrun-submit"'), 'no "Arrancar" button while the run is starting');
    assert.match(started, /<select id="newrun-project" data-action="newrun-project" disabled>/);
    assert.match(started, /data-action="newrun-recheck">Verificar de novo<\/button>/);
    assert.match(started, /<option value="sample-project" selected>sample-project · a arrancar · pedido enviado<\/option>/, 'the selector never contradicts the seal with the state from before the start');
    assert.match(started, /<div class="d state"><b>a arrancar · pedido enviado<\/b><\/div>/, 'the line under the selector says the same as the selector');

    // 3 s depois: o runner ainda não escreveu o lock — o selo TEM de ficar
    state = V.newRunReducer(state, { type: 'projects', projects: [P('sample-project', null, false), ...PROJECTS.slice(1)] });
    assert.equal(state.phase, 'started', 'a /projects with no evidence yet never sends the ticket back to the form');
    assert.match(V.renderNewRun(PROJECTS, state), /run a arrancar — a notificação chega em menos de um minuto/);

    // 15 s depois: lock do runner vivo, ainda sem RUN.json → bilhete volta ao normal, já sem convite a arrancar outra vez
    const alive = [P('sample-project', null, true), ...PROJECTS.slice(1)];
    state = V.newRunReducer(state, { type: 'projects', projects: alive });
    assert.equal(state.phase, 'idle');
    assert.equal(state.project, 'sample-project', 'the ticket stays on the project that was started');
    const back = V.renderNewRun(alive, state);
    assert.match(back, /<b>a arrancar<\/b> — nada a fazer/);
    assert.ok(!back.includes('newrun-submit'), 'busy: no action at all, not a disabled "Arrancar"');
    assert.ok(!back.includes('run a arrancar —'), 'the seal is gone once there is evidence');
  });

  test('the seal also clears when a NEW run_id shows up (RUN.json written before the lock was seen)', () => {
    let state = V.newRunReducer(st({ project: 'done-one', goal: GOAL }), { type: 'sent', project: 'done-one', runId: 'R3', resume: false });
    state = V.newRunReducer(state, { type: 'projects', projects: [P('done-one', { run_id: 'R3', status: 'finished', goal: 'já feito' }, false)] });
    assert.equal(state.phase, 'started', 'the old run_id is not evidence of anything');
    state = V.newRunReducer(state, { type: 'projects', projects: [P('done-one', { run_id: 'R6', status: 'running', goal: GOAL }, false)] });
    assert.equal(state.phase, 'idle');
    assert.equal(state.startedAt, null, 'B5: proof clears startedAt too, or a later stray tick could still expire an idle ticket');
  });

  test('a 409 puts the ticket back in the form with the amber error and the typed goal kept', async () => {
    let state = st({ project: 'sample-project', goal: GOAL, confirmArmed: true });
    state = V.newRunReducer(state, { type: 'tap', projects: PROJECTS });
    // o texto do servidor a seco ("espera 24 s") não diz o que falhou: leva sempre o prefixo
    const res = await V.postRun(PROJECTS[0], GOAL, async () => ({ ok: false, status: 409, json: async () => ({ error: 'já há um runner vivo neste projeto' }) }));
    assert.deepEqual(res, { ok: false, error: 'não foi possível arrancar — já há um runner vivo neste projeto' });
    assert.deepEqual(await V.postRun(PROJECTS[0], GOAL, async () => ({ ok: false, status: 429, json: async () => ({ error: 'espera 24 s' }) })),
      { ok: false, error: 'não foi possível arrancar — espera 24 s' });
    state = V.newRunReducer(state, { type: 'failed', error: res.error });
    assert.equal(state.phase, 'idle'); assert.equal(state.goal, GOAL, 'the typed goal is never thrown away');
    const html = V.renderNewRun(PROJECTS, state);
    assert.match(html, /<div class="err" id="newrun-err">não foi possível arrancar — já há um runner vivo neste projeto<\/div>/);
    assert.ok(!html.includes(' disabled>'), 'fields stay active after an error');
    assert.ok(!html.includes('run a arrancar —'), 'no seal after a refused start');
  });

  test('errors without a body, and a dead viewer, still say something in Portuguese', async () => {
    assert.deepEqual(await V.postRun(PROJECTS[0], GOAL, async () => ({ ok: false, status: 500, json: async () => { throw new Error('no json'); } })),
      { ok: false, error: 'não foi possível arrancar — HTTP 500' });
    assert.deepEqual(await V.postRun(PROJECTS[0], GOAL, async () => { throw new Error('network'); }),
      { ok: false, error: 'não foi possível arrancar — sem ligação ao viewer' });
  });

  test('a resume sends { project, resume: true }, never a goal', async () => {
    let sent;
    const fakeFetch = async (url, opts) => { sent = [url, opts.method, JSON.parse(opts.body)]; return { ok: true, status: 200, json: async () => ({ ok: true, action: 'resume', project: 'stale-one', pid: 9 }) }; };
    const v = V.newRunView(PROJECTS, st({ project: 'stale-one', goal: 'lixo que não deve ser enviado' }));
    assert.equal(v.isResume, true);
    const res = await V.postRun(v.sel, v.isResume ? null : v.trimmed, fakeFetch);
    assert.deepEqual(sent, ['/runs', 'POST', { project: 'stale-one', resume: true }]);
    assert.equal(res.action, 'resume');
    const state = V.newRunReducer(st({ project: 'stale-one' }), { type: 'sent', project: 'stale-one', runId: 'R2', resume: true });
    assert.match(V.renderNewRun(PROJECTS, state), /<b>Relançado:<\/b> o run em curso, do ponto onde ficou/);
  });

  test('fetchProjects: parses { ok, projects }, and a network error returns null (keep the last known list)', async () => {
    const ok = await V.fetchProjects(async (url, opts) => { assert.equal(url, '/projects'); assert.equal(opts.cache, 'no-store'); return { ok: true, json: async () => ({ ok: true, projects: PROJECTS }) }; });
    assert.deepEqual(ok, PROJECTS);
    assert.equal(await V.fetchProjects(async () => { throw new Error('network'); }), null);
    assert.equal(await V.fetchProjects(async () => ({ ok: false, status: 500, json: async () => ({}) })), null);
  });

  test('B5: the seal expires after 90s without proof — the ticket falls back to idle with the amber "runner did not start" message, goal kept', () => {
    let state = V.newRunReducer(st({ project: 'sample-project', goal: GOAL }), { type: 'sent', project: 'sample-project', runId: null, resume: false, now: 1_000_000 });
    assert.equal(state.phase, 'started'); assert.equal(state.startedAt, 1_000_000);
    // 30s in: no proof yet, but under the deadline — the seal stays, and the
    // reducer returns the SAME object (no-op: a tick before the deadline must
    // never trigger a re-render of the ticket)
    const at30 = V.newRunReducer(state, { type: 'tick', now: 1_000_000 + 30_000 });
    assert.equal(at30, state, 'identity: an under-deadline tick is a true no-op');
    assert.equal(at30.phase, 'started');
    assert.match(V.renderNewRun(PROJECTS, at30), /run a arrancar — a notificação chega em menos de um minuto/);
    // 91s in: past the 90s deadline, still no /projects proof — back to the form
    const at91 = V.newRunReducer(state, { type: 'tick', now: 1_000_000 + 91_000 });
    assert.equal(at91.phase, 'idle');
    assert.equal(at91.error, V.NEWRUN_EXPIRED_TEXT);
    assert.equal(at91.goal, GOAL, 'the objective typed before the tap is kept in the field, ready to resend');
    assert.equal(V.NEWRUN_EXPIRE_MS, 90000);
    const html = V.renderNewRun(PROJECTS, at91);
    assert.match(html, /<div class="err" id="newrun-err">o runner não arrancou — vê o computador \(o motivo fica no registo do runner\)<\/div>/);
    assert.ok(!html.includes('run a arrancar —'), 'the seal is gone');
    assert.ok(!html.includes(' disabled>'), 'the field stays active, same treatment as any other failed send');
    assert.match(html, new RegExp(`data-action="newrun-submit">Arrancar</button>`));
    // a /projects arriving between 30 s and 90 s still clears the ticket normally (unaffected by the timer)
    const proven = V.newRunReducer(at30, { type: 'projects', projects: [{ name: 'sample-project', run: null, runnerAlive: true }, ...PROJECTS.slice(1)] });
    assert.equal(proven.phase, 'idle'); assert.equal(proven.error, '', 'evidence, not the timer, cleared it — no error message');
  });
  test('project names and goals with <script> are escaped', () => {
    const evil = '<script>alert(1)</script>';
    const html = V.renderNewRun([P(evil, null, false)], st({ project: evil, goal: evil }));
    assert.ok(!html.includes('<script>'), 'no raw <script>');
    assert.ok(html.includes('&lt;script&gt;'), 'escaped');
  });
});

// Ligação perdida (T-UI-8): o servidor manda `ping` por SSE de 15 em 15 s e
// `state` a cada evento novo (viewer/server.mjs); o `fetch('/state')` de recurso
// conta como o mesmo sinal. "Offline" só depois de 30 s sem nenhum dos dois.
describe('ligação perdida (T-UI-8): a faixa no topo, "dados de HH:MM" e a volta a online', () => {
  let V;
  before(async () => { V = await import(pathToFileURL(join(here, '..', 'viewer', 'assets', 'viewer.js')).href); });
  const now = Date.parse('2026-09-17T14:07:32.000Z');

  test('isOffline: 30 s sem SSE nem /state é offline; um heartbeat sozinho já conta como sinal', () => {
    assert.equal(V.isOffline({ lastStateAt: now - 1000, lastSignal: now - 500 }, now), false, 'sinal recente: online');
    assert.equal(V.isOffline({ lastStateAt: now - 31000, lastSignal: 0 }, now), true, '31 s de silêncio: offline');
    assert.equal(V.isOffline({ lastStateAt: 0, lastSignal: now - 29000 }, now), false, 'só o heartbeat, mas a 29 s: ainda online');
    assert.equal(V.isOffline({ lastStateAt: now - 30000, lastSignal: now - 30000 }, now), false, 'exatamente no limiar (30000 ms) ainda não é offline: > 30 s, não >=');
    assert.equal(V.lastContactOf({ lastStateAt: now - 5000, lastSignal: now - 1000 }), now - 1000, 'o sinal mais recente dos dois, nunca a média');
  });

  test('a faixa diz a hora exata da queda e traz o botão «Tentar de novo»; a região ao vivo é o wrapper permanente, não o filho injetado', () => {
    const html = V.renderConnBanner(now);
    assert.ok(html.startsWith('<div class="banner offline">'), 'o filho injetado não repete role/aria-live');
    assert.ok(!html.includes('aria-live') && !html.includes('role="status"'), 'uma região ao vivo criada ao mesmo tempo que o texto não chega a ser anunciada');
    assert.ok(html.includes(`Sem ligação ao viewer desde ${V.hm(now)} — os runs continuam no PC; se o endereço mudou, abre o link mais recente que recebeste por ntfy</span>`), 'sem ponto final depois de «ntfy»');
    assert.match(html, /<button type="button" class="btn" data-action="conn-retry">Tentar de novo<\/button>/);
  });

  // O REJECT da 1.ª tentativa: o `error` do EventSource zerava `lastSignal` e,
  // como em modo SSE o /state de recurso só corre a cada 60 s, a faixa aparecia
  // meio segundo depois de um corte de 3,5 s do túnel — alarme falso.
  test('um `error` isolado do SSE com sinal recente não põe a página offline', () => {
    const S = { lastStateAt: now - 3500, lastSignal: now - 3500, sseError: false };
    V.markSseError(S);
    assert.equal(S.sseError, true, 'o erro fica marcado, mas num campo à parte');
    assert.equal(S.lastSignal, now - 3500, 'markSseError nunca mexe na hora do último sinal');
    assert.equal(S.lastStateAt, now - 3500, 'nem na do último /state');
    assert.equal(V.isOffline(S, now), false, 'corte de 3,5 s: sem faixa');
    assert.equal(V.lastContactOf(S), now - 3500, 'o último contacto continua a ser o ping real, não 0');
  });

  test('o erro marcado não impede a faixa quando o silêncio passa mesmo dos 30 s', () => {
    const S = { lastStateAt: now - 3500, lastSignal: now - 3500, sseError: true };
    assert.equal(V.isOffline(S, now + 26000), false, '29,5 s de silêncio: ainda online');
    assert.equal(V.isOffline(S, now + 27000), true, '30,5 s de silêncio: offline');
  });

  test('asOfText: só aparece offline, com a hora do último instantâneo — nunca finge que os "há X" locais são frescos', () => {
    const snap = { generatedAt: now };
    assert.equal(V.asOfText(false, snap), '', 'online: o cabeçalho não precisa de dizer nada sobre frescura');
    assert.equal(V.asOfText(true, snap), `dados de ${V.hm(now)}`);
    assert.equal(V.asOfText(true, null), '', 'sem instantâneo nenhum ainda, nada a mostrar');
  });

  // O mesmo patch de dois elementos que `tick()` faz em cada segundo (S com o
  // formato real: `lastStateAt`/`lastSignal`/`snap`), num DOM falso, para provar
  // o ciclo completo: offline mostra a faixa e a hora absoluta, online apaga as duas.
  test('o ciclo offline → online: a faixa e "dados de HH:MM" aparecem e somem (o patch que tick() faz)', () => {
    const doc = new FakeDocument();
    const banner = doc.createElement('div'); banner.id = 'conn-banner'; doc.body.appendChild(banner);
    const asof = doc.createElement('div'); asof.id = 'asof'; doc.body.appendChild(asof);
    const S = { lastStateAt: now - 40000, lastSignal: 0, snap: { generatedAt: now - 40000 } };
    const patch = () => {
      const offline = V.isOffline(S, now);
      banner.innerHTML = offline ? V.renderConnBanner(V.lastContactOf(S)) : '';
      asof.textContent = V.asOfText(offline, S.snap);
    };
    patch();
    assert.match(banner.innerHTML, /Sem ligação ao viewer desde/, 'offline: a faixa aparece');
    assert.equal(asof.textContent, `dados de ${V.hm(now - 40000)}`, 'offline: hora absoluta, não "há X"');

    S.lastStateAt = now; S.lastSignal = now; S.snap = { generatedAt: now };
    patch();
    assert.equal(banner.innerHTML, '', 'de volta: a faixa some');
    assert.equal(asof.textContent, '', 'de volta: sem a nota de frescura');
  });

  // O outro REJECT: `sticky` estava na faixa injetada, cujo pai (#conn-banner)
  // tem a altura exata dela — alcance zero, a faixa saía do ecrã ao rolar. Quem
  // cola é o wrapper, cujo pai é a `.page` inteira. O DOM falso não faz layout
  // nem scroll: aqui prova-se o contrato no CSS/HTML servidos de verdade, e a
  // posição no ecrã está medida no screenshot com a página rolada
  // (docs/dogfood/ui-offline-desktop-scrolled-1440.png).
  test('quem cola ao topo é o wrapper #conn-banner (alcance = a página inteira), nunca a faixa injetada', async () => {
    const css = (await http('/assets/viewer.css', auth())).body;
    const ruleOf = (sel) => { const i = css.indexOf(sel); assert.ok(i >= 0, `regra ${sel}`); return css.slice(i, css.indexOf('}', i) + 1); };
    const wrapper = ruleOf('#conn-banner {');
    assert.ok(wrapper.includes('position: sticky'), 'o wrapper é que cola');
    assert.ok(wrapper.includes('top: 0'), 'colado ao topo do ecrã');
    assert.ok(wrapper.includes('z-index: 30'), 'por cima do conteúdo que passa por baixo');
    const faixa = ruleOf('.banner.offline { display');
    assert.ok(!faixa.includes('position:'), 'sticky no filho tinha alcance zero');
    // o anel global é --patina, que sobre --alarm dá 1,6:1; dentro da faixa é --on-alarm (5,6:1)
    assert.ok(css.includes('.banner.offline :focus-visible { outline-color: var(--on-alarm); }'), 'anel de foco legível dentro da faixa');
    for (let i = css.indexOf('.page {'); i >= 0; i = css.indexOf('.page {', i + 1)) {
      assert.ok(!css.slice(i, css.indexOf('}', i)).includes('overflow'), 'um overflow na .page cortava o sticky');
    }
    for (const path of ['/legacy', '/legacy/m']) {
      const html = (await http(path, auth())).body;
      const wrap = '<div id="conn-banner" role="status" aria-live="polite"></div>';
      assert.ok(html.includes(wrap), `${path}: wrapper permanente com a região ao vivo`);
      const open = '<div class="page">';
      const between = html.slice(html.indexOf(open) + open.length, html.indexOf('<div id="conn-banner"'));
      const afterComment = between.includes('-->') ? between.slice(between.indexOf('-->') + 3) : between;
      assert.equal(afterComment.trim(), '', `${path}: filho direto de .page, antes do cabeçalho`);
    }
  });
});

// T-UI-9: o seletor de run. Runs verdadeiros por omissão (uma sessão que carimba
// o run_id pertence ao run e é absorvida por ele), sessões soltas dobradas com um
// rótulo honesto; e (adenda do Sponsor) o <select> é um nó estável que não se
// fecha debaixo do dedo a cada instantâneo, mais a pausa das atualizações.
describe('seletor de run: runs verdadeiros, sessões soltas dobradas e nó estável (T-UI-9)', () => {
  let V; let snap; let run;
  const lines = readFileSync(join(here, 'fixtures', 'loose-sessions.jsonl'), 'utf8').split('\n');
  const NOW = BASE + 28820_000;
  const ID = { gear: 'R-20260917-1c81', job: 'R-20260917-f054', velora: 'R-20260917-e583',
    ler: 'forj-ler0-aaaa-bbbb-cccc-000000000016', vs: 'forj-vsc0-aaaa-bbbb-cccc-000000000015' };
  before(async () => {
    V = await import(pathToFileURL(join(here, '..', 'viewer', 'assets', 'viewer.js')).href);
    const R = await import(pathToFileURL(join(here, '..', 'viewer', 'lib', 'state.mjs')).href);
    snap = R.reduceLines(lines, NOW);
    run = snap.runs.find(r => r.id === ID.gear);
  });
  const model = (sel = ID.gear, opts) => V.runSelectorModel(snap, sel, opts);
  const host = doc => { const h = doc.createElement('div'); doc.body.appendChild(h); return h; };
  const opts = h => Array.from(h.querySelector('select[data-action="run"]').querySelectorAll('option'));

  test('o modelo agrupa por projeto, ordena pelo evento mais recente e só leva runs verdadeiros', () => {
    const m = model();
    assert.deepEqual(m.groups.map(g => g.project), ['gearlift', 'job-hunter', 'velora-poker', 'forja'].slice(0, 3).concat([]), 'os projetos com run, o do evento mais recente primeiro');
    assert.deepEqual(m.groups.flatMap(g => g.options.map(o => o.label)), [
      'gearlift · R-20260917-1c81 · a trabalhar',
      'job-hunter · R-20260917-f054 · a trabalhar',
      'velora-poker · R-20260917-e583 · a trabalhar',
    ], '«<projeto> · R-… · <estado>»');
    assert.deepEqual(m.loose.map(s => s.label), [
      'forja · sessão sem run · terminado',
      'forja · sessão interativa · à espera de input',
    ], 'rótulo honesto, nunca «run»');
    assert.equal(m.loose.length, 2);
    // a 390 a caixa corta o texto: abrevia-se o id, nunca a palavra de estado
    assert.deepEqual(model(ID.gear, { compact: true }).groups[0].options.map(o => o.label),
      ['gearlift · R-…1c81 · a trabalhar']);
  });

  test('a escolha por omissão é a do instantâneo; só a escolha do Sponsor se fixa, e sobrevive ao fim do run', () => {
    assert.equal(snap.current, ID.gear, 'o run ativo mais recente, nunca uma sessão solta');
    assert.equal(V.pickRunId(snap, null), null, 'sem escolha do Sponsor manda o «current» do instantâneo');
    assert.equal(V.pickRunId(snap, ID.job), ID.job, 'o que ele escolheu fica escolhido');
    const ended = { ...snap, runs: snap.runs.map(r => r.id === ID.job ? { ...r, status: 'terminado' } : r) };
    assert.equal(V.pickRunId(ended, ID.job), ID.job, 'um run que terminou continua a ser o que está aberto');
    const gone = { ...snap, runs: snap.runs.filter(r => r.id !== ID.job) };
    assert.equal(V.pickRunId(gone, ID.job), null, 'só desaparecer do instantâneo devolve o comando ao «current»');
  });

  test('o seletor: só runs no <select>, sessões soltas numa secção dobrada que abre com o rótulo honesto', () => {
    const doc = new FakeDocument(); const h = host(doc);
    V.patchRunSelector(h, doc, model(), { looseOpen: false });
    const sel = h.querySelector('select[data-action="run"]');
    assert.deepEqual(Array.from(sel.children).map(g => g.getAttribute('label')), ['gearlift', 'job-hunter', 'velora-poker'], 'um <optgroup> por projeto');
    assert.equal(opts(h).length, 3);
    assert.equal(sel.value, ID.gear);
    for (const o of opts(h)) assert.ok(!/sessão/.test(o.textContent), 'nenhuma sessão solta no seletor por omissão');
    const toggle = h.querySelector('button[data-action="loose"]');
    const list = h.querySelector('.loose-list');
    assert.equal(toggle.textContent, 'sessões soltas (2)');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(list.hidden, true, 'dobrada por omissão');
    V.patchRunSelector(h, doc, model(), { looseOpen: true });
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(list.hidden, false);
    assert.deepEqual(Array.from(list.children).map(b => b.textContent), [
      'forja · sessão sem run · terminado',
      'forja · sessão interativa · à espera de input',
    ]);
    assert.deepEqual(Array.from(list.children).map(b => b.getAttribute('data-run')), [ID.ler, ID.vs]);
    // escolher uma sessão solta: ela aparece no próprio seletor, dita pelo nome
    V.patchRunSelector(h, doc, model(ID.vs), { looseOpen: true });
    assert.equal(sel.children[0].getAttribute('label'), 'sessão solta');
    assert.equal(sel.children[0].children[0].textContent, 'forja · sessão interativa · à espera de input');
    assert.equal(sel.value, ID.vs);
    assert.equal(list.children[1].getAttribute('aria-current'), 'true');
  });

  test('o <select> nunca é substituído: as <option> são reconciliadas in-place, e com o foco no seletor nem nelas se toca', () => {
    const doc = new FakeDocument(); const h = host(doc);
    V.patchRunSelector(h, doc, model(), {});
    const sel = h.querySelector('select[data-action="run"]');
    const firstOption = opts(h)[0];
    const moved = { ...snap, runs: snap.runs.map(r => r.id === ID.gear ? { ...r, status: 'terminado' } : r) };
    V.patchRunSelector(h, doc, V.runSelectorModel(moved, ID.gear), {});
    assert.equal(h.querySelector('select[data-action="run"]'), sel, 'o mesmo <select>');
    assert.equal(opts(h)[0], firstOption, 'a mesma <option>');
    assert.equal(firstOption.textContent, 'gearlift · R-20260917-1c81 · terminado');
    sel.focus();
    const back = { ...snap, runs: snap.runs.map(r => r.id === ID.gear ? { ...r, status: 'a trabalhar' } : r) };
    const res = V.patchRunSelector(h, doc, V.runSelectorModel(back, ID.gear), {});
    assert.deepEqual([res.applied, res.pending], [false, true], 'a atualização fica pendente');
    assert.equal(opts(h)[0], firstOption);
    assert.equal(firstOption.textContent, 'gearlift · R-20260917-1c81 · terminado', 'o texto da opção não mudou debaixo do dedo');
    assert.equal(opts(h).length, 3, 'nem opções novas, nem opções removidas');
    const res2 = V.patchRunSelector(h, doc, V.runSelectorModel(back, ID.gear), { force: true });
    assert.deepEqual([res2.applied, res2.pending], [true, false]);
    assert.equal(opts(h)[0], firstOption);
    assert.equal(firstOption.textContent, 'gearlift · R-20260917-1c81 · a trabalhar');
  });

  test('pausa das atualizações: botão com aria-pressed, a hora em palavras nas duas larguras, e o instantâneo guardado entra na retoma', () => {
    const doc = new FakeDocument(); const h = host(doc);
    const since = Date.parse('2026-09-17T14:32:00');
    V.patchRunSelector(h, doc, model(), { paused: false });
    const btn = h.querySelector('button[data-action="pause"]');
    assert.equal(h.querySelector('.pb-label').textContent, 'pausar atualizações');
    assert.equal(btn.getAttribute('aria-pressed'), 'false');
    assert.equal(h.querySelector('.pause-note').textContent, '');
    assert.equal(h.querySelector('.pb-note').textContent, '');
    V.patchRunSelector(h, doc, model(), { paused: true, pausedAt: since, frozenAt: since });
    assert.equal(h.querySelector('.pb-label').textContent, 'retomar atualizações');
    assert.equal(btn.getAttribute('aria-pressed'), 'true');
    assert.equal(h.querySelector('.pause-note').textContent, 'atualizações em pausa desde 14:32 — o ecrã só muda quando retomares');
    // telemóvel: a mesma informação vai dentro do botão (a barra nunca passa das duas linhas)
    assert.equal(h.querySelector('.pb-note').textContent, 'em pausa desde 14:32');
    V.patchRunSelector(h, doc, model(), { paused: false, frozenAt: since });
    assert.equal(h.querySelector('.pb-label').textContent, 'pausar atualizações', 'o botão só reflete a pausa à mão');
    assert.equal(h.querySelector('.pause-note').textContent, 'atualizações em pausa desde 14:32 — enquanto escreves ou escolhes');
    assert.equal(h.querySelector('.pb-note').textContent, 'em pausa enquanto escolhes · 14:32');
    // o redutor da pausa: é o que boot() chama em cada instantâneo que chega
    const ui = { paused: true, focusPaused: false, pending: null };
    assert.equal(V.gateSnapshot(ui, snap), false, 'em pausa não se re-escreve nada');
    assert.equal(ui.pending, snap, 'fica guardado o último');
    const newer = { ...snap, generatedAt: NOW + 5000 };
    assert.equal(V.gateSnapshot(ui, newer), false);
    assert.equal(V.resumeSnapshot(ui), null, 'ainda em pausa: nada entra');
    ui.paused = false;
    assert.equal(V.resumeSnapshot(ui), newer, 'ao retomar entra o último instantâneo guardado');
    assert.equal(V.resumeSnapshot(ui), null, 'e só uma vez');
    assert.equal(V.gateSnapshot(ui, snap), true, 'fora da pausa aplica-se logo');
    assert.deepEqual(['select', 'textarea', 'input'].map(t => V.isFormField({ tagName: t.toUpperCase() })), [true, true, true]);
    assert.equal(V.isFormField({ tagName: 'BUTTON' }), false);
    assert.equal(V.isFormField(null), false);
    const auto = { paused: false, focusPaused: true, pending: null };
    assert.equal(V.gateSnapshot(auto, snap), false, 'com o foco num campo, o instantâneo espera');
    auto.focusPaused = false;
    assert.equal(V.resumeSnapshot(auto), snap, 'e entra ao sair do campo');
  });

  test('o cabeçalho e o cartão do Lead de uma sessão solta não fingem um run', () => {
    const vs = snap.runs.find(r => r.id === ID.vs);
    const phone = V.renderHeader(vs, snap, NOW, 'mobile');
    const desk = V.renderHeader(vs, snap, NOW, 'desktop');
    for (const html of [phone, desk]) {
      assert.match(html, /<div class="loose-note">sessão solta — não é um run<small>/);
      assert.ok(!html.includes('<select'), 'o seletor é um nó estável fora desta string');
      for (const campo of ['piso <b>', 'forjalvl', 'checkpoints', 'perguntas abertas']) assert.ok(!html.includes(campo), campo + ' é campo de run');
    }
    const runHtml = V.renderHeader(run, snap, NOW, 'desktop');
    assert.ok(!runHtml.includes('loose-note'), 'um run verdadeiro não leva o aviso');
    assert.match(runHtml, /piso <b>fable<\/b>/, 'e continua a levar os campos do run');
    // o cartão do Lead: «sessão à espera de input», nunca «run terminado»
    const lead = vs.roster.find(c => c.key === 'lead');
    const card = V.renderCard(lead, vs, snap, NOW);
    assert.match(card, /<span class="chip">sessão<\/span>/);
    assert.match(card, />sessão à espera de input</);
    // «run» só aparece dentro do prompt que o Sponsor escreveu ("…diz que o run
    // parou"), nunca como rótulo da página: nem chip, nem selo de estado.
    assert.ok(!card.includes('<span class="chip">run</span>'), 'o chip diz «sessão»');
    assert.ok(!/class="ist[^"]*">run /.test(card), 'o selo do bloco não diz «run <estado>»');
    assert.ok(!card.includes('mínimo'), 'o piso de modelo é do run, não da sessão');
    const evil = V.renderHeader({ ...vs, project: '<script>alert(1)</script>' }, snap, NOW, 'desktop');
    assert.ok(!evil.includes('<script>') && evil.includes('&lt;script&gt;'));
  });
});
