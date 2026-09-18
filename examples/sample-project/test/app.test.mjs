// HTTP tests for lib/app.mjs, over a real server on an ephemeral port (recipe S0.6 in
// docs/forja/TECHNOLOGY.md): `listen(0, '127.0.0.1')`, a made-up token defined right here, the data
// file inside a temp folder, `fetch` with `redirect: 'manual'`, and `after()` closing every server
// and deleting the folder. Nothing here reads GREET_TOKEN or token.local.txt, so `npm test` passes
// with no token anywhere in the environment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../lib/app.mjs';

// Made up for this file and used nowhere else: it is a fixture, not a credential.
const TOKEN = 'palavra-passe-de-teste-1234';
const WRONG_TOKEN = 'palavra-passe-errada-9999999';

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const JSON_TYPE = { 'Content-Type': 'application/json' };

let root;
const servers = [];
const responses = []; // every response this file saw, for the checks that apply to all of them

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'app-test-'));
});

after(async () => {
  for (const server of servers) {
    server.closeAllConnections(); // `fetch` keeps sockets alive; without this, close() hangs
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
});

/** A server of its own, with its own data file, so no test can see another test's greetings. */
async function startApp({ contents } = {}) {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const dataFile = path.join(dir, 'greetings.json');
  if (contents !== undefined) await writeFile(dataFile, contents, 'utf8');

  const server = createApp({ token: TOKEN, dataFile });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return { server, dataFile, base: `http://127.0.0.1:${port}` };
}

async function call(app, target, options = {}) {
  const res = await fetch(app.base + target, { redirect: 'manual', ...options });
  const text = await res.text();
  const type = res.headers.get('content-type') ?? '';
  responses.push({ target, status: res.status, type, text });
  return { res, text, type };
}

/** What is on disk, or [] when the server never created the file. */
async function saved(app) {
  try {
    return JSON.parse(await readFile(app.dataFile, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

function cookieHeader(token) {
  return { Cookie: `greet=${encodeURIComponent(token)}` };
}

// --- rotas abertas ---------------------------------------------------------------------------

test('GET / redireciona para /historico', async () => {
  const app = await startApp();
  const { res } = await call(app, '/');

  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/historico');
});

test('GET /entrar abre sem token e não mostra a palavra-passe', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/entrar');

  assert.equal(res.status, 200);
  assert.match(text, /Palavra-passe/);
  assert.match(text, /name="token"/);
  assert.ok(!text.includes(TOKEN));
});

test('rota desconhecida -> 404 em português', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/nao-existe', { headers: { 'X-Greet-Token': TOKEN } });

  assert.equal(res.status, 404);
  assert.match(text, /Esta página não existe/);
});

// --- token exigido ---------------------------------------------------------------------------

test('GET /historico sem token -> 401 em português com ligação para /entrar', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/historico');

  assert.equal(res.status, 401);
  assert.match(text, /Precisa de entrar/);
  assert.match(text, /href="\/entrar"/);
  assert.ok(!text.includes(TOKEN));
});

test('GET /historico com o token errado -> 401 igual ao de quem não mandou nenhum', async () => {
  const app = await startApp();
  const semToken = await call(app, '/historico');
  const { res, text } = await call(app, '/historico', {
    headers: { 'X-Greet-Token': WRONG_TOKEN },
  });

  assert.equal(res.status, 401);
  assert.match(text, /href="\/entrar"/);
  // exatamente a mesma página: não diz se o token existe nem o que falhou (D11)
  assert.equal(text, semToken.text);
});

test('?token= no URL não autentica', async () => {
  const app = await startApp();
  const { res, text } = await call(app, `/historico?token=${encodeURIComponent(TOKEN)}`);

  assert.equal(res.status, 401);
  assert.ok(!text.includes(TOKEN));
});

test('pedido JSON sem token -> 401 com { erro } e sem HTML', async () => {
  const app = await startApp();
  const { res, text, type } = await call(app, '/saudacoes', {
    method: 'POST',
    headers: JSON_TYPE,
    body: JSON.stringify({ nome: 'Ana' }),
  });

  assert.equal(res.status, 401);
  assert.match(type, /application\/json/);
  assert.equal(typeof JSON.parse(text).erro, 'string');
  assert.ok(!text.includes(TOKEN));
});

// --- histórico -------------------------------------------------------------------------------

test('GET /historico com x-greet-token -> 200 com o estado vazio', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/historico', { headers: { 'X-Greet-Token': TOKEN } });

  assert.equal(res.status, 200);
  assert.match(text, /Ainda não há saudações guardadas/);
  assert.ok(!text.includes(TOKEN));
});

test('GET /historico só com o cookie da sessão -> 200 (é o caminho do browser)', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/historico', { headers: cookieHeader(TOKEN) });

  assert.equal(res.status, 200);
  assert.match(text, /Ainda não há saudações guardadas/);
  assert.ok(!text.includes(TOKEN));
});

