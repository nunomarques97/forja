#!/usr/bin/env node
// Generates the replay fixtures in test/fixtures/*.jsonl — one stream per
// failure mode from docs/ARCHITECTURE.md §8. Deterministic (fixed base time)
// so the files can be committed and also served to the viewer for
// screenshots of every state (EVENTS_FILE=test/fixtures/<name>.jsonl).
//
//   node test/fixtures/build-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const BASE = Date.parse('2026-09-17T09:00:00.000Z');
const CWD = 'C:\\dev\\examples\\sample-project';
const CWD_LOWER = 'c:\\dev\\examples\\sample-project';
const S1 = 'run-0001-aaaa-bbbb-cccc-000000000001';
const S2 = 'run-0002-aaaa-bbbb-cccc-000000000002';

let seq = 0;
export function ev(offsetS, fields, { session = S1, cwd = CWD } = {}) {
  seq += 1;
  const rec = { ts: new Date(BASE + offsetS * 1000).toISOString(), project: cwd.split(/[\\/]/).pop(), session_id: session, cwd, permission_mode: 'auto', ...fields };
  return JSON.stringify(rec);
}
const toolUse = (n) => `toolu_${String(n).padStart(6, '0')}`;

// Building blocks --------------------------------------------------------
function agentCall(off, { id, type, desc, model = 'fable', background = false, durationS = null, resolved = 'claude-fable-5-1', status = 'completed', tu }) {
  const lines = [];
  lines.push(ev(off, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: type, model, description: desc, prompt: `Modelo: ${model}. ${desc}`, run_in_background: background }, tool_use_id: tu }));
  if (background) lines.push(ev(off + 0.2, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: type, model, description: desc, run_in_background: true }, tool_response: { isAsync: true, status: 'async_launched', agentId: id, resolvedModel: resolved }, tool_use_id: tu, duration_ms: 5 }));
  return lines;
}
function agentDone(off, { id, type, desc, model = 'fable', resolved = 'claude-fable-5-1', durationS, tu, status = 'completed' }) {
  return [ev(off, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: type, model, description: desc, run_in_background: false }, tool_response: { status, agentId: id, agentType: type, resolvedModel: resolved, totalDurationMs: durationS * 1000 }, tool_use_id: tu, duration_ms: durationS * 1000 })];
}
const subStart = (off, id, type) => ev(off, { hook_event_name: 'SubagentStart', agent_id: id, agent_type: type });
const subStop = (off, id, type, msg, extra = {}) => ev(off, { hook_event_name: 'SubagentStop', agent_id: id, agent_type: type, last_assistant_message: msg, stop_hook_active: false, ...extra });
const subTool = (off, id, type, tool, input, post = true) => {
  const tu = toolUse(900 + seq); // one id for the Pre/Post pair (seq moves inside ev())
  return [
    ev(off, { hook_event_name: 'PreToolUse', agent_id: id, agent_type: type, tool_name: tool, tool_input: input, tool_use_id: tu }),
    ...(post ? [ev(off + 0.5, { hook_event_name: 'PostToolUse', agent_id: id, agent_type: type, tool_name: tool, tool_input: input, tool_response: { ok: true }, tool_use_id: tu, duration_ms: 500 })] : []),
  ];
};
const handback = (off, id, type, message) => ev(off, { hook_event_name: 'PostToolUse', agent_id: id, agent_type: type, tool_name: 'SubagentHandback', tool_input: { message }, tool_response: {}, tool_use_id: toolUse(800 + seq), duration_ms: 3 });
const mainTool = (off, tool, input) => ev(off, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: toolUse(seq) });
const forja = (off, kind, fields, session = S1) => ev(off, { hook_event_name: 'Forja', forja: { kind, ...fields } }, { session });

const fixtures = {};

// 1. Happy path with Forja CLI events: full task lifecycle, one review.
fixtures['happy-path'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ev(1, { hook_event_name: 'UserPromptSubmit', prompt: 'Forja run: adicionar a página de contactos ao sample-project' }),
  forja(2, 'run.start', { run_id: S1, goal: 'Adicionar a página de contactos', model_floor: 'fable' }),
  ...agentCall(3, { id: 'a-big-1', type: 'bigorna', desc: 'P · Bigorna: plano do run', tu: toolUse(1) }),
  subStart(3.5, 'a-big-1', 'bigorna'),
  ...subTool(5, 'a-big-1', 'bigorna', 'Read', { file_path: 'C:\\x\\CLAUDE.md' }),
  forja(20, 'task.add', { id: 'T1', title: 'Página de contactos (HTML + CSS)', owner: 'lapidador', criteria: 'página em /contactos, screenshots 1440/390' }),
  forja(21, 'task.add', { id: 'T2', title: 'Formulário envia para o endpoint', owner: 'fundidor', criteria: 'POST /contact grava em data/, teste verde', after: 'T1' }),
  forja(22, 'decision', { id: 'D1', text: 'Sem newsletter na página de contactos (fora do objetivo)', why: 'o objetivo pede contactos, não captação', reversible: true, by: 'bigorna' }),
  forja(23, 'ask', { id: 'Q1', text: 'Publicar a página no domínio público?', default: 'não publicar; fica só no repo', why: 'publicação externa é sempre do Sponsor' }),
  handback(25, 'a-big-1', 'bigorna', 'PLAN — 2 tasks, 1 decisão, 1 pergunta para o Sponsor'),
  subStop(26, 'a-big-1', 'bigorna', 'PLAN — 2 tasks, 1 decisão, 1 pergunta para o Sponsor'),
  ...agentDone(26.5, { id: 'a-big-1', type: 'bigorna', desc: 'P · Bigorna: plano do run', durationS: 23.5, tu: toolUse(1) }),
  forja(30, 'task.start', { id: 'T1', attempts: 1 }),
  ...agentCall(31, { id: 'a-lap-1', type: 'lapidador', desc: 'T1 · Lapidador: Página de contactos (HTML + CSS)', tu: toolUse(2) }),
  subStart(31.5, 'a-lap-1', 'lapidador'),
  ...subTool(40, 'a-lap-1', 'lapidador', 'Write', { file_path: 'C:\\x\\contactos.html' }),
  ...subTool(60, 'a-lap-1', 'lapidador', 'Bash', { command: 'node "C:/forja/bin/forja.mjs" progress "a tirar screenshots a 1440 e 390"', description: 'progress' }),
  ...subTool(90, 'a-lap-1', 'lapidador', 'Bash', { command: 'node tools/shot.mjs http://127.0.0.1:5000/contactos docs/screenshots/T1-1440.png', description: 'screenshot 1440' }),
  handback(120, 'a-lap-1', 'lapidador', 'DONE T1 — página de contactos com screenshots em docs/screenshots/T1-1440.png e T1-390.png'),
  subStop(121, 'a-lap-1', 'lapidador', 'DONE T1 — página de contactos'),
  ...agentDone(121.5, { id: 'a-lap-1', type: 'lapidador', desc: 'T1 · Lapidador: Página de contactos (HTML + CSS)', durationS: 90.5, tu: toolUse(2) }),
  mainTool(125, 'Bash', { command: 'git status --short', description: 'confirmar no disco' }),
  forja(126, 'task.review', { id: 'T1' }),
  ...agentCall(127, { id: 'a-con-1', type: 'contraste', desc: 'T1 · Contraste: review', tu: toolUse(3) }),
  subStart(127.5, 'a-con-1', 'contraste'),
  ...subTool(140, 'a-con-1', 'contraste', 'Bash', { command: 'npm test', description: 'correr testes' }),
  ...subTool(170, 'a-con-1', 'contraste', 'Read', { file_path: 'C:\\x\\docs\\screenshots\\T1-1440.png' }),
  handback(200, 'a-con-1', 'contraste', 'APPROVE — critérios cumpridos, screenshots reais nas duas larguras'),
  subStop(201, 'a-con-1', 'contraste', 'APPROVE — critérios cumpridos'),
  ...agentDone(201.5, { id: 'a-con-1', type: 'contraste', desc: 'T1 · Contraste: review', durationS: 74.5, tu: toolUse(3) }),
  forja(203, 'task.done', { id: 'T1', verdict: 'APPROVE — critérios cumpridos, screenshots reais nas duas larguras' }),
  mainTool(205, 'Bash', { command: 'git commit -m "T1: página de contactos"', description: 'commit T1' }),
  forja(206, 'run.checkpoint', { note: 'T1 fechada' }),
  forja(210, 'task.start', { id: 'T2', attempts: 1 }),
  ...agentCall(211, { id: 'a-fun-1', type: 'fundidor', desc: 'T2 · Fundidor: Formulário envia para o endpoint', tu: toolUse(4) }),
  subStart(211.5, 'a-fun-1', 'fundidor'),
  ...subTool(220, 'a-fun-1', 'fundidor', 'Edit', { file_path: 'C:\\x\\server.mjs' }),
];

