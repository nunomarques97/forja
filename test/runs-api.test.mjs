// viewer/runs-api.mjs + lib/projects.mjs against a temp data dir: the registry
// (status from each project's Core state only), the 410 of the retired
// phone launcher (GET /projects, POST /runs) and the request helpers Core still
// uses (readBody, crossSite). The server runs in-process with a fake spawnRunner
// that must never be called; the data dir is a tmpdir (never data/).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { request } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unwatchFile, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../viewer/server.mjs';
import { MAX_BODY, crossSite, readBody } from '../viewer/runs-api.mjs';
import { listProjectsWithStatus, loadProjects, missingProjects, projectsPath, pruneProjects, readProjects, removeProject, safeName, upsertProject } from '../lib/projects.mjs';


const here = dirname(fileURLToPath(import.meta.url));
const forja = join(here, '..');
const cli = join(forja, 'bin', 'forja.mjs');
const root = mkdtempSync(join(tmpdir(), 'forja-runs-api-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });

// Four projects with legacy history only (never a Core run).
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
const beta = makeProject('beta', RUNNING);                                 // running legacy run with a runner lock
const gama = makeProject('gama', { ...RUNNING, run_id: 'R-20260916-bbbb', status: 'finished' });
const delta = makeProject('delta', { ...RUNNING, run_id: 'R-20260916-cccc', driver: 'runner' }); // running, runner-driven, no runner

let server; let token; let port;
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
  // A leftover runner lock naming this very process: before 0.22.0 it made
  // beta "alive"; now project status never reads a runner lock.
  const lock = join(dataDir, 'runner', `lock-${beta.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`);
  mkdirSync(dirname(lock), { recursive: true });
  writeFileSync(lock, JSON.stringify({ pid: process.pid, run_id: RUNNING.run_id, project: beta, since: new Date().toISOString(), beat: new Date().toISOString() }));

  server = startServer({ dataDir, port: 0, host: '127.0.0.1', noWatchdog: true, spawnRunner: fakeSpawn });
  await once(server.server, 'listening');
  port = server.server.address().port;
  token = readFileSync(join(dataDir, 'viewer-token.txt'), 'utf8').trim();
});
after(() => {
  try { server.server.close(); } catch {}
  try { unwatchFile(join(dataDir, 'events.jsonl')); } catch {}
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
  test('status comes from Core state only: legacy RUN.json and runner locks read as no run, not alive', () => {
    const byName = Object.fromEntries(listProjectsWithStatus(dataDir).map(p => [p.name, p]));
    for (const name of ['alpha', 'beta', 'gama', 'delta']) {
      assert.equal(byName[name].run, null, `${name}: no Core run`);
      assert.equal(byName[name].runnerAlive, false, `${name}: a runner lock is not liveness`);
    }
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
  test('readers report it, writers refuse, the file stays byte for byte the same, the retired endpoints do not read it', async () => {
    writeFileSync(file, garbage);
    const reg = loadProjects(dataDir);
    assert.equal(reg.corrupt, true);
    assert.deepEqual(reg.projects, []);
    assert.match(reg.error, /ilegível/);
    assert.deepEqual(readProjects(dataDir), [], 'a corrupt registry reads as empty, never as the old list');
    assert.throws(() => upsertProject({ path: alpha }, dataDir), /ilegível/, 'bootstrap does not rewrite it');
    assert.throws(() => removeProject('alpha', dataDir), /ilegível/);
    assert.equal(readFileSync(file, 'utf8'), garbage, 'the file was not touched');
    assert.equal((await http('/projects')).status, 410);
    assert.equal((await post({ project: 'alpha', goal: 'arrancar com o registo partido' })).status, 410);
    assert.equal(readFileSync(file, 'utf8'), garbage, 'the 410s did not touch it either');
    assert.equal(spawned.length, 0, 'nothing was launched');
  });
  test('no registry at all is not corruption: it is an empty list', () => {
    rmSync(file);
    assert.deepEqual(loadProjects(dataDir), { projects: [], corrupt: false, error: null });
  });
});

// The phone run launcher is retired (docs/LEGACY-REMOVAL.md): both routes answer
// 410 Gone with a pointer to the terminal, whatever the method, body or project,
// and never read the registry, read the body or start a process.
describe('the retired phone run launcher', () => {
  const spawnLog = join(dataDir, 'runner', 'spawn.log');
  const assertGone = (r, label) => {
    assert.equal(r.status, 410, `${label}: ${r.body}`);
    assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /forja start/);
    assert.match(r.json.error, /forja core resume/);
    assert.equal(r.json.start, 'forja start --goal "..."');
    assert.equal(r.json.resume, 'forja core resume');
    assert.equal(r.json.monitor, '/core');
    assert.ok(!/alpha|beta|gama|delta/.test(r.body), `${label}: no project leaks`);
    assert.ok(!r.body.includes(root) && !r.body.includes(root.replace(/\\/g, '\\\\')), `${label}: no path leaks`);
  };
  test('401 without the token, before the 410', async () => {
    assert.equal((await http('/projects', { auth: false })).status, 401);
    assert.equal((await post({ project: 'alpha', goal: 'arrancar o run de teste' }, { auth: false })).status, 401);
  });
  test('GET /projects answers 410 and lists nothing', async () => {
    assertGone(await http('/projects'), 'GET /projects');
    assertGone(await http('/projects?x=1'), 'GET /projects with a query');
    assertGone(await http('/projects', { method: 'POST', body: '{}' }), 'POST /projects');
  });
  test('POST /runs answers 410 for a start, a resume and a malformed body, and launches nothing', async () => {
    assertGone(await post({ project: 'alpha', goal: 'arrancar o run de teste' }), 'start');
    assertGone(await post({ project: 'delta', resume: true }), 'resume of a runner-driven run');
    assertGone(await post('{nope'), 'bad JSON');
    assertGone(await post({ project: 'alpha', goal: 'x'.repeat(MAX_BODY * 2) }), 'body over the cap');
    assertGone(await post({ project: 'alpha', goal: 'arrancar de outra origem' }, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } }), 'cross-site');
    assertGone(await http('/runs'), 'GET /runs');
    assertGone(await http('/runs', { method: 'PUT', body: '{}' }), 'PUT /runs');
    assert.equal(spawned.length, 0, 'no process was started');
    assert.ok(!existsSync(spawnLog), 'no launch was logged');
  });
  test('the server keeps answering after a 410 that never read the body', async () => {
    assertGone(await post({ project: 'beta', goal: 'a'.repeat(3000) }), 'large body');
    assert.equal((await http('/api/core')).status, 200, 'the next request is answered');
  });
});

