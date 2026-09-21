#!/usr/bin/env node
// A stand-in for `claude` in VISIBLE mode (`--bg`), for test/runner.test.mjs.
// It emulates exactly the four calls lib/runner.mjs makes in that mode, as the
// Technology Scout described them in docs/forja/TECHNOLOGY.md §S2:
//
//   <cmd> --bg --model … --name "forja <run> <fase>"   (prompt on stdin)
//        → registers a background session and prints `backgrounded · <id8> · <name>`
//   <cmd> agents --json --cwd <project>
//        → the sessions as JSON (sessionId, name, state, pid, waitingFor);
//          each call advances the little state machine one step
//   <cmd> stop <id> / <cmd> rm <id>
//        → recorded in stops.log so a test can assert the cleanup happened
//
// The "work" of a phase (what the real Lead session would do) happens when a
// session reaches `done`: it drives the real `forja` CLI in the project folder
// and writes a transcript `~/.claude/projects/<slug>/<sessionId>.jsonl` with the
// phase's summary line, the same file lib/runner.mjs reads back.
//
// Env: FAKE_STATE_DIR (required, where sessions.json and stops.log live),
// FORJA_VISIBLE_HOME (fake home for the transcripts), FAKE_HANG / FAKE_BLOCKED /
// FAKE_LIMIT_WAIT (regexes matched against the session name: never finish /
// end blocked / wait on a usage limit), FAKE_WORKING_POLLS (polls spent
// `working` before the terminal state, default 1), and the three shapes of the
// 17 set 2026 incident (T-VIS-2), all of them sessions that NEVER reach a
// terminal state: FAKE_IDLE_DONE (does the phase, writes the whole transcript
// and then sits at `state: working, status: idle` for ever — exactly what
// `claude agents` said for 25+ min about the real session 3dc453de-…),
// FAKE_IDLE_QUIET (`idle` with a transcript that ends mid-turn, in a tool call:
// there is no answer yet and the runner must keep waiting) and FAKE_STOP_HOOK
// (does the phase and lets Forja's own hook write the `Stop` in
// data/events.jsonl, while `claude agents` keeps saying `working/busy`) and
// FAKE_LIMIT_WAIT_IDLE (a usage-limit wait reported as `idle`, whose transcript
// ends in the limit line: a finished turn to look at, a session that is coming
// back by itself in truth).
// FAKE_BG_SUBAGENT (T-VIS-3, the shape of the 17 set 2026 incident in
// velora-poker): the Lead launches a subagent IN THE BACKGROUND — `SubagentStart`
// in data/events.jsonl, «Async agent launched successfully … agentId: …» as the
// tool result in the transcript — says «… is running on T1. Waiting for the
// hand-back.» (no phase marker) and ends its turn: the hook writes `Stop` with
// `background_tasks: [{ type: "subagent", status: "running" }]` while
// `claude agents` sits at `working/idle` for ever. FAKE_BG_SUBAGENT_POLLS (5)
// polls later the subagent hands back (`SubagentStop`, the retrieval in the
// transcript), the Lead goes on working for FAKE_BG_SUBAGENT_AFTER polls (one
// `PostToolUse` each, as it writes the report and calls the Reviewer) and only
// then does the work and ends its turn again, now with the marker; with
// FAKE_BG_SUBAGENT_STUCK it never comes back and only the watchdog may end the
// phase.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', 'bin', 'forja.mjs');
const dir = process.env.FAKE_STATE_DIR;
if (!dir) { console.error('fake-claude-bg: falta FAKE_STATE_DIR'); process.exit(2); }
mkdirSync(dir, { recursive: true });
const statePath = join(dir, 'sessions.json');
const stopsPath = join(dir, 'stops.log');
const read = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return []; } };
const write = s => writeFileSync(statePath, JSON.stringify(s, null, 2));
const hits = (re, name) => Boolean(re) && new RegExp(re).test(name);

const argv = process.argv.slice(2);

