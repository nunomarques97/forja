#!/usr/bin/env node
// `node tools/efficiency-replay.mjs --root <dir> [--root <dir>] [--days N] [--json]`
//
// Replays packet candidates over the prompts that real Core runs left in
// `.forja/runs/<id>/call-N-prompt.txt`: each candidate is a transform of the
// recorded JSON packet that mirrors a proposed change to the packet builder.
// It reports the characters each candidate removes and the context tokens
// that removal saves once the packet is resent on every model call of its
// session (ledger `calls`), next to quality probes that must not drop.
//
// It also replays the calls candidates of task eff-calls: repeated checks in
// the final regression (state.json), a lower develop context budget and the
// check-log reads of rework sessions (Claude streams).
//
// Read-only like tools/efficiency-audit.mjs: it opens run files for reading
// only and prints aggregates, never a goal, prompt, path or project name.
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRunDirs, promptParts } from './efficiency-audit.mjs';
import { parseUsageLedger, normalizedUsage } from '../lib/core/metrics.mjs';
import { cappedCriteria } from '../lib/core/task-scope.mjs';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
function readRegular(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readJsonFile(path) {
  try { return JSON.parse(readRegular(path) ?? 'null'); } catch { return null; }
}

// Map lines kept by repoMap's greedy fill under a smaller budget, in the
// recorded (ranked) order.
export function capMapText(text, maxChars) {
  const kept = [];
  let used = 0;
  for (const line of String(text).split('\n')) {
    if (!line || used + line.length + 1 > maxChars) continue;
    kept.push(line);
    used += line.length + 1;
  }
  return kept.join('\n');
}
const mapPaths = (text) => new Set(String(text || '').split('\n').filter(Boolean).map((l) => l.split(' :: ')[0]));
const without = (object, key) => { const { [key]: _, ...rest } = object; return rest; };
const optionalChunks = (packet) => (packet.knowledge?.selected || []).filter((k) => !k.required && typeof k.score === 'number');

// Each candidate: transform(packet) -> packet, applied to every recorded
// packet (unchanged when it does not apply).
export const CANDIDATES = {
  map_3000_work: {
    area: 'repository_map',
    description: 'Repository map budget 3,000 characters for develop and review (plan keeps 6,000)',
    transform: (p) => p.phase !== 'plan' && p.repository_map?.text
      ? { ...p, repository_map: { ...p.repository_map, text: capMapText(p.repository_map.text, 3000) } } : p,
  },
  map_3000_pinned: {
    area: 'repository_map',
    description: 'Repository map budget 3,000 characters for develop and review, with the task files listed first (plan keeps 6,000)',
    transform: (p) => {
      if (p.phase === 'plan' || !p.repository_map?.text) return p;
      const own = new Set((p.task?.files || []).map((f) => String(f).replace(/\\/g, '/')));
      const lines = p.repository_map.text.split('\n');
      const pinned = lines.filter((l) => own.has(l.split(' :: ')[0]));
      const text = capMapText([...pinned, ...lines.filter((l) => !own.has(l.split(' :: ')[0]))].join('\n'), 3000);
      return { ...p, repository_map: { ...p.repository_map, text } };
    },
  },
  scope_cap_600: {
    area: 'task_scope',
    base: ['map_3000_pinned'],
    description: 'Criteria of remaining tasks that share a file capped at 600 characters per task (was 1,200)',
    transform: (p) => p.task_scope?.remaining_tasks?.some((t) => 'criteria' in t) ? {
      ...p,
      task_scope: {
        ...p.task_scope,
        remaining_tasks: p.task_scope.remaining_tasks.map((t) => {
          if (!('criteria' in t)) return t;
          const { criteria, truncated } = cappedCriteria(t.criteria.map((c) => String(c).replace(/…$/, '')), 600);
          return { ...without(t, 'criteria_truncated'), criteria, ...(truncated || t.criteria_truncated ? { criteria_truncated: true } : {}) };
        }),
      },
    } : p,
  },
  review_no_map: {
    area: 'repository_map',
    base: ['map_3000_pinned'],
    description: 'No repository map in review packets (the reviewer has changes.files and the patch)',
    transform: (p) => p.phase === 'review' && p.repository_map ? without(p, 'repository_map') : p,
  },
  knowledge_cut_05: {
    area: 'knowledge',
    base: ['map_3000_pinned'],
    description: 'Optional knowledge chunks scoring under half the best optional chunk are not selected',
    transform: (p) => {
      const optional = optionalChunks(p);
      if (!optional.length) return p;
      const top = Math.max(...optional.map((k) => k.score));
      return { ...p, knowledge: { ...p.knowledge, selected: p.knowledge.selected.filter((k) => k.required || typeof k.score !== 'number' || k.score >= top / 2) } };
    },
  },
};

// Quality probes, before and after a transform. Each is a count that a
// candidate must not reduce, except where noted.
function probes(before, after) {
  const files = (before.task?.files || []).map((f) => String(f).replace(/\\/g, '/'));
  const mapBefore = mapPaths(before.repository_map?.text), mapAfter = mapPaths(after.repository_map?.text);
  const listed = files.filter((f) => mapBefore.has(f));
  const sharing = (p) => (p.task_scope?.remaining_tasks || []).filter((t) => 'criteria' in t);
  const optBefore = optionalChunks(before), optAfter = optionalChunks(after);
  const topKey = (list) => list.length ? `${list[0].path}#${list[0].start}` : null;
  return {
    // Task files the recorded map listed, still listed (develop/review only).
    task_files_in_map: { before: listed.length, after: listed.filter((f) => mapAfter.has(f)).length },
    required_knowledge: {
      before: (before.knowledge?.selected || []).filter((k) => k.required).length,
      after: (after.knowledge?.selected || []).filter((k) => k.required).length,
    },
    best_knowledge_chunk: { before: optBefore.length ? 1 : 0, after: optBefore.length && topKey(optAfter) === topKey(optBefore) ? 1 : 0 },
    sharing_tasks_with_criteria: {
      before: sharing(before).filter((t) => t.criteria.length).length,
      after: sharing(after).filter((t) => t.criteria.length).length,
    },
    // Remaining tasks whose shared-file criteria arrive whole, not cut.
    sharing_tasks_complete: {
      before: sharing(before).filter((t) => !t.criteria_truncated).length,
      after: sharing(after).filter((t) => !t.criteria_truncated).length,
    },
  };
}

export function replayRun(dir) {
  const ledger = parseUsageLedger(readRegular(join(dir, 'usage.jsonl')) ?? '').rows;
  const calls = new Map();
  for (const row of ledger) if (Number.isSafeInteger(row.calls) && row.calls > 0) calls.set(row.id, row.calls);
  const result = { packets: 0, packet_characters: 0, resent_characters: 0, calls_known: 0, by_phase: {}, candidates: {} };
  for (const name of Object.keys(CANDIDATES))
    result.candidates[name] = { affected: 0, characters: 0, resent_characters: 0, quality: {} };
  let names = [];
  try { names = readdirSync(dir).filter((f) => /^call-\d+-prompt\.txt$/.test(f)); } catch {}
  for (const file of names.sort()) {
    const id = Number(file.match(/\d+/)[0]);
    const text = readRegular(join(dir, file));
    const { packet } = text == null ? { packet: null } : promptParts(text);
    if (!packet || !['plan', 'develop', 'review'].includes(packet.phase)) continue;
    // Unknown call counts weigh 1: the packet is sent at least once.
    const n = calls.get(id) ?? 1;
    if (calls.has(id)) result.calls_known++;
    const size = JSON.stringify(packet).length;
    result.packets++;
    result.packet_characters += size;
    result.resent_characters += size * n;
    const phase = (result.by_phase[packet.phase] ||= { packets: 0, packet_characters: 0, resent_characters: 0 });
    phase.packets++;
    phase.packet_characters += size;
    phase.resent_characters += size * n;
    for (const [name, { transform, base = [] }] of Object.entries(CANDIDATES)) {
      // Measured on top of the kept changes it was tried after.
      const start = base.reduce((p, kept) => CANDIDATES[kept].transform(p), packet);
      const after = transform(start);
      const saved = JSON.stringify(start).length - JSON.stringify(after).length;
      const c = result.candidates[name];
      if (saved > 0) {
        c.affected++;
        c.characters += saved;
        c.resent_characters += saved * n;
      }
      for (const [probe, { before, after: kept }] of Object.entries(probes(start, after))) {
        const q = (c.quality[probe] ||= { before: 0, after: 0 });
        q.before += before;
        q.after += kept;
      }
    }
  }
  return result;
}

const share = (part, whole) => (whole > 0 ? Math.round((10000 * part) / whole) / 100 : null);

// Final regression replay (task eff-calls): the checks a run's final
// regression executed (task finalValidation entries) that repeat a check with
// the same command and args already passed on the same tree, either earlier
// in that pass or in the validation that accepted the final task. Only runs
// whose regression passed whole are counted: a failed entry starts a repair
// and a new pass on another tree, which the state does not separate.
export function finalRegressionRun(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const entries = tasks.flatMap((t) => (Array.isArray(t?.finalValidation) ? t.finalValidation : []).filter((v) => v && !v.skipped));
  const r = { runs: 0, single_pass_runs: 0, checks: 0, check_ms: 0, repeated_in_pass: 0, repeated_in_pass_ms: 0, repeated_final_task: 0, repeated_final_task_ms: 0 };
  if (!entries.length) return r;
  r.runs = 1;
  if (entries.some((v) => v.passed !== true)) return r;
  r.single_pass_runs = 1;
  const key = (v) => JSON.stringify([v.command, v.args]);
  const finalTask = tasks.find((t) => t?.id === state.finalCheckTaskId) || tasks.at(-1);
  const accepted = state.status === 'done' && finalTask?.validated_tree && Array.isArray(finalTask.validation) && finalTask.validation.every((v) => v?.passed)
    ? new Set(finalTask.validation.map(key)) : new Set();
  const passed = new Set();
  for (const v of entries) {
    const ms = Number.isSafeInteger(v.duration_ms) && v.duration_ms > 0 ? v.duration_ms : 0;
    r.checks++;
    r.check_ms += ms;
    if (passed.has(key(v))) { r.repeated_in_pass++; r.repeated_in_pass_ms += ms; }
    else if (accepted.has(key(v))) { r.repeated_final_task++; r.repeated_final_task_ms += ms; }
    passed.add(key(v));
  }
  return r;
}

// Context budget replay (task eff-calls): what a lower develop context budget
// (maxContextTokens) would have cost on recorded Claude streams. A session is
// cut at its first model call above the budget; the fresh session that
// continues first re-orients (m calls whose context grows from the baseline
// by R, both the medians measured on real continuations after a context-limit
// stop: calls before the first edit and their growth), then repeats the
// remaining calls with the dropped context replaced by baseline plus R.
// Quality probes: tasks whose rotations would exceed the run's rotation
// budget, and sessions cut CONTEXT_LIMIT_STREAK_LIMIT times or more; both
// stop the run for an operator.
export const CONTEXT_BUDGETS = [120000, 160000, 200000];
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CHECK_LOG = /-a\d+-check-\d+\.log/;
export function requestSizes(text) {
  let outer = null;
  try { outer = JSON.parse(text); } catch {}
  const calls = new Map();
  let firstEdit = null, firstLogRead = null;
  for (const line of String(typeof outer?.stdout === 'string' ? outer.stdout : text).split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.message;
    if (event?.type !== 'assistant' || event.parent_tool_use_id || typeof message?.id !== 'string') continue;
    const u = message.usage || {};
    const size = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].every((n) => Number.isSafeInteger(n) && n >= 0)
      ? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens : null;
    if (!calls.has(message.id)) calls.set(message.id, size);
    const uses = (Array.isArray(message.content) ? message.content : []).filter((p) => p?.type === 'tool_use');
    if (firstEdit == null && uses.some((p) => EDIT_TOOLS.has(p.name))) firstEdit = calls.size;
    // A controller check log (<task>-a<N>-check-<i>.log) named in a tool input.
    if (firstLogRead == null && uses.some((p) => CHECK_LOG.test(JSON.stringify(p.input ?? null)))) firstLogRead = calls.size;
  }
  const sizes = [...calls.values()];
  return sizes.every((n) => n != null) ? { sizes, firstEdit, firstLogRead } : { sizes: [], firstEdit: null, firstLogRead: null };
}
export function simulateBudget(sizes, budget, { calls: m, growth: R }) {
  const actual = sizes.reduce((a, b) => a + b, 0);
  if (!sizes.length) return { actual, simulated: actual, cuts: 0 };
  const base = sizes[0];
  let simulated = 0, cuts = 0, offset = 0, start = 0;
  for (let j = 0; j < sizes.length; j++) {
    let context = sizes[j] - offset;
    if (context > budget && j > start && base + R < budget) {
      cuts++;
      // m re-orientation calls growing from the baseline to baseline + R.
      for (let q = 1; q <= m; q++) simulated += base + Math.round((R * q) / m);
      offset = sizes[j - 1] - (base + R);
      context = sizes[j] - offset;
      start = j;
    }
    simulated += context;
  }
  return { actual, simulated, cuts };
}
const percentile = (values, q) => {
  const v = [...values].sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : null;
};
const median = (values) => percentile(values, 0.5);
export function contextBudgetReplay(sessions, { streakLimit = 3 } = {}) {
  // Calibration from real continuations after a context-limit stop.
  const continued = sessions.filter((s) => s.afterContextLimit && s.firstEdit && s.sizes.length);
  const reorientation = {
    sessions: continued.length,
    calls: median(continued.map((s) => s.firstEdit - 1)) ?? 0,
    growth: median(continued.map((s) => s.sizes[s.firstEdit - 1] - s.sizes[0])) ?? 0,
  };
  const actualTotal = sessions.reduce((n, s) => n + s.sizes.reduce((a, b) => a + b, 0), 0);
  const budgets = {};
  for (const budget of CONTEXT_BUDGETS) {
    const r = { sessions_affected: 0, extra_rotations: 0, actual_tokens: 0, simulated_tokens: 0, saved_tokens: 0, saved_percent_of_develop_stream: null, tasks_over_rotation_budget: 0, sessions_at_streak_limit: 0 };
    const extraByTask = new Map();
    for (const s of sessions) {
      if (!(s.limit > budget) || !s.sizes.length) continue;
      const sim = simulateBudget(s.sizes, budget, reorientation);
      if (!sim.cuts) continue;
      r.sessions_affected++;
      r.extra_rotations += sim.cuts;
      r.actual_tokens += sim.actual;
      r.simulated_tokens += sim.simulated;
      if (sim.cuts >= streakLimit) r.sessions_at_streak_limit++;
      const task = extraByTask.get(s.taskKey) || { extra: 0, rotations: s.taskRotations, budget: s.rotationBudget };
      task.extra += sim.cuts;
      extraByTask.set(s.taskKey, task);
    }
    r.saved_tokens = r.actual_tokens - r.simulated_tokens;
    r.saved_percent_of_develop_stream = share(r.saved_tokens, actualTotal);
    r.tasks_over_rotation_budget = [...extraByTask.values()].filter((t) => t.rotations + t.extra > t.budget).length;
    r.tasks_with_extra_rotations = extraByTask.size;
    budgets[budget] = r;
  }
  return { develop_sessions: sessions.length, develop_stream_tokens: actualTotal, reorientation, budgets };
}

