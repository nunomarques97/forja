// bin/forja.mjs against a temp project + temp data dir: run lifecycle, task
// state machine with the 3-strike rule, decisions, Sponsor queue + answers,
// fallback floor, handover regeneration, resume prompt, Forja events emitted.
// ntfy is pointed at a dead port so nothing is sent.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'forja.mjs');
const root = mkdtempSync(join(tmpdir(), 'forja-cli-'));
const proj = join(root, 'proj'); mkdirSync(proj);
const dataDir = join(root, 'data');
const env = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9', CLAUDE_CODE_SESSION_ID: 'sess-test-1' };
const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
const state = () => ({ run: JSON.parse(readFileSync(join(proj, 'docs/forja/RUN.json'), 'utf8')), tasks: JSON.parse(readFileSync(join(proj, 'docs/forja/TASKS.json'), 'utf8')) });
const events = () => readFileSync(join(dataDir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
after(() => rmSync(root, { recursive: true, force: true }));

describe('run lifecycle', () => {
  test('run start creates RUN.json with an R- id, empty tasks, headers, handover; emits run.start', () => {
    assert.equal(forja('status').out.trim(), 'Sem run neste projeto. `forja run start --goal "…"` para começar.');
    const r = forja('run', 'start', '--goal', 'Testar o CLI');
    assert.equal(r.code, 0); assert.match(r.json.run_id, /^R-\d{8}-[a-f0-9]{4}$/);
    const { run } = state();
    assert.equal(run.status, 'running'); assert.equal(run.model_floor, 'fable'); assert.deepEqual(run.sessions, ['sess-test-1']);
    for (const f of ['TASKS.json', 'DECISIONS.md', 'SPONSOR-QUEUE.md', 'HANDOVER.md', 'reports']) assert.ok(existsSync(join(proj, 'docs/forja', f)), f);
    const ev = events().at(-1); assert.equal(ev.hook_event_name, 'Forja'); assert.equal(ev.forja.kind, 'run.start'); assert.equal(ev.session_id, 'sess-test-1'); assert.equal(ev.forja.run_id, run.run_id);
  });
  test('a second run start is refused while one is running; resume attaches a new session', () => {
    assert.equal(forja('run', 'start', '--goal', 'outro').code, 2);
    const r = spawnSync(process.execPath, [cli, 'run', 'resume'], { cwd: proj, env: { ...env, CLAUDE_CODE_SESSION_ID: 'sess-test-2' }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.deepEqual(state().run.sessions, ['sess-test-1', 'sess-test-2']);
    assert.equal(events().at(-1).forja.kind, 'run.resume');
  });
});

describe('tasks and the 3-strike rule', () => {
  test('add, start (attempt 1), review, fail → todo; third fail closes as failed; fourth start refused', () => {
    assert.equal(forja('task', 'add', '--id', 'T1', '--owner', 'fundidor', '--title', 'Primeira', '--criteria', 'passa').code, 0);
    assert.equal(forja('task', 'add', '--id', 'T2', '--owner', 'lapidador', '--title', 'Segunda', '--after', 'T1').code, 0);
    assert.equal(forja('task', 'start', 'T1').json.attempts, 1);
    assert.equal(state().tasks[0].status, 'doing'); assert.equal(state().run.current_task, 'T1');
    assert.equal(forja('task', 'review', 'T1').json.status, 'review');
    let f = forja('task', 'fail', 'T1', '--why', 'falta teste').json; assert.equal(f.status, 'todo'); assert.equal(f.final, false);
    assert.equal(forja('task', 'start', 'T1').json.attempts, 2);
    forja('task', 'fail', 'T1', '--why', 'falta teste 2');
    assert.equal(forja('task', 'start', 'T1').json.attempts, 3);
    f = forja('task', 'fail', 'T1', '--why', 'falta teste 3').json; assert.equal(f.status, 'failed'); assert.equal(f.final, true);
    const refused = forja('task', 'start', 'T1'); assert.equal(refused.code, 2); assert.match(refused.err, /3 strikes/);
    assert.equal(state().tasks[0].verdicts.length, 3);
    assert.match(readFileSync(join(proj, 'docs/forja/HANDOVER.md'), 'utf8'), /T1 \[failed\]/);
  });
  test('done records the verdict; block records the reason', () => {
    forja('task', 'start', 'T2');
    assert.equal(forja('task', 'done', 'T2', '--verdict', 'APPROVE — ok').json.status, 'done');
    assert.equal(state().tasks[1].verdicts[0].verdict, 'APPROVE');
    forja('task', 'add', '--id', 'T3', '--owner', 'fundidor', '--title', 'Terceira');
    forja('task', 'start', 'T3');
    assert.equal(forja('task', 'block', 'T3', '--why', 'permissão negada').json.status, 'blocked');
    assert.equal(state().tasks[2].why, 'permissão negada');
    assert.equal(forja('task', 'start', 'T2').code, 2, 'a done task cannot be restarted');
  });
});

describe('task show', () => {
  test('prints the whole task: state, owner, complexity, criteria, attempts, every verdict in full, dependency', () => {
    const r = forja('task', 'show', 'T1');
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split('\n');
    assert.equal(lines[0], 'T1 — Primeira');
    assert.equal(lines[1], 'Estado: failed · tentativas: 3/3 · owner: fundidor · complexidade: medium');
    assert.equal(lines[2], 'Depende de: nada');
    assert.match(r.out, /Critérios de aceitação \(definição de done\):\npassa/);
    assert.match(r.out, /Veredictos \(3\):/);
    // Verdicts in full and in order: on a retry they are the specification.
    for (const [i, why] of ['falta teste', 'falta teste 2', 'falta teste 3'].entries()) {
      assert.match(r.out, new RegExp(`${i + 1}\\. \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} · REJECT\\n${why}`), why);
    }
    assert.match(r.out, /Último motivo registado: falta teste 3/);
  });
  test('the dependency and its state; an approved task shows the APPROVE text; no criteria says so', () => {
    const t2 = forja('task', 'show', 'T2');
    assert.equal(t2.code, 0);
    assert.match(t2.out, /^T2 — Segunda\nEstado: done · tentativas: 1\/3 · owner: lapidador · complexidade: medium\nDepende de: T1 \(failed\)/);
    assert.match(t2.out, /Critérios de aceitação \(definição de done\):\n\(nenhum registado — o título é o critério\)/);
    assert.match(t2.out, /· APPROVE · piso fable\nAPPROVE — ok/);
    assert.match(forja('task', 'show', 'T3').out, /Veredictos \(0\):\n\(nenhum ainda\)/);
  });
  test('it changes nothing and emits nothing; an unknown id and a missing id are refused', () => {
    const before = readFileSync(join(proj, 'docs/forja/TASKS.json'), 'utf8');
    const eventsBefore = events().length;
    assert.equal(forja('task', 'show', 'T9').code, 2);
    assert.match(forja('task', 'show', 'T9').err, /task T9 não existe/);
    assert.equal(forja('task', 'show').code, 2);
    assert.match(forja('task', 'show').err, /falta o id da task/);
    forja('task', 'show', 'T1');
    assert.equal(readFileSync(join(proj, 'docs/forja/TASKS.json'), 'utf8'), before, 'read-only');
    assert.equal(events().length, eventsBefore, 'no event for a read');
  });
  test('a subcommand that is only an Object.prototype name is unknown, not a function to call', () => {
    for (const group of ['task', 'run', 'forjalvl', 'models', 'autonomy']) {
      for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
        const r = forja(group, name);
        assert.equal(r.code, 2, `${group} ${name}`);
        assert.match(r.err, /forja — comandos/, `${group} ${name} prints the usage`);
      }
      assert.equal(forja(group).code, 2, `${group} with no subcommand`);
    }
  });
});

describe('decisions, queue, answers, fallback', () => {
  test('decide appends D<n> to DECISIONS.md and emits; ask appends Q<n> to the queue', () => {
    assert.equal(forja('decide', 'Sem base de dados', '--why', 'volume pequeno', '--reversible', 'yes').json.id, 'D1');
    assert.equal(forja('decide', 'JSON em disco', '--why', 'simples').json.id, 'D2');
    assert.match(readFileSync(join(proj, 'docs/forja/DECISIONS.md'), 'utf8'), /\*\*D2\*\*.*JSON em disco/);
    assert.equal(forja('ask', 'Publicar?', '--default', 'não publicar', '--why', 'publicação é do Sponsor').json.id, 'Q1');
    assert.equal(forja('ask', 'Apagar legacy/?', '--default', 'não apagar', '--why', 'ficheiros do utilizador').json.id, 'Q2');
    const q = readFileSync(join(proj, 'docs/forja/SPONSOR-QUEUE.md'), 'utf8');
    assert.match(q, /## Q1 — Publicar\?\nEstado: aberta/); assert.match(q, /Default aplicado: não publicar/);
    assert.equal(events().filter(e => e.forja && e.forja.kind === 'ask').length, 2);
  });
  test('answers picks up viewer answers and file answers, marks them, emits, and is idempotent', () => {
    mkdirSync(join(dataDir, 'answers'), { recursive: true });
    appendFileSync(join(dataDir, 'answers', 'proj.jsonl'), JSON.stringify({ id: 'Q1', answer: 'não, não publicar', ts: '2026-09-17T10:00:00.000Z' }) + '\n');
    let r = forja('answers').json; assert.equal(r.applied, 1); assert.deepEqual(r.open, ['Q2']);
    const q = readFileSync(join(proj, 'docs/forja/SPONSOR-QUEUE.md'), 'utf8');
    assert.match(q, /## Q1 — Publicar\?\nEstado: respondida/); assert.match(q, /Resposta: não, não publicar/);
    r = forja('answers').json; assert.equal(r.applied, 0, 'idempotent');
    assert.equal(events().filter(e => e.forja && e.forja.kind === 'answer').length, 1);
  });
  test('fallback lowers the floor, prints F<n>, logs to data/fallbacks.jsonl', () => {
    const r = forja('fallback', 'fundidor', 'fable', 'opus', '--why', '429 rate limit').json;
    assert.equal(r.id, 'F1'); assert.equal(r.model_floor, 'opus');
    assert.equal(state().run.model_floor, 'opus');
    assert.match(readFileSync(join(dataDir, 'fallbacks.jsonl'), 'utf8'), /"role":"fundidor"/);
    assert.equal(forja('fallback', 'contraste', 'opus', 'fable', '--why', 'tentativa').json.model_floor, 'opus', 'the floor never goes back up in a run');
  });
});

describe('status, checkpoint, finish, resume', () => {
  test('checkpoint counts and regenerates the handover; status prints the summary', () => {
    assert.equal(forja('run', 'checkpoint', '--note', 'meio').json.checkpoints, 1);
    const s = forja('status').out;
    assert.match(s, /piso opus/); assert.match(s, /T1\s+failed\s+3\/3/); assert.match(s, /Fila do Sponsor: 1 aberta/); assert.match(s, /F1 fundidor fable→opus/);
  });
  test('finish refuses with open tasks unless --force; then handover says finished and resume prompt carries the floor', () => {
    forja('task', 'add', '--id', 'T4', '--owner', 'fundidor', '--title', 'Aberta');
    assert.equal(forja('run', 'finish').code, 2);
    forja('task', 'start', 'T4'); forja('task', 'done', 'T4', '--verdict', 'APPROVE');
    const r = forja('run', 'finish', '--note', 'fim').json; assert.equal(r.done, 2);
    assert.equal(state().run.status, 'finished');
    assert.match(readFileSync(join(proj, 'docs/forja/HANDOVER.md'), 'utf8'), /Run terminado/);
    const p = forja('resume').out;
    assert.match(p, /Continue the Forja run R-/); assert.match(p, /Model floor for this run: opus/); assert.match(p, /run resume/);
  });
  test('progress emits an event even without a run pointer and never fails', () => {
    assert.equal(forja('progress', 'a testar').code, 0);
    assert.equal(events().at(-1).forja.kind, 'progress');
  });
  test('guards: task fail on a todo task is refused; fallback validates the role; run start --force archives the running run', () => {
    forja('run', 'start', '--goal', 'segundo run');
    forja('task', 'add', '--id', 'T1', '--owner', 'fundidor', '--title', 'nova');
    assert.equal(forja('task', 'fail', 'T1', '--why', 'x').code, 2, 'a task that never started cannot fail');
    assert.equal(forja('fallback', 'nobody', 'fable', 'opus', '--why', 'x').code, 2);
    const running = state().run.run_id;
    const r = forja('run', 'start', '--goal', 'terceiro run', '--force');
    assert.equal(r.code, 0);
    assert.notEqual(state().run.run_id, running);
    assert.ok(existsSync(join(proj, 'docs/forja', `RUN-${running}.json`)), 'the forced-over run is archived');
    assert.equal(JSON.parse(readFileSync(join(proj, 'docs/forja', `RUN-${running}.json`), 'utf8')).status, 'abandoned');
    const kinds = events().slice(-2).map(e => e.forja.kind);
    assert.deepEqual(kinds, ['run.fail', 'run.start'], 'run.fail for the abandoned run precedes the new run.start');
  });
});

describe('run start after a closed run', () => {
  test('archives the previous run with its tasks and starts with an empty TASKS.json', async () => {
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const { spawnSync } = await import('node:child_process');
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'forja.mjs');
    const root = fs.mkdtempSync(join(os.tmpdir(), 'forja-cli-archive-'));
    const proj = join(root, 'proj'); fs.mkdirSync(proj);
    const env = { ...process.env, FORJA_DATA_DIR: join(root, 'data'), FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
    const f = (...a) => spawnSync(process.execPath, [cli, ...a], { cwd: proj, encoding: 'utf8', env });
    try {
      assert.equal(f('run', 'start', '--goal', 'one').status, 0);
      assert.equal(f('task', 'add', '--id', 'T1', '--owner', 'backend-dev', '--title', 'x').status, 0);
      const first = JSON.parse(fs.readFileSync(join(proj, 'docs/forja/RUN.json'), 'utf8')).run_id;
      assert.equal(f('run', 'fail', '--why', 'test').status, 0);
      const r = f('run', 'start', '--goal', 'two');
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(JSON.parse(fs.readFileSync(join(proj, 'docs/forja/TASKS.json'), 'utf8')), []);
      const arch = JSON.parse(fs.readFileSync(join(proj, 'docs/forja/archive', first + '.json'), 'utf8'));
      assert.equal(arch.tasks.length, 1); assert.equal(arch.run.run_id, first);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('forjalvl per run (forja forjalvl / run start --forjalvl)', () => {
  test('default max; --forjalvl writes RUN.json and the run.start event; the handover and status say the forjalvl', () => {
    const r = forja('run', 'start', '--goal', 'nível por omissão', '--force');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.forjalvl, 'max');
    assert.equal(state().run.forjalvl, 'max');
    assert.equal(state().run.model_level, undefined, 'the old key is not written any more');
    const ev = events().at(-1);
    assert.equal(ev.forja.kind, 'run.start'); assert.equal(ev.forja.forjalvl, 'max');
    assert.equal(ev.forja.model_level, 'max', 'the event keeps the old name too, for older readers');
    assert.match(forja('status').out, /forjalvl: máximo \(max\)/);
    assert.match(readFileSync(join(proj, 'docs/forja/HANDOVER.md'), 'utf8'), /forjalvl \(nível de modelos\): \*\*máximo\*\* \(`max`\)/);
    const eco = forja('run', 'start', '--goal', 'agora barato', '--forjalvl', 'eco', '--force');
    assert.equal(eco.json.forjalvl, 'eco');
    assert.equal(state().run.forjalvl, 'eco');
    assert.equal(events().at(-1).forja.forjalvl, 'eco');
    assert.match(forja('status').out, /forjalvl: económico \(eco\)/);
    assert.match(forja('resume').out, /forjalvl \(nível de modelos\) for this run: eco/);
  });
  test('--models is still accepted as a silent alias of --forjalvl', () => {
    const r = forja('run', 'start', '--goal', 'pelo nome antigo', '--models', 'alto', '--force');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.forjalvl, 'high');
    assert.equal(state().run.forjalvl, 'high');
    assert.equal(/alias/.test(r.err), false, 'the flag alias says nothing about itself (only `forja models` announces it)');
    const naked = forja('run', 'start', '--goal', 'x', '--models', '--force');
    assert.equal(naked.code, 2); assert.match(naked.err, /--models precisa de um nível/, 'the refusal names the flag the person typed');
  });
  test('the Portuguese names are accepted and normalised; an unknown forjalvl is refused with exit 2 and changes nothing', () => {
    assert.equal(forja('run', 'start', '--goal', 'em português', '--forjalvl', 'Alto', '--force').json.forjalvl, 'high');
    assert.equal(state().run.forjalvl, 'high');
    const bad = forja('run', 'start', '--goal', 'x', '--forjalvl', 'barato', '--force');
    assert.equal(bad.code, 2); assert.match(bad.err, /forjalvl desconhecido: "barato"/);
    const proto = forja('run', 'start', '--goal', 'x', '--forjalvl', 'constructor', '--force');
    assert.equal(proto.code, 2, 'a name from Object.prototype is an unknown forjalvl, not a match');
    assert.match(proto.err, /forjalvl desconhecido: "constructor"/);
    const naked = forja('run', 'start', '--goal', 'x', '--forjalvl', '--force');
    assert.equal(naked.code, 2); assert.match(naked.err, /--forjalvl precisa de um nível/);
    assert.equal(state().run.forjalvl, 'high', 'the refused start left the run untouched');
    assert.equal(state().run.goal, 'em português');
  });
  test('forjalvl set writes the project default in SETTINGS.json (only that key); forjalvl show prints project and run', () => {
    const setPath = join(proj, 'docs/forja/SETTINGS.json');
    writeFileSync(setPath, JSON.stringify({ outra_chave: 'fica', model_level: 'max' }, null, 2));
    const s = forja('forjalvl', 'set', 'económico');
    assert.equal(s.code, 0); assert.equal(s.json.forjalvl, 'eco'); assert.equal(s.json.label, 'económico');
    const saved = JSON.parse(readFileSync(setPath, 'utf8'));
    assert.deepEqual(saved, { outra_chave: 'fica', forjalvl: 'eco' }, 'other keys survive; the renamed key replaces the old one');
    const show = forja('forjalvl', 'show').out;
    assert.match(show, /forjalvl por omissão: económico \(eco\)/);
    assert.match(show, /Run R-.* — forjalvl: alto \(high\)/, 'the run keeps the forjalvl it started with');
    assert.equal(forja('forjalvl', 'set', 'turbo').code, 2);
    assert.equal(forja('forjalvl', 'set').code, 2);
    assert.equal(JSON.parse(readFileSync(setPath, 'utf8')).forjalvl, 'eco', 'a refused set changes nothing');
  });
  test('`forja models` still works and says on stderr that it is an alias', () => {
    const show = forja('models', 'show');
    assert.equal(show.code, 0, show.err);
    assert.match(show.err, /\(alias de forjalvl\)/);
    assert.match(show.out, /forjalvl por omissão: económico \(eco\)/, 'the alias prints exactly what `forjalvl show` prints');
    const set = forja('models', 'set', 'eco');
    assert.equal(set.code, 0); assert.match(set.err, /\(alias de forjalvl\)/); assert.equal(set.json.forjalvl, 'eco');
  });
  test('a new run without a flag takes the project default; an invalid SETTINGS.json forjalvl is refused at start', () => {
    assert.equal(forja('run', 'start', '--goal', 'segue o projeto', '--force').json.forjalvl, 'eco');
    const setPath = join(proj, 'docs/forja/SETTINGS.json');
    writeFileSync(setPath, JSON.stringify({ forjalvl: 'ultra' }, null, 2));
    const bad = forja('run', 'start', '--goal', 'x', '--force');
    assert.equal(bad.code, 2); assert.match(bad.err, /forjalvl desconhecido: "ultra".*SETTINGS\.json/s);
    // A SETTINGS.json written before the rename still decides the run's forjalvl.
    writeFileSync(setPath, JSON.stringify({ model_level: 'alto' }, null, 2));
    assert.equal(forja('run', 'start', '--goal', 'pelo nome antigo no disco', '--force').json.forjalvl, 'high');
    assert.deepEqual(JSON.parse(readFileSync(setPath, 'utf8')), { model_level: 'alto' }, 'reading it never rewrites it');
    assert.match(forja('forjalvl', 'show').out, /forjalvl por omissão: alto \(high\)/);
    writeFileSync(setPath, JSON.stringify({ forjalvl: 'máximo' }, null, 2));
    assert.equal(forja('run', 'start', '--goal', 'de novo no máximo', '--force').json.forjalvl, 'max');
  });
  test('a SETTINGS.json that exists but is unreadable is refused, never read as "no settings"', () => {
    const setPath = join(proj, 'docs/forja/SETTINGS.json');
    const runBefore = readFileSync(join(proj, 'docs/forja/RUN.json'));
    const truncated = '{\n  "outra_chave": "fica",\n  "forjalvl": "ec';
    writeFileSync(setPath, truncated);
    const show = forja('forjalvl', 'show');
    assert.equal(show.code, 2, 'forjalvl show refuses');
    assert.match(show.err, /SETTINGS\.json ilegível: .*corrige-o à mão/s);
    assert.equal(/sem SETTINGS\.json/.test(show.out), false, 'never announced as a missing file');
    const start = forja('run', 'start', '--goal', 'não pode arrancar às cegas', '--force');
    assert.equal(start.code, 2, 'run start refuses instead of falling back to max');
    assert.match(start.err, /SETTINGS\.json ilegível/);
    assert.deepEqual(readFileSync(join(proj, 'docs/forja/RUN.json')), runBefore, 'the refused start left RUN.json byte for byte as it was');
    assert.equal(existsSync(join(proj, 'docs/forja', `RUN-${JSON.parse(runBefore).run_id}.json`)), false, 'and did not archive the run it refused to replace');
    const set = forja('forjalvl', 'set', 'alto');
    assert.equal(set.code, 2, 'forjalvl set refuses');
    assert.match(set.err, /SETTINGS\.json ilegível/);
    assert.equal(readFileSync(setPath, 'utf8'), truncated, 'the unreadable file is never overwritten: its other keys are not lost');
    for (const junk of ['', '[]', '"eco"']) { writeFileSync(setPath, junk); assert.equal(forja('forjalvl', 'show').code, 2, `unreadable: ${JSON.stringify(junk)}`); }
    // A BOM (what PowerShell writes by default) is a readable file, not corruption.
    writeFileSync(setPath, '\ufeff' + JSON.stringify({ outra_chave: 'fica', forjalvl: 'alto' }, null, 2));
    const ok = forja('forjalvl', 'show');
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /forjalvl por omissão: alto \(high\)/);
    assert.equal(forja('run', 'start', '--goal', 'com BOM', '--force').json.forjalvl, 'high');
    // A readable file that simply does not set the key is neither missing nor broken.
    writeFileSync(setPath, JSON.stringify({ outra_chave: 'fica' }, null, 2));
    const noKey = forja('forjalvl', 'show');
    assert.equal(noKey.code, 0, noKey.err);
    assert.match(noKey.out, /por omissão do Forja; .*SETTINGS\.json existe mas não define forjalvl/);
    assert.match(noKey.out, /forjalvl por omissão: máximo \(max\)/);
  });
  test('a RUN.json written before the rename is read by its old key, and reading it never rewrites it', () => {
    const runPath = join(proj, 'docs/forja/RUN.json');
    const before = readFileSync(runPath, 'utf8');
    const legacy = JSON.parse(before);
    delete legacy.forjalvl; legacy.model_level = 'eco';
    const legacyText = JSON.stringify(legacy, null, 2) + '\n';
    writeFileSync(runPath, legacyText);
    assert.match(forja('status').out, /forjalvl: económico \(eco\)/);
    assert.match(forja('resume').out, /forjalvl \(nível de modelos\) for this run: eco/);
    assert.match(forja('forjalvl', 'show').out, /Run R-.* — forjalvl: económico \(eco\)/);
    assert.equal(readFileSync(runPath, 'utf8'), legacyText, 'none of those commands rewrote RUN.json');
    writeFileSync(runPath, before);
  });
  test('a delegated command that throws is one sentence, not a stack (the dispatch awaits it)', () => {
    // `projects prune` throws on an unreadable registry (lib/projects.mjs). If the
    // dispatch in main() returned the promise without `await`, the rejection would
    // escape its try/catch: Node printed 13 lines of stack and the Sponsor saw a
    // crash instead of a refusal.
    const solo = mkdtempSync(join(tmpdir(), 'forja-delegate-'));
    try {
      const data = join(solo, 'data'); mkdirSync(data, { recursive: true });
      const registry = join(data, 'projects.json');
      const truncated = '{ "version": 1, "projects": [ ';
      writeFileSync(registry, truncated);
      const r = spawnSync(process.execPath, [cli, 'projects', 'prune'], { cwd: solo, env: { ...env, FORJA_DATA_DIR: data }, encoding: 'utf8' });
      const output = `${r.stdout}${r.stderr}`.trim();
      assert.equal(r.status, 1, output);
      assert.equal(output.split('\n').length, 1, `one line, no stack:\n${output}`);
      assert.match(output, /^forja: o registo de projetos existe mas está ilegível .*corrige-o ou apaga-o à mão$/);
      assert.equal(/\n\s+at |\.mjs:\d+/.test(output), false, 'no stack frames');
      assert.equal(readFileSync(registry, 'utf8'), truncated, 'the unreadable registry was not rewritten');
    } finally { rmSync(solo, { recursive: true, force: true }); }
  });
  test('forjalvl set works with no run at all in the project', () => {
    const solo = mkdtempSync(join(tmpdir(), 'forja-forjalvl-'));
    try {
      const r = spawnSync(process.execPath, [cli, 'forjalvl', 'set', 'alto'], { cwd: solo, env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(readFileSync(join(solo, 'docs/forja/SETTINGS.json'), 'utf8')).forjalvl, 'high');
      const show = spawnSync(process.execPath, [cli, 'forjalvl', 'show'], { cwd: solo, env, encoding: 'utf8' });
      assert.match(show.stdout, /forjalvl por omissão: alto \(high\)/);
      assert.match(show.stdout, /Sem run neste projeto/);
    } finally { rmSync(solo, { recursive: true, force: true }); }
  });
});

describe('autonomy per run (forja autonomy / run start --autonomy)', () => {
  const setPath = join(proj, 'docs/forja/SETTINGS.json');
  test('default normal; --autonomy writes RUN.json and the run.start event; status, handover and resume say it', () => {
    writeFileSync(setPath, JSON.stringify({ outra_chave: 'fica' }, null, 2)); // no autonomy key: the Forja default
    const r = forja('run', 'start', '--goal', 'autonomia por omissão', '--force');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.autonomy, 'normal');
    assert.equal(state().run.autonomy, 'normal');
    const ev = events().at(-1);
    assert.equal(ev.forja.kind, 'run.start'); assert.equal(ev.forja.autonomy, 'normal');
    assert.match(forja('status').out, /autonomia: normal/);
    assert.match(readFileSync(join(proj, 'docs/forja/HANDOVER.md'), 'utf8'), /- Autonomia: \*\*normal\*\* — comportamento de sempre/);

    const total = forja('run', 'start', '--goal', 'agora com liberdade', '--autonomy', 'total', '--force');
    assert.equal(total.code, 0, total.err);
    assert.equal(total.json.autonomy, 'total');
    assert.equal(state().run.autonomy, 'total');
    assert.equal(events().at(-1).forja.autonomy, 'total');
    assert.match(forja('status').out, /autonomia: total/);
    // The prompt a fresh interactive Lead gets carries the rule AND its limits.
    const resume = forja('resume').out;
    assert.match(resume, /Autonomy of this run: total/);
    assert.match(resume, /do NOT go to the Sponsor queue/);
    assert.match(resume, /his money \(purchases, licences, subscriptions, paid certificates\)/);
    assert.match(resume, /docs\/forja\/SPONSOR-ROADMAP\.md/);
    // The handover a fresh runner session reads says the same, in Portuguese.
    const handover = readFileSync(join(proj, 'docs/forja/HANDOVER.md'), 'utf8');
    assert.match(handover, /- Autonomia: \*\*total\*\*/);
    assert.match(handover, /Mesmo em autonomia total continuam a ir à fila do Sponsor: dinheiro dele/);
  });
  test('aliases are accepted; an unknown autonomy is refused with exit 2 and changes nothing', () => {
    assert.equal(forja('run', 'start', '--goal', 'alias', '--autonomy', 'Completa', '--force').json.autonomy, 'total');
    assert.equal(forja('run', 'start', '--goal', 'alias', '--autonomy', 'NORMAL', '--force').json.autonomy, 'normal');
    const bad = forja('run', 'start', '--goal', 'x', '--autonomy', 'muita', '--force');
    assert.equal(bad.code, 2); assert.match(bad.err, /autonomia desconhecida: "muita"/);
    const proto = forja('run', 'start', '--goal', 'x', '--autonomy', 'constructor', '--force');
    assert.equal(proto.code, 2, 'a name from Object.prototype is an unknown autonomy, not a match');
    const naked = forja('run', 'start', '--goal', 'x', '--autonomy', '--force');
    assert.equal(naked.code, 2); assert.match(naked.err, /--autonomy precisa de um valor/);
    assert.equal(state().run.autonomy, 'normal', 'the refused starts left the run untouched');
  });
  test('autonomy set writes the project default (only that key) and prints, on one line, what still goes to the queue', () => {
    writeFileSync(setPath, JSON.stringify({ outra_chave: 'fica', forjalvl: 'eco' }, null, 2));
    const s = forja('autonomy', 'set', 'total');
    assert.equal(s.code, 0, s.err);
    assert.equal(s.json.autonomy, 'total');
    assert.deepEqual(JSON.parse(readFileSync(setPath, 'utf8')), { outra_chave: 'fica', forjalvl: 'eco', autonomy: 'total' }, 'the other keys survive, forjalvl included');
    // The Sponsor is giving freedom: he sees exactly what he is not giving.
    assert.equal(s.json.ainda_na_fila.split('\n').length, 1, 'one line');
    assert.match(s.json.ainda_na_fila, /^Mesmo em autonomia total continuam a ir à fila do Sponsor: dinheiro dele .*criar contas em nome dele.*enviar seja o que for a terceiros.*apagar dados e publicar, fazer deploy ou push\.$/);
    assert.match(s.json.perguntas_de_dinheiro, /«não gasto; alternativa gratuita».*docs\/forja\/SPONSOR-ROADMAP\.md.*Para decidires agora que estás aqui/s);
    const back = forja('autonomy', 'set', 'normal');
    assert.equal(back.json.autonomy, 'normal');
    assert.equal(back.json.ainda_na_fila, undefined, 'nothing to warn about at normal: everything goes to the queue anyway');
    assert.equal(forja('autonomy', 'set', 'muita').code, 2);
    assert.equal(forja('autonomy', 'set').code, 2);
    assert.equal(JSON.parse(readFileSync(setPath, 'utf8')).autonomy, 'normal', 'a refused set changes nothing');
  });
  test('autonomy show names the source; a new run without the flag takes the project default', () => {
    forja('autonomy', 'set', 'total');
    const show = forja('autonomy', 'show').out;
    assert.match(show, /autonomia por omissão: total — de .*SETTINGS\.json/);
    assert.match(show, /Run R-.* — autonomia: normal — diferente da autonomia por omissão do projeto/, 'the run keeps the autonomy it started with');
    assert.equal(forja('run', 'start', '--goal', 'segue o projeto', '--force').json.autonomy, 'total');
    assert.match(forja('autonomy', 'show').out, /Run R-.* — autonomia: total$/m, 'now they agree, so nothing is flagged');
    // A RUN.json written before this feature has no key at all: it reads as normal.
    const runPath = join(proj, 'docs/forja/RUN.json');
    const before = readFileSync(runPath, 'utf8');
    const legacy = JSON.parse(before); delete legacy.autonomy;
    const legacyText = JSON.stringify(legacy, null, 2) + '\n';
    writeFileSync(runPath, legacyText);
    assert.match(forja('status').out, /autonomia: normal/);
    assert.match(forja('resume').out, /Autonomy of this run: normal/);
    assert.equal(readFileSync(runPath, 'utf8'), legacyText, 'reading it never rewrote RUN.json');
    writeFileSync(runPath, before);
    // A corrupted value reads as the STRICT default, and never crashes the CLI.
    const broken = JSON.parse(before); broken.autonomy = 'liberdade a sério';
    writeFileSync(runPath, JSON.stringify(broken, null, 2) + '\n');
    assert.match(forja('status').out, /autonomia: normal/);
    writeFileSync(runPath, before);
  });
  test('an unreadable SETTINGS.json is refused by autonomy show and set, and never overwritten', () => {
    const truncated = '{\n  "outra_chave": "fica",\n  "autonomy": "tot';
    writeFileSync(setPath, truncated);
    const show = forja('autonomy', 'show');
    assert.equal(show.code, 2); assert.match(show.err, /SETTINGS\.json ilegível: .*corrige-o à mão/s);
    const set = forja('autonomy', 'set', 'total');
    assert.equal(set.code, 2); assert.match(set.err, /SETTINGS\.json ilegível/);
    assert.equal(readFileSync(setPath, 'utf8'), truncated, 'the unreadable file is never overwritten');
    const start = forja('run', 'start', '--goal', 'x', '--force');
    assert.equal(start.code, 2, 'run start refuses instead of falling back to normal');
    // An invalid value in a readable file is refused at start, naming the file.
    writeFileSync(setPath, JSON.stringify({ autonomy: 'muita' }, null, 2));
    const bad = forja('run', 'start', '--goal', 'x', '--force');
    assert.equal(bad.code, 2); assert.match(bad.err, /autonomia desconhecida: "muita".*SETTINGS\.json/s);
    writeFileSync(setPath, JSON.stringify({ outra_chave: 'fica' }, null, 2));
  });
  test('autonomy set works with no run at all in the project', () => {
    const solo = mkdtempSync(join(tmpdir(), 'forja-autonomy-'));
    try {
      const r = spawnSync(process.execPath, [cli, 'autonomy', 'set', 'total'], { cwd: solo, env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(readFileSync(join(solo, 'docs/forja/SETTINGS.json'), 'utf8')).autonomy, 'total');
      const show = spawnSync(process.execPath, [cli, 'autonomy', 'show'], { cwd: solo, env, encoding: 'utf8' });
      assert.match(show.stdout, /autonomia por omissão: total/);
      assert.match(show.stdout, /Sem run neste projeto/);
    } finally { rmSync(solo, { recursive: true, force: true }); }
  });
});

describe('forja report (sessão à mão, sem run)', () => {
  const inDir = (dir, ...args) => { mkdirSync(dir, { recursive: true }); const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, encoding: 'utf8' }); return { code: r.status, err: r.stderr }; };
  test('regista o fim da sessão numa linha (evento report); sem frase recusa; com um run a correr manda usar run finish', () => {
    const solo = join(root, 'solo');
    assert.equal(inDir(solo, 'report', 'Feed de eventos entregue').code, 0);
    const ev = events().at(-1);
    assert.equal(ev.forja.kind, 'report'); assert.equal(ev.forja.text, 'Feed de eventos entregue'); assert.equal(ev.project, 'solo');
    assert.notEqual(inDir(solo, 'report').code, 0);
    const busy = join(root, 'busy');
    assert.equal(inDir(busy, 'run', 'start', '--goal', 'x').code, 0);
    const r = inDir(busy, 'report', 'fim');
    assert.notEqual(r.code, 0); assert.match(r.err, /run finish/);
  });
});
