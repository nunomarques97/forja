import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyPage, loginPage, errorPage } from '../lib/pages.mjs';
import { countByDay } from '../lib/stats.mjs';

// Fixed "today" so results are deterministic. 2026-06-20T09:00:00Z is 10:00 in Lisbon (WEST).
const TODAY = new Date('2026-06-20T09:00:00Z');

function countLi(html) {
  return [...html.matchAll(/<li>/g)].length;
}

function h1Count(html) {
  return [...html.matchAll(/<h1[ >]/g)].length;
}

// --- historyPage --------------------------------------------------------------------------

test('historyPage with 3 records on different days: newest first, chart table matches countByDay', () => {
  const records = [
    { id: '1', nome: 'Ana', saudacao: 'Olá, Ana!', criado_em: '2026-06-15T10:00:00Z' },
    { id: '2', nome: 'Bruno', saudacao: 'Olá, Bruno!', criado_em: '2026-06-20T08:00:00Z' }, // today
    { id: '3', nome: 'Carla', saudacao: 'Olá, Carla!', criado_em: '2026-06-18T10:00:00Z' },
  ];
  const html = historyPage({ records, today: TODAY });

  // newest first: Bruno (20 June), then Carla (18 June), then Ana (15 June)
  const iBruno = html.indexOf('Olá, Bruno!');
  const iCarla = html.indexOf('Olá, Carla!');
  const iAna = html.indexOf('Olá, Ana!');
  assert.ok(iBruno > -1 && iCarla > -1 && iAna > -1);
  assert.ok(iBruno < iCarla);
  assert.ok(iCarla < iAna);

  // the chart's text table has the same numbers countByDay would produce for these records
  const expected = countByDay(records, { today: TODAY });
  const tableCells = [...html.matchAll(/<td>(\d+)<\/td>/g)].map((m) => Number(m[1]));
  assert.deepEqual(tableCells, expected.map((d) => d.count));
  assert.equal(tableCells.reduce((a, b) => a + b, 0), 3);

  // total line: 3 total, 1 today
  assert.match(html, /3 saudações no total, 1 de hoje\. As mais recentes primeiro\./);
});

test('historyPage with 150 records shows only 100 items and the total says 150', () => {
  const records = Array.from({ length: 150 }, (_, i) => ({
    id: String(i),
    nome: `Pessoa ${i}`,
    saudacao: `Olá, Pessoa ${i}!`,
    criado_em: new Date(TODAY.getTime() - i * 60_000).toISOString(),
  }));
  const html = historyPage({ records, today: TODAY });

  assert.equal(countLi(html), 100);
  assert.match(html, /150 saudações no total, \d+ de hoje\. A mostrar as 100 mais recentes\./);
  // the 100 shown are the most recent (index 0..99), not the oldest
  assert.ok(html.includes('Olá, Pessoa 0!'));
  assert.ok(html.includes('Olá, Pessoa 99!'));
  assert.ok(!html.includes('Olá, Pessoa 100!'));
  assert.ok(!html.includes('Olá, Pessoa 149!'));
});

test('historyPage with no records shows the empty state (list block), chart block stays', () => {
  const html = historyPage({ records: [], today: TODAY });
  assert.match(html, /Ainda não há saudações guardadas\./);
  assert.doesNotMatch(html, /<ul class="lista">/);
  // the chart block is still there, 14 zero bars
  assert.equal([...html.matchAll(/<rect\b/g)].length, 14);
  assert.equal([...html.matchAll(/<td>(\d+)<\/td>/g)].every((m) => m[1] === '0'), true);
});

test('a greeting containing <script> is escaped, never raw markup', () => {
  const records = [
    {
      id: '1',
      nome: '<script>alert(1)</script>',
      saudacao: 'Olá, <script>alert(1)</script>!',
      criado_em: '2026-06-20T08:00:00Z',
    },
  ];
  const html = historyPage({ records, today: TODAY });
  assert.doesNotMatch(html, /<script/i);
  assert.ok(html.includes('Olá, &lt;script&gt;alert(1)&lt;/script&gt;!'));
});

