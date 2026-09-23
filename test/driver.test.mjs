// Who drives a run — RUN.json.driver (lib/driver.mjs, docs/ARCHITECTURE.md §3c).
//
// The incident this guards against (18 set 2026, reproduced without starting a
// process): an interactive run `running` on disk with no runner lock became a
// relaunch candidate after the guard's two-minute grace, so the guard would
// have put a runner on top of the conversation. Everything here runs against a
// temp data dir and temp projects; no real runner, guard, viewer or Claude
// session is ever started — the "processes" are fakes (a node that exits, a
// node that sleeps) and the spawn of the guard is injected.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_DEAD_GRACE_MS, GUARD_POLL_MS, guardPaths, guardPlan, runGuardOnce } from '../lib/guard.mjs';
import { runSummary, upsertProject } from '../lib/projects.mjs';
import { acquireLock, lockPath } from '../lib/runner.mjs';
import { driverField, liveRunner, mutexPath, normalizeDriver, resolveDriver, runnerEvidence, withClaimMutex } from '../lib/driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'forja.mjs');
const root = mkdtempSync(join(tmpdir(), 'forja-driver-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = name => { const d = join(root, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; };
const T0 = Date.parse('2026-09-18T15:00:00.000Z');
const MIN = 60_000;

// A project on disk, registered in a data dir of its own.
function project(name, run, dataDir = fresh('data')) {
  const path = join(fresh('projects'), name);
  mkdirSync(join(path, 'docs', 'forja'), { recursive: true });
  if (run !== undefined) writeFileSync(join(path, 'docs', 'forja', 'RUN.json'), typeof run === 'string' ? run : JSON.stringify(run, null, 2));
  upsertProject({ path }, dataDir);
  return { name, path, dataDir };
}
const readRunOf = p => JSON.parse(readFileSync(join(p, 'docs', 'forja', 'RUN.json'), 'utf8'));
const env = dataDir => {
  const e = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  delete e.FORJA_RUNNER; delete e.CLAUDE_CODE_SESSION_ID; delete e.FORJA_PROJECT_ROOT;
  return e;
};
const forja = (cwd, dataDir, args, extra = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...env(dataDir), ...extra }, encoding: 'utf8', timeout: 60_000 });

// Many guard passes, one a minute, against the REAL registry + RUN.json reader,
// with the spawn and the notification injected. Returns every spawn asked for.
async function guardTicks({ dataDir, from, ticks, spawns = [], restartEvery = 0 }) {
  for (let i = 0; i < ticks; i++) {
    // A guard restart: the state file is lost (worst case) — the decision must
    // come from RUN.json, never from what the previous guard remembered.
    if (restartEvery && i > 0 && i % restartEvery === 0) rmSync(guardPaths(dataDir).state, { force: true });
    await runGuardOnce({
      dataDir, now: from + i * GUARD_POLL_MS, selfStartedAt: from,
      spawn: a => { spawns.push(a); return 9000 + spawns.length; },
      spawnPeer: () => 1, notify: async () => ({ ok: true }), log: () => {},
    });
  }
  return spawns;
}

