#!/usr/bin/env node
// `node tools/efficiency-audit.mjs --root <dir> [--root <dir>] [--days N] [--json]`
//
// Measures where real Core runs spend tokens, context and model calls, from
// the files a run already leaves in `.forja/runs/<id>/`: state.json,
// usage.jsonl, call-N-prompt.txt, call-N-result.json and the Claude
// call-N-stream.json. A root is either a project (it holds `.forja/runs`) or a
// folder of projects (one level deep).
//
// Strictly read-only: it opens files for reading only, never follows a link
// out of a run folder, never writes and never launches a process. The report
// holds aggregates only: no goal, prompt, finding, path, project or run name
// leaves a run folder. Labels that do reach the report (context source names,
// stop codes, tool names, providers, phases) are FORJA's own closed vocabulary
// and are filtered by shape, so a malformed state file cannot smuggle text in.
//
// Everything is exported for test/efficiency-bench.test.mjs; the script only
// runs itself when it is the entry point.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizedUsage, parseUsageLedger } from '../lib/core/metrics.mjs';

const MAX_FILE_BYTES = 128 * 1024 * 1024;
export const LONG_WAIT_MS = 15 * 60000;
export const LARGE_RESULT_CHARS = 20000;
export const CONTEXT_THRESHOLDS = [100000, 150000, 200000];
const PHASES = ['plan', 'develop', 'review'];
const LABEL = /^[A-Za-z][A-Za-z0-9_ .()/-]{0,79}$/;
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
const label = (value) => (typeof value === 'string' && LABEL.test(value) ? value : 'other');
const code = (value) => (typeof value === 'string' && CODE.test(value) ? value : 'other');
const count = (n) => Number.isSafeInteger(n) && n >= 0;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const add = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };

// A regular file inside the run folder, never a link; null when absent,
// unreadable or too large.
function readRegular(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
function readJson(path) {
  const text = readRegular(path);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}
const isDirectory = (path) => { try { return lstatSync(path).isDirectory(); } catch { return false; } };

// Run folders under each root: <root>/.forja/runs/* or <root>/*/.forja/runs/*.
// Created-at filtering uses state.json; runs without a valid date are kept
// only when no window is requested.
export function findRunDirs(roots, { days = null, now = Date.now() } = {}) {
  const projects = [];
  for (const root of roots) {
    const base = resolve(root);
    if (isDirectory(join(base, '.forja', 'runs'))) projects.push(base);
    else if (isDirectory(base))
      for (const name of readdirSync(base).sort())
        if (isDirectory(join(base, name, '.forja', 'runs'))) projects.push(join(base, name));
  }
  const runs = [];
  for (const project of [...new Set(projects)]) {
    const dir = join(project, '.forja', 'runs');
    for (const name of readdirSync(dir).sort()) {
      const runDir = join(dir, name);
      if (!isDirectory(runDir) || !existsSync(join(runDir, 'state.json'))) continue;
      if (days != null) {
        const created = Date.parse(readJson(join(runDir, 'state.json'))?.created_at);
        if (!Number.isFinite(created) || now - created > days * 86400000) continue;
      }
      runs.push({ project, dir: runDir });
    }
  }
  return runs;
}

// The JSON packet is the last line of a prompt that parses as an object; the
// text before it (rules, phase instructions, framing) is split by line.
export function promptParts(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const packet = JSON.parse(line);
      if (packet && typeof packet === 'object' && !Array.isArray(packet))
        return { instructions: lines.slice(0, i).filter((l) => l.trim()), packet };
    } catch {}
  }
  return { instructions: lines.filter((l) => l.trim()), packet: null };
}

