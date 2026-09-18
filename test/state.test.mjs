// Replay tests for viewer/lib/state.mjs — one describe() per failure mode
// listed in docs/ARCHITECTURE.md §8, each replaying its fixture stream from
// test/fixtures/*.jsonl (regenerate with `node test/fixtures/build-fixtures.mjs`).
// Run: node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, applyLine, snapshot, reduceLines, STATES, THRESHOLDS, roleOfType, describe as describeEvent } from '../viewer/lib/state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = Date.parse('2026-09-17T09:00:00.000Z');
const at = s => BASE + s * 1000;
const lines = name => readFileSync(join(here, 'fixtures', `${name}.jsonl`), 'utf8').split('\n');
// Replay "as of" a moment: only lines whose ts is <= now (unparseable lines are
// kept, they carry no ts), then evaluate the derived states at that moment.
const upTo = (ls, nowS) => ls.filter(l => { try { const t = Date.parse(JSON.parse(l).ts); return !Number.isFinite(t) || t <= at(nowS); } catch { return true; } });
const run = (name, nowS) => { const snap = reduceLines(upTo(lines(name), nowS), at(nowS)); return { snap, r: snap.runs[0] }; };
const card = (r, key) => r.roster.find(c => c.key === key);
const inst = (r, agentId) => r.roster.flatMap(c => c.instances).concat(r.native).find(i => i.agentId === agentId);

describe('roles', () => {
  test('legacy and new agent_type names map to the fixed roster; everything else is native', () => {
    assert.equal(roleOfType('reviewer'), 'reviewer');
    assert.equal(roleOfType('Contraste'), 'reviewer');
    assert.equal(roleOfType('backend'), 'backend-dev');
    assert.equal(roleOfType('frontend'), 'frontend-dev');
    assert.equal(roleOfType('product-manager'), 'product-manager');
    assert.equal(roleOfType('Explore'), 'native');
    assert.equal(roleOfType(''), 'native');
  });
  test('describe() gives a short Portuguese line from the fields that exist', () => {
    assert.equal(describeEvent({ tool_name: 'Read', tool_input: { file_path: 'C:\\a\\b\\README.md' } }), 'a ler README.md');
    assert.equal(describeEvent({ tool_name: 'Bash', tool_input: { description: 'run tests', command: 'npm test' } }), 'a correr: run tests');
    assert.equal(describeEvent({ hook_event_name: 'Stop' }), 'evento Stop');
  });
});

describe('happy path', () => {
  test('tasks, decisions, queue, reviews and instances are all attributed', () => {
    const { r } = run('happy-path', 225);
    assert.equal(r.status, STATES.TRABALHAR);
    assert.equal(r.goal, 'Adicionar a página de contactos');
    assert.equal(r.tasks.find(t => t.id === 'T1').status, 'done');
    assert.equal(r.tasks.find(t => t.id === 'T2').status, 'doing');
    assert.equal(r.decisions.length, 1);
    assert.equal(r.queue.length, 1); assert.equal(r.queue[0].status, 'open');
    assert.ok(r.reviews.some(v => v.verdict === 'APPROVE' && v.taskId === 'T1'));
    const lap = inst(r, 'a-lap-1');
    assert.equal(lap.state, STATES.TERMINADO);
    assert.equal(lap.taskId, 'T1');
    assert.equal(lap.task, 'T1 · Lapidador: Página de contactos (HTML + CSS)');
    assert.equal(lap.requestedModel, 'fable');
    assert.equal(lap.resolvedModel, 'claude-fable-5-1');
    assert.equal(lap.handback.status, 'DONE');
    assert.equal(lap.progress.text, 'a tirar screenshots a 1440 e 390');
    const fun = card(r, 'backend-dev');
    assert.equal(fun.state, STATES.TRABALHAR);
    assert.equal(fun.detail, 'a editar server.mjs');
    assert.equal(card(r, 'lead').state, STATES.TRABALHAR);
    assert.match(card(r, 'lead').detail, /Backend Dev/);
    assert.equal(card(r, 'reviewer').state, STATES.TERMINADO);
    assert.equal(card(r, 'reviewer').detail, 'APPROVE');
    assert.equal(r.counts.refused, 0, 'a clean run has no unanswered tool calls');
  });
  test('a specialist whose task waits for review shows "à espera de review"', () => {
    const { r } = run('happy-path', 127); // task.review emitted at 126, Contraste not started yet
    assert.equal(card(r, 'frontend-dev').state, STATES.ESPERA_REVIEW);
    assert.match(card(r, 'frontend-dev').detail, /T1/);
  });
});

