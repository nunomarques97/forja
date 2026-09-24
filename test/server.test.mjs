// viewer/server.mjs against a temp data dir: token auth, host guard, state
// snapshot, SSE state push on append, raw record on demand, answers endpoint,
// rotation handling. Never touches data/events.jsonl.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'forja-server-test-'));
const dataDir = join(dir, 'data');
mkdirSync(dataDir, { recursive: true });
const eventsFile = join(dataDir, 'events.jsonl');
const port = 43600 + Math.floor(Math.random() * 300);
const fixture = readFileSync(join(here, 'fixtures', 'happy-path.jsonl'), 'utf8');
writeFileSync(eventsFile, fixture);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server; let token; let banner = '';

const httpOn = p => (path, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: p, path, method, headers: { Host: `127.0.0.1:${p}`, ...headers } }, resp => {
    let data = ''; resp.on('data', d => { data += d; }); resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: data }));
  });
  req.on('error', reject); if (body) req.write(body); req.end();
});
const http = httpOn(port);

before(async () => {
  server = spawn(process.execPath, [join(here, '..', 'viewer', 'server.mjs')], { env: { ...process.env, PORT: String(port), FORJA_DATA_DIR: dataDir, FORJA_NO_WATCHDOG: '1', FORJA_NTFY_SERVER: 'http://127.0.0.1:9', FORJA_ALLOWED_HOSTS: 'forja.exemplo.test' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { banner += String(d); if (banner.includes('Forja viewer')) resolve(); }); server.on('exit', c => reject(new Error(`server exited early ${c}`))); });
  token = readFileSync(join(dataDir, 'viewer-token.txt'), 'utf8').trim();
});
after(() => { server.kill(); rmSync(dir, { recursive: true, force: true }); });

describe('auth', () => {
  test('no token → 401 with no data; wrong token → 401; right token → cookie + redirect; cookie works', async () => {
    assert.equal((await http('/state')).status, 401);
    assert.equal((await http('/state?k=deadbeef')).status, 401);
    const r = await http(`/state?k=${token}`);
    assert.equal(r.status, 302);
    assert.match(r.headers['set-cookie'][0], /forja_k=.*HttpOnly/);
    assert.equal(r.headers.location, '/state');
    const ok = await http('/state', { headers: { Cookie: `forja_k=${token}` } });
    assert.equal(ok.status, 200);
    assert.equal((await http('/health')).status, 200, '/health needs no token and says nothing else');
  });
  // T-SEC-1, tentativa 3: a saída de `forja serve`/`forja up` é capturada pelo
  // hook para data/events.jsonl — um token impresso no arranque ficava lá vivo.
  test('o arranque não imprime o token (nem um link com ?k=): só o endereço e onde está o ficheiro', async () => {
    await sleep(150); // as linhas seguintes à primeira podem vir noutro pedaço
    assert.ok(!banner.includes(token), 'o token nunca vai para o stdout');
    assert.ok(!banner.includes('?k='), 'nem sequer um link com o parâmetro');
    assert.match(banner, new RegExp(`Forja viewer: http://127\\.0\\.0\\.1:${port}/\\s`));
    assert.match(banner, /viewer-token\.txt/, 'diz onde está o token, sem o dizer');
  });
  test('foreign Host header → 403 even with the token (DNS rebinding guard)', async () => {
    const r = await http('/state', { headers: { Host: `evil.example:${port}`, Cookie: `forja_k=${token}` } });
    assert.equal(r.status, 403);
  });
});