// Claude stream-json: model calls are unique top-level assistant message IDs
// (subagent messages carry a parent tool use and are counted apart). The
// first call's request size is the session baseline (system prompt, tools,
// project instructions and packet) that every later call sends again.
export function streamStats(text) {
  // The adapter stores {stdout, stderr}; a bare stream-json text works too.
  let outer = null;
  try { outer = JSON.parse(text); } catch {}
  const events = String(typeof outer?.stdout === 'string' ? outer.stdout : text).split(/\r?\n/);
  const calls = new Map(), tools = {}, reads = new Map(), commands = new Map();
  let toolResultChars = 0, repeatedReadChars = 0, subagentCalls = 0;
  const toolUse = new Map(), results = [];
  for (const line of events) {
    if (!line.trim().startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.message;
    if (event?.type === 'assistant' && message && typeof message.id === 'string') {
      if (event.parent_tool_use_id) { subagentCalls += calls.has(message.id) ? 0 : 1; continue; }
      const u = message.usage || {};
      const size = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].every(count)
        ? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens : null;
      if (!calls.has(message.id)) calls.set(message.id, size);
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type !== 'tool_use' || typeof part.id !== 'string') continue;
        // MCP tool names carry server names chosen by the project: one bucket.
        const name = typeof part.name === 'string' && part.name.startsWith('mcp__') ? 'mcp' : label(part.name);
        add(tools, name);
        const input = part.input || {};
        if (name === 'Read' && typeof input.file_path === 'string') {
          const key = `${input.file_path.replace(/\\/g, '/').toLowerCase()}#${input.offset ?? ''}:${input.limit ?? ''}`;
          toolUse.set(part.id, { name, read: key });
        } else if (['Bash', 'PowerShell'].includes(name) && typeof input.command === 'string') {
          toolUse.set(part.id, { name, command: hash(input.command) });
        } else toolUse.set(part.id, { name });
      }
    } else if (event?.type === 'user' && !event.parent_tool_use_id && Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type !== 'tool_result') continue;
        const body = typeof part.content === 'string' ? part.content
          : Array.isArray(part.content) ? part.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('') : '';
        toolResultChars += body.length;
        const use = toolUse.get(part.tool_use_id);
        results.push({ characters: body.length, after: calls.size, tool: use?.name ?? 'other' });
        if (use?.read) {
          if (reads.has(use.read)) repeatedReadChars += body.length;
          reads.set(use.read, (reads.get(use.read) || 0) + 1);
        } else if (use?.command) commands.set(use.command, (commands.get(use.command) || 0) + 1);
      }
    }
  }
  // A tool result enters every later request of the session: its resend cost
  // is its size (characters/4) times the model calls made after it.
  const resend = {}, large = { results: 0, resent_tokens: 0 };
  for (const r of results) {
    const tokens = Math.ceil(r.characters / 4) * Math.max(0, calls.size - r.after);
    add(resend, r.tool, tokens);
    if (r.characters >= LARGE_RESULT_CHARS) { large.results++; large.resent_tokens += tokens; }
  }
  const sizes = [...calls.values()];
  const measured = sizes.filter(count);
  // Request tokens of calls made with a context above each threshold: the
  // part a lower context budget or an earlier checkpoint could avoid.
  const above = Object.fromEntries(CONTEXT_THRESHOLDS.map((t) => [t, measured.filter((n) => n > t).reduce((a, n) => a + n, 0)]));
  const baseline = count(sizes[0]) ? sizes[0] : null;
  return {
    model_calls: calls.size,
    subagent_calls: subagentCalls,
    context_tokens_total: measured.length === sizes.length && sizes.length ? measured.reduce((a, b) => a + b, 0) : null,
    baseline_tokens: baseline,
    baseline_resent_tokens: baseline == null ? null : baseline * calls.size,
    max_context_tokens: measured.length ? Math.max(...measured) : null,
    tokens_above: above,
    tools,
    tool_result_characters: toolResultChars,
    tool_result_resent_tokens: resend,
    large_results: large,
    reads: [...reads.values()].reduce((a, b) => a + b, 0),
    repeated_reads: [...reads.values()].reduce((a, n) => a + n - 1, 0),
    repeated_read_characters: repeatedReadChars,
    repeated_commands: [...commands.values()].reduce((a, n) => a + n - 1, 0),
  };
}

const inputOf = (row) => normalizedUsage(row).input;
const outputOf = (row) => normalizedUsage(row).output;