test('cabeçalho errado com cookie certo -> 401: o cabeçalho manda e falha fechado', async () => {
  const app = await startApp();
  const { res } = await call(app, '/historico', {
    headers: { 'X-Greet-Token': WRONG_TOKEN, ...cookieHeader(TOKEN) },
  });

  assert.equal(res.status, 401);
});

test('GET /historico com 3 registos: mais recente primeiro e tabela do gráfico certa', async () => {
  const agora = Date.now();
  const registo = (nome, msAtras) => ({
    id: `id-${nome}`,
    nome,
    saudacao: `Olá, ${nome}!`,
    criado_em: new Date(agora - msAtras).toISOString(),
  });
  const app = await startApp({
    contents: JSON.stringify([registo('Ana', 3000), registo('Beatriz', 2000), registo('Carlos', 1000)]),
  });

  const { res, text } = await call(app, '/historico', { headers: { 'X-Greet-Token': TOKEN } });

  assert.equal(res.status, 200);
  assert.match(text, /3 saudações no total/);

  const iCarlos = text.indexOf('Olá, Carlos!');
  const iBeatriz = text.indexOf('Olá, Beatriz!');
  const iAna = text.indexOf('Olá, Ana!');
  assert.ok(iCarlos > -1 && iBeatriz > -1 && iAna > -1);
  assert.ok(iCarlos < iBeatriz, 'Carlos (o mais recente) tem de vir primeiro');
  assert.ok(iBeatriz < iAna, 'Beatriz tem de vir antes da Ana');

  // Os três são do mesmo dia: a tabela do gráfico tem 13 dias a zero e um dia a 3.
  const celulas = [...text.matchAll(/<td>(\d+)<\/td>/g)].map((m) => Number(m[1]));
  assert.equal(celulas.length, 14);
  assert.equal(celulas.filter((n) => n === 3).length, 1);
  assert.equal(celulas.filter((n) => n === 0).length, 13);
  assert.equal(
    celulas.reduce((a, b) => a + b, 0),
    3,
  );
});

// --- entrar ----------------------------------------------------------------------------------

test('POST /entrar com a palavra-passe certa e Origin igual ao host -> 303 e cookie', async () => {
  const app = await startApp();
  const { res } = await call(app, '/entrar', {
    method: 'POST',
    headers: { ...FORM, Origin: app.base },
    body: `token=${encodeURIComponent(TOKEN)}`,
  });

  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/historico');

  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^greet=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  // session cookie (D19): no lifetime, so it dies when the browser closes, as /entrar promises.
  assert.doesNotMatch(cookie, /Max-Age|Expires/i);
});

test('POST /entrar com Referer igual ao host também serve', async () => {
  const app = await startApp();
  const { res } = await call(app, '/entrar', {
    method: 'POST',
    headers: { ...FORM, Referer: `${app.base}/entrar` },
    body: `token=${encodeURIComponent(TOKEN)}`,
  });

  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie'), /HttpOnly/);
});

test('POST /entrar sem Origin nem Referer -> 403 em português e sem cookie', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/entrar', {
    method: 'POST',
    headers: FORM,
    body: `token=${encodeURIComponent(TOKEN)}`,
  });

  assert.equal(res.status, 403);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.match(text, /não veio da página desta aplicação/);
});

test('POST /entrar com Origin de outro sítio -> 403 e sem cookie', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/entrar', {
    method: 'POST',
    headers: { ...FORM, Origin: 'http://outro-sitio.exemplo' },
    body: `token=${encodeURIComponent(TOKEN)}`,
  });

  assert.equal(res.status, 403);
  assert.equal(res.headers.get('set-cookie'), null);
  // nunca um beco sem saída: a página de erro tem sempre por onde continuar
  assert.match(text, /href="\/entrar"/);
});

test('POST /entrar com a palavra-passe errada -> 401 sem cookie e sem dizer nada', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/entrar', {
    method: 'POST',
    headers: { ...FORM, Origin: app.base },
    body: `token=${encodeURIComponent(WRONG_TOKEN)}`,
  });

  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.match(text, /Não foi possível entrar/);
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(WRONG_TOKEN));
});

// --- guardar saudações -----------------------------------------------------------------------

