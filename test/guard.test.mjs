// lib/guard.mjs — a guarda dos controladores Core e do viewer.
//
// The decision is pure and the clock is ALWAYS injected: not one test here
// calls Date.now() to decide anything, because a rule like "15 minutes between
// attempts" is only verifiable if the clock is a value. The action layer runs
// against fakes: no process is ever spawned, no notification ever leaves, and
// nothing is written outside a temp data dir (never the real data/, never the
// real Startup folder).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUARD_DEAD_GRACE_MS, GUARD_HEALTHY_MS, GUARD_MAX_ATTEMPTS, GUARD_MIN_POLL_MS, GUARD_POLL_MS, GUARD_RETRY_MS, GUARD_CMD_RE, GUARD_WRAPPER_RETRY_S,
  EMPTY_STATE, appendGuardLog, checkedPollMs, gaveUpMessage, guardAlive, guardLauncherFiles, guardLoop, guardPaths, guardPlan, guardStartupPaths,
  readGuardState, relaunchMessage, runGuardOnce, validRunId, writeGuardState,
} from '../lib/guard.mjs';
import { launchCore } from '../lib/spawn-runner.mjs';
import { isOurUp, isCoreRunCmd, planKillTree } from '../lib/up.mjs';
import { LOCK_STALE_MS } from '../lib/process-lock.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'forja.mjs');
const root = mkdtempSync(join(tmpdir(), 'forja-guard-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fresh = name => { const d = join(root, `${name}-${Math.random().toString(36).slice(2, 8)}`); mkdirSync(d, { recursive: true }); return d; };

// A project the way `listProjectsWithStatus` hands it over.
const RUN_ID = 'F-20260917-ab12';
const T0 = Date.parse('2026-09-17T18:00:00.000Z');
const MIN = 60_000;
const proj = (over = {}) => ({
  name: 'velora', path: join(root, 'velora'), bootstrappedAt: null,
  run: { run_id: RUN_ID, status: 'running', driver: 'core', goal: 'objetivo secreto do run', started_at: null },
  runnerAlive: false, ...over,
});
const stateOf = (entry, name = 'velora') => ({ version: 1, projects: { [name]: entry } });
// Every state that crosses a tick is round-tripped through JSON, like the real
// one: a value that only survives in memory would be a lie.
const roundTrip = state => JSON.parse(JSON.stringify(state));

describe('guardPaths e o ficheiro de estado', () => {
  test('tudo vive em data/guard/; data/watchdog.json (do viewer) nunca é tocado', () => {
    const p = guardPaths('C:\\forja\\data');
    assert.deepEqual(p, {
      dir: join('C:\\forja\\data', 'guard'),
      lock: join('C:\\forja\\data', 'guard', 'guard.lock.json'),
      stop: join('C:\\forja\\data', 'guard', 'guard.stop'),
      log: join('C:\\forja\\data', 'guard', 'guard.log'),
      state: join('C:\\forja\\data', 'guard', 'state.json'),
    });
    assert.equal(Object.values(p).some(v => /watchdog/i.test(v)), false, 'o watchdog do viewer é outra coisa e fica onde está');
  });

  test('um ficheiro que falta, ilegível ou com outra forma lê-se como estado vazio, nunca com exceção', () => {
    const dir = fresh('estado');
    writeFileSync(join(dir, 'mau.json'), '{ isto não é json');
    writeFileSync(join(dir, 'lista.json'), '[1,2,3]');
    writeFileSync(join(dir, 'sem-projects.json'), '{"version":1}');
    for (const f of ['nao-existe.json', 'mau.json', 'lista.json', 'sem-projects.json']) {
      const s = readGuardState(join(dir, f));
      assert.deepEqual(s, EMPTY_STATE(), f);
      // O mapa de projetos nunca tem protótipo: um projeto chamado `__proto__`
      // ou `toString` tem de ser uma chave como outra qualquer.
      assert.equal(Object.getPrototypeOf(s.projects), null, f);
      assert.equal(s.projects.toString, undefined, f);
    }
    // Um estado com um projeto chamado __proto__ lê-se como propriedade própria.
    // Texto cru de propósito: num literal `{ __proto__: … }` a chave seria o
    // protótipo e o JSON.stringify não escrevia nada — é a mesma armadilha.
    writeFileSync(join(dir, 'proto.json'), `{"version":1,"projects":{"__proto__":{"run_id":"${RUN_ID}","attempts":2}}}`);
    const lido = readGuardState(join(dir, 'proto.json'));
    assert.equal(lido.projects['__proto__'].attempts, 2);
    assert.equal(Object.getPrototypeOf(lido.projects), null);
  });

  test('a escrita é tmp+rename (como writeProjects) e não deixa .tmp para trás', () => {
    const dir = fresh('escrita');
    const path = join(dir, 'guard', 'state.json');
    writeGuardState(path, { version: 1, projects: { velora: { run_id: RUN_ID, attempts: 2 } } });
    assert.equal(readGuardState(path).projects.velora.attempts, 2);
    assert.deepEqual(readdirSync(join(dir, 'guard')), ['state.json'], 'sem ficheiro temporário ao lado');
    assert.match(readFileSync(path, 'utf8'), /\n$/);
  });
});

describe('o estado vem só do Core (lib/projects.mjs)', () => {
  test('runSummary lê .forja/current.json; um RUN.json legado "running" nunca é lido', async () => {
    const { runSummary, projectStatus } = await import('../lib/projects.mjs');
    const p = projectFolder('modo');
    writeLegacyRun(p, { run_id: 'R-20260917-ab12', status: 'running', driver: 'runner' });
    assert.equal(runSummary(p), null, 'sem estado Core não há run: o RUN.json legado é história');
    assert.deepEqual(projectStatus({ path: p }), { run: null, runnerAlive: false });
    writeCore(p);
    assert.equal(runSummary(p).run_id, RUN_ID);
    assert.equal(runSummary(p).driver, 'core');
    assert.equal(runSummary(p).status, 'running');
    assert.equal(projectStatus({ path: p }).runnerAlive, false, 'sem .forja/lock.json o controlador está morto');
  });
});

describe('as duas mensagens (só estado, nunca caminhos)', () => {
  test('sem "\\", sem "/", sem run_id, sem o texto do objetivo — e com o projeto e a contagem', () => {
    for (const msg of [relaunchMessage('velora poker', 2, 3), gaveUpMessage('velora poker', 3)]) {
      assert.equal(msg.includes('\\'), false, msg);
      assert.equal(msg.includes('/'), false, `"2/3" seria um caminho para quem lê: ${msg}`);
      assert.equal(/[FR]-\d{8}-[0-9a-f]{4}/.test(msg), false, 'nada que se pareça com um run_id');
      assert.equal(/objetivo secreto/.test(msg), false);
      assert.ok(msg.includes('velora poker'));
    }
    assert.match(relaunchMessage('velora', 2, 3), /tentativa 2 de 3/);
    assert.match(gaveUpMessage('velora', 3), /3 tentativas/);
    // Um nome de registo com separadores nunca vira caminho na notificação.
    assert.equal(relaunchMessage('..\\..\\etc/passwd', 1, 3).includes('/'), false);
  });
});

describe('guardPlan (pura: sem relógio real, sem I/O)', () => {
  test('sem run legível: nada a fazer — e o contador NÃO se perde (o estado Core pode estar a meio de uma escrita)', () => {
    const r = guardPlan([proj({ run: null })], stateOf({ run_id: RUN_ID, attempts: 2, gave_up_at: new Date(T0).toISOString() }), T0);
    assert.deepEqual(r.actions, []); assert.deepEqual(r.giveUps, []);
    assert.deepEqual(r.skips, [{ name: 'velora', why: 'sem run Core legível neste projeto — o contador fica como está' }]);
    assert.deepEqual(r.state.projects.velora, {
      run_id: RUN_ID, attempts: 2, failed_spawns: 0, dead_since: null, last_attempt_at: null, alive_since: null, gave_up_at: new Date(T0).toISOString(),
    }, 'uma leitura falhada não é prova de nada: nem zera tentativas, nem apaga uma desistência já anunciada');
    // Um projeto que nunca teve estado continua a ler-se como estado vazio.
    const novo = guardPlan([proj({ run: null })], { version: 1, projects: {} }, T0);
    assert.deepEqual(novo.state.projects.velora, { run_id: null, attempts: 0, failed_spawns: 0, dead_since: null, last_attempt_at: null, alive_since: null, gave_up_at: null });
  });

  test('a corrida real: um current.json ilegível lê-se como nulo — e as 2 tentativas gastas sobrevivem-lhe', async () => {
    const { runSummary } = await import('../lib/projects.mjs');
    const p = projectFolder('meia-escrita');
    const file = join(p, '.forja', 'current.json');
    const inteiro = JSON.stringify(coreState(), null, 2) + '\n';
    // Um ficheiro truncado (disco cheio, cópia a meio) é o que um leitor no
    // milissegundo errado vê.
    writeFileSync(file, inteiro.slice(0, 20));
    assert.equal(runSummary(p), null, 'meio ficheiro não é JSON: o leitor vê "sem run"');
    const gasto = stateOf({ run_id: RUN_ID, attempts: 2, dead_since: new Date(T0 - 60 * MIN).toISOString(), last_attempt_at: new Date(T0 - 30 * MIN).toISOString() });
    const glitch = guardPlan([proj({ path: p, run: runSummary(p) })], roundTrip(gasto), T0);
    assert.equal(glitch.state.projects.velora.attempts, 2);
    // A escrita acaba: o mesmo run volta a ler-se, e a tentativa seguinte é a 3ª.
    writeFileSync(file, inteiro);
    const depois = guardPlan([proj({ path: p, run: runSummary(p) })], roundTrip(glitch.state), T0 + MIN);
    assert.deepEqual(depois.actions.map(a => a.attempt), [3], 'não voltou à tentativa 1 por causa de uma leitura falhada');
  });

  test('run finished / failed / blocked: nunca relançado, contador a zero, e o bloqueado di-lo por extenso', () => {
    for (const status of ['finished', 'failed', 'abandoned']) {
      const r = guardPlan([proj({ run: { run_id: RUN_ID, status } })], stateOf({ run_id: RUN_ID, attempts: 2, dead_since: new Date(T0 - 60 * MIN).toISOString() }), T0);
      assert.deepEqual(r.actions, []);
      assert.deepEqual(r.skips, [{ name: 'velora', why: `run ${status}` }]);
      assert.equal(r.state.projects.velora.attempts, 0);
    }
    const blocked = guardPlan([proj({ run: { run_id: RUN_ID, status: 'blocked' } })], stateOf({ run_id: RUN_ID, attempts: 1 }), T0);
    assert.deepEqual(blocked.actions, []);
    assert.match(blocked.skips[0].why, /bloqueado — precisa de uma pessoa/);
    assert.equal(blocked.state.projects.velora.attempts, 0);
    // Um run sem estado nenhum também não é um run a correr.
    const semEstado = guardPlan([proj({ run: { run_id: RUN_ID } })], { version: 1, projects: {} }, T0);
    assert.deepEqual(semEstado.actions, []);
    assert.deepEqual(semEstado.skips, [{ name: 'velora', why: 'run sem estado' }]);
  });

  test('controlador vivo: nada a fazer e o relógio de morte é limpo', () => {
    const r = guardPlan([proj({ runnerAlive: true })], stateOf({ run_id: RUN_ID, attempts: 1, dead_since: new Date(T0 - 30 * MIN).toISOString() }), T0);
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.skips, [{ name: 'velora', why: 'controlador vivo' }]);
    assert.equal(r.state.projects.velora.dead_since, null);
    assert.equal(r.state.projects.velora.alive_since, new Date(T0).toISOString(), 'a série de saúde começa a contar agora');
    assert.equal(r.state.projects.velora.attempts, 1, 'estar vivo um instante não perdoa as tentativas já gastas');
  });

  test('morto mas dentro da graça: ainda não é um relançamento', () => {
    const first = guardPlan([proj()], { version: 1, projects: {} }, T0);
    assert.deepEqual(first.actions, []);
    assert.match(first.skips[0].why, /dentro da graça/);
    assert.equal(first.state.projects.velora.dead_since, new Date(T0).toISOString());
    const later = guardPlan([proj()], roundTrip(first.state), T0 + GUARD_DEAD_GRACE_MS - 1000);
    assert.deepEqual(later.actions, [], 'um segundo antes da graça acabar ainda não');
  });

  test('morto depois da graça: uma ação, tentativa 1, e o modo visível do run vai com ela', () => {
    const state = roundTrip(guardPlan([proj()], { version: 1, projects: {} }, T0).state);
    const r = guardPlan([proj()], state, T0 + GUARD_DEAD_GRACE_MS);
    assert.deepEqual(r.actions, [{ name: 'velora', path: join(root, 'velora'), attempt: 1, driver: 'core', runId: RUN_ID }]);
    assert.deepEqual(r.giveUps, []); assert.deepEqual(r.skips, []);
    assert.equal(r.state.projects.velora.attempts, 0, 'o contador só sobe depois de o processo ter mesmo arrancado');
  });

  test('só um controlador Core é relançado: um run legado (ou sem driver) nunca produz uma ação', () => {
    for (const driver of ['runner', 'claude-bg', undefined]) {
      const state = stateOf({ run_id: RUN_ID, attempts: 1, dead_since: new Date(T0 - 60 * MIN).toISOString() });
      let s = roundTrip(state);
      for (const t of [T0, T0 + GUARD_DEAD_GRACE_MS, T0 + 10 * GUARD_RETRY_MS]) {
        const r = guardPlan([proj({ run: { run_id: RUN_ID, status: 'running', driver } })], s, t);
        assert.deepEqual(r.actions, [], `driver ${driver}`);
        assert.deepEqual(r.giveUps, [], 'nem desistência: não há nada a tentar');
        assert.match(r.skips[0].why, /só relança controladores Core/);
        assert.equal(r.state.projects.velora.dead_since, null);
        assert.equal(r.state.projects.velora.attempts, 1);
        s = roundTrip(r.state);
      }
    }
  });

  test('as três tentativas, com 15 min entre elas, e a desistência à quarta morte — uma só vez', () => {
    // Tentativa 1 já dada agora mesmo (o estado é o que runGuardOnce escreveria).
    let state = stateOf({ run_id: RUN_ID, attempts: 1, dead_since: null, last_attempt_at: new Date(T0).toISOString(), alive_since: null, gave_up_at: null });
    // Morre outra vez 3 min depois: passa a graça, mas não os 15 min entre tentativas.
    const cedo = guardPlan([proj()], roundTrip(state), T0 + 3 * MIN);
    assert.deepEqual(cedo.actions, []);
    const aindaCedo = guardPlan([proj()], roundTrip(cedo.state), T0 + 6 * MIN);
    assert.deepEqual(aindaCedo.actions, []);
    assert.match(aindaCedo.skips[0].why, /última tentativa há 6 min/);
    // Passados os 15 min: tentativa 2.
    const dois = guardPlan([proj()], roundTrip(aindaCedo.state), T0 + GUARD_RETRY_MS);
    assert.deepEqual(dois.actions, [{ name: 'velora', path: join(root, 'velora'), attempt: 2, driver: 'core', runId: RUN_ID }]);
    // ... e a 3.
    state = stateOf({ run_id: RUN_ID, attempts: 2, dead_since: new Date(T0 + GUARD_RETRY_MS).toISOString(), last_attempt_at: new Date(T0 + GUARD_RETRY_MS).toISOString() });
    const tres = guardPlan([proj()], roundTrip(state), T0 + 2 * GUARD_RETRY_MS);
    assert.deepEqual(tres.actions, [{ name: 'velora', path: join(root, 'velora'), attempt: 3, driver: 'core', runId: RUN_ID }]);
    assert.equal(GUARD_MAX_ATTEMPTS, 3);
    // Quarta morte: desisto, uma vez.
    state = stateOf({ run_id: RUN_ID, attempts: 3, dead_since: new Date(T0 + 2 * GUARD_RETRY_MS).toISOString(), last_attempt_at: new Date(T0 + 2 * GUARD_RETRY_MS).toISOString() });
    const desisto = guardPlan([proj()], roundTrip(state), T0 + 3 * GUARD_RETRY_MS);
    assert.deepEqual(desisto.actions, []);
    assert.deepEqual(desisto.giveUps, [{ name: 'velora', attempts: 3 }]);
    assert.equal(desisto.state.projects.velora.gave_up_at, new Date(T0 + 3 * GUARD_RETRY_MS).toISOString());
    // E nas voltas seguintes: nem ação, nem segunda desistência.
    let s = roundTrip(desisto.state);
    for (const t of [T0 + 3 * GUARD_RETRY_MS + MIN, T0 + 10 * GUARD_RETRY_MS, T0 + 100 * GUARD_RETRY_MS]) {
      const r = guardPlan([proj()], s, t);
      assert.deepEqual(r.actions, [], `volta em +${t - T0} ms`);
      assert.deepEqual(r.giveUps, [], 'a desistência anuncia-se uma vez só');
      assert.match(r.skips[0].why, /já desisti/);
      s = roundTrip(r.state);
    }
  });

  // A guarda é a única peça do Forja que arranca um processo sem ninguém a
  // olhar: antes dela, relançar um run exigia um toque no telemóvel, e esse
  // toque era a última pessoa a ver o run_id que vem do disco. Um projeto
  // preparado pode trazer estado com um run_id forjado, e esse id acaba no
  // `--expected-run` de uma linha de comandos.
  test('um run_id forjado (aspas, &, espaços, controlo) nunca produz uma ação — e também não zera nem repete o id', () => {
    const maus = [
      'R" & calc.exe & "x',        // aspas e & de uma linha de comandos com shell
      'F-2026 0917-ab12',          // espaço
      'F-20260917-ab12\u0000',     // carácter de controlo
      'R\nX',                      // quebra de linha (forjaria uma linha de log)
      'R;whoami',
      'R`$(whoami)`',
      '..\\..\\etc\\passwd',
      '/etc/passwd',
      'R'.repeat(65),              // comprido de mais
      '',
      'F-2026—0917',               // travessão, não é hífen
    ];
    for (const id of maus) {
      const gasto = stateOf({ run_id: RUN_ID, attempts: 2, dead_since: new Date(T0 - 60 * MIN).toISOString(), last_attempt_at: new Date(T0 - 60 * MIN).toISOString() });
      const mau = proj({ run: { run_id: id, status: 'running', driver: 'core' } });
      // Várias voltas, incluindo bem depois da graça e dos 15 min: era aí que o
      // relançamento sairia se o id não fosse validado.
      let s = roundTrip(gasto);
      for (const t of [T0, T0 + GUARD_DEAD_GRACE_MS, T0 + GUARD_RETRY_MS, T0 + 10 * GUARD_RETRY_MS]) {
        const r = guardPlan([mau], s, t);
        assert.deepEqual(r.actions, [], `run_id ${JSON.stringify(id)} não pode gerar um relançamento (volta em +${(t - T0) / MIN} min)`);
        assert.deepEqual(r.giveUps, []);
        assert.match(r.skips[0].why, /run_id/);
        assert.equal(/["&;`$\u0000\n\\/]|calc|whoami|passwd/.test(r.skips[0].why), false, `o id forjado nunca é repetido no log: ${r.skips[0].why}`);
        assert.equal(r.state.projects.velora.attempts, 2, 'um id ilegível não é prova de nada: o contador fica como está');
        assert.equal(r.state.projects.velora.run_id, RUN_ID, 'e o id bom que estava guardado não é substituído pelo forjado');
        s = roundTrip(r.state);
      }
    }
    // E um id legítimo continua a passar, em qualquer das formas que o Forja escreve.
    for (const bom of [RUN_ID, 'F-20260917-0000', 'a', 'A'.repeat(64), 'run_1.2-3']) {
      assert.equal(validRunId(bom), true, bom);
      const r = guardPlan([proj({ run: { run_id: bom, status: 'running', driver: 'core' } })], stateOf({ run_id: bom, dead_since: new Date(T0 - 60 * MIN).toISOString() }), T0);
      assert.deepEqual(r.actions.map(a => a.attempt), [1], bom);
    }
  });

  test('o contador atravessa reinícios da guarda: o estado vem do disco, não da memória', () => {
    const dir = fresh('persistencia');
    const path = guardPaths(dir).state;
    writeGuardState(path, stateOf({ run_id: RUN_ID, attempts: 2, dead_since: new Date(T0).toISOString(), last_attempt_at: new Date(T0).toISOString() }));
    const r = guardPlan([proj()], readGuardState(path), T0 + GUARD_RETRY_MS);
    assert.deepEqual(r.actions.map(a => a.attempt), [3], 'depois de reiniciar, a tentativa seguinte é a 3 e não a 1');
  });

  test('reset (a): outro run_id no disco põe o contador a zero e limpa a desistência', () => {
    const state = stateOf({ run_id: RUN_ID, attempts: 3, gave_up_at: new Date(T0).toISOString(), dead_since: new Date(T0).toISOString(), last_attempt_at: new Date(T0).toISOString() });
    const novo = proj({ run: { run_id: 'F-20260918-ffff', status: 'running', driver: 'core' } });
    const dentroDaGraca = guardPlan([novo], roundTrip(state), T0 + 10 * MIN);
    assert.deepEqual(dentroDaGraca.actions, [], 'o run novo começa com a graça do zero');
    assert.equal(dentroDaGraca.state.projects.velora.attempts, 0);
    assert.equal(dentroDaGraca.state.projects.velora.gave_up_at, null);
    assert.equal(dentroDaGraca.state.projects.velora.run_id, 'F-20260918-ffff');
    const r = guardPlan([novo], roundTrip(dentroDaGraca.state), T0 + 10 * MIN + GUARD_DEAD_GRACE_MS);
    assert.deepEqual(r.actions.map(a => a.attempt), [1]);
  });

  test('reset (c): controlador vivo há 30 min zera o contador e a desistência; menos do que isso não mexe em nada', () => {
    const state = stateOf({ run_id: RUN_ID, attempts: 3, gave_up_at: new Date(T0).toISOString(), last_attempt_at: new Date(T0).toISOString(), alive_since: new Date(T0).toISOString() });
    const cedo = guardPlan([proj({ runnerAlive: true })], roundTrip(state), T0 + GUARD_HEALTHY_MS - MIN);
    assert.equal(cedo.state.projects.velora.attempts, 3, 'ainda não esteve vivo tempo que chegue');
    assert.equal(cedo.state.projects.velora.gave_up_at, new Date(T0).toISOString());
    assert.deepEqual(cedo.skips, [{ name: 'velora', why: 'controlador vivo' }]);
    const curado = guardPlan([proj({ runnerAlive: true })], roundTrip(state), T0 + GUARD_HEALTHY_MS);
    assert.equal(curado.state.projects.velora.attempts, 0);
    assert.equal(curado.state.projects.velora.gave_up_at, null);
    assert.equal(curado.state.projects.velora.last_attempt_at, null);
    assert.match(curado.skips[0].why, /contador a zero/);
    // A série tem de ser contínua: uma morte pelo meio recomeça a contagem.
    const morreu = guardPlan([proj()], roundTrip(state), T0 + 5 * MIN);
    assert.equal(morreu.state.projects.velora.alive_since, null);
    const voltou = guardPlan([proj({ runnerAlive: true })], roundTrip(morreu.state), T0 + 6 * MIN);
    assert.equal(voltou.state.projects.velora.alive_since, new Date(T0 + 6 * MIN).toISOString(), 'a série recomeça na primeira volta em que o vejo vivo');
    const trintaDepois = guardPlan([proj({ runnerAlive: true })], roundTrip(voltou.state), T0 + 6 * MIN + GUARD_HEALTHY_MS - 1);
    assert.equal(trintaDepois.state.projects.velora.attempts, 3, 'os 30 min contam da série nova, não da antiga');
  });

  test('o relógio a andar para trás (acerto de hora) nunca produz uma ação nem um NaN', () => {
    const state = stateOf({ run_id: RUN_ID, attempts: 1, dead_since: new Date(T0).toISOString(), last_attempt_at: new Date(T0).toISOString(), alive_since: new Date(T0).toISOString() });
    for (const back of [MIN, 60 * MIN, 24 * 60 * MIN]) {
      const r = guardPlan([proj()], roundTrip(state), T0 - back);
      assert.deepEqual(r.actions, [], `com o relógio ${back} ms atrás`);
      assert.deepEqual(r.giveUps, []);
      const json = JSON.stringify(r.state);
      assert.equal(/NaN|Invalid Date/.test(json), false, json);
      assert.equal(r.state.projects.velora.dead_since, new Date(T0 - back).toISOString(), 'o relógio de morte volta a ser carimbado');
      const vivo = guardPlan([proj({ runnerAlive: true })], roundTrip(state), T0 - back);
      assert.equal(vivo.state.projects.velora.alive_since, new Date(T0 - back).toISOString());
      assert.equal(/NaN/.test(JSON.stringify(vivo.state)), false);
    }
  });

  test('valores impossíveis no ficheiro de estado não viram NaN nem tentativas infinitas', () => {
    const lixo = { version: 1, projects: { velora: { run_id: 42, attempts: 'muitas', dead_since: 'ontem', last_attempt_at: {}, alive_since: [], gave_up_at: 'nunca' } } };
    const r = guardPlan([proj()], lixo, T0);
    assert.equal(/NaN/.test(JSON.stringify(r.state)), false);
    assert.equal(r.state.projects.velora.attempts, 0);
    const demais = guardPlan([proj()], { version: 1, projects: { velora: { run_id: RUN_ID, attempts: 99, dead_since: new Date(T0 - 60 * MIN).toISOString() } } }, T0);
    assert.deepEqual(demais.actions, [], '99 tentativas continua a ser "já chega"');
    assert.deepEqual(demais.giveUps, [{ name: 'velora', attempts: GUARD_MAX_ATTEMPTS }]);
  });

  test('vários projetos numa volta: cada um com o seu estado, e um projeto que saiu do registo sai do estado', () => {
    const list = [
      proj(),
      proj({ name: 'gearlift', path: join(root, 'gearlift'), runnerAlive: true }),
      proj({ name: 'job-hunter', path: join(root, 'job-hunter'), run: { run_id: 'F-20260917-cccc', status: 'finished' } }),
    ];
    const state = { version: 1, projects: { velora: { run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() }, apagado: { run_id: 'x', attempts: 2 } } };
    const r = guardPlan(list, state, T0);
    assert.deepEqual(r.actions.map(a => a.name), ['velora']);
    assert.deepEqual(Object.keys(r.state.projects).sort(), ['gearlift', 'job-hunter', 'velora'], 'um projeto que já não está no registo não fica no estado para sempre');
  });
});

// ---------- a camada de ação ----------
// Tudo falso: nenhum processo arranca, nenhuma notificação sai.
function fakes() {
  const spawned = []; const sent = []; const lines = [];
  return {
    spawned, sent, lines,
    spawn: opts => { spawned.push(opts); return 4242; },
    notify: async (message, o) => { sent.push({ message, ...o }); return { ok: true }; },
    log: line => lines.push(line),
  };
}
const projectFolder = name => {
  const p = join(root, 'projetos', name);
  mkdirSync(join(p, 'docs', 'forja'), { recursive: true }); mkdirSync(join(p, '.forja'), { recursive: true });
  return p;
};
// The Core state a controller writes; no .forja/lock.json means its controller is dead.
const coreState = (over = {}) => ({ version: 1, run_id: RUN_ID, status: 'running', goal: 'objetivo secreto do run', created_at: new Date(T0).toISOString(), tasks: [], ...over });
const writeCore = (p, over) => writeFileSync(join(p, '.forja', 'current.json'), JSON.stringify(coreState(over), null, 2));
const writeLegacyRun = (p, run) => writeFileSync(join(p, 'docs', 'forja', 'RUN.json'), JSON.stringify(run, null, 2));

describe('runGuardOnce (spawn, notify e relógio injetados)', () => {
  test('um controlador Core morto: um spawn só, sem objetivo, um resume do mesmo run_id com via=guard, estado gravado e sem notificação', async () => {
    const dir = fresh('pass'); const path = projectFolder('velora');
    const f = fakes();
    const list = () => [proj({ path, runnerAlive: false })];
    writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() }));
    const r = await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, log: f.log, now: T0 });
    assert.equal(f.spawned.length, 1);
    assert.deepEqual(f.spawned[0].project, { name: 'velora', path, runId: RUN_ID });
    assert.equal('goal' in f.spawned[0], false, 'a guarda nunca arranca um run novo: só retoma o que existe');
    assert.equal(f.spawned[0].action, 'resume');
    assert.equal(f.spawned[0].via, 'guard');
    assert.equal(f.spawned[0].dataDir, dir);
    assert.deepEqual(r.launched, [{ name: 'velora', pid: 4242, attempt: 1 }]);
    const state = readGuardState(guardPaths(dir).state);
    assert.equal(state.projects.velora.attempts, 1);
    assert.equal(state.projects.velora.last_attempt_at, new Date(T0).toISOString());
    assert.equal(state.projects.velora.dead_since, null, 'a graça recomeça a contar a partir do relançamento');
    assert.equal(f.sent.length, 0, 'relançamento bem sucedido não avisa o telemóvel — nada espera pelo Sponsor');
    assert.equal(f.lines.length, 1);
    assert.match(f.lines[0], /velora: relançado \(tentativa 1 de 3, pid 4242\)/);
    assert.equal(/objetivo secreto/.test(f.lines[0]), false, 'o log da guarda não leva o texto do objetivo');
  });

  test('a linha de comandos e o ambiente reais do relançamento (launchCore com o spawn de baixo falso)', async () => {
    const dir = fresh('argv'); const path = projectFolder('argv');
    writeCore(path);
    const calls = [];
    const spawnRunner = (command, args, options) => { calls.push({ command, args, options }); return { pid: 777 }; };
    const f = fakes();
    process.env.CLAUDE_CODE_SESSION_ID = 'sessao-de-quem-lancou';
    process.env.FORJA_PROJECT_ROOT = 'C:\\outro\\projeto';
    let r;
    try {
      writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() }, 'argv'));
      r = await runGuardOnce({
        dataDir: dir, forjaRoot: 'C:\\forja', log: f.log, notify: f.notify, now: T0,
        list: () => [proj({ name: 'argv', path })],
        spawn: opts => launchCore({ ...opts, spawnRunner }),
      });
    } finally { delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.FORJA_PROJECT_ROOT; }
    assert.deepEqual(r.launched, [{ name: 'argv', pid: 777, attempt: 1 }]);
    assert.equal(calls.length, 1);
    const { command, args, options } = calls[0];
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [join('C:\\forja', 'bin', 'forja.mjs'), 'core', 'resume', '--expected-run', RUN_ID]);
    assert.equal(args.includes('--goal'), false);
    assert.equal(options.cwd, path);
    assert.equal(options.env.FORJA_DATA_DIR, dir);
    assert.equal('CLAUDE_CODE_SESSION_ID' in options.env, false, 'a sessão de quem lançou nunca entra no run');
    assert.equal('FORJA_PROJECT_ROOT' in options.env, false);
    assert.equal(dirname(options.logPath), join(dir, 'core'));
  });

  test('launchCore recusa no último instante: outro run_id, um run que já não corre, um controlador vivo ou só um RUN.json legado', () => {
    const dir = fresh('recusa');
    const calls = [];
    const spawnRunner = (...a) => { calls.push(a); return { pid: 1 }; };
    const launch = (path, runId = RUN_ID) => launchCore({ dataDir: dir, forjaRoot: 'C:\\forja', project: { name: 'recusa', path, runId }, spawnRunner });
    const legado = projectFolder('recusa-legado');
    writeLegacyRun(legado, { run_id: 'R-20260917-ab12', status: 'running', driver: 'runner' });
    assert.equal(launch(legado, 'R-20260917-ab12'), undefined, 'um RUN.json legado "running" nunca é relançado');
    const outro = projectFolder('recusa-outro'); writeCore(outro, { run_id: 'F-20260918-ffff' });
    assert.equal(launch(outro), undefined, 'o run no disco mudou desde a decisão');
    const acabado = projectFolder('recusa-acabado'); writeCore(acabado, { status: 'done' });
    assert.equal(launch(acabado), undefined);
    const vivo = projectFolder('recusa-vivo'); writeCore(vivo);
    writeFileSync(join(vivo, '.forja', 'lock.json'), JSON.stringify({ pid: process.pid }));
    assert.equal(launch(vivo), undefined, 'nunca por cima de um controlador vivo');
    assert.deepEqual(calls, []);
  });

  test('um spawn sem pid (ou que rebenta) não gasta tentativa, fica escrito, e a volta continua para os outros projetos', async () => {
    const dir = fresh('semPid'); const a = projectFolder('a'); const b = projectFolder('b');
    const lines = []; const sent = [];
    const morto = { run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() };
    writeGuardState(guardPaths(dir).state, { version: 1, projects: { a: morto, b: { ...morto } } });
    const list = () => [proj({ name: 'a', path: a }), proj({ name: 'b', path: b })];
    const r = await runGuardOnce({
      dataDir: dir, forjaRoot: 'C:\\forja', list, log: l => lines.push(l), now: T0,
      notify: async (message, o) => { sent.push({ message, ...o }); return { ok: true }; },
      spawn: opts => { if (opts.project.name === 'a') return undefined; throw new Error('boom'); },
    });
    const state = readGuardState(guardPaths(dir).state);
    assert.equal(state.projects.a.attempts, 0, 'sem pid, sem tentativa gasta');
    assert.equal(state.projects.b.attempts, 0, 'com exceção, sem tentativa gasta');
    // ... mas a tentativa é contada como falhada E carimbada: é isto que impede
    // a volta seguinte de pedir exatamente o mesmo spawn 60 s depois.
    assert.equal(state.projects.a.failed_spawns, 1);
    assert.equal(state.projects.b.failed_spawns, 1);
    assert.equal(state.projects.a.last_attempt_at, new Date(T0).toISOString(), 'o relógio das tentativas corre também para um spawn que falhou');
    assert.equal(state.projects.a.dead_since, new Date(T0 - 10 * MIN).toISOString(), 'e o controlador continua morto desde quando morreu: nada foi relançado');
    assert.deepEqual(r.failed, ['a', 'b']);
    assert.deepEqual(sent, [], 'não se anuncia um relançamento que não aconteceu');
    assert.match(lines[0], /a: relançamento falhou \(sem pid\)/);
    assert.match(lines[0], /b: relançamento falhou \(boom\)/);
  });

  // O bug que o revisor apanhou: com o spawn a nunca dar pid, a volta anterior
  // não carimbava nada, e por isso `sinceAttempt` era sempre null e `attempts`
  // sempre 0 — a mesma ação saía outra vez a cada volta, para sempre, sem
  // espaçamento, sem teto e sem ninguém ser avisado. Uma volta só nunca
  // apanhava isto: este teste corre 200 voltas, como a guarda a sério.
  test('BLOQUEADOR: 200 voltas com um spawn que nunca dá pid — 3 tentativas espaçadas de 15 min, e depois a desistência (nunca 200 spawns)', async () => {
    const dir = fresh('semPidVoltas'); const path = projectFolder('semPidVoltas');
    const spawnsAt = []; const sent = []; const lines = [];
    writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() }, 'semPidVoltas'));
    const list = () => [proj({ name: 'semPidVoltas', path })];
    const VOLTAS = 200;
    for (let i = 0; i < VOLTAS; i++) {
      const now = T0 + i * GUARD_POLL_MS; // a guarda acorda de 60 em 60 s
      await runGuardOnce({
        dataDir: dir, forjaRoot: 'C:\\forja', list, now, log: l => lines.push(l),
        spawn: () => { spawnsAt.push((now - T0) / MIN); return undefined; },   // o spawn nunca dá pid, volta após volta
        notify: async (message, o) => { sent.push({ message, ...o }); return { ok: true }; },
      });
    }
    assert.deepEqual(spawnsAt, [0, 15, 30], `${VOLTAS} voltas deram ${spawnsAt.length} spawns: têm de ser 3, a 0, 15 e 30 min`);
    const state = readGuardState(guardPaths(dir).state);
    assert.equal(state.projects.semPidVoltas.attempts, 0, 'nenhum processo arrancou: nenhuma tentativa real foi gasta');
    assert.equal(state.projects.semPidVoltas.failed_spawns, GUARD_MAX_ATTEMPTS);
    assert.equal(state.projects.semPidVoltas.gave_up_at, new Date(T0 + 45 * MIN).toISOString(), 'à quarta vez que podia tentar, desiste');
    assert.deepEqual(sent, [{ message: gaveUpMessage('semPidVoltas', 3), priority: 'urgent', tags: ['rotating_light'], dedup: false }],
      'uma só notificação em 200 voltas — e é a urgente, a que chama o Sponsor');
    assert.equal(lines.length, VOLTAS, 'uma linha de log por volta, como sempre');
    assert.equal(lines.filter(l => /relançamento falhou/.test(l)).length, 3);
    assert.ok(lines.filter(l => /espero 15 min entre tentativas/.test(l)).length > 40, 'entre tentativas a volta diz porque não faz nada');
    assert.ok(lines.slice(-1)[0].includes('já desisti'), lines.slice(-1)[0]);
  });

  test('um current.json com um run_id forjado nunca chega ao spawn (é aqui que já não há uma pessoa a olhar)', async () => {
    const dir = fresh('runIdMau'); const path = projectFolder('runIdMau');
    const f = fakes();
    const forjado = 'F-2026" & calc.exe & "0917';
    writeCore(path, { run_id: forjado });
    const { runSummary, projectStatus } = await import('../lib/projects.mjs');
    assert.equal(runSummary(path), null, 'o leitor Core recusa o id: não há run');
    writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, attempts: 1, dead_since: new Date(T0 - 60 * MIN).toISOString(), last_attempt_at: new Date(T0 - 60 * MIN).toISOString() }, 'runIdMau'));
    for (const list of [
      () => [{ name: 'runIdMau', path, ...projectStatus({ path }) }],
      // Even when a caller hands the forged id over, the guard's own gate refuses it.
      () => [{ name: 'runIdMau', path, run: { run_id: forjado, status: 'running', driver: 'core' }, runnerAlive: false }],
    ]) {
      f.lines.length = 0;
      const r = await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', spawn: f.spawn, notify: f.notify, log: f.log, now: T0, list });
      assert.deepEqual(r.actions, []);
      assert.equal(/calc\.exe|"/.test(f.lines[0]), false, f.lines[0]);
    }
    assert.deepEqual(f.spawned, [], '…e nunca vira um processo');
    assert.deepEqual(f.sent, []);
    assert.equal(existsSync(join(dir, 'core')), false, 'nem sequer um log de arranque');
    assert.match(f.lines[0], /run_id/);
    assert.equal(readGuardState(guardPaths(dir).state).projects.runIdMau.attempts, 1, 'e o contador do run bom não foi zerado por causa dele');
  });

  test('um projeto chamado __proto__ é vigiado como outro qualquer, e o contador dele chega mesmo ao disco', async () => {
    const dir = fresh('proto'); const path = projectFolder('proto');
    const f = fakes();
    const list = () => [proj({ name: '__proto__', path })];
    const { safeName } = await import('../lib/projects.mjs');
    assert.equal(safeName('__proto__'), '__proto__', 'o registo deixa passar este nome: por isso é que tem de funcionar');
    writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() }, '__proto__'));
    // Primeira volta: relançado, como qualquer outro projeto.
    const r = await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, log: f.log, now: T0 });
    assert.deepEqual(r.launched, [{ name: '__proto__', pid: 4242, attempt: 1 }]);
    // E o contador foi mesmo gravado: no ficheiro, como propriedade própria.
    const cru = JSON.parse(readFileSync(guardPaths(dir).state, 'utf8'));
    assert.ok(Object.prototype.hasOwnProperty.call(cru.projects, '__proto__'), 'num mapa `{}` esta escrita perdia-se em silêncio');
    assert.equal(cru.projects['__proto__'].attempts, 1);
    assert.equal(readGuardState(guardPaths(dir).state).projects['__proto__'].attempts, 1, 'e volta a ler-se');
    assert.equal(Object.getPrototypeOf(readGuardState(guardPaths(dir).state).projects), null, 'o mapa lido não tem protótipo');
    // Voltas seguintes: o estado gravado é lido — a graça recomeça no
    // relançamento e depois espera-se os 15 min entre tentativas.
    await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, log: f.log, now: T0 + 5 * MIN });
    assert.match(f.lines[1], /dentro da graça/);
    await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, log: f.log, now: T0 + 10 * MIN });
    assert.match(f.lines[2], /espero 15 min entre tentativas/);
    assert.equal(f.spawned.length, 1, 'sem o contador no disco este projeto seria relançado a cada volta, para sempre');
    // E um nome que é um método do Object.prototype também não se confunde com estado.
    const semEstado = guardPlan([proj({ name: 'toString', path })], { version: 1, projects: {} }, T0);
    assert.equal(semEstado.state.projects.toString.attempts, 0, '`prev["toString"]` não é a função do protótipo');
  });

  test('uma pasta que desapareceu entre a decisão e o arranque: não se lança nada lá', async () => {
    const dir = fresh('semPasta');
    const f = fakes();
    writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() }));
    await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list: () => [proj({ path: join(root, 'pasta-que-nao-existe') })], spawn: f.spawn, notify: f.notify, log: f.log, now: T0 });
    assert.deepEqual(f.spawned, []);
    assert.match(f.lines[0], /pasta desapareceu/);
  });

  test('desistência: uma notificação urgent, uma só vez, e a volta seguinte fica calada', async () => {
    const dir = fresh('desisto'); const path = projectFolder('desisto');
    const f = fakes();
    const list = () => [proj({ name: 'desisto', path })];
    writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, attempts: 3, dead_since: new Date(T0 - 60 * MIN).toISOString(), last_attempt_at: new Date(T0 - 60 * MIN).toISOString() }, 'desisto'));
    await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, log: f.log, now: T0 });
    assert.deepEqual(f.spawned, []);
    assert.deepEqual(f.sent, [{ message: gaveUpMessage('desisto', 3), priority: 'urgent', tags: ['rotating_light'], dedup: false }]);
    assert.equal(readGuardState(guardPaths(dir).state).projects.desisto.gave_up_at, new Date(T0).toISOString());
    await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, log: f.log, now: T0 + GUARD_RETRY_MS });
    assert.equal(f.sent.length, 1, 'a segunda volta não volta a tocar o alarme');
    assert.deepEqual(f.spawned, []);
  });

  test('a notificação de desistência leva o link do telemóvel (como o `ping` da CLI), e sem túnel não leva chave nenhuma; um relançamento bem sucedido não notifica', async () => {
    const dir = fresh('click'); const path = projectFolder('click');
    const f = fakes();
    const list = () => [proj({ name: 'click', path })];
    const estado = () => writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, attempts: 3, dead_since: new Date(T0 - 60 * MIN).toISOString(), last_attempt_at: new Date(T0 - 60 * MIN).toISOString() }, 'click'));
    // Sem data/tunnel.json: nada de `click: undefined` no pedido.
    estado();
    await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, log: f.log, now: T0 });
    assert.equal('click' in f.sent[0], false, 'sem túnel, a chave nem sequer vai');
    // Com túnel: a desistência é a que o Sponsor tem de abrir — leva o link.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'tunnel.json'), JSON.stringify({ url: 'https://x.trycloudflare.com', mobileUrl: 'https://x.trycloudflare.com/m?k=segredo' }));
    estado();
    await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, log: f.log, now: T0 + GUARD_RETRY_MS });
    assert.equal(f.sent[1].message, gaveUpMessage('click', 3));
    assert.equal(f.sent[1].click, 'https://x.trycloudflare.com/m?k=segredo', 'o `notify` é que limpa a query (sanitizeClick), como para todos os outros');
    // Um relançamento bem sucedido não avisa o telemóvel: nada espera pelo Sponsor.
    writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, dead_since: new Date(T0 - 60 * MIN).toISOString() }, 'click'));
    await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, log: f.log, now: T0 + 2 * GUARD_RETRY_MS });
    assert.equal(f.sent.length, 2, 'só as duas desistências anteriores — o relançamento não somou uma terceira');
    rmSync(join(dir, 'tunnel.json'), { force: true });
  });

  test('uma notificação que rebenta não trava a volta: o estado fica gravado na mesma', async () => {
    const dir = fresh('notifyMau'); const path = projectFolder('notifyMau');
    const lines = [];
    writeGuardState(guardPaths(dir).state, stateOf({ run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() }, 'notifyMau'));
    const r = await runGuardOnce({
      dataDir: dir, forjaRoot: 'C:\\forja', log: l => lines.push(l), now: T0,
      list: () => [proj({ name: 'notifyMau', path })],
      spawn: () => 99, notify: async () => { throw new Error('ntfy em baixo'); },
    });
    assert.deepEqual(r.launched.map(l => l.pid), [99]);
    assert.equal(readGuardState(guardPaths(dir).state).projects.notifyMau.attempts, 1);
  });

  test('o log escreve uma linha por volta, com os projetos sem ação e o porquê', async () => {
    const dir = fresh('log');
    const f = fakes();
    const list = () => [proj({ runnerAlive: true }), proj({ name: 'parado', run: { run_id: 'F-20260917-dddd', status: 'finished' } })];
    await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', list, spawn: f.spawn, notify: f.notify, now: T0 });
    const log = readFileSync(guardPaths(dir).log, 'utf8').trim().split('\n');
    assert.equal(log.length, 1);
    assert.match(log[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z guarda: 2 projeto\(s\)/);
    assert.match(log[0], /velora: controlador vivo/);
    assert.match(log[0], /parado: run finished/);
  });

  test('com o registo e o disco reais: o Core morto é relançado, o Core vivo não, e um RUN.json legado "running" nunca', async () => {
    const dir = fresh('real');
    const { upsertProject } = await import('../lib/projects.mjs');
    const morto = projectFolder('real-morto'); writeCore(morto);
    // A lock whose pid is gone is a dead controller (no live owner, no live worker).
    writeFileSync(join(morto, '.forja', 'lock.json'), JSON.stringify({ pid: 4000000 }));
    const vivo = projectFolder('real-vivo'); writeCore(vivo);
    writeFileSync(join(vivo, '.forja', 'lock.json'), JSON.stringify({ pid: process.pid }));
    const legado = projectFolder('real-legado');
    writeLegacyRun(legado, { run_id: 'R-20260917-ab12', status: 'running', driver: 'runner', visible: true });
    for (const [name, path] of [['morto', morto], ['vivo', vivo], ['legado', legado]]) upsertProject({ name, path }, dir);
    const f = fakes();
    const stale = { run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() };
    writeGuardState(guardPaths(dir).state, { version: 1, projects: { morto: stale, vivo: { ...stale }, legado: { run_id: 'R-20260917-ab12', dead_since: stale.dead_since } } });
    // No `list` injected: the real listProjectsWithStatus reads data/projects.json and each .forja/.
    const r = await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', spawn: f.spawn, notify: f.notify, log: f.log, now: T0 });
    assert.deepEqual(f.spawned.map(s => s.project), [{ name: 'morto', path: morto, runId: RUN_ID }]);
    assert.deepEqual(r.launched.map(l => l.name), ['morto']);
    assert.match(f.lines[0], /vivo: controlador vivo/);
    assert.match(f.lines[0], /legado: sem run Core legível/);
    // Many ticks later the legacy run is still never touched.
    for (let i = 1; i <= 6; i++) await runGuardOnce({ dataDir: dir, forjaRoot: 'C:\\forja', spawn: f.spawn, notify: f.notify, log: f.log, now: T0 + i * GUARD_RETRY_MS });
    assert.equal(f.spawned.filter(s => s.project.name !== 'morto').length, 0);
  });
});

