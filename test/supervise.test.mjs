// lib/supervise.mjs — a supervisão mútua (docs/ARCHITECTURE.md §12).
//
// Dois processos capazes de se relançarem um ao outro é a única parte do Forja
// onde um erro de lógica não dá um bug, dá uma máquina a arrancar processos para
// sempre. Por isso a decisão é uma função pura com o relógio SEMPRE injetado
// (não há um Date.now() a decidir nada neste ficheiro) e há uma simulação dos
// dois lados ao mesmo tempo, sobre o mesmo relógio falso, com os dois predicados
// de vida a MENTIR durante duas horas.
//
// Nada arranca um processo a sério (o spawn é falso), nenhuma notificação sai, e
// nada se escreve fora de uma pasta temporária: nunca o data/ real.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unwatchFile, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../viewer/server.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forja.mjs');
import {
  EMPTY_UP_WATCH_STATE, GUARD_CMD_RE, PEERS, PEER_ALIVE_TTL_MS, PEER_DEAD_GRACE_MS, PEER_HEALTHY_MS, PEER_MAX_ATTEMPTS,
  PEER_RETRY_MS, UP_CMD_RE, appendPeerLog, blankPeerEntry, controlPaths, guardAlive, guardPaths, guardProcessAlive,
  guardProcessAliveAsync, peerAlive, peerAliveAsync, peerAliveCachedAsync, peerGaveUpMessage, peerPlan,
  peerRelaunchMessage, peerTries, readUpWatchState, readPeerEntry, resetPeerAliveCache, runPeerCheckOnce,
  upAlive, upWatchPaths, writeUpWatchState,
} from '../lib/supervise.mjs';
import { launchForja } from '../lib/spawn-runner.mjs';
import { LOCK_STALE_MS } from '../lib/runner.mjs';