describe('a reprodução do diagnóstico (guardPlan puro)', () => {
  // The exact list from the diagnosis of 18 set 2026.
  const proof = driver => [{ name: 'interactive-proof', path: 'C:/example', run: { run_id: 'R-proof', status: 'running', visible: false, ...(driver ? { driver } : {}) }, runnerAlive: false }];
  test('antes: sem responsável, a guarda pedia um runner ao fim da graça — agora não pede nada', () => {
    const a = guardPlan(proof(null), {}, 1_000_000);
    assert.deepEqual(a.actions, []);
    const b = guardPlan(proof(null), a.state, 1_120_001);
    assert.deepEqual(b.actions, [], 'um run sem responsável conhecido nunca recebe um runner');
    assert.match(b.skips[0].why, /desconhecido/);
  });
  test('um run interativo nunca recebe um runner, por muito tempo que passe', () => {
    let s = {};
    for (let t = 1_000_000; t < 1_000_000 + 6 * 60 * MIN; t += MIN) {
      const r = guardPlan(proof('interactive'), s, t);
      assert.deepEqual(r.actions, [], `t=${t}`);
      assert.deepEqual(r.giveUps, []);
      s = JSON.parse(JSON.stringify(r.state));
    }
  });
  test('o mesmo run, do runner: a recuperação de sempre continua (uma ação depois da graça)', () => {
    const a = guardPlan(proof('runner'), {}, 1_000_000);
    const b = guardPlan(proof('runner'), JSON.parse(JSON.stringify(a.state)), 1_000_000 + GUARD_DEAD_GRACE_MS);
    assert.equal(b.actions.length, 1);
    assert.equal(b.actions[0].attempt, 1);
  });
  test('passar de interativo para runner recomeça a graça a partir da mudança, não do passado', () => {
    let s = {};
    for (let t = 0; t < 30; t++) s = JSON.parse(JSON.stringify(guardPlan(proof('interactive'), s, 1_000_000 + t * MIN).state));
    const change = 1_000_000 + 30 * MIN;
    const first = guardPlan(proof('runner'), s, change);
    assert.deepEqual(first.actions, [], 'nada no próprio instante da mudança');
    const inside = guardPlan(proof('runner'), JSON.parse(JSON.stringify(first.state)), change + GUARD_DEAD_GRACE_MS - 1);
    assert.deepEqual(inside.actions, [], 'dentro da graça contada desde a mudança');
    const afterGrace = guardPlan(proof('runner'), JSON.parse(JSON.stringify(inside.state)), change + GUARD_DEAD_GRACE_MS);
    assert.equal(afterGrace.actions.length, 1);
  });
  test('passar de runner para interativo guarda o contador deste run_id mas não age', () => {
    const s = { version: 1, projects: { 'interactive-proof': { run_id: 'R-proof', attempts: 2, dead_since: new Date(T0 - 60 * MIN).toISOString() } } };
    const r = guardPlan(proof('interactive'), s, T0);
    assert.deepEqual(r.actions, []);
    assert.equal(r.state.projects['interactive-proof'].attempts, 2, 'o contador pertence ao run_id e fica');
    assert.equal(r.state.projects['interactive-proof'].dead_since, null, 'o relógio de morte não');
  });
  test('um valor de driver inválido vindo de quem chama conta como desconhecido', () => {
    const r = guardPlan(proof('robot'), { version: 1, projects: { 'interactive-proof': { run_id: 'R-proof', dead_since: new Date(T0 - 60 * MIN).toISOString() } } }, T0);
    assert.deepEqual(r.actions, []);
  });
});

describe('critério 1 — um run interativo, observado durante muitas voltas e reinícios da guarda', () => {
  test('3 h de voltas reais (registo + RUN.json do disco), estado da guarda apagado a cada 20 min: zero lançamentos', async () => {
    const p = project('conversa', { run_id: 'R-20260918-aa01', status: 'running', visible: false, driver: 'interactive', driver_since: '2026-09-18T14:00:00.000Z', goal: 'objetivo' });
    const spawns = await guardTicks({ dataDir: p.dataDir, from: T0, ticks: 180, restartEvery: 20 });
    assert.equal(spawns.length, 0);
    const log = [];
    await runGuardOnce({ dataDir: p.dataDir, now: T0 + 181 * MIN, spawn: () => { throw new Error('nunca'); }, spawnPeer: () => 1, notify: async () => ({}), log: l => log.push(l) });
    assert.match(log[0], /conversa: run conduzido por uma conversa interativa/);
  });
  test('o mesmo com o run bloqueado e depois retomado: continua a ser da conversa', async () => {
    const p = project('conversa-bloq', { run_id: 'R-20260918-aa02', status: 'blocked', driver: 'interactive' });
    await guardTicks({ dataDir: p.dataDir, from: T0, ticks: 5 });
    writeFileSync(join(p.path, 'docs', 'forja', 'RUN.json'), JSON.stringify({ run_id: 'R-20260918-aa02', status: 'running', driver: 'interactive' }));
    assert.equal((await guardTicks({ dataDir: p.dataDir, from: T0 + 5 * MIN, ticks: 30 })).length, 0);
  });
});