// ---------- o processo ----------
describe('guardAlive e GUARD_CMD_RE', () => {
  test('um pid que não existe é morto; um processo vivo que não é uma guarda também', async () => {
    assert.equal(guardAlive(4000000), false);
    assert.equal(guardAlive(0), false);
    const estranho = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)'], { stdio: 'ignore', windowsHide: true });
    await new Promise(r => setTimeout(r, 800));
    try {
      assert.equal(guardAlive(estranho.pid), false, 'o pid pode ter sido reutilizado: a linha de comandos é que decide');
    } finally { spawnSync('taskkill', ['/PID', String(estranho.pid), '/T', '/F'], { encoding: 'utf8' }); }
  });
  test('a expressão separa guarda de controlador Core nos dois sentidos', () => {
    assert.equal(GUARD_CMD_RE.test('node C:/f/bin/forja.mjs guard run'), true);
    assert.equal(GUARD_CMD_RE.test('"C:\\nodejs\\node.exe" "C:\\f\\bin\\forja.mjs" guard'), true);
    assert.equal(GUARD_CMD_RE.test('node C:/f/bin/forja.mjs core resume --expected-run F-1'), false);
    assert.equal(GUARD_CMD_RE.test('node C:/f/bin/forja.mjs guardian'), false);
    assert.equal(isCoreRunCmd('node C:/f/bin/forja.mjs guard run'), false, 'uma guarda nunca conta como controlador');
  });
});