const root = mkdtempSync(join(tmpdir(), 'forja-supervise-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fresh = name => { const d = join(root, `${name}-${Math.random().toString(36).slice(2, 8)}`); mkdirSync(d, { recursive: true }); return d; };

const T0 = Date.parse('2026-09-17T18:00:00.000Z');
const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();
// Todo o estado que atravessa uma volta passa por JSON, como o real: um valor
// que só sobrevivesse em memória seria uma mentira.
const disk = e => JSON.parse(JSON.stringify(e));
const seen = (over = {}) => disk({ ...blankPeerEntry(), seen_at: iso(T0 - 60 * MIN), ...over });

// Um processo vivo cuja linha de comandos é a de um `forja up` / `forja guard`,
// sem precisar de um viewer nem de uma guarda a sério (o truque de
// test/guard.test.mjs: argumentos a mais que o Node ignora).
function fakeProcess(...argv) {
  const p = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)', ...argv], { stdio: 'ignore', windowsHide: true });
  return { pid: p.pid, kill: () => spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { encoding: 'utf8' }) };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Quanto tempo o event loop esteve parado: um temporizador de 10 em 10 ms, e o
// maior atraso que ele apanhou. É assim que se mede um spawnSync a bloquear o
// processo que serve o SSE — a mesma medição que o Reviewer fez no viewer real.
function lagMeter(everyMs = 10) {
  let max = 0;
  let last = process.hrtime.bigint();
  const t = setInterval(() => {
    const now = process.hrtime.bigint();
    const atraso = Number(now - last) / 1e6 - everyMs;
    if (atraso > max) max = atraso;
    last = now;
  }, everyMs);
  return { stop() { clearInterval(t); return Math.max(0, Math.round(max)); } };
}

describe('constantes e caminhos (uma definição só, usada pelos dois lados)', () => {
  test('os números da política são os do plano, e o retry é o LOCK_STALE_MS', () => {
    assert.equal(PEER_DEAD_GRACE_MS, 120_000);
    assert.equal(PEER_RETRY_MS, 900_000);
    assert.equal(PEER_RETRY_MS, LOCK_STALE_MS, 'o espaçamento entre tentativas é o mesmo tempo que torna um lock velho');
    assert.equal(PEER_MAX_ATTEMPTS, 3);
    assert.equal(PEER_HEALTHY_MS, 1_800_000);
  });

  test('UP_CMD_RE e GUARD_CMD_RE separam os dois pares nos dois sentidos', () => {
    assert.equal(UP_CMD_RE.test('node C:/f/bin/forja.mjs up'), true);
    assert.equal(UP_CMD_RE.test('"C:\\nodejs\\node.exe" "C:\\f\\bin\\forja.mjs" up --no-tunnel'), true);
    assert.equal(UP_CMD_RE.test('"C:\\Program Files\\nodejs\\node.exe" bin\\forja.mjs up'), true, 'como o Sponsor o arranca, com caminho relativo');
    assert.equal(UP_CMD_RE.test('node C:/f/bin/forja.mjs guard run'), false);
    assert.equal(UP_CMD_RE.test('node C:/f/bin/forja.mjs update'), false, '"update" não é "up"');
    assert.equal(UP_CMD_RE.test('node C:/f/bin/forja.mjs runner'), false);
    assert.equal(GUARD_CMD_RE.test('node C:/f/bin/forja.mjs guard run'), true);
    assert.equal(GUARD_CMD_RE.test('node C:/f/bin/forja.mjs up'), false);
  });

  test('os três conjuntos de caminhos, e nenhum deles é o data/watchdog.json do viewer', () => {
    assert.deepEqual(controlPaths('C:\\d'), { pid: join('C:\\d', 'up.pid'), stop: join('C:\\d', 'up.stop'), tunnel: join('C:\\d', 'tunnel.json') });
    assert.equal(guardPaths('C:\\d').lock, join('C:\\d', 'guard', 'guard.lock.json'));
    assert.equal(guardPaths('C:\\d').stop, join('C:\\d', 'guard', 'guard.stop'));
    assert.deepEqual(upWatchPaths('C:\\d'), { dir: join('C:\\d', 'up-watch'), state: join('C:\\d', 'up-watch', 'state.json'), log: join('C:\\d', 'up-watch', 'up-watch.log') });
    const todos = [...Object.values(controlPaths('C:\\d')), ...Object.values(guardPaths('C:\\d')), ...Object.values(upWatchPaths('C:\\d'))];
    assert.equal(todos.some(p => /watchdog/i.test(p)), false, 'o watchdog do viewer é outra coisa e fica onde está');
  });

  test('o estado do viewer sobre a guarda: ilegível lê-se vazio, e a escrita é tmp+rename', () => {
    const dir = fresh('upwatch');
    const path = upWatchPaths(dir).state;
    assert.deepEqual(readUpWatchState(path), EMPTY_UP_WATCH_STATE());
    writeFileSync(join(dir, 'mau.json'), '{ nada disto é json');
    assert.deepEqual(readUpWatchState(join(dir, 'mau.json')), EMPTY_UP_WATCH_STATE());
    writeUpWatchState(path, { version: 1, guard: { attempts: 2 } });
    assert.equal(readUpWatchState(path).guard.attempts, 2);
    assert.deepEqual(readdirSync(upWatchPaths(dir).dir), ['state.json'], 'sem ficheiro temporário ao lado');
  });
});

describe('vida do par (na dúvida, VIVO)', () => {
  test('uma linha de comandos ilegível conta como vivo — nunca se relança na dúvida', () => {
    // O pid existe (somos nós), a linha de comandos não se consegue ler.
    assert.equal(peerAlive(process.pid, /nunca-vai-dar/, () => null), true);
    // Legível e de outra coisa: morto para efeitos de vigia.
    assert.equal(peerAlive(process.pid, /nunca-vai-dar/, () => 'node outra-coisa.mjs'), false);
    // Pid que não existe: nem se pergunta pela linha de comandos.
    assert.equal(peerAlive(4000000, /.*/, () => { throw new Error('não devia ser chamado'); }), false);
    assert.equal(peerAlive(0, /.*/, () => null), false);
  });

  test('upAlive lê a PRIMEIRA linha de up.pid e confirma pela linha de comandos', async () => {
    const dir = fresh('upalive');
    assert.equal(upAlive(dir), false, 'sem up.pid não há viewer');
    const p = fakeProcess('C:\\naoexiste\\forja\\bin\\forja.mjs', 'up');
    const estranho = fakeProcess('C:\\naoexiste\\outra-coisa.mjs');
    await sleep(1000);
    try {
      // A segunda linha (a CreationDate que o `up` guarda para o `down`) é
      // ignorada aqui: é assunto do isOurUp do `down`.
      writeFileSync(controlPaths(dir).pid, `${p.pid}\n/Date(1789673936409)/\n`);
      assert.equal(upAlive(dir), true);
      writeFileSync(controlPaths(dir).pid, `${estranho.pid}\n`);
      assert.equal(upAlive(dir), false, 'o pid pode ter sido reutilizado: a linha de comandos é que decide');
      writeFileSync(controlPaths(dir).pid, 'lixo\n');
      assert.equal(upAlive(dir), false);
      writeFileSync(controlPaths(dir).pid, '4000000\n');
      assert.equal(upAlive(dir), false);
    } finally { p.kill(); estranho.kill(); }
  });

  test('guardProcessAlive exige lock, batimento fresco E linha de comandos de guarda', async () => {
    const dir = fresh('guardalive');
    const paths = guardPaths(dir);
    mkdirSync(paths.dir, { recursive: true });
    assert.equal(guardProcessAlive(dir), false, 'sem lock não há guarda');
    const g = fakeProcess('C:\\naoexiste\\forja\\bin\\forja.mjs', 'guard', 'run');
    await sleep(1000);
    try {
      assert.equal(guardAlive(g.pid), true);
      const lock = (beat, now = Date.now()) => writeFileSync(paths.lock, JSON.stringify({ pid: g.pid, project: 'guard', since: iso(now), beat: iso(beat) }));
      lock(Date.now());
      assert.equal(guardProcessAlive(dir), true);
      lock(Date.now() - LOCK_STALE_MS - MIN);
      assert.equal(guardProcessAlive(dir), false, 'um batimento velho é uma guarda pendurada, não uma guarda viva');
      lock(Date.now());
      writeFileSync(paths.lock, JSON.stringify({ pid: 4000000, beat: iso(Date.now()) }));
      assert.equal(guardProcessAlive(dir), false);
    } finally { g.kill(); }
  });
});

describe('peerPlan — as oito regras, uma a uma (relógio injetado)', () => {
  const plan = over => peerPlan({ peer: 'up', now: T0, selfStartedAt: T0 - 60 * MIN, ...over });

  test('1. ficheiro de paragem: zero ações, contador a zero — e o seen_at FICA', () => {
    const gasto = seen({ attempts: 2, failed_spawns: 1, dead_since: iso(T0 - 30 * MIN), last_attempt_at: iso(T0 - 20 * MIN), gave_up_at: iso(T0 - MIN) });
    const r = plan({ stopRequested: true, alive: false, entry: gasto });
    assert.equal(r.act, null);
    assert.match(r.why, /parado a pedido/);
    assert.deepEqual(r.entry, { attempts: 0, failed_spawns: 0, dead_since: null, last_attempt_at: null, alive_since: null, gave_up_at: null, seen_at: iso(T0 - 60 * MIN) });
    // E mesmo com o par vivo o ficheiro de paragem manda: nada a fazer.
    assert.equal(plan({ stopRequested: true, alive: true, entry: gasto }).act, null);
  });

  test('2. vivo: limpa a morte, carimba seen_at, e 30 min de saúde OBSERVADA zeram o contador', () => {
    const r = plan({ alive: true, entry: seen({ attempts: 1, dead_since: iso(T0 - 5 * MIN) }) });
    assert.equal(r.act, null);
    assert.equal(r.entry.dead_since, null);
    assert.equal(r.entry.alive_since, iso(T0), 'a série de saúde começa agora');
    assert.equal(r.entry.seen_at, iso(T0));
    assert.equal(r.entry.attempts, 1, 'estar vivo um instante não perdoa tentativas gastas');
    const quase = plan({ alive: true, now: T0 + PEER_HEALTHY_MS - 1, entry: seen({ attempts: 3, alive_since: iso(T0), gave_up_at: iso(T0) }) });
    assert.equal(quase.entry.attempts, 3, 'um milissegundo antes dos 30 min ainda não');
    const curado = plan({ alive: true, now: T0 + PEER_HEALTHY_MS, entry: seen({ attempts: 3, alive_since: iso(T0), gave_up_at: iso(T0), last_attempt_at: iso(T0) }) });
    assert.equal(curado.entry.attempts, 0);
    assert.equal(curado.entry.failed_spawns, 0);
    assert.equal(curado.entry.gave_up_at, null);
    assert.equal(curado.entry.last_attempt_at, null);
    assert.match(curado.why, /contador a zero/);
  });

  test('3. nunca vi este par vivo aqui: nada, nunca — nem depois de horas "morto"', () => {
    for (const t of [T0, T0 + 10 * MIN, T0 + 10 * 60 * MIN]) {
      const r = plan({ alive: false, now: t, entry: disk(blankPeerEntry()) });
      assert.equal(r.act, null, `volta em +${(t - T0) / MIN} min`);
      assert.match(r.why, /nunca vi/);
      assert.equal(r.entry.dead_since, null, 'nem sequer começa a contar o tempo de morte');
    }
  });

  test('4. a regra crítica: um dead_since do disco anterior ao arranque do vigia é ignorado', () => {
    const velho = seen({ dead_since: iso(T0 - 60 * MIN) });
    // O vigia acabou de arrancar (selfStartedAt = T0): o "morto há uma hora" do
    // disco não vale nada, a graça começa AGORA.
    const r = peerPlan({ peer: 'up', alive: false, entry: velho, now: T0, selfStartedAt: T0 });
    assert.equal(r.act, null);
    assert.equal(r.entry.dead_since, iso(T0), 'carimbado de novo');
    assert.match(r.why, /dentro da graça/);
    // Um vigia que já lá está há uma hora confia no seu próprio carimbo.
    const antigo = peerPlan({ peer: 'up', alive: false, entry: velho, now: T0, selfStartedAt: T0 - 120 * MIN });
    assert.equal(antigo.act, 'relaunch');
    // Relógio acertado para trás: carimbado de novo, e nunca uma ação nem um NaN.
    const atras = peerPlan({ peer: 'up', alive: false, entry: seen({ dead_since: iso(T0 + 60 * MIN) }), now: T0, selfStartedAt: T0 - 120 * MIN });
    assert.equal(atras.act, null);
    assert.equal(atras.entry.dead_since, iso(T0));
    assert.equal(/NaN|Invalid Date/.test(JSON.stringify(atras.entry)), false);
  });

  test('5. dentro da graça de 2 min: nada', () => {
    const e = seen({ dead_since: iso(T0) });
    assert.equal(peerPlan({ alive: false, entry: e, now: T0 + PEER_DEAD_GRACE_MS - 1000, selfStartedAt: T0 - MIN }).act, null);
    assert.equal(peerPlan({ alive: false, entry: e, now: T0 + PEER_DEAD_GRACE_MS, selfStartedAt: T0 - MIN }).act, 'relaunch');
  });

  test('6. espaçamento: o last_attempt_at do DISCO é respeitado (o espaçamento sobrevive a um reinício do vigia)', () => {
    const e = seen({ dead_since: iso(T0 - 30 * MIN), last_attempt_at: iso(T0 - 10 * MIN), attempts: 1 });
    const cedo = peerPlan({ alive: false, entry: e, now: T0, selfStartedAt: T0 - 120 * MIN });
    assert.equal(cedo.act, null);
    assert.match(cedo.why, /espero 15 min entre tentativas/);
    assert.equal(peerPlan({ alive: false, entry: e, now: T0 + 5 * MIN + 1000, selfStartedAt: T0 - 120 * MIN }).act, 'relaunch');
    // Um vigia acabado de arrancar (selfStartedAt = T0), já passada a sua
    // própria graça: a tentativa que encontrou no disco continua a valer, senão
    // dois reinícios seguidos davam duas tentativas em segundos.
    const reiniciado = peerPlan({ alive: false, entry: seen({ dead_since: iso(T0), last_attempt_at: iso(T0 - 10 * MIN), attempts: 1 }), now: T0 + 3 * MIN, selfStartedAt: T0 });
    assert.equal(reiniciado.act, null);
    assert.match(reiniciado.why, /espero 15 min entre tentativas/);
    assert.equal(peerPlan({ alive: false, entry: seen({ dead_since: iso(T0), last_attempt_at: iso(T0 - 10 * MIN), attempts: 1 }), now: T0 + 5 * MIN + 1000, selfStartedAt: T0 }).act, 'relaunch');
  });

  test('7. teto de 3: desisto uma vez, e depois fico calado para sempre', () => {
    let e = seen({ attempts: 2, failed_spawns: 1, dead_since: iso(T0 - 30 * MIN), last_attempt_at: iso(T0 - 30 * MIN) });
    assert.equal(peerTries(readPeerEntry(e)), 3, 'o teto é sobre a soma: relançamentos + spawns falhados');
    const r = peerPlan({ alive: false, entry: e, now: T0, selfStartedAt: T0 - 60 * MIN });
    assert.equal(r.act, 'give-up');
    assert.equal(r.entry.gave_up_at, iso(T0));
    e = disk(r.entry);
    for (const t of [T0 + MIN, T0 + 10 * 60 * MIN, T0 + 100 * 60 * MIN]) {
      const depois = peerPlan({ alive: false, entry: e, now: t, selfStartedAt: T0 - 60 * MIN });
      assert.equal(depois.act, null, `volta em +${(t - T0) / MIN} min`);
      assert.match(depois.why, /já desisti/);
      e = disk(depois.entry);
    }
  });

  test('8. morto, passada a graça, sem tentativa recente e com teto por gastar: relanço', () => {
    const r = peerPlan({ peer: 'guard', alive: false, entry: seen({ dead_since: iso(T0 - 5 * MIN) }), now: T0, selfStartedAt: T0 - 60 * MIN });
    assert.equal(r.act, 'relaunch');
    assert.match(r.why, /tentativa 1 de 3/);
    assert.match(r.why, /a guarda/);
  });

  test('valores impossíveis no ficheiro não viram NaN nem tentativas infinitas', () => {
    const lixo = { attempts: 'muitas', failed_spawns: {}, dead_since: 'ontem', last_attempt_at: [], alive_since: NaN, gave_up_at: 'nunca', seen_at: iso(T0 - 60 * MIN) };
    const r = peerPlan({ alive: false, entry: lixo, now: T0, selfStartedAt: T0 - 60 * MIN });
    assert.equal(/NaN|Invalid Date/.test(JSON.stringify(r.entry)), false);
    assert.equal(r.entry.attempts, 0);
    const demais = peerPlan({ alive: false, entry: seen({ attempts: 99, dead_since: iso(T0 - 30 * MIN) }), now: T0, selfStartedAt: T0 - 60 * MIN });
    assert.equal(demais.act, 'give-up', '99 tentativas continua a ser "já chega"');
  });

  test('as duas mensagens são só estado: sem caminhos, sem portas, sem tokens', () => {
    for (const peer of ['up', 'guard']) {
      for (const msg of [peerRelaunchMessage(peer, 2), peerGaveUpMessage(peer)]) {
        assert.equal(msg.includes('\\'), false, msg);
        assert.equal(msg.includes('/'), false, `"2/3" seria um caminho para quem lê: ${msg}`);
        assert.equal(/\d{4,5}|token|http/i.test(msg), false, msg);
        assert.ok(msg.includes(PEERS[peer].label), msg);
      }
    }
    assert.match(peerRelaunchMessage('up', 2), /tentativa 2 de 3/);
    assert.match(peerGaveUpMessage('guard'), /3 tentativas/);
  });
});

// ---------- a camada de ação ----------
function fakes(pid = 4242) {
  const spawned = []; const sent = []; const lines = [];
  return {
    spawned, sent, lines,
    spawn: opts => { spawned.push(opts); return pid; },
    notify: async (message, o) => { sent.push({ message, ...o }); return { ok: true }; },
    log: l => lines.push(l),
  };
}

describe('runPeerCheckOnce (spawn, notify e relógio injetados; nada em disco)', () => {
  test('relançar o viewer: argv fixo, via=guard, notificação low, contador a 1 — e NADA escrito em disco', async () => {
    const dir = fresh('relanca');
    const f = fakes();
    const r = await runPeerCheckOnce({
      peer: 'up', dataDir: dir, forjaRoot: 'C:\\forja', entry: seen({ dead_since: iso(T0 - 10 * MIN) }),
      now: T0, selfStartedAt: T0 - 60 * MIN, alive: false, stopRequested: false,
      spawn: f.spawn, notify: f.notify, log: f.log,
    });
    assert.equal(r.act, 'relaunch');
    assert.equal(r.pid, 4242);
    assert.equal(f.spawned.length, 1);
    assert.deepEqual(f.spawned[0].args, ['up']);
    assert.equal(f.spawned[0].via, 'guard');
    assert.equal(f.spawned[0].dataDir, dir);
    assert.equal(f.spawned[0].forjaRoot, 'C:\\forja');
    assert.equal(r.entry.attempts, 1);
    assert.equal(r.entry.failed_spawns, 0);
    assert.equal(r.entry.last_attempt_at, iso(T0));
    assert.equal(r.entry.dead_since, null, 'a graça recomeça a contar a partir do relançamento');
    assert.deepEqual(f.sent, [{ message: peerRelaunchMessage('up', 1), priority: 'low', tags: ['arrows_counterclockwise'], dedup: false }]);
    assert.deepEqual(readdirSync(dir), [], 'esta função não escreve estado nenhum: quem chama é que persiste');
  });

  test('relançar a guarda: o outro par, o outro argv, o outro via', async () => {
    const dir = fresh('relancaGuarda');
    const f = fakes(99);
    const r = await runPeerCheckOnce({
      peer: 'guard', dataDir: dir, forjaRoot: 'C:\\forja', entry: seen({ dead_since: iso(T0 - 10 * MIN) }),
      now: T0, selfStartedAt: T0 - 60 * MIN, spawn: f.spawn, notify: f.notify,
    });
    assert.equal(r.act, 'relaunch');
    assert.deepEqual(f.spawned[0].args, ['guard', 'run']);
    assert.equal(f.spawned[0].via, 'viewer');
    assert.match(f.spawned[0].logPath, /up-watch/, 'o arranque da guarda regista-se do lado de quem a lançou');
    assert.equal(f.sent[0].message, peerRelaunchMessage('guard', 1));
    assert.equal(f.sent[0].priority, 'low');
  });

  test('um spawn sem pid (ou que rebenta) não gasta tentativa real, mas conta e carimba a hora', async () => {
    const dir = fresh('semPid');
    for (const [nome, spawnFn] of [['sem pid', () => undefined], ['exceção', () => { throw new Error('boom'); }]]) {
      const sent = []; const lines = [];
      const r = await runPeerCheckOnce({
        peer: 'up', dataDir: dir, forjaRoot: 'C:\\forja', entry: seen({ dead_since: iso(T0 - 10 * MIN) }),
        now: T0, selfStartedAt: T0 - 60 * MIN, spawn: spawnFn,
        notify: async (m, o) => { sent.push({ m, ...o }); return { ok: true }; }, log: l => lines.push(l),
      });
      assert.equal(r.pid, undefined, nome);
      assert.equal(r.entry.attempts, 0, `${nome}: nenhum processo arrancou, nenhuma tentativa real gasta`);
      assert.equal(r.entry.failed_spawns, 1, `${nome}: mas é uma tentativa contada`);
      assert.equal(r.entry.last_attempt_at, iso(T0), `${nome}: e carimbada — é isto que impede o mesmo spawn 30 s depois`);
      assert.equal(r.entry.dead_since, iso(T0 - 10 * MIN), `${nome}: o par continua morto desde quando morreu`);
      assert.deepEqual(sent, [], 'não se anuncia um relançamento que não aconteceu');
      assert.match(lines[0], /relançamento falhou/);
    }
  });

  test('um ficheiro de paragem presente não lança nada, nem gasta nada', async () => {
    const dir = fresh('parado');
    const f = fakes();
    const r = await runPeerCheckOnce({
      peer: 'guard', dataDir: dir, forjaRoot: 'C:\\forja', entry: seen({ attempts: 2, dead_since: iso(T0 - 60 * MIN) }),
      now: T0, selfStartedAt: T0 - 60 * MIN, alive: false, stopRequested: true, spawn: f.spawn, notify: f.notify, log: f.log,
    });
    assert.equal(r.act, null);
    assert.deepEqual(f.spawned, []);
    assert.deepEqual(f.sent, []);
    assert.equal(r.entry.attempts, 0);
    assert.equal(r.entry.failed_spawns, 0);
  });

  test('a terceira tentativa dá exatamente uma notificação urgent, e depois silêncio', async () => {
    const dir = fresh('desisto');
    const f = fakes();
    let entry = seen({ attempts: 3, dead_since: iso(T0 - 60 * MIN), last_attempt_at: iso(T0 - 60 * MIN) });
    for (const t of [T0, T0 + PEER_RETRY_MS, T0 + 10 * PEER_RETRY_MS]) {
      const r = await runPeerCheckOnce({
        peer: 'up', dataDir: dir, forjaRoot: 'C:\\forja', entry, now: t, selfStartedAt: T0 - 120 * MIN,
        alive: false, spawn: f.spawn, notify: f.notify, log: f.log,
      });
      entry = disk(r.entry);
    }
    assert.deepEqual(f.spawned, [], 'depois do teto não se lança mais nada');
    assert.deepEqual(f.sent, [{ message: peerGaveUpMessage('up'), priority: 'urgent', tags: ['rotating_light'], dedup: false }]);
  });

  test('as duas notificações levam o link do telemóvel, e sem túnel não levam chave nenhuma', async () => {
    const dir = fresh('click');
    const f = fakes();
    const uma = (entry, now) => runPeerCheckOnce({ peer: 'up', dataDir: dir, forjaRoot: 'C:\\forja', entry, now, selfStartedAt: T0 - 120 * MIN, alive: false, spawn: f.spawn, notify: f.notify });
    await uma(seen({ dead_since: iso(T0 - 10 * MIN) }), T0);
    assert.equal('click' in f.sent[0], false, 'sem túnel a chave nem sequer vai');
    writeFileSync(join(dir, 'tunnel.json'), JSON.stringify({ url: 'https://x.trycloudflare.com', mobileUrl: 'https://x.trycloudflare.com/m?k=segredo' }));
    await uma(seen({ attempts: 3, dead_since: iso(T0 - 60 * MIN), last_attempt_at: iso(T0 - 60 * MIN) }), T0 + PEER_RETRY_MS);
    assert.equal(f.sent[1].message, peerGaveUpMessage('up'));
    assert.equal(f.sent[1].click, 'https://x.trycloudflare.com/m?k=segredo', 'o `notify` é que limpa a query (sanitizeClick), como em todas as outras');
    rmSync(join(dir, 'tunnel.json'), { force: true });
  });

  test('uma notificação que rebenta não trava a volta', async () => {
    const dir = fresh('notifyMau');
    const r = await runPeerCheckOnce({
      peer: 'up', dataDir: dir, forjaRoot: 'C:\\forja', entry: seen({ dead_since: iso(T0 - 10 * MIN) }),
      now: T0, selfStartedAt: T0 - 60 * MIN, spawn: () => 7, notify: async () => { throw new Error('ntfy em baixo'); },
    });
    assert.equal(r.entry.attempts, 1);
  });

  test('um par desconhecido é uma recusa, não um arranque', async () => {
    await assert.rejects(() => runPeerCheckOnce({ peer: 'runner', dataDir: fresh('mau'), entry: null }), /par desconhecido/);
  });
});

describe('launchForja (a linha de comandos e o ambiente reais, com o spawn de baixo falso)', () => {
  test('argv fixo do bin deste repo, cwd no repo, FORJA_DATA_DIR no ambiente e a sessão de quem lançou fora dele', () => {
    const dir = fresh('launch');
    const calls = [];
    const spawnRunner = (command, args, options) => { calls.push({ command, args, options }); return { pid: 777 }; };
    process.env.CLAUDE_CODE_SESSION_ID = 'sessao-de-quem-lancou';
    process.env.FORJA_PROJECT_ROOT = 'C:\\outro\\projeto';
    let pid;
    try {
      pid = launchForja({ dataDir: dir, forjaRoot: 'C:\\forja', args: ['guard', 'run'], logPath: join(dir, 'up-watch', 'spawn-guard.log'), via: 'viewer', spawnRunner });
    } finally { delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.FORJA_PROJECT_ROOT; }
    assert.equal(pid, 777);
    assert.equal(calls.length, 1);
    const { command, args, options } = calls[0];
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [join('C:\\forja', 'bin', 'forja.mjs'), 'guard', 'run']);
    assert.equal(options.cwd, 'C:\\forja', 'o par corre no repo do Forja, nunca na pasta de um projeto');
    assert.equal(options.env.FORJA_DATA_DIR, dir);
    assert.equal('CLAUDE_CODE_SESSION_ID' in options.env, false);
    assert.equal('FORJA_PROJECT_ROOT' in options.env, false);
    const log = readFileSync(join(dir, 'runner', 'spawn.log'), 'utf8');
    assert.match(log, /peer=guard action=relaunch pid=777 via=viewer/);
    assert.equal(/C:\\forja|up-watch/.test(log), false, 'a linha do registo é só estado: nunca um caminho');
  });

  test('um spawn que não dá pid devolve undefined e fica escrito na mesma', () => {
    const dir = fresh('launchSemPid');
    const pid = launchForja({ dataDir: dir, forjaRoot: 'C:\\forja', args: ['up'], logPath: join(dir, 'guard', 'spawn-up.log'), via: 'guard', spawnRunner: () => ({}) });
    assert.equal(pid, undefined);
    assert.match(readFileSync(join(dir, 'runner', 'spawn.log'), 'utf8'), /peer=up action=relaunch pid=\? via=guard/);
  });

  test('vai pelo MESMO intermediário do launchRunner (o filho não fica na árvore de quem o lançou)', async () => {
    // A propriedade que interessa: um `forja guard` lançado pelo viewer não pode
    // morrer no `forja down` seguinte, e o `planKillTree` só poupa runners.
    const { DETACH_SCRIPT, defaultSpawnRunner } = await import('../lib/spawn-runner.mjs');
    assert.ok(typeof DETACH_SCRIPT === 'string' && DETACH_SCRIPT.includes('detached:true'));
    const dir = fresh('intermediario');
    const calls = [];
    launchForja({ dataDir: dir, forjaRoot: 'C:\\forja', args: ['up'], logPath: join(dir, 'x.log'), spawnRunner: (...a) => { calls.push(a); return {}; } });
    assert.equal(calls.length, 1, 'passa pelo mesmo seam que o launchRunner substitui nos testes');
    assert.equal(typeof defaultSpawnRunner, 'function');
  });
});