// ---------- claude stop <id curto> / claude rm <id curto> ----------
// Like the real thing (2.1.274): ONLY the short id works. With the uuid it
// answers "No job matching" and the session stays alive.
if (argv[0] === 'stop' || argv[0] === 'rm') {
  const id = argv[1] || '';
  const s = read();
  const hit = s.find(e => e.id === id);
  if (!hit) {
    appendFileSync(stopsPath, `recusado ${argv[0]} ${id}\n`);
    console.error(`No job matching "${id}"`);
    process.exit(1);
  }
  appendFileSync(stopsPath, `${argv[0]} ${id}\n`);
  if (argv[0] === 'stop') { hit.state = 'stopped'; hit.status = 'idle'; write(s); }
  else write(s.filter(e => e.id !== id));
  process.exit(0);
}

// ---------- claude agents --json --cwd <project> ----------
if (argv[0] === 'agents') {
  const s = read();
  for (const e of s) {
    if (e.state !== 'working') continue;
    if (!e.prompt) continue; // a session seeded by a test (an orphan of a previous runner): it just sits there
    e.polls = (e.polls || 0) + 1;
    // A session that hangs, waits on a usage limit or ends blocked still got as
    // far as opening its task — that is what makes it a failed attempt.
    const idleDone = hits(process.env.FAKE_IDLE_DONE, e.name);
    const idleQuiet = hits(process.env.FAKE_IDLE_QUIET, e.name);
    const stopHook = hits(process.env.FAKE_STOP_HOOK, e.name);
    const bgSub = hits(process.env.FAKE_BG_SUBAGENT, e.name);
    // FAKE_LIMIT_WAIT_IDLE: the same wait, but the daemon reports `idle` — the
    // shape of the real gearlift transcript 2fbad91c-… (the limit line is the
    // last `assistant` text, no tool call after it, the session continues by
    // itself hours later). It must never read as a finished phase.
    const limitWait = hits(process.env.FAKE_LIMIT_WAIT, e.name) || hits(process.env.FAKE_LIMIT_WAIT_IDLE, e.name);
    if (limitWait || hits(process.env.FAKE_HANG, e.name) || hits(process.env.FAKE_BLOCKED, e.name) || idleDone || idleQuiet || stopHook || bgSub) startTask(e);
    if (limitWait) {
      if (!e.done1) { e.done1 = true; writeTranscript(e, ["You've hit your session limit · resets 5:30pm (Europe/Lisbon)"]); }
      if (hits(process.env.FAKE_LIMIT_WAIT_IDLE, e.name)) e.status = 'idle';
      continue;
    }
    if (hits(process.env.FAKE_HANG, e.name)) continue;
    // The three sessions of T-VIS-2: the turn ends (or does not) while the state
    // stays `working` for ever. `status` is what a reader has left to go on.
    if (idleQuiet) { if (!e.done1) { e.done1 = true; writeTranscript(e, [], { midTurn: true }); } e.status = 'idle'; continue; }
    // T-VIS-3: the turn ends with a subagent still working in the background.
    if (bgSub) {
      if (!e.bgLaunched) {
        e.bgLaunched = true;
        e.agentId = `a${e.id}beef4321`;
        appendEvent(e, { hook_event_name: 'SubagentStart', agent_id: e.agentId, agent_type: 'backend-dev' });
        writeTranscript(e, ['Backend Dev is running on the task. Waiting for the hand-back.'], { launch: e.agentId });
        writeStopEvent(e, {
          message: 'Backend Dev is running on the task. Waiting for the hand-back.',
          backgroundTasks: [{ id: e.agentId, type: 'subagent', status: 'running', description: 'o subagente em fundo', agent_type: 'backend-dev' }],
        });
      } else if (!e.bgBack && !process.env.FAKE_BG_SUBAGENT_STUCK && e.polls >= Number(process.env.FAKE_BG_SUBAGENT_POLLS || 5)) {
        // The hand-back: the subagent stops and its report reaches the Lead.
        e.bgBack = true; e.bgBackPoll = e.polls;
        appendEvent(e, { hook_event_name: 'SubagentStop', agent_id: e.agentId, stop_hook_active: false });
        writeTranscript(e, [], { retrieval: e.agentId });
      } else if (e.bgBack && !e.bgDone) {
        // …and the Lead goes on working — writes the report, calls the Reviewer,
        // commits — for FAKE_BG_SUBAGENT_AFTER polls before ending the phase.
        // Measured in the velora transcript b48d3201-…: 4 min 08 s, 1 min 27 s and
        // 1 min 35 s between a hand-back and the next launch. That first `Stop`
        // must not end the phase now that the subagent is back.
        if (e.polls < e.bgBackPoll + Number(process.env.FAKE_BG_SUBAGENT_AFTER || 0)) {
          appendEvent(e, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { description: 'o Lead a trabalhar depois do hand-back' } });
        } else {
          e.bgDone = true;
          work(e);                                  // the phase's real work, and the line with the marker
          writeStopEvent(e, { message: 'a fase acabou o turno', backgroundTasks: [] });
        }
      }
      e.status = 'idle';                            // `state` never leaves `working`, like the real one
      continue;
    }
    if (idleDone || stopHook) {
      if (!e.done1) { e.done1 = true; work(e); if (stopHook) writeStopEvent(e); }
      e.status = stopHook ? 'busy' : 'idle';
      continue;
    }
    if (e.polls < Number(process.env.FAKE_WORKING_POLLS || 1)) continue;
    if (hits(process.env.FAKE_BLOCKED, e.name)) { e.state = 'blocked'; e.waitingFor = 'permissão: Write(C:/fora-do-repo/x.txt)'; continue; }
    e.state = work(e) ? 'done' : 'failed';
  }
  write(s);
  // The measured shape of `claude agents --json` (2.1.274), field by field.
  console.log(JSON.stringify(s.map(e => ({
    pid: e.pid, id: e.id, cwd: e.cwd, kind: e.kind || 'background', startedAt: e.startedAt || '2026-09-17T05:00:00.000Z',
    sessionId: e.sessionId, name: e.name, status: e.status || (e.state === 'working' ? 'busy' : e.state === 'blocked' ? 'waiting' : 'idle'),
    state: e.state, waitingFor: e.waitingFor || null,
  })), null, 2));
  process.exit(0);
}