describe('critério 2 — um run do runner comprovado que perde o runner continua a ser recuperado', () => {
  test('driver runner: uma relançamento depois da graça, nenhum duplicado nas voltas seguintes', async () => {
    const p = project('autonomo', { run_id: 'R-20260918-bb01', status: 'running', visible: true, driver: 'runner' });
    const spawns = await guardTicks({ dataDir: p.dataDir, from: T0, ticks: 14 }); // 13 min: graça + relançamento + espera de 15 min
    assert.equal(spawns.length, 1, 'exatamente um');
    assert.deepEqual(spawns[0].extraArgs, ['--visivel'], 'no modo em que o run arrancou');
    assert.equal(spawns[0].goal, null);
    assert.equal(spawns[0].via, 'guard');
  });
  test('run anterior ao campo com registos do runner para o MESMO run_id: é do runner e é recuperado', async () => {
    const p = project('legado', { run_id: 'R-20260917-bb02', status: 'running', visible: false });
    mkdirSync(join(p.dataDir, 'runner'), { recursive: true });
    writeFileSync(join(p.dataDir, 'runner', 'R-20260917-bb02-03-task-T2-a1.log'), 'saída de uma sessão\n');
    const s = runSummary(p.path, p.dataDir);
    assert.equal(s.driver, 'runner');
    assert.match(s.driver_source, /evidência do runner/);
    const spawns = await guardTicks({ dataDir: p.dataDir, from: T0, ticks: 3 });
    assert.equal(spawns.length, 1);
  });
  test('com um runner vivo (lock deste projeto, heartbeat fresco, dono que é mesmo um runner) não há relançamento', async () => {
    const p = project('vivo', { run_id: 'R-20260918-bb03', status: 'running', driver: 'runner' });
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', 'forja.mjs', 'runner'], { stdio: 'ignore' });
    try {
      acquireLock(lockPath(p.path, join(p.dataDir, 'runner')), { pid: decoy.pid, runId: 'R-20260918-bb03', project: p.path, alive: () => true, now: Date.now() });
      const spawns = [];
      for (let i = 0; i < 4; i++) await runGuardOnce({ dataDir: p.dataDir, now: Date.now() + i * GUARD_DEAD_GRACE_MS, spawn: a => { spawns.push(a); return 1; }, spawnPeer: () => 1, notify: async () => ({}), log: () => {} });
      assert.equal(spawns.length, 0);
    } finally { decoy.kill(); }
  });
});