// ---------- T5: os dois lados ao mesmo tempo ----------
describe('supervisão mútua: provar que não oscila', () => {
  // Um lado da simulação: guarda o seu estado como o disco o guardaria.
  function side(peer, { entry, selfStartedAt }) {
    const launches = []; const urgent = []; const low = [];
    return {
      peer, launches, urgent, low,
      state: disk(entry),
      selfStartedAt,
      async tick(now, alive, stopRequested = false) {
        const r = await runPeerCheckOnce({
          peer, dataDir: root, forjaRoot: 'C:\\forja', entry: this.state, now, selfStartedAt: this.selfStartedAt,
          alive, stopRequested,
          spawn: () => { launches.push(now); return 1000 + launches.length; },
          notify: async (message, o) => { (o.priority === 'urgent' ? urgent : low).push({ message, at: now }); return { ok: true }; },
        });
        this.state = disk(r.entry); // passa pelo disco, como a sério
        return r;
      },
    };
  }

  test('(a) a guarda relança o viewer; o viewer novo vê a guarda viva à primeira volta — zero ações dos dois lados', async () => {
    // A guarda está viva desde T0 e vê o viewer morto há 10 min.
    const guarda = side('up', { entry: seen({ dead_since: iso(T0 - 10 * MIN) }), selfStartedAt: T0 - 60 * MIN });
    const r = await guarda.tick(T0, false);
    assert.equal(r.act, 'relaunch');
    assert.deepEqual(guarda.launches, [T0]);
    // O viewer novo arranca em T0 e começa a vigiar. No disco está o estado do
    // viewer ANTERIOR, que dizia "a guarda morreu há uma hora" (uma mentira que
    // sobreviveu ao processo).
    const viewer = side('guard', { entry: seen({ dead_since: iso(T0 - 60 * MIN), attempts: 1, last_attempt_at: iso(T0 - 50 * MIN) }), selfStartedAt: T0 });
    // Primeira volta do viewer, 30 s depois: a guarda ESTÁ viva.
    const v1 = await viewer.tick(T0 + 30_000, true);
    assert.equal(v1.act, null);
    assert.deepEqual(viewer.launches, [], 'o viewer acabado de relançar não relança de volta quem o relançou');
    assert.equal(v1.entry.dead_since, null);
    // E a guarda, na volta seguinte, vê o viewer vivo: também não faz nada.
    const g2 = await guarda.tick(T0 + 60_000, true);
    assert.equal(g2.act, null);
    assert.deepEqual(guarda.launches, [T0], 'um relançamento, nunca dois');
    // Meia hora de saúde observada dos dois lados e os contadores voltam a zero.
    const g3 = await guarda.tick(T0 + 60_000 + PEER_HEALTHY_MS, true);
    assert.equal(g3.entry.attempts, 0);
    const v3 = await viewer.tick(T0 + 30_000 + PEER_HEALTHY_MS, true);
    assert.equal(v3.entry.attempts, 0);
  });

  test('(b) PATOLÓGICO: os dois predicados a mentir durante 2 h — no máximo 3 lançamentos por lado, a 15 min, e uma só urgente', async () => {
    // Ninguém morreu: os dois processos estão vivos e a olhar um para o outro.
    // Mas os dois predicados de vida mentem, volta após volta, para sempre. É o
    // pior caso possível, e é aqui que uma lógica errada arranca processos até a
    // máquina cair.
    const guarda = side('up', { entry: seen(), selfStartedAt: T0 });
    const viewer = side('guard', { entry: seen(), selfStartedAt: T0 });
    const FIM = T0 + 120 * MIN;
    for (let t = T0; t <= FIM; t += 30_000) {
      if ((t - T0) % 60_000 === 0) await guarda.tick(t, false);  // a guarda acorda de 60 em 60 s
      await viewer.tick(t, false);                                // o viewer de 30 em 30 s
    }
    for (const lado of [guarda, viewer]) {
      const em = lado.launches.map(t => (t - T0) / MIN);
      assert.equal(em.length, PEER_MAX_ATTEMPTS, `${lado.peer}: 2 h de mentira deram ${em.length} lançamentos (${em.join(', ')} min)`);
      for (let i = 1; i < em.length; i++) {
        assert.ok(em[i] - em[i - 1] >= PEER_RETRY_MS / MIN, `${lado.peer}: duas tentativas a ${em[i] - em[i - 1]} min uma da outra`);
      }
      assert.deepEqual(em, [2, 17, 32], `${lado.peer}: 2 min de graça e depois 15 em 15 min`);
      assert.equal(lado.urgent.length, 1, `${lado.peer}: uma desistência, uma notificação urgente, e mais nenhuma em 2 h`);
      assert.equal(lado.low.length, PEER_MAX_ATTEMPTS);
      assert.equal(lado.urgent[0].at, T0 + 47 * MIN, `${lado.peer}: a desistência sai 15 min depois da terceira tentativa`);
      assert.equal(lado.state.gave_up_at, iso(T0 + 47 * MIN));
    }
    // O contador nunca se zera com uma mentira: só 30 min de saúde OBSERVADA o
    // fazem, e uma leitura "morto" sobre um par vivo nunca produz saúde nenhuma.
    assert.equal(peerTries(readPeerEntry(guarda.state)), PEER_MAX_ATTEMPTS);
    assert.equal(peerTries(readPeerEntry(viewer.state)), PEER_MAX_ATTEMPTS);
  });

  test('(c) acabado de relançar: ignora o dead_since velho do disco, mas respeita o last_attempt_at velho', async () => {
    // Processo novo (selfStartedAt = T0) com um estado antigo no disco.
    const velho = seen({ dead_since: iso(T0 - 60 * MIN), attempts: 1, last_attempt_at: iso(T0 - 10 * MIN) });
    const lado = side('guard', { entry: velho, selfStartedAt: T0 });
    for (const t of [T0, T0 + 60_000, T0 + 119_000]) {
      const r = await lado.tick(t, false);
      assert.equal(r.act, null, `+${(t - T0) / 1000}s: dentro da graça dos 2 min de vida DESTE processo`);
    }
    // Passados os 2 min de vida própria, a graça já não trava — mas os 15 min
    // desde a última tentativa (que veio do disco) travam.
    const r1 = await lado.tick(T0 + 125_000, false);
    assert.equal(r1.act, null);
    assert.match(r1.note, /espero 15 min entre tentativas/);
    assert.deepEqual(lado.launches, []);
    // E às 15 min da tentativa anterior, sim.
    const r2 = await lado.tick(T0 + 5 * MIN + 1000, false);
    assert.equal(r2.act, 'relaunch');
    assert.deepEqual(lado.launches.map(t => Math.round((t - T0) / 1000)), [301]);
  });

  test('`down` não regride: com up.stop presente a guarda não relança o viewer nem gasta tentativa, por muitas voltas que dê', async () => {
    const guarda = side('up', { entry: seen({ dead_since: iso(T0 - 60 * MIN), attempts: 2 }), selfStartedAt: T0 - 60 * MIN });
    for (let t = T0; t <= T0 + 60 * MIN; t += 60_000) {
      const r = await guarda.tick(t, false, true); // up.stop presente em todas as voltas
      assert.equal(r.act, null);
      assert.match(r.note, /parado a pedido/);
    }
    assert.deepEqual(guarda.launches, []);
    assert.equal(guarda.state.attempts, 0, 'o contador fica a zero enquanto o pedido de paragem existir');
    assert.equal(guarda.state.failed_spawns, 0);
    assert.ok(guarda.state.seen_at, 'e o seen_at fica: um `forja up` novo apaga o up.stop e a vigia recomeça sozinha');
    // Apagado o up.stop (um `forja up` novo fá-lo no arranque), a vigia recomeça
    // do princípio: 2 min de graça a contar de agora.
    const volta = await guarda.tick(T0 + 61 * MIN, false, false);
    assert.equal(volta.act, null);
    assert.match(volta.note, /dentro da graça/);
  });
});