describe('guardLoop', () => {
  test('dá voltas, vê o guard.stop, sai com 0 e larga o lock', async () => {
    const dir = fresh('loop');
    const paths = guardPaths(dir);
    let ticks = 0;
    const lines = [];
    writeFileSync(join(fresh('x'), 'nada'), ''); // ruído: outra pasta temporária qualquer
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.stop, 'ficheiro antigo\n'); // um stop de uma paragem anterior é apagado no arranque
    const r = await guardLoop({
      dataDir: dir, forjaRoot: 'C:\\forja', pollMs: 5, log: l => lines.push(l),
      tick: async () => { ticks += 1; if (ticks === 3) writeFileSync(paths.stop, 'para\n'); },
    });
    assert.deepEqual({ ok: r.ok, code: r.code, ticks: r.ticks, why: r.why }, { ok: true, code: 0, ticks: 3, why: 'guard.stop' });
    assert.equal(existsSync(paths.lock), false, 'o lock é largado à saída');
    assert.ok(lines.some(l => /guard\.stop antigo apagado/.test(l)));
    assert.ok(lines.some(l => /a sair \(guard\.stop, 3 voltas\)/.test(l)));
  });

  test('um erro numa volta é registado e a volta seguinte corre na mesma', async () => {
    const dir = fresh('loopErro');
    const paths = guardPaths(dir);
    let ticks = 0; const lines = [];
    const r = await guardLoop({
      dataDir: dir, forjaRoot: 'C:\\forja', pollMs: 5, maxTicks: 3, log: l => lines.push(l),
      tick: async () => { ticks += 1; if (ticks === 1) throw new Error('um projeto estragado'); },
    });
    assert.equal(r.ticks, 3);
    assert.ok(lines.some(l => /a volta falhou \(Error: um projeto estragado\)/.test(l)), lines.join('\n'));
    assert.equal(existsSync(paths.lock), false);
  });

  test('o sinal (Ctrl+C, SIGHUP) acaba a volta como o ficheiro de paragem', async () => {
    const dir = fresh('loopSinal');
    const control = { stop: false };
    const r = await guardLoop({
      dataDir: dir, forjaRoot: 'C:\\forja', pollMs: 5, log: () => {}, control,
      tick: async () => { control.stop = true; },
    });
    assert.deepEqual({ ticks: r.ticks, why: r.why, ok: r.ok }, { ticks: 1, why: 'sinal', ok: true });
  });

  test('uma segunda guarda recusa-se a correr: código 3 e o pid do dono (lock escrito à mão)', async () => {
    const dir = fresh('segunda');
    const paths = guardPaths(dir);
    // Um processo vivo cuja linha de comandos é a de uma guarda — como no teste
    // do controlador em test/up.test.mjs, sem precisar de uma segunda guarda a sério.
    const falsa = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)', 'C:\\naoexiste\\forja\\bin\\forja.mjs', 'guard', 'run'], { stdio: 'ignore', windowsHide: true });
    await new Promise(r => setTimeout(r, 1000));
    try {
      assert.equal(guardAlive(falsa.pid), true, 'a guarda falsa conta como viva');
      mkdirSync(paths.dir, { recursive: true });
      const lock = { pid: falsa.pid, project: 'guard', since: new Date().toISOString(), beat: new Date().toISOString() };
      writeFileSync(paths.lock, JSON.stringify(lock, null, 2));
      const r = await guardLoop({ dataDir: dir, forjaRoot: 'C:\\forja', pollMs: 5, log: () => {}, tick: async () => { throw new Error('nunca deve correr'); } });
      assert.deepEqual({ ok: r.ok, code: r.code, ticks: r.ticks }, { ok: false, code: 3, ticks: 0 });
      assert.equal(r.owner.pid, falsa.pid);
      assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, falsa.pid, 'o lock do dono fica como estava');
      // E pela CLI: exit 3 com o pid do dono no stderr.
      const cliR = spawnSync(process.execPath, [cli, 'guard', 'run'], { env: { ...process.env, FORJA_DATA_DIR: dir }, encoding: 'utf8', timeout: 60_000 });
      assert.equal(cliR.status, 3, cliR.stdout + cliR.stderr);
      assert.match(cliR.stderr, new RegExp(`já há uma guarda viva \\(pid ${falsa.pid}`));
      assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, falsa.pid, 'e quem foi recusado não leva o lock do dono à saída');
    } finally { spawnSync('taskkill', ['/PID', String(falsa.pid), '/T', '/F'], { encoding: 'utf8' }); }
  });

  test('um lock cujo dono morreu (ou cujo batimento é velho) é assumido e registado', async () => {
    const dir = fresh('assume');
    const paths = guardPaths(dir);
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.lock, JSON.stringify({ pid: 4000000, project: 'guard', since: new Date(Date.now() - LOCK_STALE_MS * 2).toISOString(), beat: new Date(Date.now() - LOCK_STALE_MS * 2).toISOString() }));
    const lines = [];
    const r = await guardLoop({ dataDir: dir, forjaRoot: 'C:\\forja', pollMs: 5, maxTicks: 1, log: l => lines.push(l), tick: async () => {} });
    assert.equal(r.ok, true);
    assert.ok(lines.some(l => /lock anterior \(pid 4000000\).*assumido/.test(l)), lines.join('\n'));
  });
});