describe('missing SubagentStop (background reviewer never closes)', () => {
  test('handback + silence ends the instance; it never becomes a phantom "running" or "no response"', () => {
    const early = run('missing-stop', 601).r;
    assert.equal(inst(early, 'a-rev-bg').state, STATES.TRABALHAR, 'right after the handback it is still settling');
    const later = run('missing-stop', 700).r;
    const i = inst(later, 'a-rev-bg');
    assert.equal(i.state, STATES.TERMINADO);
    assert.equal(i.inferred, true);
    assert.equal(i.verdict, 'REJECT');
    assert.equal(i.resolvedModel, 'claude-opus-5[1m]');
    const muchLater = run('missing-stop', 4000).r;
    assert.equal(inst(muchLater, 'a-rev-bg').state, STATES.TERMINADO);
    assert.equal(card(muchLater, 'reviewer').state, STATES.TERMINADO);
    assert.ok(muchLater.reviews.some(v => v.verdict === 'REJECT'));
  });
  test('the old viewer logic (commit 3ad6240) kept this call open forever — documented regression', async (t) => {
    const { execFileSync } = await import('node:child_process');
    let html;
    try { html = execFileSync('git', ['show', '3ad6240:viewer/index.html'], { cwd: join(here, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
    catch { t.skip('git history with commit 3ad6240 not available'); return; }
    const fn = html.match(/function computeModelStats\(\) \{[\s\S]*?\n\}\n/)[0];
    const vm = await import('node:vm');
    const recs = lines('missing-stop').filter(Boolean).map((l, i) => { const rec = JSON.parse(l); return { rec, t: Date.parse(rec.ts), line: i + 1, project: rec.project }; });
    const ctx = { records: recs, isVisible: () => true, ABANDON_MS: 30 * 60 * 1000, Number, Math, Map, Set, console };
    vm.createContext(ctx);
    vm.runInContext(fn + '\nresult = computeModelStats();', ctx);
    assert.equal(ctx.result.open.size, 1, 'old code: the reviewer call stays open with no way to close');
    assert.equal(ctx.result.calls.length, 0, 'old code: never counted as finished');
  });
});

describe('duplicate SubagentStart (SendMessage re-fires the hook)', () => {
  test('is the same instance, not a second one', () => {
    const { r } = run('duplicate-start', 800);
    const c = card(r, 'reviewer');
    assert.equal(c.instances.length, 1);
    assert.equal(c.instances[0].reannounced, 1);
    assert.equal(c.instances[0].state, STATES.TERMINADO);
    assert.equal(c.instances[0].verdict, 'APPROVE');
    assert.equal(c.instances[0].startedAt, at(1.5), 'keeps the original start');
  });
});

describe('orphan SubagentStops', () => {
  test('empty agent_type is discarded, duplicate Stop ignored, Stop-with-duration creates a finished instance', () => {
    const { r } = run('orphan-stops', 100);
    assert.equal(inst(r, 'a-ghost'), undefined);
    const ok = inst(r, 'a-ok');
    assert.equal(ok.state, STATES.TERMINADO);
    assert.equal(ok.endedAt, at(51), 'first Stop wins; the duplicate does not move the end');
    const lost = inst(r, 'a-lost');
    assert.equal(lost.state, STATES.TERMINADO);
    assert.equal(lost.startedAt, at(30));
    assert.equal(lost.handback.status, 'DONE');
    assert.equal(r.counts.compactions, 1);
  });
});

describe('out-of-order delivery', () => {
  test('Agent result before Start, Stop before inner PostToolUse: one instance, correct end and task', () => {
    const { r } = run('out-of-order', 30);
    const i = inst(r, 'a-ooo');
    assert.equal(card(r, 'backend-dev').instances.length, 1);
    assert.equal(i.task, 'T1 · Fundidor: z');
    assert.equal(i.state, STATES.TERMINADO);
    assert.equal(i.handback.status, 'DONE');
    assert.equal(i.resolvedModel, 'claude-fable-5-1');
  });
});

describe('subagent errors, denials and cancellations', () => {
  test('rate-limit failure is a fallback signal; the retry on opus lowers the run floor', () => {
    const { r } = run('subagent-errors', 50);
    assert.equal(r.fallbacks.length, 2);
    assert.equal(r.fallbacks[0].signal, true);
    assert.equal(r.modelFloor, 'opus');
    assert.equal(inst(r, 'a-den').resolvedModel, 'claude-opus-5[1m]');
  });
  test('a pending permission shows as bloqueado until it is denied; the denial is counted once and the task blocked', () => {
    const mid = run('subagent-errors', 15).r;
    assert.equal(inst(mid, 'a-den').state, STATES.BLOQUEADO);
    assert.match(inst(mid, 'a-den').detail, /permissão/);
    assert.equal(mid.status, STATES.BLOQUEADO);
    const after = run('subagent-errors', 50).r;
    assert.equal(inst(after, 'a-den').denied, 1);
    assert.equal(inst(after, 'a-den').refused, 0, 'a denied call is not also counted as refused');
    assert.equal(after.timeline.filter(e => e.kind === 'tool.refused').length, 0);
    assert.equal(inst(after, 'a-den').state, STATES.TERMINADO);
    assert.equal(inst(after, 'a-den').handback.status, 'BLOCKED');
    assert.equal(after.tasks.find(t => t.id === 'T1').status, 'blocked');
  });
  test('a cancelled call ends as falhou, never as running', () => {
    const { r } = run('subagent-errors', 3000);
    assert.equal(inst(r, 'a-can').state, STATES.FALHOU);
    assert.equal(inst(r, 'a-can').error, 'cancelled');
    assert.equal(card(r, 'frontend-dev').state, STATES.FALHOU);
  });
});

describe('hard denial in headless mode (no PermissionDenied hook)', () => {
  test('a PreToolUse still open when the turn ends counts as refused; parallel calls do not', () => {
    const { r } = run('denied-headless', 30);
    const i = inst(r, 'a-hd');
    assert.equal(i.refused, 1);
    assert.equal(i.calls, 3);
    assert.equal(i.handback.status, 'BLOCKED');
    assert.equal(r.main.refused, 1, 'the main session git push never got a PostToolUse before Stop');
    assert.equal(r.counts.refused, 2);
    const notes = r.timeline.filter(e => e.kind === 'tool.refused');
    assert.equal(notes.length, 2);
    assert.match(notes[0].text, /apagar build/);
    assert.match(notes[1].text, /push/);
  });
});

describe('corrupt or truncated lines, CRLF', () => {
  test('bad lines are counted and skipped; the surrounding stream still reduces correctly', () => {
    const { snap, r } = run('corrupt-lines', 60);
    assert.equal(snap.badLines, 3);
    const i = inst(r, 'a-c');
    assert.equal(i.state, STATES.TERMINADO);
    assert.equal(i.verdict, 'APPROVE');
    assert.equal(i.calls, 0, 'the truncated PreToolUse is lost, nothing is invented for it');
    assert.equal(i.lastEventAt >= at(6), true, 'the CRLF-terminated PostToolUse still counts as proof of life');
    assert.ok(r.timeline.some(e => e.kind === 'bad-line'));
  });
});

describe('compaction, Stop with run running, restart in a new session', () => {
  test('the compaction ghost Stop is ignored and compactions are counted; a corrupt line after run start does not wipe the run', () => {
    const { snap, r } = run('compaction-restart', 150);
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.badLines, 1);
    assert.equal(r.id, 'R-20260917-0001');
    assert.equal(r.goal, 'x');
    assert.equal(r.tasks.length, 1);
    assert.deepEqual(r.sessions, ['run-0001-aaaa-bbbb-cccc-000000000001']);
    assert.equal(r.counts.compactions, 1);
    assert.equal(r.roster.flatMap(c => c.instances).length, 0);
  });
  test('main session ending its turn with the run still running = precisa do Sponsor, and idle_prompt does not undo it', () => {
    for (const s of [250, 261, 300, 399]) {
      const { r } = run('compaction-restart', s);
      assert.equal(card(r, 'lead').state, STATES.SPONSOR, `at t=${s}`);
      assert.equal(r.status, STATES.SPONSOR, `at t=${s}`);
      assert.match(card(r, 'lead').detail, /turno/);
    }
  });
  test('after SessionEnd the run shows as closed', () => {
    const { snap } = run('compaction-restart', 450);
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.runs[0].status, STATES.TERMINADO);
    assert.equal(snap.runs[0].endReason, 'other');
    assert.equal(snap.runs[0].id, 'R-20260917-0001');
  });
  test('a new session that runs `forja run resume` joins the same run: one run, two sessions, tasks kept', () => {
    const { snap } = run('compaction-restart', 510);
    assert.equal(snap.runs.length, 1, 'the resumed session is not a second run');
    const r = snap.runs[0];
    assert.equal(r.id, 'R-20260917-0001');
    assert.deepEqual(r.sessions, ['run-0001-aaaa-bbbb-cccc-000000000001', 'run-0002-aaaa-bbbb-cccc-000000000002']);
    assert.equal(r.status, STATES.TRABALHAR);
    assert.equal(r.endedAt, null);
    assert.equal(r.tasks.find(t => t.id === 'T1').attempts, 2);
    assert.equal(r.counts.compactions, 1);
    assert.equal(inst(r, 'a-r2').state, STATES.TRABALHAR);
    assert.ok(r.timeline.some(e => e.kind === 'run.resume'));
    assert.equal(snap.current, r.id);
  });
});

describe('two sequential runs in one session', () => {
  test('run finish then run start with a new id: the finished run keeps its identity and history', () => {
    const { snap } = run('sequential-runs', 20);
    assert.equal(snap.runs.length, 2);
    const a = snap.runs.find(x => x.id === 'R-20260917-aaaa');
    const b = snap.runs.find(x => x.id === 'R-20260917-bbbb');
    assert.equal(a.status, STATES.TERMINADO); assert.equal(a.goal, 'first'); assert.equal(a.tasks[0].title, 'a'); assert.equal(a.tasks[0].status, 'done');
    assert.equal(b.status, STATES.TRABALHAR); assert.equal(b.goal, 'second'); assert.equal(b.tasks[0].title, 'b');
    assert.deepEqual(b.sessions, ['run-0001-aaaa-bbbb-cccc-000000000001']);
    assert.equal(snap.current, b.id);
  });
});

describe('malformed but well-formed JSON never throws (fuzz)', () => {
  test('hand-built malformed shapes in corrupt-lines reduce without throwing and are counted', () => {
    const { snap } = run('corrupt-lines', 60);
    assert.equal(snap.badLines, 3, 'malformed-but-valid JSON is not a bad line; only the three unparseable ones are');
    assert.equal(snap.runs.length, 2, 'the numeric-session run.resume garbage opens one extra run (R-20260917-zzzz); nothing else leaks');
    assert.ok(snap.runs.some(r => r.id === 'R-20260917-zzzz'));
  });
  test('PermissionDenied without a tool_use_id still settles the pending call (no double count)', () => {
    const st = createState();
    const S = 'run-0001-aaaa-bbbb-cccc-000000000001';
    const base = { project: 'p', session_id: S, cwd: 'C:\\p' };
    const ev = (s, f) => applyLine(st, JSON.stringify({ ts: new Date(at(s)).toISOString(), ...base, ...f }), 1);
    ev(0, { hook_event_name: 'SessionStart', source: 'startup' });
    ev(1, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm x' }, tool_use_id: 'tu-1' });
    ev(2, { hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'rm x' } });
    ev(3, { hook_event_name: 'Stop', last_assistant_message: 'DENIED' });
    const r = snapshot(st, at(10)).runs[0];
    assert.equal(r.counts.denied, 1);
    assert.equal(r.main.refused, 0);
  });
  test('seeded random mutations of every fixture never throw', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const JUNK = [null, 0, -1, 1e12, '', 'x', [], {}, [1], { a: 1 }, true, 'R-1', 'T1', 'Q1'];
    const junk = () => structuredClone(JUNK[Math.floor(rnd() * JUNK.length)]); // fresh copy: never share (or self-reference) a junk object
    const pick = keys => keys.length ? keys[Math.floor(rnd() * keys.length)] : null;
    const names = ['happy-path', 'missing-stop', 'orphan-stops', 'subagent-errors', 'compaction-restart', 'all-states', 'denied-headless', 'sequential-runs'];
    let mutated = 0;
    for (const name of names) {
      const src = lines(name).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      for (let round = 0; round < 40; round++) {
        const ls = src.map(rec => {
          const r = JSON.parse(JSON.stringify(rec));
          if (rnd() < 0.5) { const k = pick(Object.keys(r)); if (k) { r[k] = junk(); mutated++; } }
          if (r.forja && typeof r.forja === 'object' && !Array.isArray(r.forja) && rnd() < 0.5) { const k = pick(Object.keys(r.forja)); if (k) { r.forja[k] = junk(); mutated++; } }
          if (r.tool_input && typeof r.tool_input === 'object' && !Array.isArray(r.tool_input) && rnd() < 0.3) { const k = pick(Object.keys(r.tool_input)); if (k) { r.tool_input[k] = junk(); mutated++; } }
          return JSON.stringify(r);
        });
        const st = createState();
        let n = 0;
        for (const l of ls) applyLine(st, l, ++n);
        const snap = snapshot(st, at(2000));
        assert.ok(Array.isArray(snap.runs));
        JSON.stringify(snap);
      }
    }
    assert.ok(mutated > 1000);
  });
});

describe('parallel runs and interleaved projects', () => {
  test('two sessions stay separate, each with its own instances; cwd case differences do not split a run', () => {
    const { snap } = run('parallel-runs', 20);
    assert.equal(snap.runs.length, 2);
    const s = snap.runs.find(x => x.project === 'sample-project');
    const v = snap.runs.find(x => x.project === 'indigo-cove');
    assert.ok(inst(s, 'a-p1') && !inst(s, 'a-p2'));
    assert.ok(inst(v, 'a-p2') && !inst(v, 'a-p1'));
    assert.equal(s.counts.events, 7);
  });
});

describe('native tools and legacy names', () => {
  test('two Explore instances stay in the native group; two legacy reviewers are two Contraste instances', () => {
    const { r } = run('native-and-legacy', 30);
    assert.equal(r.native.length, 2);
    assert.equal(r.native.filter(i => i.type === 'Explore').length, 2);
    assert.equal(inst(r, 'a-ex1').state, STATES.TERMINADO);
    assert.equal(inst(r, 'a-ex2').state, STATES.TRABALHAR);
    const c = card(r, 'reviewer');
    assert.equal(c.instances.length, 2);
    assert.equal(c.detail, '2 instâncias em paralelo');
  });
});

describe('every roster state at once (screenshot fixture)', () => {
  test('states are distinguishable and the loudest one wins at run level', () => {
    const { r } = run('all-states', 1600);
    assert.equal(card(r, 'product-manager').state, STATES.BLOQUEADO);
    assert.equal(card(r, 'frontend-dev').state, STATES.TRABALHAR);
    assert.ok(card(r, 'frontend-dev').quiet > THRESHOLDS.QUIET_MS, 'quiet flag set after 90 s of silence');
    assert.equal(card(r, 'frontend-dev').detail, 'a comparar screenshots com o DESIGN.md');
    assert.equal(card(r, 'backend-dev').state, STATES.TRABALHAR);
    assert.equal(card(r, 'backend-dev').instances.length, 2);
    assert.equal(card(r, 'reviewer').state, STATES.TERMINADO);
    assert.equal(card(r, 'reviewer').detail, 'REJECT');
    assert.equal(card(r, 'lead').state, STATES.TRABALHAR);
    assert.equal(r.status, STATES.BLOQUEADO);
    assert.equal(r.openQuestions, 1);
    assert.equal(r.tasks.find(t => t.id === 'T1').attempts, 1);
    assert.equal(r.tasks.find(t => t.id === 'T1').verdicts[0].verdict, 'REJECT');
  });
  test('liveness thresholds: working → quiet → sem resposta → morto, purely from silence', () => {
    const l = lines('all-states');
    const stateAt = s => inst(reduceLines(upTo(l, s), at(s)).runs[0], 'a-f2').state;
    assert.equal(stateAt(1560), STATES.TRABALHAR);
    assert.equal(stateAt(1540.5 + 200), STATES.TRABALHAR); // quiet, still working
    assert.equal(stateAt(1540.5 + 6 * 60), STATES.SEM_RESPOSTA);
    assert.equal(stateAt(1540.5 + 31 * 60), STATES.MORTO);
    const mainAt = s => reduceLines(upTo(l, s), at(s)).runs[0].roster[0].state;
    assert.equal(mainAt(1600 + 5 * 60), STATES.TRABALHAR, 'main is alive while a subagent shows activity');
    assert.equal(mainAt(1600 + 12 * 60), STATES.SEM_RESPOSTA);
    assert.equal(mainAt(1600 + 40 * 60), STATES.MORTO);
  });
});

describe('incremental application equals batch replay', () => {
  test('applyLine one by one gives the same snapshot as reduceLines', () => {
    const l = lines('happy-path');
    const st = createState();
    let n = 0;
    for (const line of l) applyLine(st, line, ++n);
    const a = JSON.stringify(snapshot(st, at(225)));
    const b = JSON.stringify(reduceLines(l, at(225)));
    assert.equal(a, b);
  });
});

describe('real data smoke test', () => {
  test('replays data/events.jsonl without throwing and closes the known phantom reviewer', { skip: !existsSync(join(here, '..', 'data', 'events.jsonl')) }, () => {
    const text = readFileSync(join(here, '..', 'data', 'events.jsonl'), 'utf8');
    const snap = reduceLines(text.split('\n'), Date.now());
    assert.ok(snap.runs.length >= 1);
    for (const r of snap.runs) for (const c of r.roster) for (const i of c.instances) assert.notEqual(i.state, undefined);
    const all = snap.runs.flatMap(r => r.roster.flatMap(c => c.instances));
    const phantom = all.find(i => i.agentId === 'ab2662da98d671c01');
    if (phantom) assert.equal(phantom.state, STATES.TERMINADO);
  });
});

import { createState as cs2, applyLine as al2, snapshot as sn2 } from '../viewer/lib/state.mjs';
describe('CLI-only verdict events (no hand-back) reach the ledger', () => {
  test('task.done and task.fail from the CLI add reviews and never throw; --no-attempt returns the task to todo without a verdict', () => {
    const st = cs2();
    let t = Date.parse('2026-09-16T10:00:00Z'); let n = 0;
    const ev = (kind, forja) => { t += 1000; al2(st, JSON.stringify({ ts: new Date(t).toISOString(), session_id: 'cli-only-1', cwd: 'C:/p/x', project: 'x', hook_event_name: 'Forja', forja: { run_id: 'R-20260916-cli1', kind, ...forja } }), ++n); };
    ev('run.start', { goal: 'g', model_floor: 'fable' });
    ev('task.add', { id: 'T1', title: 'one', owner: 'backend-dev', complexity: 'hard' });
    ev('task.start', { id: 'T1', attempts: 1 });
    ev('task.fail', { id: 'T1', attempts: 0, why: 'sessão interrompida pelo limite', no_attempt: true });
    let r = sn2(st, t).runs[0];
    assert.equal(st.badLines, 0);
    assert.equal(r.tasks[0].status, 'todo'); assert.equal(r.tasks[0].attempts, 0); assert.equal(r.reviews.length, 0);
    ev('task.start', { id: 'T1', attempts: 1 });
    ev('task.fail', { id: 'T1', attempts: 1, why: 'segurança: token em claro', final: false });
    ev('task.start', { id: 'T1', attempts: 2 });
    ev('task.done', { id: 'T1', verdict: 'APPROVE — ok' });
    r = sn2(st, t).runs[0];
    assert.equal(st.badLines, 0, 'no line was dropped by the fail-safe handler');
    assert.equal(r.tasks[0].status, 'done');
    assert.deepEqual(r.reviews.map(v => [v.verdict, v.by]), [['REJECT', 'security-reviewer'], ['APPROVE', 'reviewer']]);
  });
});

describe('runner sessions replace each other', () => {
  test('a new runner.session ends the open subagents of the previous session (no ghosts), and records the Lead model', () => {
    const st = cs2();
    let t = Date.parse('2026-09-16T12:00:00Z'); let n = 0;
    const line = rec => al2(st, JSON.stringify({ ts: new Date(t += 1000).toISOString(), cwd: 'C:/p/y', project: 'y', ...rec }), ++n);
    const forja = (sid, kind, f) => line({ session_id: sid, hook_event_name: 'Forja', forja: { run_id: 'R-20260916-rs01', kind, ...f } });
    forja('s-old', 'run.start', { goal: 'g', model_floor: 'fable' });
    forja('s-old', 'runner.session', { phase: 'start', session_id: null, model: 'opus', note: 'runner arrancou' });
    forja('s-old', 'runner.session', { phase: 'task', task: 'T1', attempt: 1, session_id: 's-old' });
    line({ session_id: 's-old', hook_event_name: 'SubagentStart', agent_id: 'a-old-1', agent_type: 'backend-dev' });
    line({ session_id: 's-old', hook_event_name: 'PreToolUse', agent_id: 'a-old-1', agent_type: 'backend-dev', tool_name: 'Read', tool_input: { file_path: 'x' }, tool_use_id: 'u1' });
    let r = sn2(st, t).runs[0];
    assert.equal(r.roster.find(c => c.key === 'backend-dev').instances.filter(i => !i.endedAt).length, 1);
    forja('s-new', 'run.resume', { note: 'sessão s-new' });
    forja('s-new', 'runner.session', { phase: 'task', task: 'T1', attempt: 2, session_id: 's-new' });
    r = sn2(st, t + 40 * 60_000).runs[0];
    const old = r.roster.find(c => c.key === 'backend-dev').instances.find(i => i.agentId === 'a-old-1');
    assert.ok(old.endedAt, 'the previous session instance is closed');
    assert.equal(old.endReason, 'sessão substituída pelo runner');
    assert.notEqual(old.state, 'morto');
    assert.deepEqual(Object.keys(r.roster[0].models), ['opus'], 'Lead model recorded from the runner');
    assert.equal(st.badLines, 0);
  });
});

describe('a runner that stops is not "a trabalhar" forever', () => {
  const build = () => {
    const st = cs2();
    let t = Date.parse('2026-09-16T14:00:00Z'); let n = 0;
    const line = rec => al2(st, JSON.stringify({ ts: new Date(t += 1000).toISOString(), cwd: 'C:/p/z', project: 'z', ...rec }), ++n);
    const forja = (sid, kind, f) => line({ session_id: sid, hook_event_name: 'Forja', forja: { run_id: 'R-20260916-rd01', kind, ...f } });
    forja('cli', 'run.start', { goal: 'g', model_floor: 'fable' });
    forja('cli', 'runner.session', { phase: 'start', session_id: null, model: 'opus' });
    forja('cli', 'runner.session', { phase: 'task', task: 'T1', attempt: 1, session_id: 's-1' });
    line({ session_id: 's-1', hook_event_name: 'SessionStart', source: 'startup' });
    forja('s-1', 'run.resume', { note: 'sessão s-1' });
    forja('s-1', 'task.add', { id: 'T1', title: 'one', owner: 'backend-dev' });
    forja('s-1', 'task.start', { id: 'T1', attempts: 1 });
    line({ session_id: 's-1', hook_event_name: 'SessionEnd', reason: 'other' });
    return { st, forja, at: () => t };
  };
  const lead = (st, at) => sn2(st, at).runs[0].roster[0];
  test('killed runner: between sessions for a short gap, then sem resposta, then morto (run status follows)', () => {
    const { st, at } = build();
    assert.equal(lead(st, at() + 60_000).state, 'a trabalhar');
    assert.match(lead(st, at() + 60_000).detail, /entre sessões do runner/);
    assert.equal(lead(st, at() + 11 * 60_000).state, 'sem resposta');
    assert.equal(lead(st, at() + 31 * 60_000).state, 'morto');
    assert.equal(sn2(st, at() + 31 * 60_000).runs[0].status, 'morto');
    assert.equal(sn2(st, at() + 24 * 3600_000).runs[0].status, 'morto', 'a day later it is still morto, never a trabalhar');
  });
  test('runner.exit: the Sponsor is needed to relaunch, immediately and for good', () => {
    const { st, forja, at } = build();
    forja('cli', 'runner.exit', { why: 'limite de 60 sessões' });
    const l = lead(st, at() + 10_000);
    assert.equal(l.state, 'precisa do Sponsor'); assert.match(l.detail, /relançar/);
    assert.equal(sn2(st, at() + 6 * 3600_000).runs[0].status, 'precisa do Sponsor');
  });
  test('a paused run stays em pausa until the promised resume time (+10 min); past it the Sponsor is needed; a new session clears it', () => {
    const { st, forja, at } = build();
    forja('cli', 'run.pause', { reason: 'limite de utilização', resume_at: new Date(at() + 3 * 3600_000).toISOString(), message: 'x' });
    assert.equal(lead(st, at() + 2 * 3600_000).state, 'em pausa');
    assert.equal(sn2(st, at() + 2 * 3600_000).runs[0].status, 'em pausa');
    assert.equal(lead(st, at() + 3 * 3600_000 + 9 * 60_000).state, 'em pausa', 'inside the margin it is still a pause');
    const late = lead(st, at() + 3 * 3600_000 + 11 * 60_000);
    assert.equal(late.state, 'precisa do Sponsor'); assert.match(late.detail, /não voltou/);
    assert.equal(sn2(st, at() + 24 * 3600_000).runs[0].status, 'precisa do Sponsor', 'a day later it still asks for the Sponsor, never em pausa');
    forja('cli', 'run.unpause', { note: 'retomou' });
    forja('cli', 'runner.session', { phase: 'task', task: 'T1', attempt: 1, session_id: 's-2' });
    assert.equal(lead(st, at() + 5_000).state, 'a trabalhar');
  });
});

import { createState as cs3, applyLine as al3, snapshot as sn3 } from '../viewer/lib/state.mjs';
describe('forjalvl of a run in the viewer', () => {
  const line = (t, forja) => JSON.stringify({ ts: new Date(t).toISOString(), session_id: 'lvl-1', cwd: 'C:/p/x', project: 'x', hook_event_name: 'Forja', forja });
  const replay = (fields, more = []) => {
    const st = cs3();
    let t = Date.parse('2026-09-16T14:00:00Z');
    al3(st, line(t, { run_id: 'R-20260916-lvl1', kind: 'run.start', goal: 'g', model_floor: 'fable', ...fields }), 1);
    more.forEach((f, i) => al3(st, line(t + (i + 1) * 1000, { run_id: 'R-20260916-lvl1', ...f }), i + 2));
    return { r: sn3(st, t).runs[0], st };
  };
  test('run.start carries the forjalvl (new name and old); an old event without it reads as max', () => {
    const { r, st } = replay({ forjalvl: 'eco', model_level: 'eco' });
    assert.equal(st.badLines, 0);
    assert.equal(r.forja.forjalvl, 'eco');
    assert.equal(r.forja.modelLevel, 'eco', 'modelLevel is kept as an alias of forjalvl in the snapshot');
    assert.equal(r.forja.modelFloor, 'fable', 'the floor is untouched');
    assert.equal(replay({}).r.forja.forjalvl, 'max', 'runs recorded before this feature');
    assert.equal(replay({}).r.forja.modelLevel, 'max');
    assert.equal(replay({ model_level: 'high' }).r.forja.forjalvl, 'high', 'an event recorded before the rename still reads');
    assert.equal(replay({ forjalvl: 'high' }).r.forja.forjalvl, 'high');
    assert.equal(replay({ forjalvl: 'eco', model_level: 'high' }).r.forja.forjalvl, 'eco', 'the new name wins when both are there');
    assert.equal(replay({ model_level: { a: 1 } }).r.forja.forjalvl, 'max', 'a malformed value falls back, never throws');
    assert.equal(replay({ forjalvl: { a: 1 } }).r.forja.forjalvl, 'max');
  });
  test('runner.session also carries the forjalvl; an event without it keeps what was known', () => {
    assert.equal(replay({ forjalvl: 'max' }, [{ kind: 'runner.session', phase: 'plan', session_id: 's1', forjalvl: 'eco', model_level: 'eco' }]).r.forja.forjalvl, 'eco');
    assert.equal(replay({ forjalvl: 'max' }, [{ kind: 'runner.session', phase: 'plan', session_id: 's1', model_level: 'high' }]).r.forja.forjalvl, 'high', 'old name accepted');
    assert.equal(replay({ forjalvl: 'eco' }, [{ kind: 'runner.session', phase: 'plan', session_id: 's1' }]).r.forja.forjalvl, 'eco', 'no forjalvl in the event: the run keeps the one it had');
  });
});

describe('autonomy of a run in the viewer', () => {
  const line = (t, forja) => JSON.stringify({ ts: new Date(t).toISOString(), session_id: 'aut-1', cwd: 'C:/p/x', project: 'x', hook_event_name: 'Forja', forja });
  const replay = (fields, more = []) => {
    const st = cs3();
    const t = Date.parse('2026-09-17T06:00:00Z');
    al3(st, line(t, { run_id: 'R-20260917-aut1', kind: 'run.start', goal: 'g', model_floor: 'fable', ...fields }), 1);
    more.forEach((f, i) => al3(st, line(t + (i + 1) * 1000, { run_id: 'R-20260917-aut1', ...f }), i + 2));
    return { r: sn3(st, t).runs[0], st };
  };
  test('run.start carries the autonomy; a run recorded before this feature reads as normal', () => {
    const { r, st } = replay({ autonomy: 'total' });
    assert.equal(st.badLines, 0);
    assert.equal(r.forja.autonomy, 'total');
    assert.equal(r.forja.forjalvl, 'max', 'the forjalvl is untouched');
    assert.equal(replay({}).r.forja.autonomy, 'normal', 'runs recorded before this feature');
    assert.equal(replay({ autonomy: 'normal' }).r.forja.autonomy, 'normal');
    assert.equal(replay({ autonomy: { a: 1 } }).r.forja.autonomy, 'normal', 'a malformed value falls back, never throws');
    // Only the two values exist: anything else — a tampered event, a stream
    // from a later version, a corrupted field — reads as the strict one. The
    // UI must never announce more freedom than the Sponsor gave.
    for (const v of ['liberdade a sério', 'completa', 'TOTAL', 'constructor', '', 0, true])
      assert.equal(replay({ autonomy: v }).r.forja.autonomy, 'normal', JSON.stringify(v));
    assert.equal(replay({ autonomy: 'total', forjalvl: 'eco' }).r.forja.forjalvl, 'eco', 'the two travel together and neither overwrites the other');
  });
  test('runner.session also carries the autonomy; an event without it keeps what was known', () => {
    assert.equal(replay({ autonomy: 'normal' }, [{ kind: 'runner.session', phase: 'plan', session_id: 's1', autonomy: 'total' }]).r.forja.autonomy, 'total');
    assert.equal(replay({ autonomy: 'total' }, [{ kind: 'runner.session', phase: 'plan', session_id: 's1' }]).r.forja.autonomy, 'total', 'no autonomy in the event: the run keeps the one it had');
    assert.equal(replay({}, [{ kind: 'runner.session', phase: 'start', session_id: null, autonomy: 'total' }]).r.forja.autonomy, 'total', 'the runner\'s start event alone is enough');
  });
});

// ---------- T-VIS-2: fim de turno de uma sessão do runner (incidente real, 17 set 2026) ----------
describe('runner sessions: ending the turn is the end of a phase, not a ticket for the Sponsor', () => {
  // Fixture built from the real stream of the granite run (session
  // 3dc453de-…, task T4): `runner.session` emitted from the previous session
  // with the id of the visible one, and the `Stop` hook of that visible session.
  const ls = lines('runner-visible-turn-end');
  test('the session that ended its turn under the runner reads as "entre sessões do runner"', () => {
    const snap = reduceLines(upTo(ls, 90), at(90));
    const r = snap.runs[0];
    assert.equal(snap.badLines, 0);
    assert.equal(r.forja.status, 'running', 'the run is still going');
    const lead = card(r, 'lead');
    assert.equal(lead.state, STATES.TRABALHAR, JSON.stringify(lead));
    assert.match(lead.detail, /entre sessões do runner \(última: task T4\)/);
    assert.equal(r.status, STATES.TRABALHAR);
    for (const text of [JSON.stringify(lead), JSON.stringify(r.status), String(r.detail)])
      assert.equal(/terminou o turno com o run em curso/.test(text), false, 'o bilhete do terminal não aparece em modo runner');
    assert.notEqual(lead.state, STATES.SPONSOR);
  });
  test('the same silence still escalates: it is evidence, never a promise', () => {
    const deadS = 60 + THRESHOLDS.DEAD_MS / 1000 + 60;
    const quietS = 60 + THRESHOLDS.MAIN_UNRESPONSIVE_MS / 1000 + 60;
    assert.equal(card(reduceLines(upTo(ls, quietS), at(quietS)).runs[0], 'lead').state, STATES.SEM_RESPOSTA);
    assert.equal(card(reduceLines(upTo(ls, deadS), at(deadS)).runs[0], 'lead').state, STATES.MORTO);
  });
  test('it holds when the runner.session lands in another run object (stream read from the middle)', () => {
    // What the real stream looks like to a viewer that starts mid-run: the
    // `run.start` is out of the window, so the session that emitted
    // `runner.session` is a run object of its own and the phase session keys the
    // run by itself. The index of launched sessions is what keeps them together.
    const mid = ls.filter(l => !l.includes('"run.start"'));
    const snap = reduceLines(upTo(mid, 90), at(90));
    const r = snap.runs.find(x => x.sessions.includes('3dc453de-521a-46f0-9b31-6265f2e5a242'));
    const lead = card(r, 'lead');
    assert.equal(lead.state, STATES.TRABALHAR, JSON.stringify(lead));
    assert.match(lead.detail, /entre sessões do runner/);
  });
  test('a later INTERACTIVE session in the same run still raises the ticket: only the launched session is a runner session', () => {
    // The Sponsor killed the runner by hand and opened `claude` himself on the
    // same run. The run has seen `runner.session` events, but this session was
    // never launched by the runner: the end of his turn is his to deal with.
    const SPONSOR = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
    const line = (offS, fields) => JSON.stringify({ ts: new Date(BASE + offS * 1000).toISOString(), project: 'sample-project', session_id: SPONSOR, cwd: 'C:\dev\examples\sample-project', permission_mode: 'auto', ...fields });
    const mixed = [...ls.filter(l => l.trim()),
      line(200, { hook_event_name: 'SessionStart', source: 'startup' }),
      line(201, { hook_event_name: 'UserPromptSubmit', prompt: 'continua o run à mão' }),
      line(202, { hook_event_name: 'Forja', forja: { kind: 'run.resume', run_id: 'run-0001-aaaa-bbbb-cccc-000000000001', note: 'sessão do Sponsor' } }),
      line(260, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'parei aqui, diz-me o que queres a seguir' }),
    ];
    const r = reduceLines(upTo(mixed, 290), at(290)).runs.find(x => x.sessions.includes(SPONSOR));
    const lead = card(r, 'lead');
    assert.equal(lead.state, STATES.SPONSOR, JSON.stringify(lead));
    assert.equal(lead.detail, 'terminou o turno com o run em curso');
  });
  test('without the runner.session event the same stream is a real ticket for the Sponsor', () => {
    // The control: an interactive session of the Sponsor that ends its turn with
    // a run open is still «só se resolve no terminal».
    const alone = ls.filter(l => !l.includes('"runner.session"'));
    const lead = card(reduceLines(upTo(alone, 90), at(90)).runs[0], 'lead');
    assert.equal(lead.state, STATES.SPONSOR);
    assert.equal(lead.detail, 'terminou o turno com o run em curso');
  });
});

