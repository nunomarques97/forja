// viewer/runs-api.mjs + lib/projects.mjs against a temp data dir: the registry,
// GET /projects (shape, liveness from a real lock with a live/dead owner) and
// POST /runs (validation, the three 409s, the 30 s throttle, the exact argv and
// cwd of the launch). The server runs in-process with a fake spawnRunner, so no
// real runner is ever started; the data dir is a tmpdir (never data/).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unwatchFile, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../viewer/server.mjs';
import { MAX_BODY } from '../viewer/runs-api.mjs';
import { acquireLock, lockPath, ownerAlive, releaseLock } from '../lib/runner.mjs';
import { ALIVE_TTL_MS, listProjectsWithStatus, loadProjects, missingProjects, ownerAliveAsync, ownerAliveCached, projectsPath, pruneProjects, readProjects, removeProject, resetAliveCache, safeName, upsertProject } from '../lib/projects.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const here = dirname(fileURLToPath(import.meta.url));
const forja = join(here, '..');
const cli = join(forja, 'bin', 'forja.mjs');
const root = mkdtempSync(join(tmpdir(), 'forja-runs-api-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });

// Four projects, one per state the phone has to tell apart.
const projDir = name => join(root, 'projects', name);
function makeProject(name, run = null) {
  const p = projDir(name);
  mkdirSync(join(p, 'docs', 'forja'), { recursive: true });
  if (run) writeFileSync(join(p, 'docs', 'forja', 'RUN.json'), JSON.stringify(run, null, 2));
  upsertProject({ path: p }, dataDir);
  return p;
}
const RUNNING = { run_id: 'R-20260916-aaaa', project: 'x', goal: 'continuar o que ficou a meio', status: 'running', started_at: '2026-09-16T10:00:00.000Z' };
const alpha = makeProject('alpha');                                        // never ran
const beta = makeProject('beta', RUNNING);                                 // running + live runner
const gama = makeProject('gama', { ...RUNNING, run_id: 'R-20260916-bbbb', status: 'finished' });
const delta = makeProject('delta', { ...RUNNING, run_id: 'R-20260916-cccc', driver: 'runner' }); // running, runner-driven, no runner

let decoy; let deadPid; let server; let token; let port;
const spawned = [];
const fakeSpawn = (command, args, options) => { spawned.push({ command, args, options }); return { pid: 4242 + spawned.length }; };

const http = (path, { method = 'GET', headers = {}, body = null, auth = true } = {}) => new Promise((resolve, reject) => {
  const h = { Host: `127.0.0.1:${port}`, ...(auth ? { Cookie: `forja_k=${token}` } : {}), ...headers };
  const req = request({ host: '127.0.0.1', port, path, method, headers: h }, resp => {
    let data = ''; resp.on('data', d => { data += d; }); resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
  });
  req.on('error', reject); if (body !== null) req.write(body); req.end();
});
const post = (payload, opts = {}) => http('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof payload === 'string' ? payload : JSON.stringify(payload), ...opts });

before(async () => {
  // A live "runner": a node process whose command line matches forja.mjs runner
  // (pid reuse on Windows means ownerAlive checks the command line, not the pid).
  decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', '--', 'forja.mjs', 'runner'], { stdio: 'ignore' });
  acquireLock(lockPath(beta, join(dataDir, 'runner')), { pid: decoy.pid, project: beta, alive: () => true });
  // A dead owner: a process that existed and is gone.
  const corpse = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  deadPid = corpse.pid;
  await once(corpse, 'exit');
  acquireLock(lockPath(gama, join(dataDir, 'runner')), { pid: deadPid, project: gama, alive: () => true });

  server = startServer({ dataDir, port: 0, host: '127.0.0.1', noWatchdog: true, spawnRunner: fakeSpawn });
  await once(server.server, 'listening');
  port = server.server.address().port;
  token = readFileSync(join(dataDir, 'viewer-token.txt'), 'utf8').trim();
});
after(() => {
  try { server.server.close(); } catch {}
  try { unwatchFile(join(dataDir, 'events.jsonl')); } catch {}
  try { releaseLock(lockPath(beta, join(dataDir, 'runner')), decoy.pid); } catch {}
  try { decoy.kill(); } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe('registry (lib/projects.mjs)', () => {
  test('one entry per folder, name from the basename, re-register refreshes instead of duplicating', () => {
    const list = readProjects(dataDir);
    assert.deepEqual(list.map(p => p.name).sort(), ['alpha', 'beta', 'delta', 'gama']);
    assert.equal(list.find(p => p.name === 'alpha').path, alpha);
    assert.match(list[0].bootstrappedAt, /^\d{4}-\d{2}-\d{2}T/);
    const again = upsertProject({ path: alpha }, dataDir);
    assert.equal(again.name, 'alpha');
    assert.equal(readProjects(dataDir).length, 4, 'the same folder twice is one entry');
  });
  test('two folders with the same basename get distinct names; remove takes an entry out', () => {
    const other = join(root, 'outro', 'alpha');
    mkdirSync(other, { recursive: true });
    assert.equal(upsertProject({ path: other }, dataDir).name, 'alpha-2');
    assert.ok(removeProject('alpha-2', dataDir));
    assert.equal(removeProject('alpha-2', dataDir), false);
    assert.equal(readProjects(dataDir).length, 4);
  });
  test('a name is sanitised for display and for the log file name', () => {
    assert.equal(safeName('My Proj'), 'My Proj');
    assert.equal(safeName('../../etc'), 'etc');
    assert.equal(safeName('a/b\\c'), 'a-b-c');
    assert.equal(safeName(''), 'projeto');
  });
  test('liveness comes from the lock: a live runner owner is true, a dead pid false', () => {
    assert.ok(ownerAlive(decoy.pid), 'decoy recognised as a runner');
    const byName = Object.fromEntries(listProjectsWithStatus(dataDir).map(p => [p.name, p]));
    assert.equal(byName.beta.runnerAlive, true);
    assert.equal(byName.gama.runnerAlive, false, 'lock with a dead owner is not a live runner');
    assert.equal(byName.alpha.runnerAlive, false, 'no lock at all');
  });
  test('the async liveness check gives the same answer as the blocking one', async () => {
    assert.equal(await ownerAliveAsync(decoy.pid), true, 'a live runner');
    assert.equal(await ownerAliveAsync(deadPid), false, 'a pid that is gone');
  });
  test('after the TTL the cache answers with the last known value and refreshes in the background', async () => {
    resetAliveCache();
    const pid = 987654; // never looked up for real: both checks are injected
    let sync = 0; let background = 0;
    const blocking = () => { sync++; return true; };
    const inBackground = async () => { background++; return false; };
    const t0 = Date.now();
    assert.equal(ownerAliveCached(pid, t0, blocking, inBackground), true, 'first sighting: measured, not guessed');
    assert.equal(ownerAliveCached(pid, t0 + 1000, blocking, inBackground), true);
    assert.equal(sync, 1, 'inside the TTL nothing is checked again');
    assert.equal(ownerAliveCached(pid, t0 + ALIVE_TTL_MS + 1, blocking, inBackground), true, 'stale: the last known value, without blocking');
    assert.equal(sync, 1, 'the blocking check is never repeated');
    await sleep(20);
    assert.equal(background, 1, 'exactly one background refresh in flight');
    assert.equal(ownerAliveCached(pid, Date.now(), blocking, inBackground), false, 'the refresh updated the value');
    assert.equal(sync, 1);
  });
});

// The registry is the record of the Sponsor's own bootstraps: a half-written or
// hand-edited file must never be treated as "no projects" and rewritten on top.
describe('an unreadable projects.json is left alone', () => {
  const file = projectsPath(dataDir);
  const garbage = '{ "projects": [ { "name": "alpha", "path": "C:\\\\x"  <- ficheiro meio escrito\n';
  let original;
  before(() => { original = readFileSync(file, 'utf8'); });
  after(() => writeFileSync(file, original));
  test('readers report it, writers refuse, the file stays byte for byte the same, both endpoints answer 500', async () => {
    writeFileSync(file, garbage);
    const reg = loadProjects(dataDir);
    assert.equal(reg.corrupt, true);
    assert.deepEqual(reg.projects, []);
    assert.match(reg.error, /ilegível/);
    assert.deepEqual(readProjects(dataDir), [], 'a corrupt registry reads as empty, never as the old list');
    assert.throws(() => upsertProject({ path: alpha }, dataDir), /ilegível/, 'bootstrap does not rewrite it');
    assert.throws(() => removeProject('alpha', dataDir), /ilegível/);
    assert.equal(readFileSync(file, 'utf8'), garbage, 'the file was not touched');
    const list = await http('/projects');
    assert.equal(list.status, 500);
    assert.match(list.json.error, /ilegível/);
    assert.ok(!list.body.includes(root), 'the error carries no path');
    const run = await post({ project: 'alpha', goal: 'arrancar com o registo partido' });
    assert.equal(run.status, 500, 'a corrupt registry is not "projeto desconhecido"');
    assert.equal(spawned.length, 0, 'nothing was launched');
  });
  test('no registry at all is not corruption: it is an empty list', () => {
    rmSync(file);
    assert.deepEqual(loadProjects(dataDir), { projects: [], corrupt: false, error: null });
  });
});

describe('GET /projects', () => {
  test('401 without the token, and nothing about the projects leaks', async () => {
    const r = await http('/projects', { auth: false });
    assert.equal(r.status, 401);
    assert.ok(!/alpha|beta/.test(r.body), 'the 401 page says nothing about the registry');
  });
  test('every project with its run summary and liveness; no-store; unknown method → 405', async () => {
    const r = await http('/projects');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.projects.map(p => p.name), ['alpha', 'beta', 'delta', 'gama']);
    const byName = Object.fromEntries(r.json.projects.map(p => [p.name, p]));
    assert.equal(byName.alpha.run, null, 'a project that never ran has no run');
    assert.equal(byName.alpha.runnerAlive, false);
    // `visible` entrou no resumo com a guarda dos runners (lib/guard.mjs, §12):
    // um run relançado tem de ser relançado no modo em que arrancou.
    // `driver` (§3c): beta's RUN.json predates the field and its lock names no
    // run_id — a live lock of a run we cannot name is not evidence, so the
    // driver is shown as unknown, never guessed.
    assert.deepEqual(byName.beta.run, {
      run_id: 'R-20260916-aaaa', status: 'running', goal: 'continuar o que ficou a meio', started_at: '2026-09-16T10:00:00.000Z', visible: false,
      driver: 'unknown', driver_source: 'sem evidência (run anterior ao campo: nenhum registo do runner com este run_id)', driver_request: null,
    });
    assert.equal(byName.beta.runnerAlive, true);
    assert.equal(byName.gama.run.status, 'finished');
    assert.equal(byName.gama.runnerAlive, false);
    assert.match(byName.alpha.bootstrappedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(Object.keys(byName.alpha).sort(), ['bootstrappedAt', 'name', 'run', 'runnerAlive'], 'sem `path`: o telemóvel identifica um projeto pelo nome e mais nada');
    assert.ok(!r.body.includes(root.replace(/\\/g, '\\\\')) && !r.body.includes(root), 'nenhum caminho do PC atravessa o túnel');
    assert.equal((await http('/projects', { method: 'POST', body: '{}' })).status, 405);
  });
  test('the answer never waits for a liveness check (two locked projects, one live owner)', async () => {
    await http('/projects'); // the first sighting of each pid is the one synchronous check
    const t0 = performance.now();
    const r = await http('/projects');
    const ms = performance.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(r.json.projects.find(p => p.name === 'beta').runnerAlive, true, 'still the right answer');
    assert.ok(ms < 100, `GET /projects demorou ${ms.toFixed(0)} ms (o PowerShell de ownerAlive custa ~300 ms por projeto com lock)`);
  });
});

describe('POST /runs — refusals', () => {
  test('401 without the token', async () => {
    assert.equal((await post({ project: 'alpha', goal: 'arrancar o run de teste' }, { auth: false })).status, 401);
  });
  test('400: bad json, not an object, no project, short goal, long goal, control characters, body over 4 KB', async () => {
    assert.equal((await post('{nope')).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post([1, 2])).status, 400);
    assert.equal((await post({ goal: 'sem projeto nenhum' })).status, 400);
    const short = await post({ project: 'alpha', goal: '  curto  ' });
    assert.equal(short.status, 400);
    assert.match(short.json.error, /10 caracteres/);
    const long = await post({ project: 'alpha', goal: 'a'.repeat(601) });
    assert.equal(long.status, 400);
    assert.match(long.json.error, /600/);
    const ctrl = await post({ project: 'alpha', goal: 'arrancar o run com sino' });
    assert.equal(ctrl.status, 400);
    assert.match(ctrl.json.error, /controlo/);
    // Invisible formatting: a goal that reads clean in the queue but carries a
    // zero-width or bidi mark would put something else in argv and in RUN.json.
    for (const cp of [0x00ad, 0x061c, 0x180e, 0x200b, 0x200e, 0x202e, 0x2065, 0x2066, 0xfeff, 0xe0001, 0xe0041, 0xe007f]) {
      const hidden = await post({ project: 'alpha', goal: `limpar a${String.fromCodePoint(cp)}configuração antiga` });
      assert.equal(hidden.status, 400, `U+${cp.toString(16).toUpperCase().padStart(4, '0')} devia ser recusado`);
      assert.match(hidden.json.error, /controlo ou invisíveis/);
    }
    // `--max-sessions 999` as a goal must not reach argv as a flag: one argv
    // element either way, but the CLI would read it as a flag and lose the goal.
    const dash = await post({ project: 'alpha', goal: '--max-sessions 999 e mais texto' });
    assert.equal(dash.status, 400);
    assert.match(dash.json.error, /começar por/);
    assert.equal((await post({ project: 'alpha', goal: 'x'.repeat(8000) })).status, 400, 'body over 4 KB');
    assert.equal(spawned.length, 0, 'nothing was launched by a bad request');
    assert.equal((await http('/health')).status, 200, 'server still up after hostile input');
  });
  test('404 for a project that is not in the registry (and a path is never accepted)', async () => {
    const r = await post({ project: 'desconhecido', goal: 'arrancar um run qualquer' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'projeto desconhecido' });
    const byPath = await post({ project: alpha, path: alpha, goal: 'arrancar pelo caminho absoluto' });
    assert.equal(byPath.status, 404, 'a path in the body is not a project');
    assert.ok(!byPath.body.includes(root), 'the error never echoes a path');
    assert.equal(spawned.length, 0);
  });
  test('409: a live runner, a run already in progress, and resume with no run to resume', async () => {
    const live = await post({ project: 'beta', goal: 'arrancar por cima de um runner vivo' });
    assert.equal(live.status, 409);
    assert.deepEqual(live.json, { error: 'já há um runner vivo neste projeto' });
    assert.equal((await post({ project: 'beta', resume: true })).status, 409, 'resume is refused too while the runner is alive');
    const running = await post({ project: 'delta', goal: 'arrancar um segundo run no mesmo projeto' });
    assert.equal(running.status, 409);
    assert.deepEqual(running.json, { error: 'há um run em curso — relança-o em vez de arrancar outro' });
    const noRun = await post({ project: 'alpha', resume: true });
    assert.equal(noRun.status, 409);
    assert.deepEqual(noRun.json, { error: 'não há run em curso para relançar' });
    assert.equal(spawned.length, 0);
  });
  test('403 for a cross-site POST (the token cookie alone must not be enough to launch a process)', async () => {
    const r = await post({ project: 'alpha', goal: 'arrancar a partir de outro site' }, { headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' } });
    assert.equal(r.status, 403);
    // `Origin: null` is what a sandboxed iframe or a redirected cross-origin post
    // sends; no page of this viewer ever produces it. Absent Origin still passes
    // (curl and the tests above have none).
    const nul = await post({ project: 'alpha', goal: 'arrancar a partir de uma iframe' }, { headers: { Origin: 'null', 'Content-Type': 'application/json' } });
    assert.equal(nul.status, 403);
    assert.deepEqual(nul.json, { error: 'pedido de outra origem' });
    assert.equal(spawned.length, 0);
  });
});

describe('POST /runs — launches', () => {
  test('start: 200 with the pid, the runner argv carries the goal as one argument, cwd is the project folder', async () => {
    const goal = 'acrescentar a página de definições ao viewer';
    const r = await post({ project: 'alpha', goal }, { headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.deepEqual(r.json, { ok: true, action: 'start', project: 'alpha', pid: 4243 });
    assert.equal(spawned.length, 1);
    const call = spawned[0];
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args, [join(forja, 'bin', 'forja.mjs'), 'runner', '--goal', goal]);
    assert.equal(call.options.cwd, alpha);
    assert.equal(call.options.env.FORJA_DATA_DIR, dataDir);
    assert.equal(call.options.env.CLAUDE_CODE_SESSION_ID, undefined, 'the viewer session never leaks into the run');
    assert.equal(call.options.env.FORJA_PROJECT_ROOT, undefined);
    assert.match(call.options.logPath, /runner[\\/]spawn-alpha-/);
  });
  test('the launch is logged as status only — project, action, pid, goal length, never the goal text', () => {
    const log = readFileSync(join(dataDir, 'runner', 'spawn.log'), 'utf8');
    assert.match(log, /project=alpha action=start pid=4243 goal_chars=44 via=viewer/);
    assert.ok(!/página de definições/.test(log), 'the goal text is never written to the log');
  });
  test('a second start for the same project inside 30 s → 409, no second process', async () => {
    const again = await post({ project: 'alpha', goal: 'arrancar outra vez a correr' });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /^espera \d+ s$/);
    assert.equal(spawned.length, 1, 'no second launch');
  });
  test('resume: 200 for a run in progress with no live runner, and the runner gets no --goal', async () => {
    const r = await post({ project: 'delta', resume: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, action: 'resume', project: 'delta', pid: 4244 });
    const call = spawned[1];
    assert.deepEqual(call.args, [join(forja, 'bin', 'forja.mjs'), 'runner']);
    assert.equal(call.options.cwd, delta);
    assert.match(readFileSync(join(dataDir, 'runner', 'spawn.log'), 'utf8'), /project=delta action=resume pid=4244 goal_chars=0/);
  });
  test('a project whose run already finished may start a new one', async () => {
    const r = await post({ project: 'gama', goal: 'arrancar um run novo no gama' });
    assert.equal(r.status, 200, 'gama finished its run: a new one may start');
    assert.equal(spawned.length, 3);
    assert.deepEqual(spawned[2].args.slice(1), ['runner', '--goal', 'arrancar um run novo no gama']);
  });
});

// §3c: the phone never relaunches a run that is not the runner's. A run a
// conversation conducts, and a run whose driver cannot be proven, are refused
// before any process exists — even with no live runner and the run "running".
describe('POST /runs — only a runner-driven run is relaunched (§3c)', () => {
  before(() => {
    makeProject('drv-conversa', { ...RUNNING, run_id: 'R-20260916-dddd', driver: 'interactive', driver_since: '2026-09-16T10:00:00.000Z' });
    makeProject('drv-sem-campo', { ...RUNNING, run_id: 'R-20260916-eeee' });
    makeProject('drv-invalido', { ...RUNNING, run_id: 'R-20260916-ffff', driver: 'robot' });
  });
  test('interactive, unknown (no field, no evidence) and an invalid value → 409, nothing launched', async () => {
    const before = spawned.length;
    const eta = await post({ project: 'drv-conversa', resume: true });
    assert.equal(eta.status, 409);
    assert.match(eta.json.error, /conversa/);
    for (const name of ['drv-sem-campo', 'drv-invalido']) {
      const r = await post({ project: name, resume: true });
      assert.equal(r.status, 409, name);
      assert.match(r.json.error, /não sei quem conduz/, name);
    }
    assert.equal(spawned.length, before, 'no runner was started');
  });
  test('GET /projects shows each driver as it is — never a guess', async () => {
    const r = await http('/projects');
    const by = Object.fromEntries(r.json.projects.map(p => [p.name, p]));
    assert.equal(by['drv-conversa'].run.driver, 'interactive');
    assert.equal(by['drv-sem-campo'].run.driver, 'unknown');
    assert.equal(by['drv-invalido'].run.driver, 'unknown');
    assert.equal(by['drv-invalido'].run.driver_source, 'valor inválido no RUN.json');
    assert.equal(by.delta.run.driver, 'runner');
  });
});

// A registry hand-edited (or written by an older Forja) can hold a name that
// safeName would have refused; spawn.log must not let it forge a line.
describe('POST /runs — the log line never trusts the registry name', () => {
  const nasty = 'omega\nproject=alpha action=start pid=1 goal_chars=0 via=teclado';
  let original;
  before(() => {
    const dir = join(root, 'projects', 'omega');
    mkdirSync(join(dir, 'docs', 'forja'), { recursive: true });
    original = readFileSync(projectsPath(dataDir), 'utf8');
    const reg = JSON.parse(original);
    reg.projects.push({ name: nasty, path: dir, bootstrappedAt: new Date().toISOString() });
    writeFileSync(projectsPath(dataDir), JSON.stringify(reg, null, 2));
  });
  after(() => writeFileSync(projectsPath(dataDir), original));
  test('the name in spawn.log goes through safeName: one line, no forged record', async () => {
    const before = readFileSync(join(dataDir, 'runner', 'spawn.log'), 'utf8').trim().split('\n').length;
    const r = await post({ project: nasty, goal: 'arrancar com um nome tramado' });
    assert.equal(r.status, 200, r.body);
    const lines = readFileSync(join(dataDir, 'runner', 'spawn.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, before + 1, 'um arranque, uma linha — o \\n do nome não abriu um registo novo');
    assert.ok(lines.at(-1).includes('project=omega-project-alpha action-start pid-1 goal_chars-0 via-teclado action=start pid=4'),
      `linha inesperada: ${lines.at(-1)}`);
  });
});

// U+00A0 arrives by accident (phone keyboard, a paste from a document) and
// reads exactly like a space: refusing the goal over it is a dead end the
// Sponsor cannot diagnose. It is normalised to a plain space before validation
// and never reaches argv as U+00A0; every other invisible stays refused.
describe('POST /runs — o espaço inquebrável é normalizado, não recusado', () => {
  const teta = join(root, 'projects', 'teta');
  before(() => {
    mkdirSync(join(teta, 'docs', 'forja'), { recursive: true });
    upsertProject({ path: teta }, dataDir);
  });
  test('um objetivo com NBSP (e espaços estreito/figura/fino) é aceite e chega ao argv com espaços normais; os outros invisíveis continuam recusados', async () => {
    const n = spawned.length;
    const goal = 'arrumar a\u00A0configuração\u202Fantiga\u2009do\u2007viewer';
    const r = await post({ project: 'teta', goal });
    assert.equal(r.status, 200, r.body);
    assert.equal(spawned.length, n + 1, 'o arranque aconteceu mesmo');
    assert.equal(spawned.at(-1).args.at(-1), 'arrumar a configuração antiga do viewer');
    assert.ok(!/[\u00A0\u2007\u2009\u202F]/.test(spawned.at(-1).args.at(-1)), 'nenhum espaço invisível chega ao runner');
    const zw = await post({ project: 'teta', goal: 'arrumar a\u200Bconfiguração antiga do viewer' });
    assert.equal(zw.status, 400, 'o zero-width continua a ser recusado');
    assert.match(zw.json.error, /controlo ou invisíveis/);
  });
});

// The phone posts over the tunnel: a body past ~1,4 KB arrives in several TCP
// segments, and a segment boundary can fall inside a multibyte character.
describe('POST /runs — a body split across chunks', () => {
  const epsilon = join(root, 'projects', 'epsilon');
  const zeta = join(root, 'projects', 'zeta');
  before(() => {
    for (const p of [epsilon, zeta]) mkdirSync(join(p, 'docs', 'forja'), { recursive: true });
    upsertProject({ path: epsilon }, dataDir);
    upsertProject({ path: zeta }, dataDir);
  });
  // Two writes with a pause between them, so the server really sees two 'data'
  // events with the boundary where we put it.
  const postSplit = (payload, cut) => new Promise((resolve, reject) => {
    const buf = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    const at = typeof cut === 'function' ? cut(buf) : cut;
    const headers = { Host: `127.0.0.1:${port}`, Cookie: `forja_k=${token}`, 'Content-Type': 'application/json', 'Content-Length': buf.length };
    const req = request({ host: '127.0.0.1', port, path: '/runs', method: 'POST', headers }, resp => {
      let data = ''; resp.setEncoding('utf8'); resp.on('data', d => { data += d; });
      resp.on('end', () => resolve({ status: resp.statusCode, body: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.write(buf.subarray(0, at));
    setTimeout(() => req.end(buf.subarray(at)), 25);
  });
  // A cut one byte into a two-byte character: the worst case for a per-chunk decode.
  const midChar = (buf, ch) => { const i = buf.indexOf(Buffer.from(ch, 'utf8')); assert.ok(i > 0, `${ch} no corpo`); return i + 1; };

  test('a goal cut in half inside a «ç» reaches argv exactly as it was sent', async () => {
    const goal = 'começar a limpeza da configuração antiga e da documentação';
    const r = await postSplit({ project: 'epsilon', goal }, buf => midChar(buf, 'ç'));
    assert.equal(r.status, 200, r.body);
    const sent = spawned.at(-1).args.at(-1);
    assert.equal(sent, goal, 'o objetivo chega inteiro ao argv do runner');
    assert.ok(!sent.includes('�'), 'nenhum caractere partido a meio');
    assert.equal(spawned.at(-1).options.cwd, epsilon);
  });
  test('601 accented characters are refused for length; 600 are accepted, split or not', async () => {
    const tooLong = await postSplit({ project: 'zeta', goal: 'á'.repeat(601) }, 40);
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.json.error, /600/);
    const before = spawned.length;
    const goal = 'á'.repeat(600); // 600 caracteres, 1200 bytes: dentro do teto de 4 KB
    const ok = await postSplit({ project: 'zeta', goal }, buf => midChar(buf, 'á'));
    assert.equal(ok.status, 200, ok.body);
    assert.equal(spawned.length, before + 1);
    assert.equal(spawned.at(-1).args.at(-1), goal, 'os 600 caracteres acentuados chegam inteiros');
  });
  test('the 4 KB cap is counted in bytes, not in decoded chunks', async () => {
    const body = total => { // um corpo JSON de exatamente `total` bytes
      const empty = JSON.stringify({ project: 'zeta', goal: '' });
      return JSON.stringify({ project: 'zeta', goal: 'a'.repeat(total - Buffer.byteLength(empty)) });
    };
    const atCap = await postSplit(body(MAX_BODY), 100);
    assert.equal(Buffer.byteLength(body(MAX_BODY)), MAX_BODY);
    assert.equal(atCap.status, 400);
    assert.match(atCap.json.error, /600/, 'no limite o corpo é lido: recusado pelo comprimento do objetivo, não pelo tamanho');
    const over = await postSplit(body(MAX_BODY + 1), 100);
    assert.equal(over.status, 400);
    assert.match(over.json.error, /demasiado grande/);
  });
});

describe('`forja bootstrap` registers the project', () => {
  const bootRoot = mkdtempSync(join(tmpdir(), 'forja-runs-api-boot-'));
  const bootData = join(bootRoot, 'data');
  const env = { ...process.env, FORJA_DATA_DIR: bootData, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  after(() => rmSync(bootRoot, { recursive: true, force: true }));
  test('a real bootstrap adds the entry; --dry-run adds nothing', () => {
    const target = join(bootRoot, 'meu-projeto'); mkdirSync(target, { recursive: true });
    const dry = join(bootRoot, 'so-ensaio'); mkdirSync(dry, { recursive: true });
    const r = spawnSync(process.execPath, [cli, 'bootstrap', target], { env, encoding: 'utf8', cwd: bootRoot });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const summary = JSON.parse(r.stdout);
    assert.deepEqual(summary.registry && { registered: summary.registry.registered, name: summary.registry.name }, { registered: true, name: 'meu-projeto' });
    const list = readProjects(bootData);
    assert.deepEqual(list.map(p => p.name), ['meu-projeto']);
    assert.equal(list[0].path, target);

    const r2 = spawnSync(process.execPath, [cli, 'bootstrap', dry, '--dry-run'], { env, encoding: 'utf8', cwd: bootRoot });
    assert.equal(r2.status, 0, r2.stdout + r2.stderr);
    assert.equal(JSON.parse(r2.stdout).registry, undefined, '--dry-run writes nothing, not even the registry');
    assert.deepEqual(readProjects(bootData).map(p => p.name), ['meu-projeto']);
    assert.ok(!existsSync(join(dry, '.claude')), '--dry-run really wrote nothing');
  });
  test('with an unreadable registry the bootstrap still succeeds, says so, and does not overwrite it', () => {
    const file = projectsPath(bootData);
    const garbage = readFileSync(file, 'utf8').slice(0, 30); // uma escrita interrompida
    writeFileSync(file, garbage);
    const target = join(bootRoot, 'outro-projeto'); mkdirSync(target, { recursive: true });
    const r = spawnSync(process.execPath, [cli, 'bootstrap', target], { env, encoding: 'utf8', cwd: bootRoot });
    assert.equal(r.status, 0, 'os ficheiros do projeto foram escritos: o registo não faz falhar o bootstrap');
    const summary = JSON.parse(r.stdout);
    assert.equal(summary.registry.registered, false);
    assert.match(summary.registry.error, /ilegível/);
    assert.equal(summary.registry.file, file, 'diz qual é o ficheiro a corrigir');
    assert.match(summary.warnings.join(' '), /telemóvel/);
    assert.equal(readFileSync(file, 'utf8'), garbage, 'o registo partido ficou exatamente como estava');
    assert.ok(existsSync(join(target, '.claude')), 'o projeto foi mesmo preparado');
  });
});

// Uma entrada cuja pasta já não existe (apagada, disco desligado, resto de um
// teste) não é oferecida a ninguém — e também não desaparece do ficheiro sem
// ordem: o registo é o registo do Sponsor. Quem apaga é `forja projects prune`.
describe('registo: entradas cuja pasta já não existe', () => {
  const ghost = join(root, 'projects', 'fantasma');
  const ghost2 = join(root, 'projects', 'fantasma2');
  before(() => {
    for (const g of [ghost, ghost2]) { mkdirSync(join(g, 'docs', 'forja'), { recursive: true }); upsertProject({ path: g }, dataDir); rmSync(g, { recursive: true, force: true }); }
  });
  test('readProjects e GET /projects escondem-na, o ficheiro mantém-na, e POST /runs recusa arrancar lá', async () => {
    assert.ok(!readProjects(dataDir).some(p => p.name === 'fantasma'), 'fora dos leitores');
    assert.ok(loadProjects(dataDir).projects.some(p => p.name === 'fantasma'), 'mas continua no ficheiro');
    assert.ok(missingProjects(dataDir).map(p => p.name).includes('fantasma'));
    const list = JSON.parse((await http('/projects')).body).projects.map(p => p.name);
    assert.ok(!list.includes('fantasma') && !list.includes('fantasma2'), `a lista do telemóvel não as mostra: ${list.join(',')}`);
    const r = await post({ project: 'fantasma', goal: 'arrancar numa pasta que já não existe' });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /desconhecido/);
  });
  test('pruneProjects tira-as do ficheiro, diz quantas, e é idempotente', () => {
    const { removed, kept } = pruneProjects(dataDir);
    assert.ok(removed.includes('fantasma'), `removidas: ${removed.join(',')}`);
    assert.equal(kept, loadProjects(dataDir).projects.length);
    assert.ok(!loadProjects(dataDir).projects.some(p => p.name === 'fantasma'));
    assert.deepEqual(pruneProjects(dataDir).removed, [], 'segunda passagem não remove nada');
  });
  test('CLI: `forja projects list` mostra pasta e existência; `projects prune` limpa e conta', () => {
    mkdirSync(join(root, 'projects', 'fantasma2', 'docs', 'forja'), { recursive: true });
    upsertProject({ path: join(root, 'projects', 'fantasma2') }, dataDir);
    rmSync(join(root, 'projects', 'fantasma2'), { recursive: true, force: true });
    const env = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
    const list = spawnSync(process.execPath, [cli, 'projects', 'list'], { env, encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    const j = JSON.parse(list.stdout);
    const f2 = j.projects.find(p => p.name === 'fantasma2');
    assert.ok(f2 && f2.exists === false, 'a lista do PC mostra-a, marcada como sem pasta');
    assert.ok(j.projects.find(p => p.name === 'alpha').exists === true);
    assert.ok(j.projects.every(p => typeof p.path === 'string'), 'no PC o caminho é a informação útil');
    assert.equal(j.missing, 1);
    const prune = spawnSync(process.execPath, [cli, 'projects', 'prune'], { env, encoding: 'utf8' });
    assert.equal(prune.status, 0, prune.stderr);
    const pj = JSON.parse(prune.stdout);
    assert.equal(pj.removed, 1);
    assert.deepEqual(pj.names, ['fantasma2']);
    assert.ok(!loadProjects(dataDir).projects.some(p => p.name === 'fantasma2'));
  });
});