describe('critério 3 — dados antigos, ilegíveis, locks de outro run e PID reutilizado', () => {
  test('sem campo e sem evidência: desconhecido, e a guarda não age', async () => {
    const p = project('sem-campo', { run_id: 'R-20260918-cc01', status: 'running' });
    assert.equal(runSummary(p.path, p.dataDir).driver, 'unknown');
    assert.equal((await guardTicks({ dataDir: p.dataDir, from: T0, ticks: 30 })).length, 0);
  });
  test('um lock deste projeto mas de OUTRO run não é evidência (nem um lock antigo sem run_id)', () => {
    const p = project('lock-outro', { run_id: 'R-20260918-cc02', status: 'running' });
    const lock = lockPath(p.path, join(p.dataDir, 'runner'));
    acquireLock(lock, { pid: 111, runId: 'R-20260901-zzzz', project: p.path, alive: () => false });
    assert.equal(resolveDriver(readRunOf(p.path), p.path, p.dataDir).driver, 'unknown');
    acquireLock(lock, { pid: 112, runId: null, project: p.path, alive: () => false });
    assert.equal(resolveDriver(readRunOf(p.path), p.path, p.dataDir).driver, 'unknown', 'lock sem run_id (anterior a §3c) não prova nada');
    acquireLock(lock, { pid: 113, runId: 'R-20260918-cc02', project: p.path, alive: () => false });
    assert.equal(resolveDriver(readRunOf(p.path), p.path, p.dataDir).driver, 'runner', 'o lock que nomeia ESTE run é evidência');
  });
  test('o lock de OUTRO projeto com o mesmo run_id não conta para este', () => {
    const data = fresh('data');
    const a = project('proj-a', { run_id: 'R-20260918-cc03', status: 'running' }, data);
    const b = project('proj-b', { run_id: 'R-20260918-cc04', status: 'running' }, data);
    acquireLock(lockPath(a.path, join(data, 'runner')), { pid: 114, runId: 'R-20260918-cc04', project: a.path, alive: () => false });
    assert.equal(resolveDriver(readRunOf(b.path), b.path, data).driver, 'unknown');
  });
  test('um registo de sessão de outro run, ou um nome que só começa pelo run_id, não conta', () => {
    const data = fresh('data');
    mkdirSync(join(data, 'runner'), { recursive: true });
    writeFileSync(join(data, 'runner', 'R-20260918-cc05-01-plan.log'), '');
    writeFileSync(join(data, 'runner', 'R-20260918-cc0-01-plan.log'), '');
    writeFileSync(join(data, 'runner', 'R-20260918-cc06-notas.log'), '');
    assert.equal(runnerEvidence('R-20260918-cc06', 'C:/x', data).found, false);
    assert.equal(runnerEvidence('R-20260918-cc05', 'C:/x', data).found, true);
    assert.equal(runnerEvidence('R-"x" & del', 'C:/x', data).found, false, 'um run_id com outra forma nunca procura nada');
  });
  test('RUN.json a meio de uma escrita (ou lixo): sem run legível, nenhuma ação e nenhum contador perdido', async () => {
    const p = project('meio', '{ "run_id": "R-20260918-cc07", "status": "runn');
    assert.equal(runSummary(p.path, p.dataDir), null);
    assert.equal((await guardTicks({ dataDir: p.dataDir, from: T0, ticks: 5 })).length, 0);
  });
  test('valor inválido no disco: desconhecido, dito como tal', () => {
    const run = { run_id: 'R-20260918-cc08', status: 'running', driver: 'Runner ' };
    assert.equal(driverField(run), 'invalid');
    assert.deepEqual(resolveDriver(run, 'C:/x', fresh('data')), { driver: 'unknown', source: 'valor inválido no RUN.json', request: null });
  });
  test('escrito à mão pela pessoa: aceita nomes portugueses, recusa o resto', () => {
    assert.equal(normalizeDriver('interativo'), 'interactive');
    assert.equal(normalizeDriver('Runner'), 'runner');
    assert.throws(() => normalizeDriver('guard'), /desconhecido/);
  });
  test('PID reutilizado: um lock cujo pid é agora outro processo (não um runner) não é um runner vivo', () => {
    const p = project('pid', { run_id: 'R-20260918-cc09', status: 'running', driver: 'runner' });
    // "owner" = este processo de testes, que está vivo mas não é `forja.mjs runner`.
    acquireLock(lockPath(p.path, join(p.dataDir, 'runner')), { pid: process.pid, runId: 'R-20260918-cc09', project: p.path, alive: () => true });
    assert.equal(liveRunner(p.path, p.dataDir), null);
  });
  test('lock obsoleto: dono vivo mas heartbeat com mais de 15 min não é um runner vivo', () => {
    const p = project('velho', { run_id: 'R-20260918-cc10', status: 'running', driver: 'runner' });
    acquireLock(lockPath(p.path, join(p.dataDir, 'runner')), { pid: 4242, runId: 'R-20260918-cc10', alive: () => true, now: Date.now() - 16 * MIN });
    assert.equal(liveRunner(p.path, p.dataDir, { alive: () => true }), null);
    assert.ok(liveRunner(p.path, p.dataDir, { alive: () => true, now: Date.now() - 16 * MIN + 1000 }), 'o mesmo lock, lido no seu tempo, estava vivo');
  });
});