// ---------- claude --bg … (the launch) ----------
if (argv.includes('--bg')) {
  if (argv.includes('-p') || argv.includes('--output-format') || argv.includes('--session-id')) {
    console.error('fake-claude-bg: --bg não aceita -p / --output-format / --session-id');
    process.exit(2);
  }
  const name = argv[argv.indexOf('--name') + 1] || '';
  const prompt = readFileSync(0, 'utf8');
  const sessionId = randomUUID();
  const id = sessionId.slice(0, 8); // the short id: the first hex group of the uuid
  // Evidence for the tests: the exact command line, and the size of the prompt
  // that came on stdin (over the 8191 characters cmd.exe would allow).
  appendFileSync(join(dir, 'launches.log'), `${JSON.stringify(argv)}\t${Buffer.byteLength(prompt)}\n`);
  const s = read();
  s.push({ sessionId, id, name, kind: 'background', state: 'working', pid: process.pid, waitingFor: null, cwd: process.cwd(), startedAt: new Date().toISOString(), polls: 0, prompt });
  write(s);
  console.log(`backgrounded · ${id} · ${name}`);
  process.exit(0);
}

console.error(`fake-claude-bg: chamada inesperada: ${argv.join(' ')}`);
process.exit(2);

// ---------- what a phase session does ----------
function startTask(entry) {
  const t = String(entry.prompt || '').match(/PHASE: TASK (T\w+)/);
  if (!t || entry.started) return;
  entry.started = true;
  spawnSync(process.execPath, [CLI, 'task', 'start', t[1]], { cwd: entry.cwd, encoding: 'utf8', env: process.env });
}