// 2. Missing SubagentStop (background reviewer, the real bug): handback seen, no Stop ever.
fixtures['missing-stop'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ev(1, { hook_event_name: 'UserPromptSubmit', prompt: 'review the hub view' }),
  ...agentCall(2, { id: 'a-rev-bg', type: 'reviewer', desc: 'T7 · Contraste: review', background: true, resolved: 'claude-opus-5[1m]', model: 'opus', tu: toolUse(10) }),
  subStart(2.5, 'a-rev-bg', 'reviewer'),
  ...subTool(30, 'a-rev-bg', 'reviewer', 'Read', { file_path: 'C:\\x\\viewer\\index.html' }),
  ...subTool(300, 'a-rev-bg', 'reviewer', 'Bash', { command: 'npm run test:viewer', description: 'tests' }),
  handback(600, 'a-rev-bg', 'reviewer', 'REJECT — timer overflows the node ring at 1440'),
  // no SubagentStop, ever; main session keeps working after reading the result
  mainTool(650, 'Edit', { file_path: 'C:\\x\\viewer\\index.html' }),
];

// 3. Duplicate SubagentStart (SendMessage nudge re-fires the hook) + single Stop.
fixtures['duplicate-start'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ...agentCall(1, { id: 'a-dup', type: 'contraste', desc: 'T3 · Contraste: review', background: true, tu: toolUse(20) }),
  subStart(1.5, 'a-dup', 'contraste'),
  ...subTool(10, 'a-dup', 'contraste', 'Read', { file_path: 'C:\\x\\a.mjs' }),
  ev(600, { hook_event_name: 'PreToolUse', tool_name: 'SendMessage', tool_input: { to: 'a-dup', message: 'wrap up' }, tool_use_id: toolUse(21) }),
  subStart(601, 'a-dup', 'contraste'), // re-announce, same instance
  ...subTool(605, 'a-dup', 'contraste', 'Read', { file_path: 'C:\\x\\b.mjs' }),
  handback(700, 'a-dup', 'contraste', 'APPROVE — fine'),
  subStop(701, 'a-dup', 'contraste', 'APPROVE — fine'),
];

// 4. Orphan Stops: empty agent_type (compaction), duplicate Stop, Stop-with-duration-only (start lost).
fixtures['orphan-stops'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ...agentCall(1, { id: 'a-ok', type: 'fundidor', desc: 'T1 · Fundidor: x', tu: toolUse(30) }),
  subStart(1.5, 'a-ok', 'fundidor'),
  handback(50, 'a-ok', 'fundidor', 'DONE T1 — x'),
  subStop(51, 'a-ok', 'fundidor', 'DONE T1 — x'),
  subStop(51.2, 'a-ok', 'fundidor', 'DONE T1 — x'), // duplicate
  ...agentDone(52, { id: 'a-ok', type: 'fundidor', desc: 'T1 · Fundidor: x', durationS: 51, tu: toolUse(30) }),
  ev(60, { hook_event_name: 'PreCompact', trigger: 'auto' }),
  subStop(62, 'a-ghost', '', '<analysis>\nLet me chronologically trace…'), // compaction ghost: discard
  subStop(70, 'a-lost', 'lapidador', 'DONE T2 — y', { duration_ms: 40000 }), // Start hook lost: finished instance
  ev(72, { hook_event_name: 'PostCompact', trigger: 'auto' }),
];

// 5. Out-of-order delivery: PostToolUse(Agent) written before SubagentStart, and a Stop before its inner PostToolUse.
fixtures['out-of-order'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ev(3.0, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'fundidor', model: 'fable', description: 'T1 · Fundidor: z', run_in_background: true }, tool_response: { isAsync: true, status: 'async_launched', agentId: 'a-ooo', resolvedModel: 'claude-fable-5-1' }, tool_use_id: toolUse(40), duration_ms: 4 }),
  ev(2.9, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'fundidor', model: 'fable', description: 'T1 · Fundidor: z', run_in_background: true }, tool_use_id: toolUse(40) }),
  subStart(3.1, 'a-ooo', 'fundidor'),
  ev(20.6, { hook_event_name: 'SubagentStop', agent_id: 'a-ooo', agent_type: 'fundidor', last_assistant_message: 'DONE T1 — z' }),
  ev(20.2, { hook_event_name: 'PostToolUse', agent_id: 'a-ooo', agent_type: 'fundidor', tool_name: 'SubagentHandback', tool_input: { message: 'DONE T1 — z' }, tool_response: {}, tool_use_id: toolUse(41), duration_ms: 2 }),
];