test('POST /saudacoes em JSON com o cabeçalho -> 201 e um registo no ficheiro', async () => {
  const app = await startApp();
  const { res, text, type } = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...JSON_TYPE, 'X-Greet-Token': TOKEN },
    body: JSON.stringify({ nome: 'Ana' }),
  });

  assert.equal(res.status, 201);
  assert.match(type, /application\/json/);
  assert.equal(JSON.parse(text).saudacao, 'Olá, Ana!');

  const registos = await saved(app);
  assert.equal(registos.length, 1);
  assert.equal(registos[0].nome, 'Ana');
  assert.equal(registos[0].saudacao, 'Olá, Ana!');
  assert.equal(typeof registos[0].id, 'string');
  assert.match(registos[0].criado_em, /^\d{4}-\d{2}-\d{2}T/);
  // D10: id, nome, saudação e data/hora — e mais nada (sem IP, sem user-agent)
  assert.deepEqual(Object.keys(registos[0]).sort(), ['criado_em', 'id', 'nome', 'saudacao']);
});

test('POST /saudacoes só com o cookie e sem Origin/Referer -> 403 e nada gravado', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...FORM, ...cookieHeader(TOKEN) },
    body: 'nome=Ana',
  });

  assert.equal(res.status, 403);
  assert.match(text, /não veio da página desta aplicação/);
  assert.deepEqual(await saved(app), []);
});

test('POST /saudacoes com o cookie e Origin igual -> 303 e o registo fica gravado', async () => {
  const app = await startApp();
  const { res } = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...FORM, ...cookieHeader(TOKEN), Origin: app.base },
    body: 'nome=Ana+Sofia',
  });

  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/historico');

  const registos = await saved(app);
  assert.equal(registos.length, 1);
  assert.equal(registos[0].nome, 'Ana Sofia');
  assert.equal(registos[0].saudacao, 'Olá, Ana Sofia!');
});

test('POST /saudacoes com o cookie e Origin de outro sítio -> 403 e nada gravado', async () => {
  const app = await startApp();
  const { res } = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...FORM, ...cookieHeader(TOKEN), Origin: 'http://outro-sitio.exemplo' },
    body: 'nome=Ana',
  });

  assert.equal(res.status, 403);
  assert.deepEqual(await saved(app), []);
});

test('POST /saudacoes com corpo de 5000 bytes -> 413 em português e nada gravado', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...FORM, 'X-Greet-Token': TOKEN },
    body: `nome=${'a'.repeat(5000)}`,
  });

  assert.equal(res.status, 413);
  assert.match(text, /demasiado grande/);
  assert.deepEqual(await saved(app), []);
});

test('POST /saudacoes com nome vazio -> 400 com a mensagem no formulário', async () => {
  const app = await startApp();
  const { res, text } = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...FORM, 'X-Greet-Token': TOKEN },
    body: 'nome=%20%20',
  });

  assert.equal(res.status, 400);
  assert.match(text, /Não foi possível guardar/);
  assert.match(text, /aria-invalid="true"/);
  assert.deepEqual(await saved(app), []);
});

test('POST /saudacoes com nome de 81 caracteres -> 400 no formulário e em JSON', async () => {
  const app = await startApp();
  const nome = 'a'.repeat(81);

  const form = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...FORM, 'X-Greet-Token': TOKEN },
    body: `nome=${nome}`,
  });
  assert.equal(form.res.status, 400);
  assert.match(form.text, /Não foi possível guardar/);

  const json = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...JSON_TYPE, 'X-Greet-Token': TOKEN },
    body: JSON.stringify({ nome }),
  });
  assert.equal(json.res.status, 400);
  assert.match(JSON.parse(json.text).erro, /1 a 80 caracteres/);

  assert.deepEqual(await saved(app), []);

  // 80 caracteres, o limite exato, passa
  const limite = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...JSON_TYPE, 'X-Greet-Token': TOKEN },
    body: JSON.stringify({ nome: 'a'.repeat(80) }),
  });
  assert.equal(limite.res.status, 201);
  assert.equal((await saved(app)).length, 1);
});

test('um nome com HTML é gravado tal e qual e sai escapado na página', async () => {
  const app = await startApp();
  const nome = '<script>alert("oi")</script>';

  const criado = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...JSON_TYPE, 'X-Greet-Token': TOKEN },
    body: JSON.stringify({ nome }),
  });
  assert.equal(criado.res.status, 201);
  assert.equal((await saved(app))[0].nome, nome);

  const pagina = await call(app, '/historico', { headers: { 'X-Greet-Token': TOKEN } });
  assert.equal(pagina.res.status, 200);
  assert.match(pagina.text, /&lt;script&gt;alert\(&quot;oi&quot;\)&lt;\/script&gt;/);
  assert.ok(!pagina.text.includes('<script'));
});