test('historyPage shows the form error message when error is truthy, and the rest of the page stays', () => {
  const records = [{ id: '1', nome: 'Ana', saudacao: 'Olá, Ana!', criado_em: '2026-06-20T08:00:00Z' }];
  const html = historyPage({ records, today: TODAY, error: true });
  assert.match(html, /<p class="erro-campo" id="erro-nome"><strong>Não foi possível guardar\.<\/strong>/);
  assert.match(html, /aria-invalid="true" aria-describedby="erro-nome"/);
  // the existing greeting is still listed
  assert.ok(html.includes('Olá, Ana!'));
});

test('historyPage has the required form controls: label for, input, button', () => {
  const html = historyPage({ records: [], today: TODAY });
  assert.match(html, /<label for="nome">Nome de quem quer cumprimentar<\/label>/);
  assert.match(html, /<input id="nome" name="nome" type="text" maxlength="80" required autocomplete="off"/);
  assert.match(html, /<button type="submit">Guardar saudação<\/button>/);
  assert.match(html, /<form method="post" action="\/saudacoes">/);
});

test('historyPage: full document shape (doctype, lang, single h1, main, no JS, no http(s))', () => {
  const html = historyPage({ records: [], today: TODAY });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="pt">/);
  assert.match(html, /<title>Saudações<\/title>/);
  assert.equal(h1Count(html), 1);
  assert.match(html, /<main>/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /http:\/\//);
  assert.doesNotMatch(html, /https:\/\//);
});

// --- loginPage -----------------------------------------------------------------------------

test('loginPage has the password form and never echoes a value', () => {
  const html = loginPage({});
  assert.match(html, /<html lang="pt">/);
  assert.match(html, /<label for="token">Palavra-passe<\/label>/);
  assert.match(html, /<input id="token" name="token" type="password" autocomplete="off" required>/);
  assert.match(html, /<button type="submit">Entrar<\/button>/);
  assert.doesNotMatch(html, /value="/);
  assert.equal(h1Count(html), 1);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /http:\/\//);
  assert.doesNotMatch(html, /https:\/\//);
});

test('loginPage with error shows the wrong-password message, never says whether a token exists', () => {
  const html = loginPage({ error: true });
  assert.match(html, /<p class="erro-campo" id="erro-token"><strong>Não foi possível entrar\.<\/strong>/);
  assert.match(html, /aria-invalid="true" aria-describedby="erro-token"/);
  assert.doesNotMatch(html, /value="/);
});

// --- errorPage -----------------------------------------------------------------------------

test('errorPage 401 links to /entrar and shows the code, no stack trace', () => {
  const html = errorPage({ status: 401 });
  assert.match(html, /<html lang="pt">/);
  assert.match(html, /<h1>Precisa de entrar<\/h1>/);
  assert.match(html, /Esta página só abre depois de escrever a palavra-passe da equipa\./);
  assert.match(html, /<a class="acao" href="\/entrar">Ir para a página de entrada<\/a>/);
  assert.match(html, /<p class="codigo">Código 401\.<\/p>/);
  assert.equal(h1Count(html), 1);
  assert.doesNotMatch(html, /at Object|at Module|\.mjs:\d+/); // no stack-trace-looking text
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /http:\/\//);
  assert.doesNotMatch(html, /https:\/\//);
});

test('errorPage 404 links back to /historico', () => {
  const html = errorPage({ status: 404 });
  assert.match(html, /<h1>Esta página não existe<\/h1>/);
  assert.match(html, /<a class="acao" href="\/historico">Voltar às saudações<\/a>/);
  assert.match(html, /Código 404\./);
});

test('errorPage 413 says nothing was saved and links back to /historico', () => {
  const html = errorPage({ status: 413 });
  assert.match(html, /<h1>O nome que enviou é demasiado grande<\/h1>/);
  assert.match(html, /Nada foi gravado\./);
  assert.match(html, /<a class="acao" href="\/historico">Voltar às saudações<\/a>/);
});

test('errorPage 500 has no link (nothing to show someone who is not authenticated)', () => {
  const html = errorPage({ status: 500 });
  assert.match(html, /<h1>Não foi possível ler as saudações guardadas<\/h1>/);
  assert.doesNotMatch(html, /<a class="acao"/);
  assert.match(html, /Código 500\./);
});

test('errorPage linkToLogin forces the /entrar link regardless of status', () => {
  const html = errorPage({ status: 500, linkToLogin: true });
  assert.match(html, /<a class="acao" href="\/entrar">Ir para a página de entrada<\/a>/);
});