// 6. Subagent errors: failed call (rate limit), permission denied inside a subagent, cancelled call.
fixtures['subagent-errors'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  forja(1, 'run.start', { run_id: S1, goal: 'erros de subagente' }),
  // a) Agent call fails with a rate-limit error → fallback signal
  ev(2, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'fundidor', model: 'fable', description: 'T1 · Fundidor: a' }, tool_use_id: toolUse(50) }),
  ev(3, { hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_input: { subagent_type: 'fundidor', model: 'fable', description: 'T1 · Fundidor: a' }, error: 'API Error: 429 rate_limit_error: This request would exceed your usage limit', tool_use_id: toolUse(50) }),
  forja(4, 'fallback', { role: 'fundidor', from: 'fable', to: 'opus', why: '429 rate limit' }),
  // b) retry on opus; permission denied inside the subagent
  ...agentCall(5, { id: 'a-den', type: 'fundidor', desc: 'T1 · Fundidor: a', model: 'opus', resolved: 'claude-opus-5[1m]', tu: toolUse(51) }),
  subStart(5.5, 'a-den', 'fundidor'),
  // real order: PreToolUse fires before the permission is evaluated
  ev(9.9, { hook_event_name: 'PreToolUse', agent_id: 'a-den', agent_type: 'fundidor', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'limpar build' }, tool_use_id: toolUse(52) }),
  ev(10, { hook_event_name: 'PermissionRequest', agent_id: 'a-den', agent_type: 'fundidor', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'limpar build' }, tool_use_id: toolUse(52) }),
  ev(20, { hook_event_name: 'PermissionDenied', agent_id: 'a-den', agent_type: 'fundidor', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'limpar build' }, tool_use_id: toolUse(52) }),
  handback(25, 'a-den', 'fundidor', 'BLOCKED T1 — permissão negada para limpar a pasta build'),
  subStop(26, 'a-den', 'fundidor', 'BLOCKED T1 — permissão negada'),
  ...agentDone(26.5, { id: 'a-den', type: 'fundidor', desc: 'T1 · Fundidor: a', model: 'opus', resolved: 'claude-opus-5[1m]', durationS: 21.5, tu: toolUse(51) }),
  forja(27, 'task.block', { id: 'T1', why: 'permissão negada para apagar build/' }),
  // c) cancelled background call: Agent result status "cancelled"
  ...agentCall(30, { id: 'a-can', type: 'lapidador', desc: 'T2 · Lapidador: b', background: true, tu: toolUse(53) }),
  subStart(30.5, 'a-can', 'lapidador'),
  ...subTool(35, 'a-can', 'lapidador', 'Read', { file_path: 'C:\\x\\index.html' }),
  ev(40, { hook_event_name: 'PreToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'a-can' }, tool_use_id: toolUse(54) }),
  ev(40.5, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'lapidador', description: 'T2 · Lapidador: b' }, tool_response: { status: 'cancelled', agentId: 'a-can' }, tool_use_id: toolUse(55), duration_ms: 10000 }),
];

// 6b. Hard denial in headless mode: no PermissionDenied hook fires (verified
// 16 set 2026 with `claude -p --disallowedTools "Bash(rm:*)"`): the PreToolUse
// simply never gets a PostToolUse, then the actor's turn ends. Parallel tool
// calls (Pre B before Post A) must NOT count as refusals.
fixtures['denied-headless'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  forja(1, 'run.start', { run_id: S1, goal: 'denial' }),
  ...agentCall(2, { id: 'a-hd', type: 'fundidor', desc: 'T1 · Fundidor: limpar', tu: toolUse(56) }),
  subStart(2.5, 'a-hd', 'fundidor'),
  // parallel calls: two Pre, then both Post — fine
  ev(5, { hook_event_name: 'PreToolUse', agent_id: 'a-hd', agent_type: 'fundidor', tool_name: 'Read', tool_input: { file_path: 'C:\\x\\a.mjs' }, tool_use_id: toolUse(57) }),
  ev(5.1, { hook_event_name: 'PreToolUse', agent_id: 'a-hd', agent_type: 'fundidor', tool_name: 'Read', tool_input: { file_path: 'C:\\x\\b.mjs' }, tool_use_id: toolUse(58) }),
  ev(5.5, { hook_event_name: 'PostToolUse', agent_id: 'a-hd', agent_type: 'fundidor', tool_name: 'Read', tool_input: { file_path: 'C:\\x\\a.mjs' }, tool_response: {}, tool_use_id: toolUse(57), duration_ms: 400 }),
  ev(5.6, { hook_event_name: 'PostToolUse', agent_id: 'a-hd', agent_type: 'fundidor', tool_name: 'Read', tool_input: { file_path: 'C:\\x\\b.mjs' }, tool_response: {}, tool_use_id: toolUse(58), duration_ms: 500 }),
  // the denied one: Pre without Post
  ev(8, { hook_event_name: 'PreToolUse', agent_id: 'a-hd', agent_type: 'fundidor', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'apagar build' }, tool_use_id: toolUse(59) }),
  handback(12, 'a-hd', 'fundidor', 'BLOCKED T1 — o comando rm foi recusado'),
  subStop(13, 'a-hd', 'fundidor', 'BLOCKED T1 — o comando rm foi recusado'),
  ...agentDone(13.5, { id: 'a-hd', type: 'fundidor', desc: 'T1 · Fundidor: limpar', durationS: 11.5, tu: toolUse(56) }),
  // main session too: a denied Bash then Stop
  ev(20, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push', description: 'push' }, tool_use_id: toolUse(60) }),
  ev(25, { hook_event_name: 'Stop', last_assistant_message: 'DENIED', stop_hook_active: false }),
];

// 7. Corrupt / truncated lines in the stream, CRLF, a hook that failed to write (gap).
fixtures['corrupt-lines'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ...agentCall(1, { id: 'a-c', type: 'contraste', desc: 'T1 · Contraste: review', tu: toolUse(60) }),
  subStart(1.5, 'a-c', 'contraste'),
  '{"ts":"2026-09-17T09:00:05.000Z","project":"sample-project","session_id":"' + S1 + '","hook_event_name":"PreToolUse","agent_id":"a-c","agent_type":"contraste","tool_name":"Read","tool_input":{"file_path":"C:\\\\x\\\\big.js","content":"aaaaaaaaaa', // truncated line (hook killed mid-write)
  ev(6, { hook_event_name: 'PostToolUse', agent_id: 'a-c', agent_type: 'contraste', tool_name: 'Read', tool_input: { file_path: 'C:\\x\\big.js' }, tool_response: {}, tool_use_id: toolUse(61), duration_ms: 3 }) + '\r',
  'not json at all',
  '[1,2,3]',
  // well-formed JSON with malformed field types (found by fuzzing in review round 1): must never throw
  ev(10, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'fundidor', description: 42, model: null }, tool_use_id: 12345 }),
  ev(11, { hook_event_name: 'Notification', notification_type: ['permission_prompt'], message: { nested: true } }),
  ev(12, { hook_event_name: 'Forja', forja: { kind: 'run.resume', run_id: 'R-20260917-zzzz' }, session_id: 99 }),
  ev(13, { hook_event_name: 'SubagentStart', agent_id: { odd: true }, agent_type: 7 }),
  ev(14, { hook_event_name: 'SubagentStop', agent_id: 'a-weird', agent_type: null, duration_ms: 'soon' }),
  ev(15, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: 'not-an-object', tool_response: [1, 2], tool_use_id: null }),
  ev(16, { hook_event_name: 'Forja', forja: 'not-an-object' }),
  ev(17, { hook_event_name: 'Forja', forja: { kind: 'task.add', id: { x: 1 }, title: ['t'] } }),
  handback(30, 'a-c', 'contraste', 'APPROVE — ok'),
  subStop(31, 'a-c', 'contraste', 'APPROVE — ok'),
  ...agentDone(31.5, { id: 'a-c', type: 'contraste', desc: 'T1 · Contraste: review', durationS: 30.5, tu: toolUse(60) }),
];