// Develop sessions of one run, for the context budget replay. Only sizes and
// counts leave this function; task IDs are replaced by an opaque key.
export function developSessions(dir, state, runKey) {
  const ledger = parseUsageLedger(readRegular(join(dir, 'usage.jsonl')) ?? '').rows;
  const unique = new Map();
  for (const row of ledger) if (!unique.has(row.id) || row.result !== 'interrupted') unique.set(row.id, row);
  const tasks = new Map((Array.isArray(state?.tasks) ? state.tasks : []).map((t) => [t?.id, t]));
  const limit = Number.isSafeInteger(state?.limits?.contextTokens) ? state.limits.contextTokens : 120000;
  const rotationBudget = Number.isSafeInteger(state?.limits?.rotations) ? state.limits.rotations : 2;
  const lastWasLimit = new Map(), lastHandoff = new Map(), out = [];
  for (const row of [...unique.values()].sort((a, b) => a.id - b.id)) {
    // A develop handoff followed by another develop session of the same task
    // means the controller's checks failed in between (a review would sit
    // between them otherwise).
    if (row.phase !== 'develop') { lastHandoff.set(row.task, false); continue; }
    if (row.provider !== 'claude' || !Number.isSafeInteger(row.id)) continue;
    const text = readRegular(join(dir, `call-${row.id}-stream.json`));
    const status = row.result === 'returned' && !row.context_limit_reached ? readJsonFile(join(dir, `call-${row.id}-result.json`))?.status : null;
    if (text != null) {
      const { sizes, firstEdit, firstLogRead } = requestSizes(text);
      const task = tasks.get(row.task);
      out.push({ taskKey: `${runKey}\0${row.task}`, limit, rotationBudget, taskRotations: Number.isSafeInteger(task?.rotations) ? task.rotations : 0,
        sizes, firstEdit, firstLogRead, afterContextLimit: lastWasLimit.get(row.task) === true, afterCheckFailure: lastHandoff.get(row.task) === true });
    }
    lastWasLimit.set(row.task, !!row.context_limit_reached);
    lastHandoff.set(row.task, ['ready_for_validation', 'done'].includes(status));
  }
  return out;
}