describe('exclusão mútua (claim mutex) com processos reais', () => {
  test('8 processos a mudar o mesmo ficheiro dentro do mutex: nenhuma escrita perdida', async () => {
    const data = fresh('data');
    const proj = fresh('mutex-proj');
    const counter = join(root, `counter-${n}.txt`);
    writeFileSync(counter, '0');
    const script = `
      import { withClaimMutex } from ${JSON.stringify(new URL('../lib/driver.mjs', import.meta.url).href)};
      import { readFileSync, writeFileSync } from 'node:fs';
      const [proj, data, file] = process.argv.slice(1);
      for (let i = 0; i < 5; i++) withClaimMutex(proj, () => {
        const v = Number(readFileSync(file, 'utf8'));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        writeFileSync(file, String(v + 1));
      }, { dir: data, waitMs: 30000 });`;
    const kids = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', script, proj, data, counter], { stdio: ['ignore', 'ignore', 'pipe'] }));
    const codes = await Promise.all(kids.map(k => new Promise(r => { let err = ''; k.stderr.on('data', d => { err += d; }); k.on('exit', c => r({ c, err })); })));
    assert.deepEqual(codes.filter(x => x.c !== 0), [], JSON.stringify(codes));
    assert.equal(readFileSync(counter, 'utf8'), '40');
    assert.equal(existsSync(mutexPath(proj, data)), false, 'o mutex nunca fica para trás');
  });
  test('um mutex deixado por um processo que morreu é assumido depois de 60 s; um recente faz esperar e recusa', () => {
    const data = fresh('data');
    const proj = fresh('mutex-velho');
    const path = mutexPath(proj, data);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '999 recente');
    assert.throws(() => withClaimMutex(proj, () => 1, { dir: data, waitMs: 200 }), /outro processo/);
    let clock = Date.now();
    assert.throws(() => withClaimMutex(proj, () => 1, { dir: data, waitMs: 100, now: () => (clock += 60) }), /outro processo/);
    // Envelhece o ficheiro: mtime 70 s no passado.
    const old = new Date(Date.now() - 70_000);
    spawnSync(process.execPath, ['-e', `require('fs').utimesSync(${JSON.stringify(path)}, new Date(${old.getTime()}), new Date(${old.getTime()}))`]);
    assert.equal(withClaimMutex(proj, () => 7, { dir: data, waitMs: 200 }), 7);
  });
});

describe('CLI: run start, run resume, task start e run driver', () => {
  test('run start numa conversa regista driver interactive; com FORJA_RUNNER=1 regista runner', () => {
    const data = fresh('data');
    const a = fresh('cli-a');
    assert.equal(forja(a, data, ['run', 'start', '--goal', 'uma conversa']).status, 0);
    const ra = readRunOf(a);
    assert.equal(ra.driver, 'interactive');
    assert.ok(ra.driver_since);
    const b = fresh('cli-b');
    assert.equal(forja(b, data, ['run', 'start', '--goal', 'um runner'], { FORJA_RUNNER: '1' }).status, 0);
    assert.equal(readRunOf(b).driver, 'runner');
    const c = fresh('cli-c');
    const bad = forja(c, data, ['run', 'start', '--goal', 'x', '--driver', 'robot']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /responsável "robot" desconhecido/);
    assert.equal(existsSync(join(c, 'docs', 'forja', 'RUN.json')), false, 'um valor recusado não deixa nada escrito');
  });
  test('uma conversa não pega num run do runner, nem num run sem responsável conhecido; o runner não pega num da conversa', () => {
    const data = fresh('data');
    const p = fresh('cli-guarda');
    forja(p, data, ['run', 'start', '--goal', 'autónomo', '--driver', 'runner']);
    forja(p, data, ['task', 'add', '--id', 'T1', '--title', 'uma task', '--owner', 'backend-dev'], { FORJA_RUNNER: '1' });
    const r1 = forja(p, data, ['run', 'resume']);
    assert.equal(r1.status, 4);
    assert.match(r1.stderr, /conduzido pelo runner .*run driver set interactive/);
    assert.equal(forja(p, data, ['task', 'start', 'T1']).status, 4);
    assert.equal(forja(p, data, ['run', 'resume'], { FORJA_RUNNER: '1' }).status, 0, 'o próprio runner continua a poder');
    // Sem campo (run anterior): a conversa tem de dizer que é dela.
    const run = readRunOf(p); delete run.driver; writeFileSync(join(p, 'docs', 'forja', 'RUN.json'), JSON.stringify(run));
    const r2 = forja(p, data, ['run', 'resume']);
    assert.equal(r2.status, 4);
    assert.match(r2.stderr, /desconhecido/);
    const set = forja(p, data, ['run', 'driver', 'set', 'interactive']);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(readRunOf(p).driver, 'interactive');
    assert.match(readRunOf(p).checkpoints.at(-1).note, /→ conversa interativa/);
    assert.equal(forja(p, data, ['run', 'resume']).status, 0);
    const r3 = forja(p, data, ['task', 'start', 'T1'], { FORJA_RUNNER: '1' });
    assert.equal(r3.status, 4, 'uma sessão do runner não começa uma task num run da conversa');
  });
  test('passar ao runner exige a task em curso fechada ou devolvida; depois disso a guarda passa a tratar dele', async () => {
    const data = fresh('data');
    const p = fresh('cli-passagem');
    forja(p, data, ['run', 'start', '--goal', 'conversa que vai passar']);
    forja(p, data, ['task', 'add', '--id', 'T1', '--title', 'uma', '--owner', 'backend-dev']);
    forja(p, data, ['task', 'start', 'T1']);
    const refused = forja(p, data, ['run', 'driver', 'set', 'runner']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /T1 está em curso/);
    forja(p, data, ['task', 'fail', 'T1', '--no-attempt', '--why', 'passada ao runner']);
    const ok = forja(p, data, ['run', 'driver', 'set', 'runner']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(JSON.parse(ok.stdout).note, /Nada foi lançado/);
    assert.equal(readRunOf(p).driver, 'runner');
    upsertProject({ path: p }, data);
    const spawns = await guardTicks({ dataDir: data, from: T0, ticks: 4 });
    assert.equal(spawns.length, 1, 'agora é um run autónomo sem runner: a guarda recupera-o');
  });
  test('run driver show diz a verdade, com a origem', () => {
    const data = fresh('data');
    const p = fresh('cli-show');
    forja(p, data, ['run', 'start', '--goal', 'mostrar']);
    const s = JSON.parse(forja(p, data, ['run', 'driver', 'show']).stdout);
    assert.equal(s.driver, 'interactive');
    assert.equal(s.source, 'RUN.json');
    assert.equal(s.runner, null);
  });
  test('run start recusa arrancar por cima de um runner vivo neste projeto', () => {
    const data = fresh('data');
    const p = fresh('cli-vivo');
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', 'forja.mjs', 'runner'], { stdio: 'ignore' });
    try {
      acquireLock(lockPath(p, join(data, 'runner')), { pid: decoy.pid, project: p, alive: () => true });
      const r = forja(p, data, ['run', 'start', '--goal', 'por cima']);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /runner vivo/);
      assert.equal(existsSync(join(p, 'docs', 'forja', 'RUN.json')), false);
      assert.equal(existsSync(mutexPath(p, data)), false, 'a recusa não deixa o mutex para trás');
    } finally { decoy.kill(); }
  });
});