// 8. Main session compacted and restarted; Stop with run still running (needs Sponsor); resume in a new session.
fixtures['compaction-restart'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ev(1, { hook_event_name: 'UserPromptSubmit', prompt: 'Forja run: x' }),
  forja(2, 'run.start', { run_id: 'R-20260917-0001', goal: 'x' }),
  forja(3, 'task.add', { id: 'T1', title: 'a', owner: 'fundidor' }),
  forja(4, 'task.start', { id: 'T1', attempts: 1 }),
  ev(100, { hook_event_name: 'PreCompact', trigger: 'auto' }),
  '{"ts":"2026-09-17T09:01:40.500Z","project":"sample-project","session_id":"' + S1 + '","hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"C:\\\\x\\\\big', // truncated line AFTER run.start: must not wipe the run
  ev(101, { hook_event_name: 'SubagentStop', agent_id: 'a-ghost2', agent_type: '', last_assistant_message: '<analysis>…' }),
  ev(102, { hook_event_name: 'PostCompact', trigger: 'auto' }),
  mainTool(110, 'Read', { file_path: 'C:\\x\\docs\\forja\\HANDOVER.md' }),
  ev(200, { hook_event_name: 'Stop', last_assistant_message: 'Preciso que o Sponsor confirme o domínio antes de continuar.', stop_hook_active: false }),
  ev(260, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }),
  ev(400, { hook_event_name: 'SessionEnd', reason: 'other' }),
  // new session resumes the same project
  ev(500, { hook_event_name: 'SessionStart', source: 'startup' }, { session: S2 }),
  ev(501, { hook_event_name: 'UserPromptSubmit', prompt: 'continue from docs/forja/HANDOVER.md' }, { session: S2 }),
  forja(502, 'run.resume', { run_id: 'R-20260917-0001', note: 'retoma depois de reinício' }, S2),
  forja(503, 'task.start', { id: 'T1', attempts: 2 }, S2),
  ...agentCall(504, { id: 'a-r2', type: 'fundidor', desc: 'T1 · Fundidor: a', tu: toolUse(70) }).map(l => l.replace(S1, S2)),
  subStart(504.5, 'a-r2', 'fundidor').replace(S1, S2),
];

// 8b. Two sequential runs in ONE session: run finish then run start with a new id — the finished run keeps its identity.
fixtures['sequential-runs'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  forja(1, 'run.start', { run_id: 'R-20260917-aaaa', goal: 'first' }),
  forja(2, 'task.add', { id: 'T1', title: 'a', owner: 'fundidor' }),
  forja(3, 'task.start', { id: 'T1', attempts: 1 }),
  forja(4, 'task.done', { id: 'T1', verdict: 'APPROVE' }),
  forja(5, 'run.finish', { note: 'done' }),
  forja(10, 'run.start', { run_id: 'R-20260917-bbbb', goal: 'second' }),
  forja(11, 'task.add', { id: 'T1', title: 'b', owner: 'lapidador' }),
  mainTool(12, 'Read', { file_path: 'x' }),
];

// 9. Two runs in parallel (two projects) interleaved in one file, with different cwd casing for the same project.
fixtures['parallel-runs'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ev(0.5, { hook_event_name: 'SessionStart', source: 'startup' }, { session: S2, cwd: 'C:\\dev\\indigo-cove' }),
  forja(1, 'run.start', { run_id: S1, goal: 'sample: a' }),
  forja(1.5, 'run.start', { run_id: S2, goal: 'invest: b' }, S2),
  ...agentCall(2, { id: 'a-p1', type: 'fundidor', desc: 'T1 · Fundidor: sample', tu: toolUse(80) }),
  subStart(2.5, 'a-p1', 'fundidor'),
  ev(3, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'fundidor', model: 'fable', description: 'T1 · Fundidor: invest' }, tool_use_id: toolUse(81) }, { session: S2, cwd: 'C:\\dev\\indigo-cove' }),
  ev(3.5, { hook_event_name: 'SubagentStart', agent_id: 'a-p2', agent_type: 'fundidor' }, { session: S2, cwd: 'C:\\dev\\indigo-cove' }),
  ...subTool(10, 'a-p1', 'fundidor', 'Edit', { file_path: 'C:\\x\\a.mjs' }),
  ev(11, { hook_event_name: 'PreToolUse', agent_id: 'a-p2', agent_type: 'fundidor', tool_name: 'Edit', tool_input: { file_path: 'C:\\y\\b.ts' }, tool_use_id: toolUse(82) }, { session: S2, cwd: 'C:\\dev\\indigo-cove' }),
  // same project S1 continues with lower-case drive letter in cwd (Windows quirk)
  ev(12, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, tool_use_id: toolUse(83) }, { cwd: CWD_LOWER }),
];

// 10. Native tools (Explore, claude-code-guide) plus a legacy-named reviewer: grouping, not merging.
fixtures['native-and-legacy'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ...agentCall(1, { id: 'a-ex1', type: 'Explore', desc: 'Quick repo lookup', model: 'sonnet', resolved: 'claude-sonnet-5', background: true, tu: toolUse(90) }),
  subStart(1.5, 'a-ex1', 'Explore'),
  ...agentCall(2, { id: 'a-ex2', type: 'Explore', desc: 'Second lookup', model: 'sonnet', resolved: 'claude-sonnet-5', background: true, tu: toolUse(91) }),
  subStart(2.5, 'a-ex2', 'Explore'),
  ...agentCall(3, { id: 'a-leg', type: 'reviewer', desc: 'Independent review', model: 'opus', resolved: 'claude-opus-5[1m]', tu: toolUse(92) }),
  subStart(3.5, 'a-leg', 'reviewer'),
  ...agentCall(4, { id: 'a-leg2', type: 'reviewer', desc: 'Second review in parallel', model: 'opus', resolved: 'claude-opus-5[1m]', background: true, tu: toolUse(93) }),
  subStart(4.5, 'a-leg2', 'reviewer'),
  handback(20, 'a-ex1', 'Explore', 'viewer/ contains index.html'),
  subStop(21, 'a-ex1', 'Explore', 'Report delivered.'),
];