describe('a CLI: guard status e guard stop (registo temporário, nada lançado)', () => {
  const dir = fresh('cli');
  const projeto = projectFolder('cli-velora');
  const env = { ...process.env, FORJA_DATA_DIR: dir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9', APPDATA: join(dir, 'Roaming') };
  const forja = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 120_000 });
    return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
  };

  test('status: diz o que faria, sem lançar nada e sem escrever o estado', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: [{ name: 'cli-velora', path: projeto, bootstrappedAt: null }] }, null, 2));
    writeCore(projeto);
    const before = existsSync(guardPaths(dir).state);
    const r = forja('guard', 'status');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.running, false, 'não há guarda viva neste data dir');
    assert.deepEqual(r.json.policy, { poll_ms: GUARD_POLL_MS, dead_grace_ms: GUARD_DEAD_GRACE_MS, retry_ms: GUARD_RETRY_MS, max_attempts: GUARD_MAX_ATTEMPTS, healthy_ms: GUARD_HEALTHY_MS });
    assert.deepEqual(r.json.projects, [{ name: 'cli-velora', status: 'running', driver: 'core', runnerAlive: false }]);
    // Primeira volta: o controlador acabou de ser visto morto, por isso ainda está na graça.
    assert.deepEqual(r.json.plan.actions, []);
    assert.match(r.json.plan.skips[0].why, /dentro da graça/);
    assert.equal(existsSync(guardPaths(dir).state), before, 'o status não escreve o estado');
    assert.equal(existsSync(join(dir, 'core')), false, 'e não lança controlador nenhum');
  });

  test('stop: escreve o ficheiro de paragem e mais nada — não mata controladores, não mexe no projeto', () => {
    const marca = join(projeto, '.forja', 'current.json');
    const antes = readFileSync(marca, 'utf8');
    const r = forja('guard', 'stop');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.stopFile, guardPaths(dir).stop);
    assert.equal(r.json.guardPid, null);
    assert.ok(existsSync(guardPaths(dir).stop));
    assert.equal(readFileSync(marca, 'utf8'), antes, 'o estado Core do projeto fica exatamente como estava');
    assert.ok(existsSync(projeto));
    rmSync(guardPaths(dir).stop, { force: true });
  });

  test('um subcomando desconhecido é uma recusa clara, não um arranque', () => {
    const r = forja('guard', 'bogus');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /run\|stop\|status/);
  });

  test('um --poll-ms sem valor ou com lixo é recusado em voz alta, antes de pegar no lock', () => {
    for (const args of [['guard', 'run', '--poll-ms'], ['guard', 'run', '--poll-ms', 'abc'], ['guard', '--poll-ms', '0'], ['guard', 'run', '--poll-ms', '-5']]) {
      const r = forja(...args);
      assert.notEqual(r.code, 0, `${args.join(' ')} devia ser recusado`);
      assert.match(r.err, /--poll-ms/);
      assert.match(r.err, new RegExp(String(GUARD_MIN_POLL_MS)));
      assert.equal(existsSync(guardPaths(dir).lock), false, 'uma recusa não deixa lock para trás');
    }
  });
});