// readBody is still the body reader of POST /api/core/decision (viewer/core-api.mjs):
// a body split across chunks is decoded once, and the cap counts bytes.
describe('readBody', () => {
  const fakeReq = () => {
    const req = new EventEmitter();
    req.destroy = () => { req.destroyed = true; };
    return req;
  };
  const fakeRes = () => {
    const res = { status: null, body: null };
    res.writeHead = status => { res.status = status; };
    res.end = body => { res.body = body; };
    return res;
  };
  test('a character cut in half between two chunks arrives whole', () => {
    const text = JSON.stringify({ choice: 'começar a limpeza da configuração' });
    const buf = Buffer.from(text, 'utf8');
    const cut = buf.indexOf(Buffer.from('ç', 'utf8')) + 1;
    const req = fakeReq(); const res = fakeRes(); let got = null;
    readBody(req, res, body => { got = body; });
    req.emit('data', buf.subarray(0, cut)); req.emit('data', buf.subarray(cut)); req.emit('end');
    assert.equal(got, text);
    assert.ok(!got.includes('�'), 'no broken character');
    assert.equal(res.status, null, 'the reader answered nothing');
  });
  test('the cap is counted in bytes: MAX_BODY passes, one byte more is a 400 and onDone never runs', () => {
    const atCap = fakeReq(); let got = null;
    readBody(atCap, fakeRes(), body => { got = body; });
    atCap.emit('data', Buffer.from('á'.repeat(MAX_BODY / 2), 'utf8')); atCap.emit('end');
    assert.equal(Buffer.byteLength(got), MAX_BODY);
    const over = fakeReq(); const res = fakeRes(); let called = false;
    readBody(over, res, () => { called = true; });
    over.emit('data', Buffer.alloc(MAX_BODY, 97)); over.emit('data', Buffer.from('b')); over.emit('end');
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /too large/);
    assert.equal(called, false);
  });
});

// crossSite stays the Origin check of /login and /api/core/decision.
describe('crossSite', () => {
  const req = (origin, host = '127.0.0.1:8787') => ({ headers: { host, ...(origin === undefined ? {} : { origin }) } });
  test('same origin and no Origin pass; another site, garbage and null are refused; null passes only with allowNull', () => {
    assert.equal(crossSite(req(undefined)), false);
    assert.equal(crossSite(req('http://127.0.0.1:8787')), false);
    assert.equal(crossSite(req('https://evil.example')), true);
    assert.equal(crossSite(req('not a url')), true);
    assert.equal(crossSite(req('null')), true);
    assert.equal(crossSite(req('null'), { allowNull: true }), false);
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
    assert.match(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), /forja-core:begin/, 'o projeto foi mesmo preparado');
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
  test('readProjects esconde-a e o ficheiro mantém-na', () => {
    assert.ok(!readProjects(dataDir).some(p => p.name === 'fantasma'), 'fora dos leitores');
    assert.ok(loadProjects(dataDir).projects.some(p => p.name === 'fantasma'), 'mas continua no ficheiro');
    assert.ok(missingProjects(dataDir).map(p => p.name).includes('fantasma'));
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