// 11. All roster states at once (for viewer screenshots): working, quiet, unresponsive, dead, blocked, waiting review, done, failed, idle.
fixtures['all-states'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ev(1, { hook_event_name: 'UserPromptSubmit', prompt: 'Forja run: demonstração de estados' }),
  forja(2, 'run.start', { run_id: S1, goal: 'Demonstração de todos os estados do elenco' }),
  forja(3, 'task.add', { id: 'T1', title: 'Modelo de dados', owner: 'fundidor' }),
  forja(4, 'task.add', { id: 'T2', title: 'Ecrã de lista', owner: 'lapidador' }),
  forja(5, 'task.add', { id: 'T3', title: 'Exportar CSV', owner: 'fundidor' }),
  forja(6, 'decision', { id: 'D1', text: 'Guardar em JSON, sem base de dados', why: 'volume pequeno, reversível', reversible: true }),
  forja(7, 'ask', { id: 'Q1', text: 'Podemos apagar os ficheiros antigos em data/legacy/?', default: 'não apagar; ficam intactos', why: 'apagar ficheiros do utilizador é sempre do Sponsor' }),
  forja(8, 'task.start', { id: 'T1', attempts: 1 }),
  ...agentCall(9, { id: 'a-f1', type: 'fundidor', desc: 'T1 · Fundidor: Modelo de dados', tu: toolUse(100) }),
  subStart(9.5, 'a-f1', 'fundidor'),
  handback(100, 'a-f1', 'fundidor', 'DONE T1 — modelo em lib/model.mjs com testes'),
  subStop(101, 'a-f1', 'fundidor', 'DONE T1'),
  ...agentDone(101.5, { id: 'a-f1', type: 'fundidor', desc: 'T1 · Fundidor: Modelo de dados', durationS: 92, tu: toolUse(100) }),
  forja(102, 'task.review', { id: 'T1' }),
  ...agentCall(103, { id: 'a-c1', type: 'contraste', desc: 'T1 · Contraste: review', tu: toolUse(101) }),
  subStart(103.5, 'a-c1', 'contraste'),
  handback(200, 'a-c1', 'contraste', 'REJECT — falta teste para valores negativos'),
  subStop(201, 'a-c1', 'contraste', 'REJECT'),
  ...agentDone(201.5, { id: 'a-c1', type: 'contraste', desc: 'T1 · Contraste: review', durationS: 98, tu: toolUse(101) }),
  forja(202, 'task.fail', { id: 'T1', attempts: 1, why: 'falta teste para valores negativos' }),
  forja(210, 'task.start', { id: 'T2', attempts: 1 }),
  ...agentCall(211, { id: 'a-l1', type: 'lapidador', desc: 'T2 · Lapidador: Ecrã de lista', background: true, tu: toolUse(102) }),
  subStart(211.5, 'a-l1', 'lapidador'),
  ...subTool(1500, 'a-l1', 'lapidador', 'Bash', { command: 'node "C:/forja/bin/forja.mjs" progress "a comparar screenshots com o DESIGN.md"', description: 'progress' }),
  ...agentCall(1510, { id: 'a-b1', type: 'bigorna', desc: 'Q · Bigorna: paginação ou scroll infinito', background: true, tu: toolUse(103) }),
  subStart(1510.5, 'a-b1', 'bigorna'),
  ev(1520, { hook_event_name: 'PermissionRequest', agent_id: 'a-b1', agent_type: 'bigorna', tool_name: 'Bash', tool_input: { command: 'node forja.mjs decide "scroll infinito"', description: 'registar decisão' }, tool_use_id: toolUse(104) }),
  ...agentCall(1530, { id: 'a-f2', type: 'fundidor', desc: 'T3 · Fundidor: Exportar CSV', background: true, tu: toolUse(105) }),
  subStart(1530.5, 'a-f2', 'fundidor'),
  ...subTool(1540, 'a-f2', 'fundidor', 'Edit', { file_path: 'C:\\x\\export.mjs' }),
  ...agentCall(1550, { id: 'a-ex', type: 'Explore', desc: 'find csv helpers', model: 'sonnet', resolved: 'claude-sonnet-5', background: true, tu: toolUse(106) }),
  subStart(1550.5, 'a-ex', 'Explore'),
  ...subTool(1560, 'a-ex', 'Explore', 'Grep', { pattern: 'csv' }),
  mainTool(1600, 'Bash', { command: 'node "C:/forja/bin/forja.mjs" status', description: 'estado do run' }),
];