// T-UI-9. O seletor do viewer mostrava lado a lado runs e «sessões soltas». Com
// três runs vivos a emitir eventos, o Sponsor leu duas dessas linhas («terminado
// há 3 h 50», «à espera de input há 4 h») como se fossem os runs e concluiu que
// estavam todos parados. Duas verdades separadas: uma sessão que CARIMBA o
// run_id pertence ao run (as sessões de fase do runner nunca correm `run
// start`/`run resume`, mas carimbam-no em `task.*`, `run.checkpoint` e
// `runner.session`), e só uma sessão sem run_id nenhum é solta.
describe('runs verdadeiros e sessões soltas (T-UI-9)', () => {
  const NOW = 28820; // 20 s depois do último evento do fixture
  test('a sessão de fase que só carimba o run_id é absorvida pelo run; solta é só quem nunca o emite', () => {
    const { snap } = run('loose-sessions', NOW);
    assert.equal(snap.runs.length, 5, 'três runs e duas sessões soltas — as sessões de fase não contam à parte');
    assert.deepEqual(snap.runs.map(r => [r.kind, r.project, r.status]), [
      ['run', 'granite', STATES.TRABALHAR],
      ['run', 'juniper-hill', STATES.TRABALHAR],
      ['run', 'violet-pier', STATES.TRABALHAR],
      ['session', 'forja', STATES.TERMINADO],
      ['session', 'forja', STATES.ESPERA_INPUT],
    ]);
    const gear = snap.runs[0];
    assert.deepEqual(gear.sessions, ['gran-run0-aaaa-bbbb-cccc-000000000010', 'gear-fase-aaaa-bbbb-cccc-000000000011'],
      'a sessão de fase entra no run, não fica como objeto à parte');
    assert.equal(gear.tasks[0].status, 'done', 'e o que ela fez conta para o run: T1 fechada');
    assert.equal(snap.runs.filter(r => r.kind === 'session' && r.project !== 'forja').length, 0,
      'nos projetos com run não sobra nenhuma «sessão sem run»');
    const vs = snap.runs.find(r => r.id.startsWith('forj-vsc0'));
    const ler = snap.runs.find(r => r.id.startsWith('forj-ler0'));
    assert.equal(vs.interactive, true, 'alguém escreveu mesmo nesta sessão: é interativa');
    assert.equal(ler.interactive, false, 'esta só leu; ninguém lhe escreveu um prompt');
    assert.equal(vs.runId, null, 'uma sessão solta não tem run_id nenhum');
    assert.equal(Math.round((at(NOW) - ler.lastEventAt) / 60000), 230, 'calou-se há 3 h 50');
    assert.equal(Math.round((at(NOW) - vs.lastEventAt) / 60000), 240, 'calou-se há 4 h');
  });
  test('o run_id é prova de pertença venha no evento que vier — task.*, run.checkpoint ou runner.session', () => {
    const st = createState();
    const line = (s, session, fields) => applyLine(st, JSON.stringify({ ts: new Date(at(s)).toISOString(), project: 'alfa', session_id: session, cwd: 'C:\\p\\alfa', ...fields }), 1);
    line(0, 'sess-run', { hook_event_name: 'SessionStart', source: 'startup' });
    line(1, 'sess-run', { hook_event_name: 'Forja', forja: { kind: 'run.start', run_id: 'R-alfa', goal: 'x' } });
    // a sessão de fase: nunca anuncia nada, só carimba o run_id no que faz
    line(10, 'sess-fase', { hook_event_name: 'SessionStart', source: 'startup' });
    line(11, 'sess-fase', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 't1' });
    line(12, 'sess-fase', { hook_event_name: 'Forja', forja: { kind: 'task.start', run_id: 'R-alfa', id: 'T1', attempts: 1 } });
    const snap = snapshot(st, at(20));
    assert.equal(snap.runs.length, 1, 'um run só');
    assert.deepEqual(snap.runs[0].sessions, ['sess-run', 'sess-fase']);
    assert.equal(snap.runs[0].kind, 'run');
    assert.equal(snap.runs[0].tasks[0].id, 'T1', 'o que a sessão de fase fez conta para o run');
  });
  test('a escolha por omissão é um run ativo, mesmo quando a sessão solta é a mais recente de todas', () => {
    const st = createState();
    const line = (s, session, cwd, fields) => applyLine(st, JSON.stringify({ ts: new Date(at(s)).toISOString(), project: cwd.split('\\').pop(), session_id: session, cwd, ...fields }), 1);
    line(0, 'sess-run', 'C:\\p\\alfa', { hook_event_name: 'SessionStart', source: 'startup' });
    line(1, 'sess-run', 'C:\\p\\alfa', { hook_event_name: 'Forja', forja: { kind: 'run.start', run_id: 'R-alfa', goal: 'x' } });
    line(10, 'sess-run', 'C:\\p\\alfa', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' }, tool_use_id: 't1' });
    line(100, 'sess-solta', 'C:\\p\\beta', { hook_event_name: 'SessionStart', source: 'startup' });
    line(101, 'sess-solta', 'C:\\p\\beta', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'b' }, tool_use_id: 't2' });
    const snap = snapshot(st, at(110));
    assert.deepEqual(snap.runs.map(r => r.kind), ['session', 'run'], 'a sessão solta é mesmo a mais recente');
    assert.equal(snap.current, 'R-alfa', 'a escolha por omissão salta-a');
  });
  test('sem um único run, a página tem de mostrar alguma coisa: a sessão mais recente, dita como sessão', () => {
    const { snap } = run('native-and-legacy', 30);
    assert.deepEqual(snap.runs.map(r => r.kind), ['session']);
    assert.equal(snap.current, snap.runs[0].id);
  });
  test('`run start` sem run_id continua a ser um run: o que conta é ter-se anunciado', () => {
    const st = createState();
    const rec = (s, fields) => applyLine(st, JSON.stringify({ ts: new Date(at(s)).toISOString(), project: 'p', session_id: 'sem-id', cwd: 'C:\\p', ...fields }), 1);
    rec(0, { hook_event_name: 'SessionStart', source: 'startup' });
    rec(1, { hook_event_name: 'Forja', forja: { kind: 'run.start', goal: 'sem run_id' } });
    const snap = snapshot(st, at(5));
    assert.equal(snap.runs[0].kind, 'run');
  });
});