describe('checkedPollMs (o --poll-ms validado como o --forjalvl da CLI)', () => {
  test('um número bom passa; o interruptor nu, o lixo e o valor pequeno rebentam com a razão escrita', () => {
    assert.equal(checkedPollMs(5000), 5000);
    assert.equal(checkedPollMs('60000'), GUARD_POLL_MS);
    assert.equal(checkedPollMs(' 2500 '), 2500);
    assert.equal(checkedPollMs(1500.9), 1500, 'milissegundos são inteiros');
    // `--poll-ms` sozinho vira `true`, e Number(true) é 1: um ciclo a 1 ms é uma
    // guarda a comer um núcleo, não uma guarda.
    assert.throws(() => checkedPollMs(true), /precisa de um número/);
    assert.throws(() => checkedPollMs(''), /precisa de um número/);
    assert.throws(() => checkedPollMs(undefined), /precisa de um número/);
    for (const mau of ['abc', '1e', {}, [], NaN, Infinity, -1, 0, 1, GUARD_MIN_POLL_MS - 1]) {
      assert.throws(() => checkedPollMs(mau), new RegExp(`--poll-ms|>= ${GUARD_MIN_POLL_MS}`), `"${String(mau)}" devia ser recusado`);
    }
    assert.equal(checkedPollMs(GUARD_MIN_POLL_MS), GUARD_MIN_POLL_MS, 'o mínimo é aceite');
    assert.throws(() => checkedPollMs('abc', 'FORJA_GUARD_POLL_MS'), /FORJA_GUARD_POLL_MS/, 'a variável de ambiente diz-se pelo nome dela');
  });
});