// ---------- T4: o viewer vigia a guarda ----------
// O `startPeerWatch` de viewer/server.mjs: quem o arranca é o `forja up`, nunca
// o `startServer` — e nada disto toca no watchdog do viewer (outra função, outro
// ficheiro, outra palavra).
describe('o viewer vigia a guarda (startPeerWatch)', () => {
  const servers = [];
  const startViewer = async dir => {
    const srv = startServer({ dataDir: dir, port: 0, host: '127.0.0.1' });
    await once(srv.server, 'listening');
    servers.push({ srv, dir });
    return srv;
  };
  after(() => {
    for (const { srv, dir } of servers) {
      try { srv.server.close(); } catch {}
      try { unwatchFile(join(dir, 'events.jsonl')); } catch {}
    }
  });

  test('`startServer` sozinho não vigia nada: sem temporizador, sem data/up-watch/, sem tocar no data/watchdog.json', async () => {
    const dir = fresh('semVigia');
    const srv = await startViewer(dir);
    assert.equal(typeof srv.startPeerWatch, 'function', 'devolve-o, mas não o arranca');
    await sleep(200);
    assert.equal(existsSync(upWatchPaths(dir).dir), false, 'um `forja serve` (ou um `up` que saiu com a porta ocupada) não vigia ninguém');
    assert.equal(existsSync(join(dir, 'watchdog.json')), false);
  });

  test('uma guarda morta é relançada com o spawn injetado; o estado e o log ficam em data/up-watch/', async () => {
    const dir = fresh('vigia');
    writeUpWatchState(upWatchPaths(dir).state, { version: 1, guard: seen({ dead_since: iso(T0 - 10 * MIN) }) });
    const srv = await startViewer(dir);
    const f = fakes(3131);
    const watch = srv.startPeerWatch({ forjaRoot: 'C:\\forja', spawn: f.spawn, notify: f.notify, now: () => T0, selfStartedAt: T0 - 60 * MIN });
    assert.equal(watch.enabled, true);
    try {
      const r = await watch.peerCheck(T0);
      assert.equal(r.act, 'relaunch');
      assert.deepEqual(f.spawned[0].args, ['guard', 'run']);
      assert.equal(f.spawned[0].via, 'viewer');
      assert.equal(f.spawned[0].dataDir, dir);
      assert.equal(f.spawned[0].forjaRoot, 'C:\\forja');
      const estado = readUpWatchState(upWatchPaths(dir).state);
      assert.equal(estado.guard.attempts, 1);
      assert.equal(estado.guard.last_attempt_at, iso(T0));
      assert.match(readFileSync(upWatchPaths(dir).log, 'utf8'), /a guarda dos runners: relançada \(tentativa 1 de 3, pid 3131\)/);
      assert.deepEqual(f.sent, [{ message: peerRelaunchMessage('guard', 1), priority: 'low', tags: ['arrows_counterclockwise'], dedup: false }]);
      // A volta seguinte, 30 s depois, espera os 15 min: nunca um segundo arranque.
      await watch.peerCheck(T0 + 30_000);
      assert.equal(f.spawned.length, 1);
      // E o watchdog do viewer, que é outra coisa, não foi tocado por este caminho.
      assert.equal(existsSync(join(dir, 'watchdog.json')), false, 'data/watchdog.json é do watchdog do viewer e este caminho nunca lhe mexe');
      // Um segundo startPeerWatch não cria um segundo temporizador.
      assert.equal(srv.startPeerWatch({ spawn: f.spawn }).enabled, false);
    } finally { watch.stop(); }
  });

  test('com data/guard/guard.stop presente, a guarda não é relançada e o contador fica a zero', async () => {
    const dir = fresh('guardaParada');
    mkdirSync(guardPaths(dir).dir, { recursive: true });
    writeFileSync(guardPaths(dir).stop, 'forja guard stop\n');
    writeUpWatchState(upWatchPaths(dir).state, { version: 1, guard: seen({ attempts: 2, dead_since: iso(T0 - 60 * MIN) }) });
    const srv = await startViewer(dir);
    const f = fakes();
    const watch = srv.startPeerWatch({ forjaRoot: 'C:\\forja', spawn: f.spawn, notify: f.notify, now: () => T0, selfStartedAt: T0 - 60 * MIN });
    try {
      for (let i = 0; i < 20; i++) await watch.peerCheck(T0 + i * 30_000);
      assert.deepEqual(f.spawned, [], '`forja autostart remove` e `forja guard stop` param mesmo a guarda');
      assert.deepEqual(f.sent, []);
      const estado = readUpWatchState(upWatchPaths(dir).state);
      assert.equal(estado.guard.attempts, 0);
      assert.equal(estado.guard.failed_spawns, 0);
      assert.match(readFileSync(upWatchPaths(dir).log, 'utf8').trim(), /a guarda dos runners está parada a pedido/);
      assert.equal(readFileSync(upWatchPaths(dir).log, 'utf8').trim().split('\n').length, 1, 'uma linha por ação (e por mudança), não uma por volta');
    } finally { watch.stop(); }
  });

  // ---- BLOQUEADOR 1 (revisão): a volta do viewer não pode parar o event loop ----
  // A versão anterior lia a vida da guarda com `guardProcessAlive`, que passa
  // por um spawnSync do PowerShell: medido pelo Reviewer no viewer a sério,
  // 369-390 ms de event loop parado POR VOLTA, no mesmo processo que serve o
  // SSE e o telemóvel pelo túnel. O par ownerAliveAsync/ownerAliveCached
  // (lib/projects.mjs) existe desde sempre por esta razão exata.
  test('BLOQUEADOR: a volta do viewer não bloqueia o event loop (e a síncrona bloqueia mesmo — medido lado a lado)', async () => {
    const dir = fresh('semBloqueio');
    const g = fakeProcess('C:\\naoexiste\\forja\\bin\\forja.mjs', 'guard', 'run');
    await sleep(1000);
    try {
      mkdirSync(guardPaths(dir).dir, { recursive: true });
      writeFileSync(guardPaths(dir).lock, JSON.stringify({ pid: g.pid, project: 'guard', since: iso(Date.now()), beat: iso(Date.now()) }));
      writeUpWatchState(upWatchPaths(dir).state, { version: 1, guard: seen() });
      const srv = await startViewer(dir);
      const f = fakes();
      const watch = srv.startPeerWatch({ forjaRoot: 'C:\\forja', spawn: f.spawn, notify: f.notify, now: () => T0, selfStartedAt: T0 - 60 * MIN });
      try {
        // Controlo: a leitura SÍNCRONA, a mesma que a guarda usa do lado dela.
        // O `await` a seguir é indispensável: sem devolver o event loop, o
        // temporizador da medição nunca chegava a correr e o atraso lia-se 0.
        resetPeerAliveCache();
        const m1 = lagMeter();
        assert.equal(guardProcessAlive(dir), true);
        await sleep(30);
        const sincrono = m1.stop();
        // A volta do viewer, com a leitura assíncrona por omissão.
        resetPeerAliveCache();
        const m2 = lagMeter();
        const r = await watch.peerCheck(T0);
        await sleep(30);
        const assincrono = m2.stop();
        // A prova de que o caminho caro foi mesmo percorrido (e não saltado):
        // a resposta só pode ser "viva" se a linha de comandos foi lida e bateu.
        assert.match(r.note, /a guarda dos runners viva/);
        assert.deepEqual(f.spawned, []);
        assert.ok(sincrono >= 150, `o controlo tem de bloquear mesmo (bloqueou ${sincrono} ms); se este número for pequeno a medição não vale nada`);
        assert.ok(assincrono < 150, `a volta do viewer parou o event loop ${assincrono} ms (síncrona: ${sincrono} ms) — o telemóvel paga isto a cada 30 s`);
        assert.ok(assincrono < sincrono / 2, `assíncrono ${assincrono} ms vs síncrono ${sincrono} ms`);
        // E a cache de curta duração responde sem gastar outro PowerShell.
        const m3 = lagMeter();
        assert.equal(await guardProcessAliveAsync(dir), true);
        await sleep(30);
        assert.ok(m3.stop() < 50, 'a segunda leitura dentro do TTL nem sequer arranca um processo');
      } finally { watch.stop(); }
    } finally { g.kill(); resetPeerAliveCache(); }
  });

  test('peerAliveAsync dá a MESMA resposta que peerAlive (incluindo o default seguro da dúvida)', async () => {
    const g = fakeProcess('C:\\naoexiste\\forja\\bin\\forja.mjs', 'guard', 'run');
    await sleep(1000);
    try {
      assert.equal(await peerAliveAsync(g.pid, GUARD_CMD_RE), true);
      assert.equal(peerAlive(g.pid, GUARD_CMD_RE), true);
      assert.equal(await peerAliveAsync(g.pid, UP_CMD_RE), false, 'uma guarda não é um viewer');
      assert.equal(await peerAliveAsync(4000000, GUARD_CMD_RE), false, 'um pid que não existe é morto');
      // Dúvida = vivo, também no caminho assíncrono (aqui com o leitor injetado).
      assert.equal(await peerAliveCachedAsync(g.pid, GUARD_CMD_RE, { now: Date.now(), aliveAsync: async () => true }), true);
      resetPeerAliveCache();
      // E o TTL: dentro dele responde-se do que já se mediu, sem voltar a medir.
      let medicoes = 0;
      const conta = async () => { medicoes += 1; return true; };
      const t = Date.now();
      await peerAliveCachedAsync(999001, GUARD_CMD_RE, { now: t, aliveAsync: conta });
      await peerAliveCachedAsync(999001, GUARD_CMD_RE, { now: t + 100, aliveAsync: conta });
      assert.equal(medicoes, 1);
      await peerAliveCachedAsync(999001, GUARD_CMD_RE, { now: t + PEER_ALIVE_TTL_MS + 1, aliveAsync: conta });
      assert.equal(medicoes, 2, 'passado o TTL mede-se outra vez: uma decisão que arranca processos não se toma com um valor velho');
    } finally { g.kill(); resetPeerAliveCache(); }
  });

  // ---- BLOQUEADOR 2 (revisão): voltas sobrepostas lançavam duas vezes ----
  // O estado só chega ao disco no FIM da volta. Com setInterval e uma volta que
  // demora mais do que o intervalo (15 s da linha de comandos + 20 s do
  // intermediário + 10 s do ntfy > 30 s), a volta seguinte lia o MESMO estado
  // pré-relançamento e relançava outra vez: dois processos, uma tentativa
  // registada — os 15 min entre tentativas e o teto de 3 deixavam de valer.
  test('BLOQUEADOR: duas voltas sobrepostas dão UM lançamento só (a segunda é saltada)', async () => {
    const dir = fresh('reentrante');
    writeUpWatchState(upWatchPaths(dir).state, { version: 1, guard: seen({ dead_since: iso(T0 - 10 * MIN) }) });
    const srv = await startViewer(dir);
    const spawned = []; const sent = [];
    const watch = srv.startPeerWatch({
      forjaRoot: 'C:\\forja', now: () => T0, selfStartedAt: T0 - 60 * MIN,
      alive: async () => { await sleep(80); return false; },              // a leitura demora, como a real
      spawn: o => { spawned.push(o); return 800 + spawned.length; },
      notify: async (message, o) => { await sleep(200); sent.push({ message, ...o }); return { ok: true }; },
    });
    try {
      const p1 = watch.peerCheck(T0);
      const p2 = watch.peerCheck(T0);            // começa com a primeira a meio
      const p3 = watch.peerCheck(T0 + 1000);
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(r1.act, 'relaunch');
      assert.equal(r2.skipped, true); assert.equal(r2.act, null);
      assert.equal(r3.skipped, true);
      assert.equal(spawned.length, 1, `duas voltas sobrepostas lançaram ${spawned.length} processos`);
      assert.equal(sent.length, 1);
      // E o disco já tem a tentativa, antes de qualquer volta seguinte poder decidir.
      const estado = readUpWatchState(upWatchPaths(dir).state);
      assert.equal(estado.guard.attempts, 1);
      assert.equal(estado.guard.last_attempt_at, iso(T0));
      // As voltas seguintes, já não sobrepostas, leem esse estado: primeiro a
      // graça (que recomeça no relançamento) e depois os 15 min entre tentativas.
      const r4 = await watch.peerCheck(T0 + 30_000);
      assert.equal(r4.act, null);
      assert.match(r4.note, /dentro da graça/);
      const r5 = await watch.peerCheck(T0 + 3 * MIN);
      assert.equal(r5.act, null);
      assert.match(r5.note, /espero 15 min entre tentativas/);
      assert.equal(spawned.length, 1);
      // Prova de que o teste apanha mesmo o defeito: sem a trava, duas chamadas
      // concorrentes sobre o MESMO estado em disco decidem as duas relançar.
      const semTrava = [];
      const estadoDisco = readUpWatchState(upWatchPaths(fresh('semTrava')).state);
      const entrada = seen({ dead_since: iso(T0 - 10 * MIN) });
      const duas = await Promise.all([1, 2].map(() => runPeerCheckOnce({
        peer: 'guard', dataDir: dir, forjaRoot: 'C:\\forja', entry: entrada, now: T0, selfStartedAt: T0 - 60 * MIN,
        alive: false, spawn: () => { semTrava.push(1); return 1; }, notify: async () => ({ ok: true }),
      })));
      assert.equal(semTrava.length, 2, 'é exatamente isto que a trava impede');
      assert.deepEqual(duas.map(d => d.entry.attempts), [1, 1], 'cada uma a achar que era a primeira tentativa');
      assert.equal(estadoDisco.guard.attempts, undefined);
    } finally { watch.stop(); }
  });

  test('a corrente de voltas nunca se sobrepõe a si própria (setTimeout encadeado, não setInterval)', async () => {
    const dir = fresh('corrente');
    writeUpWatchState(upWatchPaths(dir).state, { version: 1, guard: seen() });
    const srv = await startViewer(dir);
    let emCurso = 0; let maxEmCurso = 0; let voltas = 0;
    const watch = srv.startPeerWatch({
      forjaRoot: 'C:\\forja', everyMs: 40, now: () => T0, selfStartedAt: T0 - 60 * MIN,
      alive: async () => { emCurso += 1; maxEmCurso = Math.max(maxEmCurso, emCurso); await sleep(120); emCurso -= 1; voltas += 1; return true; },
      spawn: () => { throw new Error('nada a relançar nesta volta'); },
      notify: async () => ({ ok: true }),
    });
    try {
      await sleep(700);
      assert.ok(voltas >= 2, `deu ${voltas} voltas em 700 ms`);
      assert.equal(maxEmCurso, 1, 'com setInterval de 40 ms e voltas de 120 ms havia sempre 2 a 3 em voo ao mesmo tempo');
    } finally { watch.stop(); }
    const depois = voltas;
    await sleep(200);
    assert.equal(voltas, depois, 'stop() durante a corrente não deixa marcada mais nenhuma volta');
  });

  test('FORJA_NO_PEER_WATCH=1 desliga só esta vigia; FORJA_NO_WATCHDOG=1 desliga-a também', async () => {
    const dir = fresh('desligada');
    process.env.FORJA_NO_PEER_WATCH = '1';
    try {
      const srv = await startViewer(dir);
      const watch = srv.startPeerWatch({ forjaRoot: 'C:\\forja', spawn: () => 1, now: () => T0 });
      assert.equal(watch.enabled, false);
      assert.equal(existsSync(upWatchPaths(dir).dir), false);
    } finally { delete process.env.FORJA_NO_PEER_WATCH; }
    const dir2 = fresh('semWatchdog');
    const srv2 = startServer({ dataDir: dir2, port: 0, host: '127.0.0.1', noWatchdog: true });
    await once(srv2.server, 'listening');
    servers.push({ srv: srv2, dir: dir2 });
    assert.equal(srv2.startPeerWatch({ spawn: () => 1 }).enabled, false, 'os testes que já desligavam o watchdog continuam sem vigia nenhuma');
    assert.equal(existsSync(upWatchPaths(dir2).dir), false);
  });
});