// Rework after failed controller checks (task eff-calls, candidate: put the
// failing log in the feedback): the model call at which the fresh session
// first names a check log. Reading it on the first call costs no extra call.
export function checkFailureRework(sessions) {
  const rework = sessions.filter((s) => s.afterCheckFailure && s.sizes.length);
  const reads = rework.filter((s) => s.firstLogRead).map((s) => s.firstLogRead);
  return {
    sessions: rework.length,
    read_log: reads.length,
    read_on_first_call: reads.filter((n) => n === 1).length,
    first_read_call_p50: median(reads),
    calls_p50: median(rework.map((s) => s.sizes.length)),
  };
}

export function replay(roots, { days = null } = {}) {
  const runs = findRunDirs(roots, { days });
  const total = { runs: 0, projects: new Set(), packets: 0, packet_characters: 0, resent_characters: 0, calls_known: 0, input_tokens: 0, by_phase: {}, candidates: {} };
  const final = finalRegressionRun(null), sessions = [], perRun = [];
  for (const { project, dir } of runs) {
    let state = null;
    try { state = JSON.parse(readRegular(join(dir, 'state.json')) ?? 'null'); } catch {}
    const f = finalRegressionRun(state);
    for (const [key, n] of Object.entries(f)) final[key] += n;
    if (f.single_pass_runs) perRun.push(f.repeated_in_pass_ms + f.repeated_final_task_ms);
    sessions.push(...developSessions(dir, state, dir));
    const r = replayRun(dir);
    if (!r.packets) continue;
    total.runs++;
    total.projects.add(project);
    for (const key of ['packets', 'packet_characters', 'resent_characters', 'calls_known']) total[key] += r[key];
    for (const [phase, p] of Object.entries(r.by_phase)) {
      const t = (total.by_phase[phase] ||= { packets: 0, packet_characters: 0, resent_characters: 0 });
      for (const key of Object.keys(t)) t[key] += p[key];
    }
    for (const [name, c] of Object.entries(r.candidates)) {
      const t = (total.candidates[name] ||= { affected: 0, characters: 0, resent_characters: 0, quality: {} });
      t.affected += c.affected;
      t.characters += c.characters;
      t.resent_characters += c.resent_characters;
      for (const [probe, q] of Object.entries(c.quality)) {
        const tq = (t.quality[probe] ||= { before: 0, after: 0 });
        tq.before += q.before;
        tq.after += q.after;
      }
    }
    // Input of the same invocations, for the share of all input tokens.
    for (const row of parseUsageLedger(readRegular(join(dir, 'usage.jsonl')) ?? '').rows) {
      const input = normalizedUsage(row).input;
      if (Number.isSafeInteger(input)) total.input_tokens += input;
    }
  }
  const resentTokens = Math.ceil(total.resent_characters / 4);
  return {
    version: 1,
    runs: total.runs,
    projects: total.projects.size,
    packets: total.packets,
    calls_known: total.calls_known,
    packet_characters: total.packet_characters,
    packet_resent_tokens: resentTokens,
    ledger_input_tokens: total.input_tokens,
    by_phase: total.by_phase,
    candidates: Object.fromEntries(Object.entries(total.candidates).map(([name, c]) => [name, {
      area: CANDIDATES[name].area,
      description: CANDIDATES[name].description,
      affected_packets: c.affected,
      characters: c.characters,
      packet_characters_percent: share(c.characters, total.packet_characters),
      resent_tokens: Math.ceil(c.resent_characters / 4),
      packet_resent_percent: share(c.resent_characters, total.resent_characters),
      ledger_input_percent: share(Math.ceil(c.resent_characters / 4), total.input_tokens),
      quality: c.quality,
    }])),
    final_regression: {
      ...final,
      repeated: final.repeated_in_pass + final.repeated_final_task,
      repeated_ms: final.repeated_in_pass_ms + final.repeated_final_task_ms,
      repeated_ms_percent: share(final.repeated_in_pass_ms + final.repeated_final_task_ms, final.check_ms),
      repeated_ms_per_run: { p50: percentile(perRun, 0.5), p90: percentile(perRun, 0.9), max: perRun.length ? Math.max(...perRun) : null },
    },
    context_budget: contextBudgetReplay(sessions),
    check_failure_rework: checkFailureRework(sessions),
  };
}