test('5 POST simultâneos -> 5 registos no ficheiro, nenhum perdido', async () => {
  const app = await startApp();
  const nomes = ['Ana', 'Beatriz', 'Carlos', 'Daniela', 'Eduardo'];

  const respostas = await Promise.all(
    nomes.map((nome) =>
      call(app, '/saudacoes', {
        method: 'POST',
        headers: { ...JSON_TYPE, 'X-Greet-Token': TOKEN },
        body: JSON.stringify({ nome }),
      }),
    ),
  );

  for (const { res } of respostas) assert.equal(res.status, 201);

  const registos = await saved(app);
  assert.equal(registos.length, 5);
  assert.deepEqual(
    registos.map((r) => r.nome).sort(),
    [...nomes].sort(),
  );
  assert.equal(new Set(registos.map((r) => r.id)).size, 5);
});

// --- ficheiro de dados ilegível ----------------------------------------------------------------

test('ficheiro de dados inválido -> 500 que diz o caminho, e os bytes ficam iguais', async () => {
  const conteudo = '{ isto não é uma lista de saudações';
  const app = await startApp({ contents: conteudo });
  const antes = await readFile(app.dataFile);

  const pagina = await call(app, '/historico', { headers: { 'X-Greet-Token': TOKEN } });
  assert.equal(pagina.res.status, 500);
  assert.match(pagina.text, /Nenhuma saudação se perdeu/);
  assert.ok(pagina.text.includes(app.dataFile), 'a página tem de dizer o caminho do ficheiro');
  assert.ok(!/<\/?(script|pre)[ >]/.test(pagina.text), 'sem stack trace na página');

  const api = await call(app, '/saudacoes', {
    method: 'POST',
    headers: { ...JSON_TYPE, 'X-Greet-Token': TOKEN },
    body: JSON.stringify({ nome: 'Ana' }),
  });
  assert.equal(api.res.status, 500);
  assert.equal(typeof JSON.parse(api.text).erro, 'string');

  const depois = await readFile(app.dataFile);
  assert.deepEqual(depois, antes, 'o ficheiro ilegível nunca é tocado');
  assert.equal(depois.toString('utf8'), conteudo);
});

// --- o que vale para todas as respostas ---------------------------------------------------------

test('todas as respostas deste ficheiro: utf-8, sem token, sem <script e sem http://', () => {
  assert.ok(responses.length > 25, `poucas respostas recolhidas: ${responses.length}`);

  for (const { target, status, type, text } of responses) {
    const onde = `${target} (${status})`;
    assert.match(type, /charset=utf-8/, `sem charset=utf-8 em ${onde}`);
    assert.ok(!text.includes(TOKEN), `resposta ecoa o token em ${onde}`);
    assert.ok(!text.includes(WRONG_TOKEN), `resposta ecoa o que foi enviado em ${onde}`);
    if (type.startsWith('text/html')) {
      assert.ok(!text.includes('<script'), `HTML com <script em ${onde}`);
      assert.ok(!text.includes('http://'), `HTML com http:// em ${onde}`);
      assert.ok(!text.includes('https://'), `HTML com https:// em ${onde}`);
    }
  }
});

// Duas regras que não se veem numa resposta HTTP e por isso se afirmam sobre o próprio ficheiro:
// nada é escrito para log nenhum (um `console.log(req.headers)` deixado para trás publicaria a
// palavra-passe no terminal, D11), e o módulo só importa node:http, node:crypto e módulos deste
// projeto (S0.1/S0.3 — nenhuma dependência nova).
test('lib/app.mjs não escreve em log nenhum e só usa node:http, node:crypto e ./', async () => {
  const fonte = await readFile(new URL('../lib/app.mjs', import.meta.url), 'utf8');

  const semComentarios = fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  assert.ok(
    !/\bconsole\s*\./.test(semComentarios),
    'lib/app.mjs não pode registar nada: um log do pedido publica cabeçalhos, cookies e a palavra-passe',
  );
  assert.ok(!/\bprocess\.std(out|err)\b/.test(semComentarios), 'nada escrito para stdout/stderr');

  const origens = [...semComentarios.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.ok(origens.length > 0, 'não foi encontrado nenhum import — o regex partiu-se');
  const permitidos = new Set(['node:http', 'node:crypto']);
  for (const origem of origens) {
    assert.ok(
      permitidos.has(origem) || origem.startsWith('./'),
      `import proibido em lib/app.mjs: ${origem}`,
    );
  }
});