// One run folder -> anonymous metrics. Nothing textual from the run is kept
// except closed-vocabulary labels.
export function auditRun(dir) {
  const state = readJson(join(dir, 'state.json'));
  if (!state || typeof state !== 'object') return null;
  const ledger = parseUsageLedger(readRegular(join(dir, 'usage.jsonl')) ?? '');
  // Same rule as summarizeUsage: a final result replaces an interrupted record.
  const unique = new Map();
  for (const row of ledger.rows) if (!unique.has(row.id) || row.result !== 'interrupted') unique.set(row.id, row);
  const rows = [...unique.values()].sort((a, b) => a.id - b.id);
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const run = {
    status: code(state.status),
    stop_code: state.status === 'blocked' ? code(state.stopCode) : null,
    provider: label(state.provider),
    ledger_warnings: ledger.warnings.length,
    tasks: tasks.length,
    tasks_done: tasks.filter((t) => t?.status === 'done').length,
    invocations: rows.length,
    by_phase: {},
    results: {},
    packets: {},
    sources: {},
    repeated: { characters: 0, repeated_characters: 0, by_source: {} },
    replans: 0,
    reviews: { approve: 0, reject: 0, other: 0, reject_tokens: 0 },
    rework: { develop_attempts_after_first: 0, develop_tokens_after_first: 0 },
    retries: { automatic: rows.filter((r) => r.automatic_retry).length, task_total: 0, attempts_after_first: 0 },
    rotations: { task_total: 0, stalled: 0, context_limit_rows: 0, context_limit_tokens: 0 },
    failures: { timed_out: 0, rate_limited: 0, error: 0, interrupted: 0, tokens: 0 },
    waits: { gaps: [], long_waits: 0, long_wait_ms: 0, check_ms: 0 },
    streams: { sessions: 0, packet_resent_tokens: 0, model_calls: 0, subagent_calls: 0, context_tokens: 0, baseline_resent_tokens: 0, baselines: [], max_context: [], above: {}, tools: {}, result_resent: {}, large_results: 0, large_result_resent_tokens: 0, tool_result_characters: 0, reads: 0, repeated_reads: 0, repeated_read_characters: 0, repeated_commands: 0, covered: 0 },
  };
  const seen = new Set();
  let previousEnd = null, plans = 0;
  const firstAttempt = new Map();
  for (const row of rows) {
    const phase = PHASES.includes(row.phase) ? row.phase : 'other';
    const p = (run.by_phase[phase] ||= { invocations: 0, input_tokens: 0, input_covered: 0, input_from_stream: 0, output_tokens: 0, duration_ms: 0, model_calls: 0, calls_covered: 0 });
    p.invocations++;
    // A session stopped at the context limit is killed before the provider
    // reports usage; its stream still records every request, so the stream
    // total stands in for the missing ledger figure (never added twice).
    const stream = row.provider === 'claude' ? readRegular(join(dir, `call-${row.id}-stream.json`)) : null;
    const s = stream == null ? null : streamStats(stream);
    const ledgerInput = inputOf(row), output = outputOf(row);
    const input = ledgerInput ?? s?.context_tokens_total ?? null;
    if (input != null) { p.input_tokens += input; p.input_covered++; if (ledgerInput == null) p.input_from_stream++; }
    if (row.context_limit_reached && input != null) run.rotations.context_limit_tokens += input;
    if (count(row.prompt_characters) && s?.model_calls) run.streams.packet_resent_tokens += Math.ceil(row.prompt_characters / 4) * s.model_calls;
    if (output != null) p.output_tokens += output;
    if (count(row.duration_ms)) p.duration_ms += row.duration_ms;
    if (count(row.calls) && row.calls_source === 'unique assistant message IDs in provider stream') { p.model_calls += row.calls; p.calls_covered++; }
    add(run.results, code(row.result));
    if (count(row.prompt_characters)) (run.packets[phase] ||= []).push(row.prompt_characters);
    for (const s of Array.isArray(row.context_sources) ? row.context_sources : [])
      if (count(s?.characters)) add(run.sources, label(s.source), s.characters);
    if (row.timed_out) run.failures.timed_out++;
    if (row.rate_limited) run.failures.rate_limited++;
    if (row.context_limit_reached) run.rotations.context_limit_rows++;
    // Context-limit stops are rotations, counted above; the rest are failures.
    if ((row.result === 'error' && !row.context_limit_reached) || row.result === 'interrupted') {
      run.failures[row.result]++;
      if (input != null) run.failures.tokens += input;
    }
    if (phase === 'plan' && ++plans > 1) run.replans++;
    if (phase === 'develop' && typeof row.task === 'string') {
      const first = firstAttempt.get(row.task);
      if (first == null) firstAttempt.set(row.task, row.attempt);
      else if (count(row.attempt) && row.attempt > first) {
        run.rework.develop_attempts_after_first++;
        if (input != null) run.rework.develop_tokens_after_first += input;
      }
    }
    if (phase === 'review') {
      const status = readJson(join(dir, `call-${row.id}-result.json`))?.status;
      run.reviews[status === 'approve' ? 'approve' : status === 'reject' ? 'reject' : 'other']++;
      if (status === 'reject' && input != null) run.reviews.reject_tokens += input;
    }
    const start = Date.parse(row.started_at), end = Date.parse(row.at);
    if (previousEnd != null && Number.isFinite(start) && start >= previousEnd) {
      const gap = start - previousEnd;
      run.waits.gaps.push(gap);
      if (gap >= LONG_WAIT_MS) { run.waits.long_waits++; run.waits.long_wait_ms += gap; }
    }
    if (Number.isFinite(end)) previousEnd = end;
    // Repeated context: packet keys and instruction lines already sent
    // earlier in this run, compared by hash only.
    const prompt = readRegular(join(dir, `call-${row.id}-prompt.txt`));
    if (prompt != null) {
      const { instructions, packet } = promptParts(prompt);
      const parts = [
        ...instructions.map((line) => ['instructions', line]),
        ...Object.entries(packet || {}).map(([key, value]) => [key, JSON.stringify(value)]),
      ];
      for (const [key, text] of parts) {
        const source = label(key), digest = hash(`${source}\0${text}`);
        const entry = (run.repeated.by_source[source] ||= { characters: 0, repeated_characters: 0 });
        entry.characters += text.length;
        run.repeated.characters += text.length;
        if (seen.has(digest)) { entry.repeated_characters += text.length; run.repeated.repeated_characters += text.length; }
        seen.add(digest);
      }
    }
    if (s) {
      const r = run.streams;
      r.sessions++;
      r.model_calls += s.model_calls;
      r.subagent_calls += s.subagent_calls;
      if (s.context_tokens_total != null && s.baseline_resent_tokens != null) {
        r.covered++;
        r.context_tokens += s.context_tokens_total;
        r.baseline_resent_tokens += s.baseline_resent_tokens;
        r.baselines.push(s.baseline_tokens);
        r.max_context.push(s.max_context_tokens);
        for (const [t, n] of Object.entries(s.tokens_above)) add(r.above, t, n);
      }
      for (const [name, n] of Object.entries(s.tools)) add(r.tools, name, n);
      r.tool_result_characters += s.tool_result_characters;
      for (const [name, n] of Object.entries(s.tool_result_resent_tokens)) add(r.result_resent, name, n);
      r.large_results += s.large_results.results;
      r.large_result_resent_tokens += s.large_results.resent_tokens;
      r.reads += s.reads;
      r.repeated_reads += s.repeated_reads;
      r.repeated_read_characters += s.repeated_read_characters;
      r.repeated_commands += s.repeated_commands;
    }
  }
  for (const t of tasks) {
    if (count(t?.provider_retries?.total)) run.retries.task_total += t.provider_retries.total;
    if (count(t?.attempts) && t.attempts > 1) run.retries.attempts_after_first += t.attempts - 1;
    if (count(t?.rotations)) run.rotations.task_total += t.rotations;
    if (count(t?.stalled_rotations)) run.rotations.stalled += t.stalled_rotations;
    for (const v of Array.isArray(t?.validation) ? t.validation : []) if (count(v?.duration_ms)) run.waits.check_ms += v.duration_ms;
  }
  return run;
}