function text(report) {
  const k = (n) => (n == null ? 'n/a' : n.toLocaleString('en-US'));
  const lines = [
    `${k(report.runs)} runs in ${k(report.projects)} projects, ${k(report.packets)} packets (${k(report.calls_known)} with a call count), ${k(report.packet_characters)} packet characters, ${k(report.packet_resent_tokens)} packet tokens resent, ${k(report.ledger_input_tokens)} ledger input tokens`,
  ];
  for (const [name, c] of Object.entries(report.candidates)) {
    lines.push(`${name}: ${k(c.affected_packets)} packets, -${k(c.characters)} chars (${c.packet_characters_percent}% of packet chars), -${k(c.resent_tokens)} resent tokens (${c.packet_resent_percent}% of packet resend, ${c.ledger_input_percent}% of ledger input)`);
    lines.push(`  quality: ${Object.entries(c.quality).map(([p, q]) => `${p} ${k(q.after)}/${k(q.before)}`).join(', ')}`);
  }
  const f = report.final_regression;
  lines.push(`final regression: ${k(f.single_pass_runs)} of ${k(f.runs)} runs passed in one pass, ${k(f.checks)} checks in ${k(Math.round(f.check_ms / 1000))} s; same check already passed on the same tree: ${k(f.repeated)} (${k(f.repeated_in_pass)} in the pass, ${k(f.repeated_final_task)} in the final task validation), ${k(Math.round(f.repeated_ms / 1000))} s (${f.repeated_ms_percent}% of check time; per run p50 ${k(Math.round((f.repeated_ms_per_run.p50 ?? 0) / 1000))} s, p90 ${k(Math.round((f.repeated_ms_per_run.p90 ?? 0) / 1000))} s, max ${k(Math.round((f.repeated_ms_per_run.max ?? 0) / 1000))} s)`);
  const c = report.context_budget;
  lines.push(`context budget: ${k(c.develop_sessions)} develop sessions, ${k(c.develop_stream_tokens)} stream tokens; re-orientation after a context-limit stop (median of ${k(c.reorientation.sessions)}): ${k(c.reorientation.calls)} calls, +${k(c.reorientation.growth)} tokens`);
  for (const [budget, b] of Object.entries(c.budgets))
    lines.push(`  ${k(Number(budget))}: ${k(b.sessions_affected)} sessions cut ${k(b.extra_rotations)} more times, ${k(b.actual_tokens)} -> ${k(b.simulated_tokens)} tokens (saved ${k(b.saved_tokens)}, ${b.saved_percent_of_develop_stream}% of develop stream); tasks over the rotation budget ${k(b.tasks_over_rotation_budget)} of ${k(b.tasks_with_extra_rotations)}, sessions at the streak limit ${k(b.sessions_at_streak_limit)}`);
  const w = report.check_failure_rework;
  lines.push(`check failure rework: ${k(w.sessions)} sessions, ${k(w.read_log)} named a check log (${k(w.read_on_first_call)} on their first call; median call ${k(w.first_read_call_p50)}), median ${k(w.calls_p50)} calls per session`);
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), roots = [];
  let days = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && args[i + 1]) roots.push(args[++i]);
    else if (args[i] === '--days' && /^\d+$/.test(args[i + 1] || '')) days = Number(args[++i]);
    else if (args[i] !== '--json') { console.error(`efficiency-replay: unknown argument ${args[i]}`); process.exit(2); }
  }
  if (!roots.length) { console.error('efficiency-replay: pass at least one --root <folder of projects or project>'); process.exit(2); }
  const report = replay(roots, { days });
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : text(report));
}