// T-SEC-1: the ntfy link stopped carrying the token, so the two HTML pages ask
// for it once instead of being a dead end. Everything else stays 401.
describe('página de entrada e POST /login', () => {
  const form = (fields, headers = {}) => http('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(fields).toString(),
  });

  test('GET / e /m sem cookie → 200 com o formulário; as outras rotas continuam 401', async () => {
    for (const [path, next] of [['/', '/'], ['/m', '/m'], ['/m/', '/m']]) {
      const r = await http(path);
      assert.equal(r.status, 200, `${path} devia dar a página de entrada`);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.match(r.body, /<form method="post" action="\/login">/);
      assert.ok(r.body.includes(`name="next" value="${next}"`), `o formulário volta para ${next}`);
      assert.match(r.body, /viewer-token\.txt/, 'diz onde está o token');
      assert.ok(!r.body.includes(token), 'a página nunca mostra o token');
      assert.ok(!r.body.includes('<script'), 'sem script nenhum');
    }
    for (const path of ['/state', '/events', '/projects', '/assets/viewer.css', '/feed']) {
      assert.equal((await http(path)).status, 401, `${path} sem cookie continua 401`);
    }
    assert.equal((await http('/', { method: 'POST', body: 'x' })).status, 401, 'só GET dá o formulário');
  });

  test('um ?k= certo continua a funcionar; um errado devolve o formulário com o aviso, sem detalhes', async () => {
    const ok = await http(`/m?k=${token}`);
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.location, '/m');
    assert.match(ok.headers['set-cookie'][0], /forja_k=.*HttpOnly.*SameSite=Lax/);
    const bad = await http('/m?k=deadbeef');
    assert.equal(bad.status, 200);
    assert.match(bad.body, /Incorrect token/);
    assert.ok(!bad.body.includes(token));
    assert.equal((await http('/state?k=deadbeef')).status, 401, 'fora das duas páginas continua 401');
  });

  test('POST /login com o token certo → cookie + 302 para a página pedida, e o cookie serve', async () => {
    const r = await form({ k: `  ${token}\n`, next: '/m' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/m');
    const cookie = r.headers['set-cookie'][0];
    // 30 dias (não um ano): um telemóvel perdido ou emprestado deixa de ser uma
    // porta para o PC ao fim de um mês, e o token é uma colagem.
    assert.match(cookie, /^forja_k=[a-f0-9]{32,}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/);
    const after = await http('/state', { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(after.status, 200, 'o cookie do formulário é o mesmo que o do ?k=');
    const outside = await form({ k: token, next: 'https://evil.example/x' });
    assert.equal(outside.headers.location, '/', 'um next de fora volta para /, nunca para outro sítio');
  });

  // Em loopback a flag `Secure` impediria o browser de guardar o cookie (http);
  // atrás do túnel o browser fala https com a Cloudflare e o cloudflared
  // reencaminha `X-Forwarded-Proto: https` — aí o cookie nunca pode viajar em claro.
  test('o cookie leva `Secure` fora do loopback (X-Forwarded-Proto ou Host do túnel) e não o leva em 127.0.0.1', async () => {
    const local = await form({ k: token, next: '/' });
    assert.ok(!/;\s*Secure/i.test(local.headers['set-cookie'][0]), 'http://127.0.0.1 continua a funcionar');
    const fwd = await form({ k: token, next: '/' }, { 'X-Forwarded-Proto': 'https' });
    assert.match(fwd.headers['set-cookie'][0], /; Secure$/);
    const tunnel = await http(`/m?k=${token}`, { headers: { Host: 'forja.exemplo.test' } });
    assert.equal(tunnel.status, 302);
    assert.match(tunnel.headers['set-cookie'][0], /; Secure$/, 'um Host que não é loopback basta');
  });

  test('POST /login recusado: outra origem → 403, corpo acima de 1 KB → 413', async () => {
    assert.equal((await form({ k: token, next: '/' }, { Origin: 'https://evil.example', Referer: 'https://evil.example/' })).status, 403);
    const big = await form({ k: 'a'.repeat(2000), next: '/' });
    assert.equal(big.status, 413);
  });

  // Regressão da tentativa 1 (REJECT do Reviewer, provado com Chrome real): a
  // página manda `Referrer-Policy: no-referrer` e, pela spec do Fetch, uma
  // navegação não-GET a partir de uma página dessas leva `Origin: null` — é
  // exatamente isto que o browser envia ao submeter este formulário. Recusá-lo
  // deixava à porta o Sponsor com o token certo. O token é a própria prova: uma
  // submissão forjada de outro sítio não ganha nada, porque quem consegue enviar
  // o token já o tem.
  test('POST /login como o browser real o envia (Origin: null, sem Referer) → 302 + cookie; /runs continua a recusar Origin: null', async () => {
    const r = await form({ k: token, next: '/m' }, { Origin: 'null' });
    assert.equal(r.status, 302, 'o formulário da própria página tem de deixar entrar');
    assert.equal(r.headers.location, '/m');
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    assert.equal((await http('/state', { headers: { Cookie: cookie } })).status, 200, 'o cookie que ele devolve serve mesmo');
    const runs = await http('/runs', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    assert.equal(runs.status, 403, 'a rota que lança processos mantém o 403 a Origin: null');
  });
});

// O travão vive no processo do viewer e conta por endereço de cliente: este
// bloco arranca o seu para contar do zero (e para não gastar as tentativas dos
// testes acima, que também falham tokens de propósito).
describe('travão de tentativas: 5 por minuto, no formulário e no ?k=', () => {
  const dir2 = mkdtempSync(join(tmpdir(), 'forja-server-brake-'));
  const dataDir2 = join(dir2, 'data');
  mkdirSync(dataDir2, { recursive: true });
  const port2 = 43950 + Math.floor(Math.random() * 40);
  const h = httpOn(port2);
  const form2 = (k, next = '/m') => h('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ k, next }).toString() });
  const timed = async fn => { const t0 = Date.now(); const r = await fn(); return { r, ms: Date.now() - t0 }; };
  let srv2; let token2;
  before(async () => {
    srv2 = spawn(process.execPath, [join(here, '..', 'viewer', 'server.mjs')], { env: { ...process.env, PORT: String(port2), FORJA_DATA_DIR: dataDir2, FORJA_NO_WATCHDOG: '1', FORJA_NTFY_SERVER: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => { srv2.stdout.on('data', d => { if (String(d).includes('Forja viewer')) resolve(); }); srv2.on('exit', c => reject(new Error(`server exited early ${c}`))); });
    token2 = readFileSync(join(dataDir2, 'viewer-token.txt'), 'utf8').trim();
  });
  after(() => { srv2.kill(); rmSync(dir2, { recursive: true, force: true }); });

  test('cada falha custa ~1 s e uma vaga (formulário ou ?k=); à 6.ª → 429 com o destino certo; o token certo entra mesmo no minuto travado', async () => {
    for (let i = 1; i <= 3; i++) {
      const { r, ms } = await timed(() => form2(`nao-e-o-token-${i}`));
      assert.equal(r.status, 200, `tentativa ${i}`);
      assert.match(r.body, /Incorrect token/);
      assert.ok(!r.headers['set-cookie'], 'nenhum cookie numa tentativa falhada');
      assert.ok(!/[a-f0-9]{32,}/.test(r.body), 'a resposta não diz nada sobre o token');
      assert.ok(ms >= 900, `a tentativa ${i} demorou ${ms} ms — devia custar ~1 s`);
    }
    const k4 = await timed(() => h('/m?k=nao-e-o-token-4'));
    assert.equal(k4.r.status, 200); assert.match(k4.r.body, /Incorrect token/);
    assert.ok(k4.ms >= 900, `o ?k= errado devia custar o mesmo segundo (${k4.ms} ms)`);
    const k5 = await timed(() => h('/state?k=nao-e-o-token-5'));
    assert.equal(k5.r.status, 401, 'fora das duas páginas continua 401');
    assert.ok(k5.ms >= 900, `e também conta e atrasa (${k5.ms} ms)`);

    const blocked = await form2('nao-e-o-token-6', '/m');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['retry-after'], '60');
    assert.match(blocked.body, /Too many attempts/);
    assert.ok(blocked.body.includes('name="next" value="/m"'), 'a página de 429 não perde o destino');
    assert.ok((await h('/?k=ainda-errado')).body.includes('name="next" value="/"'), 'e no PC volta para /');

    // O token é validado antes de se consultar o bloqueio: atrás do túnel o
    // travão é global (uma só ligação), e ninguém pode manter o Sponsor de fora.
    const good = await form2(token2, '/m');
    assert.equal(good.status, 302, 'o Sponsor com o token certo nunca fica de fora');
    assert.match(good.headers['set-cookie'][0], /forja_k=[a-f0-9]{32,}; HttpOnly/);
    assert.equal((await h(`/m?k=${token2}`)).status, 302, 'e o ?k= certo também');
  });
});

describe('state and records', () => {
  const auth = () => ({ Cookie: `forja_k=${token}` });
  test('/state is the reducer snapshot with the fixture run', async () => {
    const snap = JSON.parse((await http('/state', { headers: auth() })).body);
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.runs[0].project, 'sample-project');
    assert.equal(snap.runs[0].roster.length, 10);
    assert.equal(snap.runs[0].roster[0].name, 'Lead');
    assert.equal(snap.runs[0].tasks.length, 2);
  });
  test('/feed serves the key-events feed of the projects in data/projects.json; the raw view is gone (/raw → 404)', async () => {
    assert.equal((await http('/raw/3', { headers: auth() })).status, 404, 'no raw record route any more');
    writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ version: 1, projects: [{ name: 'sample-project', path: join(dir, 'no-such-folder') }] }));
    const f = JSON.parse((await http('/feed', { headers: auth() })).body);
    assert.deepEqual(f.agora.map(p => p.projeto), ['sample-project']);
    assert.ok(f.itens.length > 0, 'the fixture\'s delegations and verdicts reach the feed');
    assert.ok(f.itens.some(x => x.tipo === 'volta'), 'delegations are grouped into rounds');
    assert.ok(f.itens.every(x => x.projeto === 'sample-project'));
    rmSync(join(dataDir, 'projects.json'));
  });
  test('/events pushes a state snapshot on connect and again after an append (no reload)', async () => {
    const chunks = [];
    const req = request({ host: '127.0.0.1', port, path: '/events', headers: { Host: `127.0.0.1:${port}`, ...auth() } }, resp => { resp.on('data', d => chunks.push(String(d))); });
    req.end();
    await sleep(700);
    assert.match(chunks.join(''), /event: state/);
    const before = (chunks.join('').match(/event: state/g) || []).length;
    appendFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), project: 'sample-project', session_id: 'run-0001-aaaa-bbbb-cccc-000000000001', cwd: 'C:\\x', hook_event_name: 'Forja', forja: { kind: 'progress', text: 'push de teste' } }) + '\n');
    await sleep(1500);
    const after = (chunks.join('').match(/event: state/g) || []).length;
    assert.ok(after > before, `expected a new state push (${before} → ${after})`);
    const last = chunks.join('').split('event: state').at(-1);
    assert.match(last, /push de teste/);
    req.destroy();
  });
  test('POST /answers stores the answer for the lead and marks the question pending in the state', async () => {
    const r = await http('/answers', { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'sample-project', id: 'Q1', answer: 'não publicar, obrigado' }) });
    assert.equal(r.status, 200);
    const stored = readFileSync(join(dataDir, 'answers', 'sample-project.jsonl'), 'utf8');
    assert.match(stored, /não publicar, obrigado/);
    await sleep(1200);
    const snap = JSON.parse((await http('/state', { headers: auth() })).body);
    assert.equal(snap.runs[0].queue[0].status, 'pending');
    const bad = await http('/answers', { method: 'POST', headers: auth(), body: JSON.stringify({ project: '../x', id: 'nope', answer: '' }) });
    assert.equal(bad.status, 400);
    const unknown = await http('/answers', { method: 'POST', headers: auth(), body: JSON.stringify({ project: 'sample-project', id: 'Q99', answer: 'x' }) });
    assert.equal(unknown.status, 404, 'no such open question → 404, no ghost run');
    const nullBody = await http('/answers', { method: 'POST', headers: auth(), body: 'null' });
    assert.equal(nullBody.status, 400);
    const big = await http('/answers', { method: 'POST', headers: auth(), body: JSON.stringify({ project: 'sample-project', id: 'Q1', answer: 'a'.repeat(70 * 1024) }) });
    assert.equal(big.status, 413);
    assert.equal((await http('/health')).status, 200, 'server still up after hostile inputs');
    assert.equal((await http('/state?k=%E0%A4%A')).status, 401, 'malformed multibyte token → 401, no crash');
    assert.equal((await http('/state', { headers: { Cookie: 'forja_k=%' } })).status, 401);
  });
  test('rotation: the file is renamed and a fresh one started; nothing is lost and new lines still arrive', async () => {
    renameSync(eventsFile, join(dataDir, 'events.2026-09-17T00-00-00-000Z.jsonl'));
    writeFileSync(eventsFile, JSON.stringify({ ts: new Date().toISOString(), project: 'sample-project', session_id: 'run-0001-aaaa-bbbb-cccc-000000000001', cwd: 'C:\\x', hook_event_name: 'Forja', forja: { kind: 'progress', text: 'depois da rotação' } }) + '\n');
    await sleep(1500);
    const snap = JSON.parse((await http('/state', { headers: auth() })).body);
    assert.equal(snap.runs.length, 1, 'history kept after rotation');
    assert.equal(snap.runs[0].tasks.length, 2);
    const fixtureLines = fixture.split('\n').filter(l => l.trim()).length;
    assert.equal(snap.lines, fixtureLines + 3, 'fixture + progress push + answer.pending + post-rotation line, none lost');
    assert.match(JSON.stringify(snap.runs[0].timeline.slice(-3)), /rotação|push de teste|respondeu/);
  });
});