export function distribution(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, sum: 0, mean: null, p50: null, p90: null, max: null };
  const at = (q) => v[Math.min(v.length - 1, Math.ceil(q * v.length) - 1)];
  const sum = v.reduce((a, b) => a + b, 0);
  return { n: v.length, sum, mean: Math.round(sum / v.length), p50: at(0.5), p90: at(0.9), max: v[v.length - 1] };
}
const share = (part, whole) => (whole > 0 ? Math.round((1000 * part) / whole) / 10 : null);

// Many anonymous run metrics -> one public-safe aggregate.
export function aggregateAudit(runs, { projects = null } = {}) {
  runs = runs.filter(Boolean);
  const sum = (f) => runs.reduce((n, r) => n + (f(r) || 0), 0);
  const merge = (f) => { const out = {}; for (const r of runs) for (const [k, v] of Object.entries(f(r) || {})) add(out, k, v); return out; };
  const byPhase = {};
  for (const r of runs) for (const [phase, p] of Object.entries(r.by_phase)) {
    const t = (byPhase[phase] ||= { invocations: 0, input_tokens: 0, input_covered: 0, input_from_stream: 0, output_tokens: 0, duration_ms: 0, model_calls: 0, calls_covered: 0 });
    for (const k of Object.keys(t)) t[k] += p[k] || 0;
  }
  const input = Object.values(byPhase).reduce((n, p) => n + p.input_tokens, 0);
  const sources = merge((r) => r.sources);
  const sourceTotal = Object.values(sources).reduce((a, b) => a + b, 0);
  const repeatedBy = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.repeated.by_source)) {
    const t = (repeatedBy[k] ||= { characters: 0, repeated_characters: 0 });
    t.characters += v.characters; t.repeated_characters += v.repeated_characters;
  }
  const repeatedChars = sum((r) => r.repeated.characters), repeatedRepeated = sum((r) => r.repeated.repeated_characters);
  const streamContext = sum((r) => r.streams.context_tokens), baselineResent = sum((r) => r.streams.baseline_resent_tokens);
  const packets = {};
  for (const phase of [...PHASES, 'other']) {
    const values = runs.flatMap((r) => r.packets[phase] || []);
    if (values.length) packets[phase] = distribution(values);
  }
  const reviews = { approve: sum((r) => r.reviews.approve), reject: sum((r) => r.reviews.reject), other: sum((r) => r.reviews.other), reject_input_tokens: sum((r) => r.reviews.reject_tokens) };
  const gaps = runs.flatMap((r) => r.waits.gaps);
  return {
    scope: {
      runs: runs.length,
      ...(projects == null ? {} : { projects }),
      invocations: sum((r) => r.invocations),
      tasks: sum((r) => r.tasks),
      tasks_done: sum((r) => r.tasks_done),
      ledger_warnings: sum((r) => r.ledger_warnings),
      run_status: merge((r) => ({ [r.status]: 1 })),
      stop_codes: merge((r) => (r.stop_code ? { [r.stop_code]: 1 } : {})),
      providers: merge((r) => ({ [r.provider]: 1 })),
    },
    tokens: {
      by_phase: Object.fromEntries(Object.entries(byPhase).map(([phase, p]) => [phase, { ...p, input_share_percent: share(p.input_tokens, input) }])),
      input_tokens_including_cache: input,
      output_tokens: Object.values(byPhase).reduce((n, p) => n + p.output_tokens, 0),
    },
    packets: {
      prompt_characters: packets,
      sources_characters: Object.fromEntries(Object.entries(sources).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { characters: v, share_percent: share(v, sourceTotal) }])),
    },
    repeated_context: {
      across_invocations: {
        characters: repeatedChars,
        repeated_characters: repeatedRepeated,
        repeated_percent: share(repeatedRepeated, repeatedChars),
        by_source: Object.fromEntries(Object.entries(repeatedBy).sort((a, b) => b[1].repeated_characters - a[1].repeated_characters)
          .map(([k, v]) => [k, { ...v, repeated_percent: share(v.repeated_characters, v.characters) }])),
      },
      within_sessions: {
        sessions_covered: sum((r) => r.streams.covered),
        sessions_seen: sum((r) => r.streams.sessions),
        model_calls: sum((r) => r.streams.model_calls),
        subagent_calls: sum((r) => r.streams.subagent_calls),
        context_tokens: streamContext,
        baseline_resent_tokens: baselineResent,
        baseline_share_percent: share(baselineResent, streamContext),
        packet_resent_tokens_estimate: sum((r) => r.streams.packet_resent_tokens),
        packet_share_percent: share(sum((r) => r.streams.packet_resent_tokens), streamContext),
        baseline_tokens: distribution(runs.flatMap((r) => r.streams.baselines)),
        max_context_tokens: distribution(runs.flatMap((r) => r.streams.max_context)),
        tokens_in_calls_above: Object.fromEntries(Object.entries(merge((r) => r.streams.above)).map(([t, n]) => [t, { tokens: n, share_percent: share(n, streamContext) }])),
        tool_uses: Object.fromEntries(Object.entries(merge((r) => r.streams.tools)).sort((a, b) => b[1] - a[1])),
        tool_result_characters: sum((r) => r.streams.tool_result_characters),
        tool_result_resent_tokens_estimate: Object.fromEntries(Object.entries(merge((r) => r.streams.result_resent)).sort((a, b) => b[1] - a[1])),
        tool_result_share_percent: share(Object.values(merge((r) => r.streams.result_resent)).reduce((a, b) => a + b, 0), streamContext),
        large_results: { threshold_characters: LARGE_RESULT_CHARS, results: sum((r) => r.streams.large_results), resent_tokens_estimate: sum((r) => r.streams.large_result_resent_tokens), share_percent: share(sum((r) => r.streams.large_result_resent_tokens), streamContext) },
        reads: sum((r) => r.streams.reads),
        repeated_reads: sum((r) => r.streams.repeated_reads),
        repeated_read_characters: sum((r) => r.streams.repeated_read_characters),
        repeated_commands: sum((r) => r.streams.repeated_commands),
      },
    },
    rotations: {
      task_total: sum((r) => r.rotations.task_total),
      stalled: sum((r) => r.rotations.stalled),
      context_limit_invocations: sum((r) => r.rotations.context_limit_rows),
      context_limit_input_tokens: sum((r) => r.rotations.context_limit_tokens),
      context_limit_share_percent: share(sum((r) => r.rotations.context_limit_tokens), input),
    },
    retries: {
      automatic_provider_retries: sum((r) => r.retries.automatic),
      task_provider_retries: sum((r) => r.retries.task_total),
      implementation_attempts_after_first: sum((r) => r.retries.attempts_after_first),
      develop_invocations_after_first_attempt: sum((r) => r.rework.develop_attempts_after_first),
      develop_tokens_after_first_attempt: sum((r) => r.rework.develop_tokens_after_first),
    },
    reviews: { ...reviews, rejection_percent: share(reviews.reject, reviews.approve + reviews.reject) },
    replans: { extra_plan_invocations: sum((r) => r.replans), runs_with_replans: runs.filter((r) => r.replans > 0).length },
    failures: {
      results: merge((r) => r.results),
      timed_out: sum((r) => r.failures.timed_out),
      rate_limited: sum((r) => r.failures.rate_limited),
      error: sum((r) => r.failures.error),
      interrupted: sum((r) => r.failures.interrupted),
      input_tokens_in_failed_invocations: sum((r) => r.failures.tokens),
    },
    idle: {
      gaps_ms: distribution(gaps),
      long_wait_threshold_ms: LONG_WAIT_MS,
      long_waits: sum((r) => r.waits.long_waits),
      long_wait_ms: sum((r) => r.waits.long_wait_ms),
      recorded_check_ms: sum((r) => r.waits.check_ms),
      invocation_ms: Object.values(byPhase).reduce((n, p) => n + p.duration_ms, 0),
    },
  };
}