function work(entry) {
  const forja = args => spawnSync(process.execPath, [CLI, ...args], { cwd: entry.cwd, encoding: 'utf8', env: process.env });
  const p = String(entry.prompt || '');
  const say = line => { writeTranscript(entry, [line]); return true; };
  if (/PHASE: PLAN/.test(p)) {
    forja(['task', 'add', '--id', 'T1', '--owner', 'backend-dev', '--title', 'uma', '--complexity', 'easy']);
    return say('PLAN OK 1 tasks');
  }
  const t = p.match(/PHASE: TASK (T\w+)/);
  if (t) {
    forja(['task', 'start', t[1]]);
    forja(['task', 'review', t[1]]);
    forja(['task', 'done', t[1], '--verdict', 'APPROVE']);
    return say(`TASK ${t[1]} done`);
  }
  if (/PHASE: CLOSE/.test(p)) { forja(['run', 'finish', '--note', 'fake']); return say('RUN CLOSED'); }
  return say('(nada a fazer)');
}

// The transcript Claude Code keeps per session. Capitalisation of the project
// slug varies in the real thing, and there are always other projects next to it:
// both are reproduced here so the runner's search really has to look around.
// The `Stop` hook event Forja's own hook writes at the end of every turn, in the
// exact shape the real one has (data/events.jsonl, one JSON object per line).
function writeStopEvent(entry, { message = 'a fase acabou o turno', backgroundTasks = [] } = {}) {
  appendEvent(entry, {
    hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: message,
    background_tasks: backgroundTasks, session_crons: [],
  });
}
// Any hook event of this session, in the shape the real hook writes them
// (`data/events.jsonl`, one JSON object per line).
function appendEvent(entry, fields) {
  const dir = process.env.FORJA_DATA_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), project: 'proj', session_id: entry.sessionId, cwd: entry.cwd, ...fields,
  }) + '\n');
}

function writeTranscript(entry, texts, { midTurn = false, launch = null, retrieval = null } = {}) {
  const home = process.env.FORJA_VISIBLE_HOME;
  if (!home) return;
  const base = join(home, '.claude', 'projects');
  for (const d of ['C--Outro-Projeto-Qualquer', 'd--Fake-Projeto-Do-Teste']) mkdirSync(join(base, d), { recursive: true });
  const path = join(base, 'd--Fake-Projeto-Do-Teste', `${entry.sessionId}.jsonl`);
  const lines = [
    // Everything that is NOT an assistant text block of the main thread must be
    // ignored by the reader: the prompt, thinking, tool calls and the sidechains
    // (subagents) — including a verdict that quotes the usage-limit sentence.
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'o prompt do runner (não conta como resposta)' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'a pensar alto, não é resposta' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git status' } }] } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: "REJECT — o Dev escreveu \"You've hit your session limit, resets at 3pm\" no relatório" }] } }),
    // An `Agent` launched in the background: the tool answers at once, exactly
    // as measured in the velora transcript b48d3201-… (T-VIS-3).
    ...(launch ? [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tuA', name: 'Agent', input: { subagent_type: 'backend-dev', description: 'T1 · Backend Dev: a task' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tuA', content: [{ type: 'text', text: `Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${launch} (internal ID - do not mention to user.)\nThe agent is working in the background.` }] }] } }),
    ] : []),
    // …and the hand-back that arrives later, in the same shape.
    ...(retrieval ? [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tuA', content: `<retrieval_status>success</retrieval_status>\n\n<task_id>${retrieval}</task_id>\n\n<task_type>local_agent</task_type>\n\n<status>completed</status>` }] } }),
    ] : []),
    ...texts.map(text => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })),
    // A transcript cut mid-turn: the model called a tool and the result came
    // back, so the last turn is a `user` one — there is no answer yet.
    ...(midTurn ? [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'vou correr os testes' }, { type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'npm test' } }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'ok' }] } }),
      JSON.stringify({ type: 'system', subtype: 'post_tool', content: 'ruído que não é um turno' }),
    ] : []),
    '{ isto não é json',
  ];
  appendFileSync(path, lines.join('\n') + '\n');
  if (!existsSync(path)) throw new Error('transcript não escrito');
}