// 12. The ten roles (docs/ARCHITECTURE.md §2) in one run with the new agent_type
// values, in different states: a SECURITY-REJECT, a `QA FAIL`, FRAME/PLAN/DONE S<n>
// hand-backs, two Backend Dev sessions, a Product Designer gone silent, and a
// usage-limit `run.pause` at the very end (the run is left paused, session still
// open so the badge can say "em pausa"). Served whole → the paused viewer; served
// up to offset 1596 (tools/serve-fixture.mjs on a truncated copy) → every role live.
fixtures['all-roles'] = [
  ev(0, { hook_event_name: 'SessionStart', source: 'startup' }),
  ev(1, { hook_event_name: 'UserPromptSubmit', prompt: 'Forja run: viewer com os dez papéis' }),
  forja(2, 'run.start', { run_id: S1, goal: 'Viewer com os dez papéis, pausa e estatística de tempo ligado', model_floor: 'fable' }),
  ...agentCall(3, { id: 'a-pm-1', type: 'product-manager', desc: 'F · Product Manager: perfil de produto e enquadramento', tu: toolUse(200) }),
  subStart(3.5, 'a-pm-1', 'product-manager'),
  forja(10, 'decision', { id: 'D1', text: 'Perfil de produto: a leitura em 5 segundos manda sobre tudo', why: 'é o teste do DESIGN.md', reversible: true, by: 'product-manager' }),
  forja(12, 'ask', { id: 'Q1', text: 'Publicar o viewer no túnel público durante o run?', default: 'não; só localhost', why: 'exposição externa é sempre do Sponsor' }),
  handback(30, 'a-pm-1', 'product-manager', 'FRAME — 1 decisão, 1 pergunta para o Sponsor'),
  subStop(31, 'a-pm-1', 'product-manager', 'FRAME — 1 decisão, 1 pergunta para o Sponsor'),
  ...agentDone(31.5, { id: 'a-pm-1', type: 'product-manager', desc: 'F · Product Manager: perfil de produto e enquadramento', durationS: 28.5, tu: toolUse(200) }),
  ...agentCall(35, { id: 'a-ar-1', type: 'architect', desc: 'P · Architect: plano de tasks', tu: toolUse(201) }),
  subStart(35.5, 'a-ar-1', 'architect'),
  forja(40, 'task.add', { id: 'T1', title: 'Redutor: dez papéis e pausa', owner: 'backend-dev', criteria: 'ROSTER com dez papéis, run.pause, testes verdes' }),
  forja(41, 'task.add', { id: 'T2', title: 'Cena com dez estações', owner: 'frontend-dev', criteria: 'screenshots 1440/390', after: 'T1' }),
  forja(42, 'task.add', { id: 'T3', title: 'Estatística de tempo ligado', owner: 'backend-dev', after: 'T1' }),
  forja(43, 'task.add', { id: 'T4', title: 'Regressão e2e do viewer', owner: 'qa', after: 'T2' }),
  handback(60, 'a-ar-1', 'architect', 'PLAN — 4 tasks, 0 replaneadas'),
  subStop(61, 'a-ar-1', 'architect', 'PLAN — 4 tasks, 0 replaneadas'),
  ...agentDone(61.5, { id: 'a-ar-1', type: 'architect', desc: 'P · Architect: plano de tasks', durationS: 26.5, tu: toolUse(201) }),
  ...agentCall(65, { id: 'a-ts-1', type: 'technology-scout', desc: 'S1 · Technology Scout: cena do viewer (dez estações)', tu: toolUse(202) }),
  subStart(65.5, 'a-ts-1', 'technology-scout'),
  ...subTool(70, 'a-ts-1', 'technology-scout', 'WebFetch', { url: 'https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feGaussianBlur' }),
  handback(110, 'a-ts-1', 'technology-scout', 'DONE S1 — sem biblioteca: SVG inline + CSS da plataforma'),
  subStop(111, 'a-ts-1', 'technology-scout', 'DONE S1 — sem biblioteca: SVG inline + CSS da plataforma'),
  ...agentDone(111.5, { id: 'a-ts-1', type: 'technology-scout', desc: 'S1 · Technology Scout: cena do viewer (dez estações)', durationS: 46.5, tu: toolUse(202) }),
  forja(120, 'task.start', { id: 'T1', attempts: 1 }),
  ...agentCall(121, { id: 'a-bd-1', type: 'backend-dev', desc: 'T1 · Backend Dev: Redutor: dez papéis e pausa', tu: toolUse(203) }),
  subStart(121.5, 'a-bd-1', 'backend-dev'),
  ...subTool(130, 'a-bd-1', 'backend-dev', 'Edit', { file_path: 'C:\\x\\viewer\\lib\\state.mjs' }),
  ...agentCall(200, { id: 'a-pd-1', type: 'product-designer', desc: 'D · Product Designer: direção da cena com dez estações', background: true, tu: toolUse(207) }),
  subStart(200.5, 'a-pd-1', 'product-designer'),
  ...subTool(250, 'a-pd-1', 'product-designer', 'Write', { file_path: 'C:\\x\\docs\\design\\mocks\\oficina-dez.html' }),
  // (the designer never signals again: "sem resposta" after 5 min, still open)
  handback(300, 'a-bd-1', 'backend-dev', 'DONE T1 — ROSTER com dez papéis, run.pause no redutor, testes verdes'),
  subStop(301, 'a-bd-1', 'backend-dev', 'DONE T1 — ROSTER com dez papéis, run.pause no redutor, testes verdes'),
  ...agentDone(301.5, { id: 'a-bd-1', type: 'backend-dev', desc: 'T1 · Backend Dev: Redutor: dez papéis e pausa', durationS: 180.5, tu: toolUse(203) }),
  forja(302, 'task.review', { id: 'T1' }),
  ...agentCall(303, { id: 'a-re-1', type: 'reviewer', desc: 'T1 · Reviewer: review', model: 'opus', resolved: 'claude-opus-5[1m]', tu: toolUse(204) }),
  subStart(303.5, 'a-re-1', 'reviewer'),
  ...subTool(310, 'a-re-1', 'reviewer', 'Bash', { command: 'npm test', description: 'correr testes' }),
  handback(400, 'a-re-1', 'reviewer', 'APPROVE — critérios cumpridos, 28 testes verdes'),
  subStop(401, 'a-re-1', 'reviewer', 'APPROVE — critérios cumpridos, 28 testes verdes'),
  ...agentDone(401.5, { id: 'a-re-1', type: 'reviewer', desc: 'T1 · Reviewer: review', model: 'opus', resolved: 'claude-opus-5[1m]', durationS: 98.5, tu: toolUse(204) }),
  forja(402, 'task.done', { id: 'T1', verdict: 'APPROVE — critérios cumpridos, 28 testes verdes' }),
  ...agentCall(405, { id: 'a-sr-1', type: 'security-reviewer', desc: 'T1 · Security Reviewer: segunda revisão', model: 'opus', resolved: 'claude-opus-5[1m]', tu: toolUse(205) }),
  subStart(405.5, 'a-sr-1', 'security-reviewer'),
  ...subTool(410, 'a-sr-1', 'security-reviewer', 'Grep', { pattern: 'token' }),
  handback(500, 'a-sr-1', 'security-reviewer', 'SECURITY-REJECT — o token do viewer aparece em claro num log de erro'),
  subStop(501, 'a-sr-1', 'security-reviewer', 'SECURITY-REJECT — o token do viewer aparece em claro num log de erro'),
  ...agentDone(501.5, { id: 'a-sr-1', type: 'security-reviewer', desc: 'T1 · Security Reviewer: segunda revisão', model: 'opus', resolved: 'claude-opus-5[1m]', durationS: 96.5, tu: toolUse(205) }),
  forja(502, 'task.fail', { id: 'T1', attempts: 1, why: 'SECURITY-REJECT: token em claro num log de erro' }),
  forja(510, 'task.start', { id: 'T2', attempts: 1 }),
  ...agentCall(511, { id: 'a-fd-1', type: 'frontend-dev', desc: 'T2 · Frontend Dev: Cena com dez estações', tu: toolUse(206) }),
  subStart(511.5, 'a-fd-1', 'frontend-dev'),
  ...subTool(600, 'a-fd-1', 'frontend-dev', 'Bash', { command: 'node "C:/forja/bin/forja.mjs" progress "a tirar screenshots a 1440 e 390"', description: 'progress' }),
  handback(1000, 'a-fd-1', 'frontend-dev', 'DONE T2 — dez estações alinhadas, screenshots em docs/dogfood/'),
  subStop(1001, 'a-fd-1', 'frontend-dev', 'DONE T2 — dez estações alinhadas, screenshots em docs/dogfood/'),
  ...agentDone(1001.5, { id: 'a-fd-1', type: 'frontend-dev', desc: 'T2 · Frontend Dev: Cena com dez estações', durationS: 490.5, tu: toolUse(206) }),
  forja(1002, 'task.review', { id: 'T2' }),
  forja(1010, 'task.start', { id: 'T4', attempts: 1 }),
  ...agentCall(1011, { id: 'a-qa-1', type: 'qa', desc: 'T4 · QA: regressão e2e do viewer', tu: toolUse(208) }),
  subStart(1011.5, 'a-qa-1', 'qa'),
  ...subTool(1100, 'a-qa-1', 'qa', 'Bash', { command: 'node --test test/*.test.mjs', description: 'regressão' }),
  handback(1300, 'a-qa-1', 'qa', 'QA FAIL — 2 findings: o selo do run não muda em pausa; estatística sem sessões'),
  subStop(1301, 'a-qa-1', 'qa', 'QA FAIL — 2 findings: o selo do run não muda em pausa; estatística sem sessões'),
  ...agentDone(1301.5, { id: 'a-qa-1', type: 'qa', desc: 'T4 · QA: regressão e2e do viewer', durationS: 290.5, tu: toolUse(208) }),
  forja(1305, 'task.start', { id: 'T1', attempts: 2 }),
  ...agentCall(1306, { id: 'a-bd-2', type: 'backend-dev', desc: 'T1 · Backend Dev: Redutor: dez papéis e pausa (tentativa 2)', background: true, tu: toolUse(209) }),
  subStart(1306.5, 'a-bd-2', 'backend-dev'),
  ...subTool(1400, 'a-bd-2', 'backend-dev', 'Edit', { file_path: 'C:\\x\\viewer\\lib\\state.mjs' }),
  ...agentCall(1450, { id: 'a-re-2', type: 'reviewer', desc: 'T2 · Reviewer: review', model: 'opus', resolved: 'claude-opus-5[1m]', background: true, tu: toolUse(210) }),
  subStart(1450.5, 'a-re-2', 'reviewer'),
  ...agentCall(1500, { id: 'a-ex-1', type: 'Explore', desc: 'find station geometry', model: 'sonnet', resolved: 'claude-sonnet-5', background: true, tu: toolUse(211) }),
  subStart(1500.5, 'a-ex-1', 'Explore'),
  ...subTool(1560, 'a-ex-1', 'Explore', 'Grep', { pattern: 'station' }),
  ...subTool(1580, 'a-re-2', 'reviewer', 'Read', { file_path: 'C:\\x\\docs\\dogfood\\ui-ten-roles-desktop.png' }),
  ...subTool(1590, 'a-bd-2', 'backend-dev', 'Bash', { command: 'node "C:/forja/bin/forja.mjs" progress "a correr os testes do redutor"', description: 'progress' }),
  mainTool(1595, 'Bash', { command: 'node "C:/forja/bin/forja.mjs" status', description: 'estado do run' }),
  // ---- from here on: wrap-up and the usage-limit pause (cut before 1600 for the "all live" screenshot)
  handback(1600, 'a-re-2', 'reviewer', 'APPROVE — cena alinhada com os cartões, pulso só na estação a trabalhar'),
  subStop(1601, 'a-re-2', 'reviewer', 'APPROVE — cena alinhada com os cartões, pulso só na estação a trabalhar'),
  ...agentDone(1601.5, { id: 'a-re-2', type: 'reviewer', desc: 'T2 · Reviewer: review', model: 'opus', resolved: 'claude-opus-5[1m]', durationS: 151.5, tu: toolUse(210) }),
  forja(1602, 'task.done', { id: 'T2', verdict: 'APPROVE — cena alinhada com os cartões' }),
  handback(1605, 'a-bd-2', 'backend-dev', 'DONE T1 — log de erro sem token; teste novo cobre o caso'),
  subStop(1606, 'a-bd-2', 'backend-dev', 'DONE T1 — log de erro sem token; teste novo cobre o caso'),
  ...agentDone(1606.5, { id: 'a-bd-2', type: 'backend-dev', desc: 'T1 · Backend Dev: Redutor: dez papéis e pausa (tentativa 2)', durationS: 300.5, tu: toolUse(209) }),
  forja(1607, 'task.review', { id: 'T1' }),
  ev(1609, { hook_event_name: 'StopFailure', type: 'rate_limit', message: "You've hit your session limit, resets at 3pm" }),
  forja(1610, 'run.pause', { reason: 'limite de utilização', resume_at: '2026-09-17T14:00:00.000Z', message: "You've hit your session limit, resets at 3pm", limit_kind: 'session', backoff: false }),
];

