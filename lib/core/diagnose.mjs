// On-demand, read-only metadata diagnostics. Never read native session files or
// infer successful checks, model reasoning, token usage or handoffs from events.
import { openSync, closeSync, readSync, fstatSync, lstatSync } from 'node:fs';
import { inside } from './files.mjs';
import { parseUsageLedger } from './metrics.mjs';

const count = n => Number.isSafeInteger(n) && n >= 0;
const toolTypes = ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'];
const terminal = ['completed', 'failed', 'declined'];
const tool = type => ({ type, start: null, finish: null, failed: false, status: null, exit: null });
const eventTypes = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']);
const empty = warning => ({ coverage: 'unavailable', warnings: [warning], tools: null,
  first_event_ms: null, last_event_ms: null, first_tool_start_ms: null,
  first_file_change_ms: null, last_tool_finish_ms: null,
  observed_tool_span_ms: null, outside_observed_tool_spans_ms: null, after_last_event_ms: null });

export function summarizeTrace(text, { provider, durationMs } = {}) {
  const r = empty('missing_start_record'), warnings = new Set();
  const seen = new Map(), intervals = [];
  let header = false, ended = false, sequence = 0, time = 0, events = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { warnings.add('invalid_record'); continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { warnings.add('invalid_record'); continue; }
    if (row.kind === 'start') {
      if (header || events || ended) { warnings.add('invalid_record'); continue; }
      if (row.version !== 1 || row.provider !== 'codex' || provider !== 'codex') return empty('unsupported_trace');
      header = true;
      continue;
    }
    if (!header) { warnings.add('missing_start_record'); continue; }
    if (row.kind === 'end') {
      // Only a well-formed end closes the stream; a malformed one derives nothing.
      if (ended || !count(row.dropped_events) || !count(row.unparsed_lines)
        || (row.recorded_events !== undefined && !count(row.recorded_events))) { warnings.add('invalid_record'); continue; }
      ended = true;
      if (row.dropped_events > 0) warnings.add('dropped_events');
      if (row.unparsed_lines > 0) warnings.add('unparsed_provider_lines');
      if (row.recorded_events !== undefined && row.recorded_events !== events) warnings.add('record_count_mismatch');
      continue;
    }
    if (ended) { warnings.add('invalid_record'); continue; }
    if (row.kind !== 'event' || !count(row.elapsed_ms) || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
      warnings.add('invalid_record'); continue;
    }
    if (++events > 10000) { warnings.add('event_limit'); break; }
    if (row.sequence !== sequence + 1) warnings.add('sequence_gap');
    if (row.sequence <= sequence) continue;
    sequence = row.sequence;
    if (row.elapsed_ms < time) { warnings.add('clock_order'); continue; }
    time = row.elapsed_ms;
    r.first_event_ms ??= time;
    r.last_event_ms = time;
    if (!eventTypes.has(row.type)) { warnings.add('unknown_event_type'); continue; }
    const i = row.item;
    if (!row.type.startsWith('item.')) continue;
    if (!i || typeof i !== 'object') { warnings.add('invalid_record'); continue; }
    if (!toolTypes.includes(i.type)) {
      if (!['agent_message', 'reasoning', 'todo_list', 'error'].includes(i.type)) warnings.add('unknown_item_type');
      continue;
    }
    if (typeof i.id !== 'string' || !/^[\w-]{1,80}$/.test(i.id)) { warnings.add('invalid_record'); continue; }
    const done = row.type === 'item.completed';
    if (done ? !terminal.includes(i.status) : i.status !== 'in_progress') { warnings.add('unknown_tool_status'); continue; }
    let entry = seen.get(i.id);
    if (entry && entry.type !== i.type) { warnings.add('invalid_record'); continue; }
    // The first accepted lifecycle wins; contradictions are flagged, never merged.
    if (!done) {
      if (entry && (entry.finish !== null || (row.type === 'item.started' && entry.start !== null))) {
        warnings.add('conflicting_tool_event'); continue;
      }
      if (!entry) { entry = tool(i.type); seen.set(i.id, entry); }
      if (row.type === 'item.started') { entry.start = time; r.first_tool_start_ms ??= time; }
      continue;
    }
    const exit = Number.isSafeInteger(i.exit_code) ? i.exit_code : null;
    if (entry && entry.finish !== null) {
      if (entry.status !== i.status || entry.exit !== exit) warnings.add('conflicting_tool_event');
      continue;
    }
    if (!entry) { entry = tool(i.type); seen.set(i.id, entry); }
    entry.finish = time;
    entry.status = i.status;
    entry.exit = exit;
    entry.failed = i.status !== 'completed' || (exit !== null && exit !== 0);
    if (entry.start === null) warnings.add('missing_tool_start');
    else intervals.push([entry.start, time]);
    r.last_tool_finish_ms = time;
    if (i.type === 'file_change' && !entry.failed) r.first_file_change_ms ??= time;
  }
  if (!header) return empty('missing_start_record');
  if (!ended) warnings.add('missing_end_record');
  r.tools = Object.fromEntries(toolTypes.map(t => [t, { observed: 0, finished: 0, failed: 0, open: 0 }]));
  for (const e of seen.values()) {
    const t = r.tools[e.type]; t.observed++;
    if (e.finish === null) { t.open++; warnings.add('missing_tool_finish'); }
    else { t.finished++; if (e.failed) t.failed++; }
  }
  let span = 0, last = 0;
  for (const [a, b] of intervals.sort((a, b) => a[0] - b[0])) {
    span += Math.max(0, b - Math.max(a, last)); last = Math.max(last, b);
  }
  r.observed_tool_span_ms = span;
  if (count(durationMs) && r.last_event_ms !== null) {
    if (durationMs < r.last_event_ms) warnings.add('duration_conflict');
    else {
      r.outside_observed_tool_spans_ms = durationMs - span;
      r.after_last_event_ms = durationMs - r.last_event_ms;
    }
  }
  r.coverage = warnings.size ? 'partial' : 'recorded';
  r.warnings = [...warnings];
  return r;
}