describe('`forja down` não conhece a guarda', () => {
  test('nem por linha de comandos (isOurUp / isCoreRunCmd), nem pela árvore de processos', () => {
    const forja = 'C:\\Fixtures\\x\\forja';
    const cmd = 'node C:/Fixtures/x/forja/bin/forja.mjs guard run';
    assert.equal(isOurUp({ Name: 'node.exe', CommandLine: cmd }, { forja }), false, '`down` só mata o `forja up` deste repo');
    assert.equal(isCoreRunCmd(cmd), false);
    // A guarda arranca do seu próprio .vbs, fora da árvore do `up`: o plano de
    // morte de um `down` nunca lhe chega.
    const procs = [
      { ProcessId: 100, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node C:\\f\\bin\\forja.mjs up' },
      { ProcessId: 200, ParentProcessId: 100, Name: 'node.exe', CommandLine: 'node C:\\f\\viewer\\server.mjs' },
      { ProcessId: 900, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node C:\\f\\bin\\forja.mjs guard run' },
    ];
    const plan = planKillTree(100, procs);
    assert.deepEqual(plan.kill, [200, 100]);
    assert.equal(plan.kill.includes(900), false, 'a guarda não entra no plano de um `down`');
  });
});

describe('arranque automático da guarda (ficheiros exatos, nunca a pasta Arranque real)', () => {
  test('o .vbs vai para a pasta Arranque, o .cmd para data/autostart, e a consola para data/guard', () => {
    const p = guardStartupPaths({ appData: 'C:\\Fixtures\\x\\AppData\\Roaming', data: 'C:\\forja\\data' });
    assert.equal(p.startupDir, join('C:\\Fixtures\\x\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'));
    assert.equal(p.launcher, join(p.startupDir, 'forja-guard.vbs'));
    assert.equal(p.wrapper, join('C:\\forja\\data', 'autostart', 'forja-guard.cmd'));
    assert.equal(p.consoleLog, join('C:\\forja\\data', 'guard', 'guard.console.log'));
    assert.equal(p.stop, join('C:\\forja\\data', 'guard', 'guard.stop'));
    assert.throws(() => guardStartupPaths({ appData: '', data: 'x' }), /APPDATA/);
  });

  test('o .cmd corre `guard run` em ciclo com 30 s de espera, sai no guard.stop e no código 3; o .vbs corre-o sem janela', () => {
    const p = guardStartupPaths({ appData: 'C:\\Fixtures\\x\\AppData\\Roaming', data: 'C:\\forja\\data' });
    const files = guardLauncherFiles(p, { forja: 'C:\\forja', node: 'C:\\nodejs\\node.exe' });
    const cmd = files[p.wrapper]; const vbs = files[p.launcher];
    assert.equal(Object.keys(files).length, 2);
    assert.ok(cmd.includes('cd /d "C:\\forja"'));
    assert.ok(cmd.includes('"C:\\nodejs\\node.exe" "C:\\forja\\bin\\forja.mjs" guard run >> "C:\\forja\\data\\guard\\guard.console.log" 2>&1'));
    assert.ok(cmd.includes(':loop') && cmd.includes('goto loop') && cmd.includes('if %FORJA_CODE% EQU 0 goto end'));
    assert.ok(cmd.includes('if %FORJA_CODE% EQU 3 goto end'), 'já há outra guarda viva: sair, nunca martelar');
    assert.ok(cmd.includes(`"C:\\nodejs\\node.exe" -e "setTimeout(function(){}, ${GUARD_WRAPPER_RETRY_S * 1000})"`), '30 s depois de um erro');
    assert.ok(cmd.includes('if exist "C:\\forja\\data\\guard\\guard.stop" del /q "C:\\forja\\data\\guard\\guard.stop"'), 'um arranque limpo apaga o stop antigo');
    assert.equal((cmd.match(/if exist "C:\\forja\\data\\guard\\guard\.stop" goto end/g) || []).length, 2, 'stop verificado antes e depois da espera');
    assert.ok(cmd.includes('\r\n'), 'CRLF para o cmd.exe');
    assert.equal(/forja\.mjs" up/.test(cmd), false, 'o wrapper da guarda nunca arranca o viewer');
    assert.ok(vbs.includes('CreateObject("WScript.Shell")'));
    assert.ok(vbs.includes(`sh.Run "cmd.exe /c ""${p.wrapper}""", 0, False`));
    assert.ok(vbs.includes('\r\n'));
  });

  test('o wrapper do `up` continua a não arrancar a guarda', async () => {
    const { launcherFiles, startupPaths } = await import('../lib/up.mjs');
    const p = startupPaths({ appData: 'C:\\Fixtures\\x\\AppData\\Roaming', data: 'C:\\forja\\data' });
    const cmd = launcherFiles(p, { forja: 'C:\\forja', node: 'C:\\nodejs\\node.exe' })[p.wrapper];
    assert.equal(/guard/.test(cmd), false, 'dois ciclos independentes: o do viewer não sabe da guarda');
  });

  test('`autostart install` escreve os QUATRO ficheiros, repetir não muda nada, e `remove` tira os quatro e pede à guarda que pare', () => {
    const dir = fresh('autostart');
    const appData = join(dir, 'Roaming'); const data = join(dir, 'data');
    const env = { ...process.env, APPDATA: appData, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
    const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 180_000 }); return { code: r.status, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
    const up = { launcher: join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'forja-up.vbs'), wrapper: join(data, 'autostart', 'forja-up.cmd') };
    const g = guardStartupPaths({ appData, data });
    const todos = [up.launcher, up.wrapper, g.launcher, g.wrapper].sort();

    const r1 = forja('autostart', 'install');
    assert.equal(r1.code, 0, r1.err);
    assert.deepEqual(r1.json.written.sort(), todos);
    assert.equal(r1.json.guardLauncher, g.launcher); assert.equal(r1.json.guardWrapper, g.wrapper);
    for (const f of todos) assert.ok(existsSync(f), f);
    assert.ok(readFileSync(g.wrapper, 'utf8').includes(`"${join(here, '..', 'bin', 'forja.mjs')}" guard run`), 'o wrapper corre o bin real deste repo');

    const r2 = forja('autostart', 'install');
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(r2.json.written, []);
    assert.deepEqual(r2.json.unchanged.sort(), todos);

    const r3 = forja('autostart', 'remove');
    assert.equal(r3.code, 0, r3.err);
    assert.deepEqual(r3.json.removed.sort(), todos);
    assert.equal(r3.json.guardStopFile, guardPaths(data).stop);
    assert.ok(existsSync(guardPaths(data).stop), 'a guarda é mandada parar, nunca morta');
    for (const f of todos) assert.equal(existsSync(f), false, f);

    const r4 = forja('autostart', 'remove');
    assert.equal(r4.code, 0, r4.err);
    assert.deepEqual(r4.json.removed, []);
    assert.deepEqual(r4.json.missing.sort(), todos);
  });
});

// ---------- a guarda também vigia o viewer (supervisão mútua, §12) ----------
// A metade da guarda: as regras e a decisão são de lib/supervise.mjs (e estão
// provadas em test/supervise.test.mjs, com os dois lados a correr sobre o mesmo
// relógio falso). O que se prova AQUI é a ligação: a chave nova no estado, a
// volta a fazer as duas coisas numa escrita só, e o `guard status` a dizê-lo.
describe('a guarda vigia o viewer (data/guard/state.json → chave `up`)', () => {
  const upEntry = (over = {}) => ({ attempts: 0, failed_spawns: 0, dead_since: null, last_attempt_at: null, alive_since: null, gave_up_at: null, seen_at: new Date(T0 - 60 * MIN).toISOString(), ...over });
  const withUp = (up, projects = {}) => ({ version: 1, projects, up });

  test('um ficheiro de estado antigo (só com projetos) lê-se na mesma, e a escrita seguinte não perde a chave nova', () => {
    const dir = fresh('estadoAntigo');
    const path = guardPaths(dir).state;
    // Exatamente o que a versão anterior da guarda escrevia.
    mkdirSync(guardPaths(dir).dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, projects: { velora: { run_id: RUN_ID, attempts: 2 } } }, null, 2) + '\n');
    const lido = readGuardState(path);
    assert.equal(lido.projects.velora.attempts, 2);
    assert.deepEqual(lido.up, {}, 'sem a chave nova, o viewer lê-se como entrada vazia');
    writeGuardState(path, { ...lido, up: upEntry({ attempts: 1 }) });
    const outra = readGuardState(path);
    assert.equal(outra.projects.velora.attempts, 2, 'e os projetos não se perdem no caminho');
    assert.equal(outra.up.attempts, 1);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).up.attempts, 1, 'a chave está mesmo no ficheiro');
  });

  test('`up` é irmão de `projects`, nunca um projeto lá dentro (um projeto pode chamar-se "up")', async () => {
    const dir = fresh('irmao'); const path = projectFolder('up');
    const f = fakes();
    writeGuardState(guardPaths(dir).state, withUp(upEntry(), { up: { run_id: RUN_ID, dead_since: new Date(T0 - 10 * MIN).toISOString() } }));
    await runGuardOnce({
      dataDir: dir, forjaRoot: 'C:\\forja', list: () => [proj({ name: 'up', path })],
      spawn: f.spawn, spawnPeer: () => { throw new Error('o viewer não devia ser relançado nesta volta'); },
      notify: f.notify, log: f.log, now: T0, selfStartedAt: T0,
    });
    const cru = JSON.parse(readFileSync(guardPaths(dir).state, 'utf8'));
    assert.equal(cru.projects.up.attempts, 1, 'o projeto chamado "up" foi relançado e tem o seu contador');
    assert.equal(cru.up.attempts, 0, 'e o contador do viewer é outro, ao lado');
    assert.ok(Object.prototype.hasOwnProperty.call(cru, 'up'));
  });

  test('a chave `up` atravessa uma volta: o que a volta decidiu fica gravado', async () => {
    const dir = fresh('atravessa');
    const f = fakes();
    writeGuardState(guardPaths(dir).state, withUp(upEntry({ dead_since: new Date(T0 - 10 * MIN).toISOString() })));
    const r = await runGuardOnce({
      dataDir: dir, forjaRoot: 'C:\\forja', list: () => [], spawn: f.spawn, notify: f.notify, log: f.log,
      spawnPeer: opts => { f.spawned.push(opts); return 555; }, now: T0, selfStartedAt: T0 - 60 * MIN,
    });
    assert.equal(r.viewer.act, 'relaunch');
    const estado = readGuardState(guardPaths(dir).state);
    assert.equal(estado.up.attempts, 1);
    assert.equal(estado.up.last_attempt_at, new Date(T0).toISOString());
    assert.equal(estado.up.dead_since, null);
    assert.equal(f.lines.length, 1, 'continua a ser UMA linha de log por volta');
    assert.match(f.lines[0], /guarda: 0 projeto\(s\) · o viewer: relançado \(tentativa 1 de 3, pid 555\)/);
    assert.equal(/viewer: o viewer/.test(f.lines[0]), false, 'o rótulo não se repete: a nota já começa por «o viewer»');
  });

  test('um viewer morto há mais de 2 min é relançado exatamente uma vez (e nunca com --goal nem numa pasta de projeto)', async () => {
    const dir = fresh('viewerMorto');
    const spawned = []; const sent = []; const lines = [];
    const spawnPeer = opts => { spawned.push(opts); return 4321; };
    const notify = async (message, o) => { sent.push({ message, ...o }); return { ok: true }; };
    let state = withUp(upEntry({ dead_since: new Date(T0 - 10 * MIN).toISOString() }));
    writeGuardState(guardPaths(dir).state, state);
    // Dez voltas de minuto a minuto, o viewer morto em todas elas.
    for (let i = 0; i < 10; i++) {
      await runGuardOnce({
        dataDir: dir, forjaRoot: 'C:\\forja', list: () => [], spawnPeer, notify, log: l => lines.push(l),
        now: T0 + i * GUARD_POLL_MS, selfStartedAt: T0 - 60 * MIN,
      });
    }
    assert.equal(spawned.length, 1, '10 voltas, um relançamento: as outras nove esperam os 15 min');
    assert.deepEqual(spawned[0].args, ['up']);
    assert.equal(spawned[0].via, 'guard');
    assert.equal(spawned[0].dataDir, dir);
    assert.equal('goal' in spawned[0], false, 'o viewer não tem objetivos: isto não é um run');
    assert.equal(sent.length, 0, 'relançamento bem sucedido não avisa o telemóvel — nada espera pelo Sponsor');
    assert.equal(lines.length, 10);
    assert.ok(lines.slice(1).every(l => /espero 15 min entre tentativas|dentro da graça/.test(l)), lines.join('\n'));
  });

  test('nunca se relança um viewer que esta guarda nunca viu vivo', async () => {
    const dir = fresh('nuncaVisto');
    const spawned = [];
    for (let i = 0; i < 30; i++) {
      await runGuardOnce({
        dataDir: dir, forjaRoot: 'C:\\forja', list: () => [], log: () => {},
        spawnPeer: o => { spawned.push(o); return 1; }, notify: async () => ({ ok: true }),
        now: T0 + i * GUARD_POLL_MS, selfStartedAt: T0,
      });
    }
    assert.deepEqual(spawned, [], 'sem up.pid nunca houve viewer nenhum aqui: meia hora de voltas e zero tentativas');
    assert.equal(readGuardState(guardPaths(dir).state).up.seen_at, null);
  });

  test('`forja down` continua a querer dizer parado: com up.stop nada é relançado e o contador fica a zero', async () => {
    const dir = fresh('downFirme');
    const spawned = []; const lines = [];
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'up.stop'), 'forja down\n');
    writeGuardState(guardPaths(dir).state, withUp(upEntry({ attempts: 2, dead_since: new Date(T0 - 60 * MIN).toISOString() })));
    for (let i = 0; i < 20; i++) {
      await runGuardOnce({
        dataDir: dir, forjaRoot: 'C:\\forja', list: () => [], log: l => lines.push(l),
        spawnPeer: o => { spawned.push(o); return 1; }, notify: async () => ({ ok: true }),
        now: T0 + i * GUARD_POLL_MS, selfStartedAt: T0 - 60 * MIN,
      });
    }
    assert.deepEqual(spawned, [], '20 minutos de voltas com o pedido de paragem em pé: zero relançamentos');
    const estado = readGuardState(guardPaths(dir).state);
    assert.equal(estado.up.attempts, 0);
    assert.equal(estado.up.failed_spawns, 0);
    assert.ok(lines.every(l => /parado a pedido/.test(l)), lines[0]);
    // Apagado o up.stop (um `forja up` novo apaga-o no arranque), a vigia
    // recomeça pela graça — nunca com um relançamento imediato.
    rmSync(join(dir, 'up.stop'), { force: true });
    await runGuardOnce({
      dataDir: dir, forjaRoot: 'C:\\forja', list: () => [], log: l => lines.push(l),
      spawnPeer: o => { spawned.push(o); return 1; }, notify: async () => ({ ok: true }),
      now: T0 + 20 * GUARD_POLL_MS, selfStartedAt: T0 - 60 * MIN,
    });
    assert.deepEqual(spawned, []);
    assert.match(lines.at(-1), /dentro da graça/);
  });

  test('`forja guard status` mostra o bloco do viewer e continua a não ter efeito nenhum', () => {
    const dir = fresh('statusViewer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ version: 1, projects: [] }, null, 2));
    writeGuardState(guardPaths(dir).state, withUp(upEntry({ attempts: 1 })));
    const antes = readFileSync(guardPaths(dir).state, 'utf8');
    const r = spawnSync(process.execPath, [cli, 'guard', 'status'], { env: { ...process.env, FORJA_DATA_DIR: dir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' }, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.viewer.running, false, 'não há viewer vivo neste data dir');
    assert.equal(json.viewer.stopFile, null);
    assert.equal(json.viewer.state.attempts, 1, 'o estado em disco, tal como está');
    assert.equal(json.viewer.plan.act, null);
    assert.ok(typeof json.viewer.plan.why === 'string' && json.viewer.plan.why.length > 0);
    assert.equal(readFileSync(guardPaths(dir).state, 'utf8'), antes, 'o status não escreve o estado');
    assert.equal(existsSync(join(dir, 'up-watch')), false);
    assert.equal(existsSync(join(dir, 'core')), false, 'e não lança nada');
    // Com o pedido de paragem em pé, o bloco di-lo.
    writeFileSync(join(dir, 'up.stop'), 'forja down\n');
    const r2 = spawnSync(process.execPath, [cli, 'guard', 'status'], { env: { ...process.env, FORJA_DATA_DIR: dir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' }, encoding: 'utf8', timeout: 120_000 });
    const json2 = JSON.parse(r2.stdout);
    assert.equal(json2.viewer.stopFile, join(dir, 'up.stop'));
    assert.match(json2.viewer.plan.why, /parado a pedido/);
  });
});

describe('appendGuardLog', () => {
  test('cria a pasta, carimba a hora e nunca deixa uma linha partir-se em duas', () => {
    const dir = fresh('logfile');
    const path = join(dir, 'guard', 'guard.log');
    appendGuardLog(path, 'linha um');
    appendGuardLog(path, 'linha\ncom\r\nquebras');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z linha um$/);
    assert.match(lines[1], /linha com quebras$/);
    assert.ok(statSync(path).size > 0);
  });
});