// 13. Modo visível do runner (§3b) — o incidente real do run granite de 17 set
// 2026, reduzido ao essencial e com o id de sessão e a última mensagem reais:
// o runner (sessão anterior) anuncia a sessão de fundo que lançou, essa sessão
// faz a task e TERMINA O TURNO (hook `Stop`) com o run ainda a correr. Nesse dia
// o viewer dizia «precisa do Sponsor — terminou o turno com o run em curso»,
// quando o normal em modo runner é o runner lançar a fase seguinte.
const VIS = '3dc453de-521a-46f0-9b31-6265f2e5a242';   // a sessão visível real
const PREV = '4b7ef410-c98d-4807-ae8d-53881969a6e1'; // a sessão da fase anterior, de onde o runner emite
fixtures['runner-visible-turn-end'] = [
  forja(0, 'run.start', { run_id: S1, goal: 'Granite: fiabilidade e acessibilidade', model_floor: 'fable', visible: true, autonomy: 'total', forjalvl: 'high' }, PREV),
  // O evento que diz qual é a sessão da fase — emitido DA SESSÃO ANTERIOR, com o
  // id real da nova no payload (é o que o modo visível permite saber).
  forja(1, 'runner.session', { phase: 'task', task: 'T4', attempt: 1, session_id: VIS, visible: true, forjalvl: 'high', autonomy: 'total', effort: 'medium', minutes: 45 }, PREV),
  ev(2, { hook_event_name: 'SessionStart', source: 'startup' }, { session: VIS }),
  ev(3, { hook_event_name: 'UserPromptSubmit', prompt: '[runner] PHASE: TASK T4 — lê docs/forja/ e fecha a task' }, { session: VIS }),
  // É o `run resume` de cada fase que liga a sessão nova ao run (medido no
  // stream real: 07:41:28Z, logo a seguir ao arranque da sessão visível).
  forja(5, 'run.resume', { run_id: S1, note: 'sessão de fase do runner' }, VIS),
  forja(10, 'task.start', { id: 'T4', attempts: 1 }, VIS),
  ev(20, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'regressão' }, tool_use_id: toolUse(700) }, { session: VIS }),
  ev(40, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: '25 suites / 468 tests' }, tool_use_id: toolUse(700), duration_ms: 20000 }, { session: VIS }),
  forja(50, 'task.done', { id: 'T4', verdict: 'APPROVE — erro de sincronização deixa de ser silencioso' }, VIS),
  // O fim do turno, com a última mensagem tal como ficou no evento real.
  ev(60, { hook_event_name: 'Stop', stop_hook_active: false, effort: { level: 'medium' }, last_assistant_message: 'T4 closed: Reviewer APPROVE, Security Reviewer SECURITY-APPROVE, `npx tsc --noEmit` clean and `npm test` green (25 suites / 468 tests) verified in the main checkout, Settings screenshot on the emulator confirms the normal-state layout is unchanged.\n\nTASK T4 done.' }, { session: VIS }),
];