export function audit(roots, options = {}) {
  const found = findRunDirs(roots, options);
  const runs = found.map(({ dir }) => auditRun(dir)).filter(Boolean);
  return aggregateAudit(runs, { projects: new Set(found.map((f) => f.project)).size });
}

function parseArgs(argv) {
  const out = { roots: [], days: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) out.roots.push(argv[++i]);
    else if (a === '--days' && /^\d{1,4}$/.test(argv[i + 1] || '')) out.days = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  if (!out.roots.length) throw new Error('Pass at least one --root <project or folder of projects>.');
  return out;
}

function text(report) {
  const k = (n) => (n == null ? 'n/a' : n.toLocaleString('en-US'));
  const w = report.repeated_context.within_sessions, a = report.repeated_context.across_invocations;
  return [
    `runs ${k(report.scope.runs)} (projects ${k(report.scope.projects)}), invocations ${k(report.scope.invocations)}, tasks ${k(report.scope.tasks_done)}/${k(report.scope.tasks)} done`,
    `input tokens incl. cache ${k(report.tokens.input_tokens_including_cache)}, output ${k(report.tokens.output_tokens)}`,
    ...Object.entries(report.tokens.by_phase).map(([p, v]) => `  ${p}: ${k(v.invocations)} invocations, ${k(v.input_tokens)} input (${v.input_share_percent ?? 'n/a'}%), ${k(v.model_calls)} model calls`),
    ...Object.entries(report.packets.prompt_characters).map(([p, d]) => `prompt chars ${p}: p50 ${k(d.p50)} p90 ${k(d.p90)} max ${k(d.max)}`),
    `repeated across invocations: ${a.repeated_percent ?? 'n/a'}% of ${k(a.characters)} prompt characters`,
    `baseline resent within sessions: ${w.baseline_share_percent ?? 'n/a'}% of ${k(w.context_tokens)} context tokens (${k(w.sessions_covered)} sessions, ${k(w.model_calls)} model calls); packet share ${w.packet_share_percent ?? 'n/a'}%`,
    `context-limit sessions: ${k(report.rotations.context_limit_invocations)} using ${k(report.rotations.context_limit_input_tokens)} input tokens (${report.rotations.context_limit_share_percent ?? 'n/a'}%)`,
    `rework: ${k(report.retries.develop_invocations_after_first_attempt)} develop invocations after the first attempt, ${k(report.retries.develop_tokens_after_first_attempt)} input tokens; rejected reviews ${k(report.reviews.reject_input_tokens)}`,
    `tool results resent: ${w.tool_result_share_percent ?? 'n/a'}% of context tokens; results >= ${k(w.large_results.threshold_characters)} chars: ${k(w.large_results.results)} (${w.large_results.share_percent ?? 'n/a'}%)`,
    `repeated reads ${k(w.repeated_reads)}/${k(w.reads)} (${k(w.repeated_read_characters)} chars), repeated commands ${k(w.repeated_commands)}`,
    `rotations ${k(report.rotations.task_total)}, automatic retries ${k(report.retries.automatic_provider_retries)}, attempts after first ${k(report.retries.implementation_attempts_after_first)}`,
    `reviews approve ${k(report.reviews.approve)} reject ${k(report.reviews.reject)} (${report.reviews.rejection_percent ?? 'n/a'}%), extra plans ${k(report.replans.extra_plan_invocations)}`,
    `failed invocations: timeout ${k(report.failures.timed_out)}, rate limit ${k(report.failures.rate_limited)}, error ${k(report.failures.error)}, interrupted ${k(report.failures.interrupted)}`,
    `idle gaps p50 ${k(report.idle.gaps_ms.p50)} ms, long waits ${k(report.idle.long_waits)} (${k(report.idle.long_wait_ms)} ms)`,
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = audit(args.roots, { days: args.days });
    console.log(args.json ? JSON.stringify(report, null, 2) : text(report));
  } catch (error) {
    console.error(`efficiency-audit: ${error.message}`);
    process.exit(1);
  }
}