// ---- Revisão de segurança: o `down` tem de ganhar a corrida do arranque ----
// A janela: a guarda decide relançar o viewer (o velho está morto há mais de
// 2 min) e, nesse instante, o Sponsor corre `forja down`. O `down` não encontra
// up.pid nenhum — o viewer velho já morreu — e responde «não havia nada a
// correr»; segundos depois o viewer que a guarda lançou chegava ao `listening`,
// apagava o up.stop, escrevia o up.pid e reabria o TÚNEL PÚBLICO, sem ninguém
// para o parar. Um `down` explícito a dizer «parado» com o endereço público a
// voltar a seguir é exatamente o que esta funcionalidade não pode fazer.
describe('um `forja down` a meio do arranque ganha ao `forja up` que estava a nascer', () => {
  test('o up.stop que aparece durante o arranque faz o processo novo sair em vez de servir e abrir o túnel', async () => {
    const dir = fresh('corridaDown');
    const env = { ...process.env, FORJA_DATA_DIR: dir, PORT: '0', FORJA_NTFY_SERVER: 'http://127.0.0.1:9', FORJA_NO_WATCHDOG: '1' };
    const child = spawn(process.execPath, [cli, 'up', '--no-tunnel'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    // O `down` a sério escreve o up.stop e RE-ARMA-O (+1,5 s e +4 s,
    // lib/up.mjs), precisamente porque o wrapper pode relançar um `up` no meio.
    // Aqui a insistência é a mesma: o ficheiro aparece depois de este `up` já
    // ter apagado o antigo, e continua lá quando ele chega ao `listening`.
    const stop = controlPaths(dir).stop;
    const armar = setInterval(() => { try { writeFileSync(stop, `${new Date().toISOString()} forja down (teste)\n`); } catch {} }, 5);
    let code = null;
    try {
      code = await Promise.race([
        new Promise(r => child.on('exit', c => r(c))),
        sleep(25_000).then(() => 'timeout'),
      ]);
    } finally { clearInterval(armar); try { if (code === 'timeout') child.kill(); } catch {} }
    const log = (() => { try { return readFileSync(join(dir, 'up.log'), 'utf8'); } catch { return ''; } })();
    assert.notEqual(code, 'timeout', `o \`forja up\` continuou a servir apesar do pedido de paragem — log:\n${log}`);
    assert.equal(code, 0, `saída ${code} — log:\n${log}`);
    assert.match(log, /apareceu um data\/up\.stop durante o arranque/);
    assert.equal(existsSync(controlPaths(dir).pid), false, 'não chegou a dizer "o viewer sou eu": sem up.pid, o `down` seguinte não tem nada para matar e a guarda não tem nada para vigiar');
    assert.ok(existsSync(stop), 'e o pedido de paragem fica como estava — quem o apagasse tirava o travão à guarda também');
    assert.equal(existsSync(join(dir, 'tunnel.json')), false, 'nunca abriu o túnel público');
  });
});

describe('appendPeerLog', () => {
  test('cria a pasta, carimba a hora e nunca deixa uma linha partir-se em duas', () => {
    const dir = fresh('logfile');
    const path = upWatchPaths(dir).log;
    appendPeerLog(path, 'linha um');
    appendPeerLog(path, 'linha\ncom\r\nquebras');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z linha um$/);
    assert.match(lines[1], /linha com quebras$/);
    assert.ok(existsSync(path));
  });
});