// 17. Dois runs vivos e duas sessões soltas do mesmo projeto (T-UI-9), com a
// forma do stream real de 17 set 2026: o Sponsor abriu o telemóvel, viu no
// seletor um «Lead TERMINADO há 3 h 50» (uma sessão de fase morta) e um «Lead À
// ESPERA DE INPUT há 4 h» (a sessão interativa dele no VS Code) e concluiu que
// os runs estavam parados — quando os dois runs verdadeiros tinham eventos há um
// minuto. Uma sessão solta é uma sessão do Claude Code no mesmo projeto que
// nunca correu `forja run start`/`run resume`.
const GEAR = 'C:\\dev\\granite';
const JOB = 'C:\\dev\\juniper-hill';
const G_RUN = 'gran-run0-aaaa-bbbb-cccc-000000000010';   // a sessão do run vivo do granite
const G_VS = 'gear-vsc0-aaaa-bbbb-cccc-000000000011';    // sessão interativa do Sponsor no VS Code
const G_PHASE = 'gear-fase-aaaa-bbbb-cccc-000000000012'; // sessão de fase (modo visível) que nunca anunciou nada
const J_RUN = 'jun-run00-aaaa-bbbb-cccc-000000000013';
const lev = (off, fields, session, cwd) => ev(off, fields, { session, cwd });
const lforja = (off, kind, fields, session, cwd) => lev(off, { hook_event_name: 'Forja', forja: { kind, ...fields } }, session, cwd);
const END = 28800; // 8 h de run; o último evento é o fim do ficheiro

fixtures['loose-sessions'] = [
  // --- run vivo A: granite ---
  lev(0, { hook_event_name: 'SessionStart', source: 'startup' }, G_RUN, GEAR),
  lforja(1, 'run.start', { run_id: 'R-20260917-1c81', goal: 'Granite: fiabilidade e acessibilidade', model_floor: 'fable', forjalvl: 'high', autonomy: 'total' }, G_RUN, GEAR),
  lforja(20, 'task.add', { id: 'T1', title: 'Ecrã de definições', owner: 'frontend-dev' }, G_RUN, GEAR),
  lforja(30, 'task.start', { id: 'T1', attempts: 1 }, G_RUN, GEAR),
  // --- run vivo B: juniper-hill ---
  lev(600, { hook_event_name: 'SessionStart', source: 'startup' }, J_RUN, JOB),
  lforja(601, 'run.start', { run_id: 'R-20260917-f054', goal: 'Juniper Hill: exportação e testes', model_floor: 'fable', forjalvl: 'max' }, J_RUN, JOB),
  lforja(620, 'task.add', { id: 'T3', title: 'Importar ofertas', owner: 'backend-dev' }, J_RUN, JOB),
  lforja(630, 'task.start', { id: 'T3', attempts: 1 }, J_RUN, JOB),
  // --- sessão solta 1 (granite): a sessão interativa do Sponsor no VS Code ---
  lev(100, { hook_event_name: 'SessionStart', source: 'startup' }, G_VS, GEAR),
  lev(120, { hook_event_name: 'UserPromptSubmit', prompt: 'explica-me porque é que a página diz que o run parou' }, G_VS, GEAR),
  lev(200, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: `${GEAR}\\docs\\forja\\RUN.json` }, tool_use_id: toolUse(940) }, G_VS, GEAR),
  lev(201, { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: `${GEAR}\\docs\\forja\\RUN.json` }, tool_response: { ok: true }, tool_use_id: toolUse(940), duration_ms: 12 }, G_VS, GEAR),
  lev(END - 14400, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'O run continua a correr: os eventos mais recentes são de há segundos.' }, G_VS, GEAR),
  // --- sessão solta 2 (granite): sessão de fase do runner em modo visível, morta ---
  lev(3000, { hook_event_name: 'SessionStart', source: 'startup' }, G_PHASE, GEAR),
  lev(3010, { hook_event_name: 'UserPromptSubmit', prompt: '[runner] PHASE: TASK T7 — fecha a task e entrega' }, G_PHASE, GEAR),
  lev(3100, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'regressão' }, tool_use_id: toolUse(941) }, G_PHASE, GEAR),
  lev(3140, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: '25 suites' }, tool_use_id: toolUse(941), duration_ms: 40000 }, G_PHASE, GEAR),
  lev(END - 13810, { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'TASK T7 done.' }, G_PHASE, GEAR),
  lev(END - 13800, { hook_event_name: 'SessionEnd', reason: 'other' }, G_PHASE, GEAR),
  // --- os dois runs continuam vivos até ao fim do ficheiro ---
  lev(END - 240, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'frontend-dev', model: 'sonnet', description: 'T1 · Frontend Dev: ecrã de definições', prompt: 'Modelo: sonnet.' }, tool_use_id: toolUse(942) }, G_RUN, GEAR),
  lev(END - 235, { hook_event_name: 'SubagentStart', agent_id: 'a-gear-fd', agent_type: 'frontend-dev' }, G_RUN, GEAR),
  lev(END - 120, { hook_event_name: 'PreToolUse', agent_id: 'a-gear-fd', agent_type: 'frontend-dev', tool_name: 'Edit', tool_input: { file_path: `${GEAR}\\app\\settings.tsx` }, tool_use_id: toolUse(943) }, G_RUN, GEAR),
  lev(END - 90, { hook_event_name: 'PreToolUse', agent_id: 'a-job-bd', agent_type: 'backend-dev', tool_name: 'Edit', tool_input: { file_path: `${JOB}\\lib\\import.mjs` }, tool_use_id: toolUse(944) }, J_RUN, JOB),
  lev(END - 60, { hook_event_name: 'SubagentStart', agent_id: 'a-job-bd', agent_type: 'backend-dev' }, J_RUN, JOB),
  lforja(END - 30, 'progress', { text: 'a correr os testes do importador', role: 'backend-dev' }, J_RUN, JOB),
  lev(END, { hook_event_name: 'PreToolUse', agent_id: 'a-gear-fd', agent_type: 'frontend-dev', tool_name: 'Bash', tool_input: { command: 'node tools/shot.mjs', description: 'screenshot a 390' }, tool_use_id: toolUse(945) }, G_RUN, GEAR),
];

mkdirSync(here, { recursive: true });
for (const [name, lines] of Object.entries(fixtures)) {
  writeFileSync(join(here, `${name}.jsonl`), lines.join('\n') + '\n');
}
console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${here}`);