// Limit each file and the complete request. Do not follow a final symlink;
// inside() also rejects ancestors resolving outside the selected project.
function readMetadata(root, name, budget, limit = 4 * 1024 * 1024) {
  let fd;
  try {
    const file = inside(root, name);
    if (!lstatSync(file).isFile()) return { warning: 'not_regular_file' };
    fd = openSync(file, 'r');
    const stat = fstatSync(fd), available = Math.min(limit, budget.left);
    if (!stat.isFile()) return { warning: 'not_regular_file' };
    if (stat.size > available) return { warning: budget.left < limit ? 'read_budget' : 'file_limit' };
    const buffer = Buffer.alloc(Math.min(stat.size + 1, available + 1));
    let bytes = 0, n;
    while (bytes < buffer.length && (n = readSync(fd, buffer, bytes, buffer.length - bytes, null))) bytes += n;
    budget.left -= bytes;
    if (bytes > stat.size) return { warning: 'file_changed_during_read' };
    return { text: buffer.subarray(0, bytes).toString('utf8') };
  } catch (e) { return { warning: e.code === 'ENOENT' ? 'missing_file' : 'unreadable_file' }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function diagnoseRun(root) {
  const budget = { left: 16 * 1024 * 1024 }, warnings = new Set();
  const state = readMetadata(root, '.forja/current.json', budget);
  let run;
  try { run = JSON.parse(state.text); } catch { throw new Error('Invalid Core diagnostic state'); }
  if (run?.version !== 1 || typeof run.run_id !== 'string' || run.run_id.length > 100 || !/^F-[A-Za-z0-9-]+$/.test(run.run_id) || !['running', 'blocked', 'done', 'failed'].includes(run.status)) throw new Error('Invalid Core diagnostic state');
  const prefix = `.forja/runs/${run.run_id}`;
  const ledger = readMetadata(root, `${prefix}/usage.jsonl`, budget);
  if (ledger.warning) warnings.add(`ledger_${ledger.warning}`);
  const parsed = parseUsageLedger(ledger.text ?? '');
  if (parsed.warnings.length) warnings.add('invalid_ledger_records');
  const rows = new Map();
  for (const row of parsed.rows) {
    if (row.id > 200) { warnings.add('invocation_limit'); continue; }
    const prior = rows.get(row.id);
    if (!prior || row.result !== 'interrupted') rows.set(row.id, row);
  }
  if (Number.isSafeInteger(run.pending?.id) && run.pending.id > 0 && run.pending.id <= 200 && !rows.has(run.pending.id)) rows.set(run.pending.id, { ...run.pending, result: 'pending' });
  if (count(run.invocations) && rows.size < run.invocations) warnings.add('missing_invocation_records');
  const invocations = [...rows.values()].sort((a, b) => a.id - b.id).map(row => {
    const file = readMetadata(root, `${prefix}/call-${row.id}-events.jsonl`, budget);
    return {
      id: row.id,
      phase: ['plan', 'develop', 'review'].includes(row.phase) ? row.phase : null,
      provider: ['codex', 'claude', 'custom'].includes(row.provider) ? row.provider : null,
      outcome: row.result === 'pending' ? 'pending' : row.result === 'interrupted' ? 'interrupted' : row.timed_out === true ? 'timeout' : row.result === 'returned' ? 'returned' : row.result === 'error' ? 'error' : 'unknown',
      duration_ms: count(row.duration_ms) ? row.duration_ms : null,
      trace: file.warning ? empty(file.warning) : summarizeTrace(file.text, { provider: row.provider, durationMs: row.duration_ms }),
    };
  });
  return { run: run.run_id, status: run.status, warnings: [...warnings], invocations,
    interpretation: 'Read-only snapshot of recorded stdout metadata. Recorded coverage does not mean all native tools were exposed. Tool spans are unions of matched start/finish receipt intervals; other time is unattributed, not idle or inference time. Open tools lack a recorded finish, not proof of a live process. File events do not prove correct edits; command success is not acceptance or review. Provider return is not an approved handoff. No usage is inferred.' };
}