describe('o runner (processo real, claude falso)', () => {
  const dead = `"${process.execPath}" -e "process.exit(7)"`;
  const runner = (cwd, data, args = [], extra = {}) => forja(cwd, data, ['runner', '--max-task-minutes', '1', '--max-sessions', '4', ...args], { FORJA_CLAUDE_CMD: dead, ...extra });
  test('recusa um run interativo ativo (código 4) sem lançar sessão nenhuma e sem mexer no RUN.json', () => {
    const data = fresh('data');
    const p = fresh('runner-conversa');
    forja(p, data, ['run', 'start', '--goal', 'da conversa']);
    const before = readFileSync(join(p, 'docs', 'forja', 'RUN.json'), 'utf8');
    const r = runner(p, data);
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stderr, /conduzido por uma conversa interativa.*Não o assumi/s);
    assert.equal(readFileSync(join(p, 'docs', 'forja', 'RUN.json'), 'utf8'), before);
    assert.equal(existsSync(lockPath(p, join(data, 'runner'))), false, 'o lock foi largado');
    assert.equal(existsSync(join(data, 'runner')) && readFileSync(join(data, 'runner', 'runner.log'), 'utf8').includes('sessão 1'), false, 'nenhuma sessão');
  });
  test('recusa um run sem responsável conhecido; aceita e migra um run anterior com evidência do MESMO run_id', () => {
    const data = fresh('data');
    const p = fresh('runner-legado');
    mkdirSync(join(p, 'docs', 'forja'), { recursive: true });
    writeFileSync(join(p, 'docs', 'forja', 'RUN.json'), JSON.stringify({ run_id: 'R-20260917-dd01', project: 'x', goal: 'antigo', status: 'running', model_floor: 'fable', sessions: [], checkpoints: [], fallbacks: [] }));
    const refused = runner(p, data);
    assert.equal(refused.status, 4);
    assert.match(refused.stderr, /responsável desconhecido/);
    mkdirSync(join(data, 'runner'), { recursive: true });
    writeFileSync(join(data, 'runner', 'R-20260917-dd01-01-plan.log'), 'sessão antiga\n');
    const ok = runner(p, data);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const run = readRunOf(p);
    assert.equal(run.driver, 'runner');
    assert.match(run.driver_source, /migrado/);
  });
  test('uma conversa pede o run a um runner vivo: o runner liberta-o ENTRE sessões, com checkpoint, e sai', async t => {
    const data = fresh('data');
    const p = fresh('runner-passagem');
    const marker = join(root, `sessao-${n}.txt`);
    const release = join(root, `release-${n}.txt`);
    // Keep the fake session alive until the request and refusal are observed.
    const fake = join(root, `fake-claude-${n}.mjs`);
    writeFileSync(fake, "import { writeFileSync, existsSync } from 'node:fs'; writeFileSync(process.env.MARK, 'ready'); const timer = setInterval(() => { if (existsSync(process.env.RELEASE)) clearInterval(timer); }, 25); setTimeout(() => process.exit(1), 60000).unref();\n");
    const slow = `"${process.execPath}" "${fake}"`;
    forja(p, data, ['run', 'start', '--goal', 'autónomo que vai passar', '--driver', 'runner']);
    const child = spawn(process.execPath, [cli, 'runner', '--max-sessions', '6'], { cwd: p, env: { ...env(data), FORJA_CLAUDE_CMD: slow, MARK: marker, RELEASE: release }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    const exited = new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
    t.after(async () => { writeFileSync(release, 'release'); await exited; });
    for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(existsSync(marker), 'a primeira sessão começou');
    const lock = JSON.parse(readFileSync(lockPath(p, join(data, 'runner')), 'utf8'));
    assert.equal(lock.run_id, readRunOf(p).run_id, 'o lock do runner nomeia o run que conduz');
    const ask = forja(p, data, ['run', 'driver', 'set', 'interactive']);
    assert.equal(ask.status, 0, ask.stderr);
    assert.equal(JSON.parse(ask.stdout).pending, 'interactive', 'com o runner vivo é um pedido, não uma tomada');
    assert.equal(readRunOf(p).driver, 'runner', 'ainda do runner enquanto a sessão corre');
    assert.equal(forja(p, data, ['run', 'resume']).status, 4, 'e a conversa ainda não pode continuar');
    writeFileSync(release, 'release');
    const code = await exited;
    assert.equal(code, 0, out);
    const run = readRunOf(p);
    assert.equal(run.driver, 'interactive');
    assert.equal(run.driver_request, undefined);
    assert.match(run.checkpoints.at(-1).note, /pedido honrado pelo runner/);
    assert.match(out, /transferência pedida/);
    assert.equal(existsSync(lockPath(p, join(data, 'runner'))), false, 'libertação confirmada: o lock já não existe');
    assert.equal(forja(p, data, ['run', 'resume']).status, 0, 'agora a conversa continua');
  });
});

// Found by the independent review of 18 set 2026 (both reproduced before the fix).
describe('revisão: runner visível, lock ilegível, mutex alheio, run_id curto', () => {
  // A live "runner" whose lock says it runs visible sessions, the current one
  // being `abcd1234` (what `claude --bg` announces and the runner tags).
  function visibleRunner(p, data, fields) {
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', 'forja.mjs', 'runner'], { stdio: 'ignore' });
    const path = lockPath(p, join(data, 'runner'));
    acquireLock(path, { pid: decoy.pid, runId: readRunOf(p).run_id, project: p, alive: () => true });
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...lock, visible: true, ...fields }));
    return decoy;
  }
  test('BLOQUEADOR 1: com um runner visível vivo, só a sessão que ele nomeou passa — uma conversa, e quem pediu a passagem, não', () => {
    const data = fresh('data');
    const p = fresh('visivel');
    forja(p, data, ['run', 'start', '--goal', 'autónomo visível', '--driver', 'runner']);
    forja(p, data, ['task', 'add', '--id', 'T1', '--title', 'uma', '--owner', 'backend-dev'], { FORJA_RUNNER: '1' });
    const decoy = visibleRunner(p, data, { session: 'abcd1234' });
    try {
      const conversa = { CLAUDE_CODE_SESSION_ID: '99999999-0000-4000-8000-000000000000' };
      assert.equal(forja(p, data, ['run', 'resume'], conversa).status, 4, 'uma conversa qualquer é recusada');
      assert.equal(forja(p, data, ['task', 'start', 'T1'], conversa).status, 4);
      const ask = forja(p, data, ['run', 'driver', 'set', 'interactive'], conversa);
      assert.equal(JSON.parse(ask.stdout).pending, 'interactive');
      assert.equal(forja(p, data, ['run', 'resume'], conversa).status, 4, 'quem pediu a passagem espera pela libertação');
      assert.equal(forja(p, data, ['task', 'start', 'T1'], conversa).status, 4);
      const sessaoDoRunner = { CLAUDE_CODE_SESSION_ID: 'abcd1234-1111-4111-8111-111111111111' };
      assert.equal(forja(p, data, ['run', 'resume'], sessaoDoRunner).status, 0, 'a sessão visível do runner continua a trabalhar');
      assert.equal(forja(p, data, ['task', 'start', 'T1'], sessaoDoRunner).status, 0);
    } finally { decoy.kill(); }
  });
  test('sem sessão marcada no lock (entre duas fases), nenhuma chamada sem FORJA_RUNNER passa', () => {
    const data = fresh('data');
    const p = fresh('visivel-entre');
    forja(p, data, ['run', 'start', '--goal', 'autónomo visível', '--driver', 'runner']);
    const decoy = visibleRunner(p, data, { session: null });
    try {
      assert.equal(forja(p, data, ['run', 'resume'], { CLAUDE_CODE_SESSION_ID: 'abcd1234-1111-4111-8111-111111111111' }).status, 4);
    } finally { decoy.kill(); }
  });
  test('BLOQUEADOR 2: um lock que existe mas não se lê conta como runner vivo — pedido, nunca tomada', () => {
    const data = fresh('data');
    const p = fresh('lock-ilegivel');
    forja(p, data, ['run', 'start', '--goal', 'autónomo', '--driver', 'runner']);
    const path = lockPath(p, join(data, 'runner'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ "pid": 12');
    assert.equal(liveRunner(p, data).unreadable, true);
    const ask = forja(p, data, ['run', 'driver', 'set', 'interactive']);
    assert.equal(JSON.parse(ask.stdout).pending, 'interactive', 'na dúvida, vivo');
    assert.equal(readRunOf(p).driver, 'runner');
    const force = forja(p, data, ['run', 'start', '--goal', 'por cima', '--force']);
    assert.equal(force.status, 1);
    assert.match(force.stderr, /runner vivo/);
  });
  test('o lock do runner é escrito por tmp + rename: 3000 leituras durante 3000 escritas nunca apanham meio ficheiro', async () => {
    const data = fresh('data');
    const p = fresh('lock-atomico');
    const path = lockPath(p, join(data, 'runner'));
    acquireLock(path, { pid: process.pid, runId: 'R-20260918-ee01', project: p, alive: () => false });
    const writer = spawn(process.execPath, ['--input-type=module', '-e', `
      import { beatLock } from ${JSON.stringify(new URL('../lib/runner.mjs', import.meta.url).href)};
      for (let i = 0; i < 3000; i++) beatLock(process.argv[1], Number(process.argv[2]));`, path, String(process.pid)], { stdio: 'ignore' });
    const done = new Promise(r => writer.on('exit', r));
    let bad = 0; let reads = 0;
    const { readLock } = await import('../lib/runner.mjs');
    while (reads < 3000) { if (readLock(path) === null) bad++; reads++; if (reads % 100 === 0) await new Promise(r => setImmediate(r)); }
    await done;
    assert.equal(bad, 0, `${bad} leituras a meio`);
  });
  test('o mutex só apaga o seu próprio ficheiro, nunca o de quem o assumiu depois', () => {
    const data = fresh('data');
    const proj = fresh('mutex-alheio');
    const path = mutexPath(proj, data);
    withClaimMutex(proj, () => { writeFileSync(path, 'outro dono'); }, { dir: data });
    assert.equal(readFileSync(path, 'utf8'), 'outro dono');
  });
  test('run_id que não tem a forma do Forja (curto, prefixo de outros) nunca procura evidência', () => {
    const data = fresh('data');
    mkdirSync(join(data, 'runner'), { recursive: true });
    writeFileSync(join(data, 'runner', 'R-20260918-ab12-01-plan.log'), '');
    assert.equal(runnerEvidence('R-20260918-ab12', 'C:/x', data).found, true);
    for (const id of ['R', 'R-2026', 'R-20260918', 'R-20260918-ab1']) assert.equal(runnerEvidence(id, 'C:/x', data).found, false, id);
  });
});