describe('a body split across chunks', () => {
  // Same hazard as POST /runs: over the tunnel the body arrives in several TCP
  // segments and a boundary can fall inside a multibyte character. Decoding each
  // chunk on its own would store two U+FFFD instead of the character.
  test('POST /answers keeps an accented answer intact when the cut is inside a «ç»', async () => {
    const answer = 'não publicar; a configuração de produção fica como está — ação adiada';
    const buf = Buffer.from(JSON.stringify({ project: 'sample-project', id: 'Q1', answer }), 'utf8');
    const at = buf.indexOf(Buffer.from('ç', 'utf8')) + 1;
    assert.ok(at > 1, 'o corpo tem mesmo um ç');
    const r = await new Promise((resolve, reject) => {
      const headers = { Host: `127.0.0.1:${port}`, Cookie: `forja_k=${token}`, 'Content-Type': 'application/json', 'Content-Length': buf.length };
      const req = request({ host: '127.0.0.1', port, path: '/answers', method: 'POST', headers }, resp => {
        let data = ''; resp.setEncoding('utf8'); resp.on('data', d => { data += d; }); resp.on('end', () => resolve({ status: resp.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(buf.subarray(0, at));
      setTimeout(() => req.end(buf.subarray(at)), 25);
    });
    assert.equal(r.status, 200, r.body);
    const stored = readFileSync(join(dataDir, 'answers', 'sample-project.jsonl'), 'utf8').trim().split('\n').at(-1);
    assert.equal(JSON.parse(stored).answer, answer, 'a resposta ficou guardada exatamente como foi enviada');
    assert.ok(!stored.includes('�'), 'nenhum caractere partido');
  });
});

import { watchdogPlan as wp2 } from '../viewer/server.mjs';
describe('watchdog plan (pure)', () => {
  const now = Date.now();
  const run = (over = {}) => ({ id: 'R-x', project: 'p', synthetic: false, lastEventAt: now - 60_000, main: { permission: null }, forja: { runner: null }, roster: [{ state: 'a trabalhar', since: now, detail: '' }, { name: 'Backend Dev', instances: [{ key: 'k1', state: 'morto', task: 'T1' }] }], ...over });
  test('a dead subagent notifies in an interactive run but not under the runner; a dead or stopped main session always does', () => {
    assert.deepEqual(wp2({ runs: [run()] }, now).map(n => n.key), ['R-x|dead|k1']);
    assert.deepEqual(wp2({ runs: [run({ forja: { runner: { phase: 'task' }, status: 'running' } })] }, now), []);
    const dead = run({ forja: { runner: { phase: 'task' }, status: 'running' }, roster: [{ state: 'morto', since: now - 1, detail: 'runner sem sinal' }, { name: 'Backend Dev', instances: [] }] });
    assert.deepEqual(wp2({ runs: [dead] }, now).map(n => [n.key, n.priority]), [['R-x|main-dead|' + (now - 1), 'urgent']]);
    const stopped = run({ roster: [{ state: 'precisa do Sponsor', since: 5, detail: 'o runner parou (x) — relançar' }, { name: 'Backend Dev', instances: [] }] });
    assert.match(wp2({ runs: [stopped] }, now)[0].message, /o runner parou/);
    assert.deepEqual(wp2({ runs: [run({ lastEventAt: now - 13 * 3600_000 })] }, now), [], 'runs silent for half a day are history');
    assert.deepEqual(wp2({ runs: [run({ synthetic: true })] }, now), [], 'synthetic runs never notify');
  });
  test('a dead subagent does not notify once its parent session ended, its legacy run closed or Core drives the project', () => {
    assert.deepEqual(wp2({ runs: [run({ endedAt: now - 40 * 60_000 })] }, now), [], 'parent session ended');
    assert.deepEqual(wp2({ runs: [run({ forja: { runner: null, status: 'failed' } })] }, now), [], 'legacy run already failed');
    assert.deepEqual(wp2({ runs: [run({ forja: { runner: null, status: 'finished' } })] }, now), [], 'legacy run already finished');
    const mainGone = run({ roster: [{ state: 'terminado', since: now, detail: '' }, { name: 'Reviewer', instances: [{ key: 'k1', state: 'morto', task: 'review' }] }] });
    assert.deepEqual(wp2({ runs: [mainGone] }, now), [], 'main session closed');
    const mainDead = run({ roster: [{ state: 'morto', since: now - 1, detail: 'x' }, { name: 'Reviewer', instances: [{ key: 'k1', state: 'morto', task: 'review' }] }] });
    assert.deepEqual(wp2({ runs: [mainDead] }, now).map(n => n.key), ['R-x|main-dead|' + (now - 1)], 'one alert for the dead session, not one per subagent');
    const core = { coreProjects: new Set(['c:/p/demo']) };
    assert.deepEqual(wp2({ runs: [run({ projectKey: 'c:/p/demo' })] }, now, undefined, core), [], 'old interactive session of a Core-driven project');
    assert.deepEqual(wp2({ runs: [run({ projectKey: 'c:/p/demo', forja: { runner: null, status: 'running' } })] }, now, undefined, core).map(n => n.key), ['R-x|dead|k1'], 'a live legacy run still alerts');
    assert.deepEqual(wp2({ runs: [run({ projectKey: 'c:/p/other' })] }, now, undefined, core).map(n => n.key), ['R-x|dead|k1']);
  });
});

import { createState as createReducer, applyEvent as reduceEvent, snapshot as reducerSnapshot } from '../viewer/lib/state.mjs';
describe('watchdog permission notifications', () => {
  const secret = 'curl -H "Authorization: Bearer ghp_EXAMPLEFAKE0000" https://api.example.invalid/deploy';
  function permissionPlan(toolName, toolInput, ageMs) {
    const st = createReducer();
    const now = Date.now();
    const t0 = now - ageMs - 2000;
    const iso = ms => new Date(ms).toISOString();
    const base = { session_id: 'sess-perm', cwd: '/srv/work/acme-private' };
    reduceEvent(st, { ...base, hook_event_name: 'SessionStart', ts: iso(t0) });
    reduceEvent(st, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x', ts: iso(t0 + 1000) });
    reduceEvent(st, { ...base, hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: toolInput, ts: iso(now - ageMs) });
    return wp2(reducerSnapshot(st, now), now);
  }
  test('a pending main-session permission notifies once, after the delay, with status only', () => {
    const plan = permissionPlan('Bash', { command: secret }, 5 * 60_000);
    assert.equal(plan.length, 1, 'one notification per permission episode');
    assert.match(plan[0].key, /\|mainperm\|/);
    assert.equal(plan[0].message, 'Forja precisa de ti (acme-private): permissão pendente (Bash)');
    for (const [tool, input, leak] of [['WebFetch', { url: 'https://internal.example.invalid/?key=abc' }, 'internal.example'], ['WebSearch', { query: 'private customer name' }, 'customer'], ['PowerShell', { command: secret }, 'ghp_']]) {
      const [n] = permissionPlan(tool, input, 5 * 60_000);
      assert.ok(!n.message.includes(leak), `${tool} input must not reach the notification`);
      assert.ok(n.message.endsWith(`(${tool})`), n.message);
    }
    assert.deepEqual(permissionPlan('Bash', { command: secret }, 30_000), [], 'a permission answered within the delay never notifies');
  });
  test('a subagent permission notification carries the tool name, never its message', () => {
    const now = Date.now();
    const run = { id: 'R-y', project: 'p', synthetic: false, lastEventAt: now - 1000, main: { permission: null }, forja: { runner: null },
      roster: [{ state: 'a trabalhar', since: now, detail: '' }, { name: 'Backend Dev', instances: [{ key: 'k2', state: 'bloqueado', permission: { since: now - 5 * 60_000, tool: 'Bash', message: `a correr: ${secret}` } }] }] };
    const plan = wp2({ runs: [run] }, now);
    assert.deepEqual(plan.map(n => n.message), ['Forja precisa de ti (p): Backend Dev à espera de permissão (Bash)']);
    run.roster[1].instances[0].permission.tool = 'Bash; rm -rf /';
    assert.equal(wp2({ runs: [run] }, now)[0].message, 'Forja precisa de ti (p): Backend Dev à espera de permissão');
  });
});
