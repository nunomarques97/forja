import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnoseRun, summarizeTrace } from '../lib/core/diagnose.mjs';

const root = mkdtempSync(join(tmpdir(), 'forja-diagnose-'));
after(() => rmSync(root, { recursive: true, force: true }));
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
const start = { kind: 'start', version: 1, provider: 'codex' };
const end = { kind: 'end', dropped_events: 0, unparsed_lines: 0 };
const event = (sequence, elapsed_ms, type, item) => ({ kind: 'event', sequence, elapsed_ms, type, ...(item ? { item } : {}) });
const item = (id, type, status, exit_code = null) => ({ id, type, status, exit_code });

test('diagnostic unions overlapping observed tool intervals without calling gaps inference time', () => {
  const trace = jsonl([start,
    event(1, 10, 'turn.started'),
    event(2, 20, 'item.started', item('a', 'command_execution', 'in_progress')),
    event(3, 40, 'item.started', item('b', 'file_change', 'in_progress')),
    event(4, 60, 'item.completed', item('a', 'command_execution', 'completed', 1)),
    event(5, 80, 'item.completed', item('b', 'file_change', 'completed')),
    event(6, 150, 'item.completed', item('c', 'agent_message', null)), end]);
  const r = summarizeTrace(trace, { provider: 'codex', durationMs: 200 });
  assert.equal(r.coverage, 'recorded');
  assert.deepEqual(r.tools.command_execution, { observed: 1, finished: 1, failed: 1, open: 0 });
  assert.equal(r.tools.file_change.finished, 1);
  assert.equal(r.first_file_change_ms, 80);
  assert.equal(r.first_tool_start_ms, 20);
  assert.equal(r.last_tool_finish_ms, 80);
  assert.equal(r.observed_tool_span_ms, 60);
  assert.equal(r.outside_observed_tool_spans_ms, 140);
  assert.equal(r.last_event_ms, 150);
  assert.equal(r.after_last_event_ms, 50);
});

test('duplicate events do not double count and unfinished tools remain open', () => {
  const r = summarizeTrace(jsonl([start,
    event(1, 0, 'item.started', item('a', 'command_execution', 'in_progress')),
    event(2, 5, 'item.updated', item('a', 'command_execution', 'in_progress')),
    event(3, 10, 'item.completed', item('a', 'command_execution', 'completed', 0)),
    event(4, 11, 'item.completed', item('a', 'command_execution', 'completed', 0)),
    event(5, 12, 'item.started', item('b', 'file_change', 'in_progress')),
  ]), { provider: 'codex', durationMs: 30 });
  assert.equal(r.tools.command_execution.finished, 1);
  assert.equal(r.tools.file_change.open, 1);
  assert.equal(r.observed_tool_span_ms, 10);
  assert.equal(r.coverage, 'partial');
  assert.ok(r.warnings.includes('missing_end_record'));
});

test('malformed, out-of-order and orphaned events are explicit partial observations', () => {
  const r = summarizeTrace(jsonl([start,
    event(1, 20, 'item.started', item('a', 'command_execution', 'in_progress')),
    event(2, 10, 'item.completed', item('a', 'command_execution', 'completed', 0)),
    event(4, 30, 'item.completed', item('b', 'file_change', 'failed')),
    { kind: 'event', sequence: 5, elapsed_ms: -1, type: 'item.started' },
    { ...end, dropped_events: 4, unparsed_lines: 1 },
  ]) + '{broken PRIVATE', { provider: 'codex', durationMs: 25 });
  assert.equal(r.coverage, 'partial');
  assert.equal(r.tools.command_execution.open, 1);
  assert.equal(r.tools.file_change.failed, 1);
  assert.equal(r.observed_tool_span_ms, 0);
  assert.equal(r.outside_observed_tool_spans_ms, null);
  for (const w of ['clock_order', 'sequence_gap', 'invalid_record', 'missing_tool_start', 'dropped_events', 'unparsed_provider_lines', 'duration_conflict']) assert.ok(r.warnings.includes(w), w);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
});

test('unsupported providers and missing headers never report zero tools as measured', () => {
  for (const text of [jsonl([{ ...start, provider: 'claude' }, end]), jsonl([end]), jsonl([{ ...start, version: 99 }, end])]) {
    const r = summarizeTrace(text, { provider: 'claude' });
    assert.equal(r.tools, null);
    assert.equal(r.observed_tool_span_ms, null);
    assert.notEqual(r.coverage, 'recorded');
  }
});

function fixture(name, rows = [], pending = null) {
  const project = join(root, name), dir = join(project, '.forja', 'runs', 'F-test');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, '.forja/current.json'), JSON.stringify({ version: 1, run_id: 'F-test', status: pending ? 'running' : 'failed', invocations: 2, pending }));
  writeFileSync(join(dir, 'usage.jsonl'), jsonl(rows));
  return { project, dir };
}
const row = { id: 1, phase: 'develop', provider: 'codex', duration_ms: 100, result: 'error', timed_out: true };

test('report reads only fixed metadata paths, preserves files and handles legacy missing journals', () => {
  const f = fixture('metadata', [{ ...row, events_log: '../PRIVATE', error: 'PRIVATE_ERROR' }, { id: 2, result: 'returned', provider: 'codex', phase: 'review' }]);
  writeFileSync(join(f.dir, 'call-1-events.jsonl'), jsonl([start, event(1, 90, 'turn.started'), end]));
  const before = readFileSync(join(f.project, '.forja/current.json'));
  const r = diagnoseRun(f.project);
  assert.equal(r.invocations[0].outcome, 'timeout');
  assert.equal(r.invocations[0].trace.after_last_event_ms, 10);
  assert.equal(r.invocations[1].trace.coverage, 'unavailable');
  assert.ok(r.invocations[1].trace.warnings.includes('missing_file'));
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|prompt|source code/i);
  assert.equal(JSON.stringify(r).includes(f.project), false);
  assert.deepEqual(readFileSync(join(f.project, '.forja/current.json')), before);
});

test('active and interrupted snapshots retain partial evidence without fabricating elapsed time', () => {
  const f = fixture('active', [{ ...row, result: 'interrupted', timed_out: false, duration_ms: null }], { id: 2, phase: 'review', provider: 'codex' });
  writeFileSync(join(f.dir, 'call-2-events.jsonl'), jsonl([start, event(1, 50, 'item.started', item('a', 'command_execution', 'in_progress'))]));
  const r = diagnoseRun(f.project);
  assert.equal(r.invocations[0].outcome, 'interrupted');
  assert.equal(r.invocations[1].outcome, 'pending');
  assert.equal(r.invocations[1].trace.tools.command_execution.open, 1);
  assert.equal(r.invocations[1].trace.after_last_event_ms, null);
});

test('settled ledger entries beat interrupted duplicates and a stale pending marker', () => {
  const f = fixture('duplicate-ledger', [row, { ...row, result: 'interrupted' }], { id: 1, provider: 'codex' });
  const r = diagnoseRun(f.project);
  assert.equal(r.invocations.length, 1);
  assert.equal(r.invocations[0].outcome, 'timeout');
});

test('oversized files and malformed ledger lines are bounded and observable', () => {
  const f = fixture('bounded', [row]);
  writeFileSync(join(f.dir, 'call-1-events.jsonl'), 'x'.repeat(4 * 1024 * 1024 + 1));
  writeFileSync(join(f.dir, 'usage.jsonl'), jsonl([row]) + '{broken PRIVATE\n');
  const r = diagnoseRun(f.project);
  assert.ok(r.warnings.includes('invalid_ledger_records'));
  assert.ok(r.invocations[0].trace.warnings.includes('file_limit'));
  assert.equal(r.invocations[0].trace.tools, null);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
});

test('untrusted paths and symlinks cannot redirect the report outside the project', t => {
  const f = fixture('paths', [row]);
  writeFileSync(join(f.project, '.forja/current.json'), JSON.stringify({ version: 1, run_id: '../PRIVATE' }));
  assert.throws(() => diagnoseRun(f.project), /Invalid Core diagnostic state/);
  const g = fixture('links', [row]);
  const outside = join(root, 'outside.txt'); writeFileSync(outside, 'PRIVATE');
  try { symlinkSync(outside, join(g.dir, 'call-1-events.jsonl'), 'file'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip('File symlinks unavailable'); throw e; }
  const r = diagnoseRun(g.project);
  assert.equal(r.invocations[0].trace.coverage, 'unavailable');
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|outside\.txt/);
});

test('CLI diagnose is read-only and needs neither provider nor Git setup', () => {
  const f = fixture('cli', [row]);
  const before = readdirSync(f.dir).sort();
  const cli = fileURLToPath(new URL('../bin/forja.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'core', 'diagnose', '--project', f.project], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).invocations[0].outcome, 'timeout');
  assert.deepEqual(readdirSync(f.dir).sort(), before);
});

test('journal count mismatches and data after end cannot masquerade as recorded coverage', () => {
  const r = summarizeTrace(jsonl([start, event(1, 0, 'turn.started'), { ...end, recorded_events: 2 },
    event(2, 20, 'item.completed', item('a', 'file_change', 'completed')),
  ]), { provider: 'codex', durationMs: 40 });
  assert.equal(r.coverage, 'partial');
  assert.ok(r.warnings.includes('record_count_mismatch'));
  assert.ok(r.warnings.includes('invalid_record'));
  assert.equal(r.tools.file_change.observed, 0);
  assert.equal(r.last_event_ms, 0);
});

test('trace projection never copies content, IDs, unknown types or arbitrary error strings', () => {
  const r = summarizeTrace(jsonl([start,
    { ...event(1, 0, 'item.started', { ...item('PRIVATE_ID', 'command_execution', 'in_progress'), command: 'PRIVATE_COMMAND', aggregated_output: 'PRIVATE_TEXT', path: 'PRIVATE_PATH' }), message: 'PRIVATE_MESSAGE' },
    event(2, 10, 'PRIVATE_EVENT'),
    event(3, 20, 'item.completed', item('b', 'PRIVATE_TYPE', 'PRIVATE_STATUS')),
    end,
  ]), { provider: 'codex' });
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  assert.equal(r.coverage, 'partial');
  assert.equal(r.tools.command_execution.open, 1);
});

test('conflicting terminal events are flagged without counting a second operation', () => {
  const r = summarizeTrace(jsonl([start,
    event(1, 0, 'item.started', item('a', 'command_execution', 'in_progress')),
    event(2, 1, 'item.completed', item('a', 'command_execution', 'completed', 0)),
    event(3, 2, 'item.completed', item('a', 'command_execution', 'failed', 1)), end,
  ]), { provider: 'codex' });
  assert.equal(r.tools.command_execution.observed, 1);
  assert.equal(r.tools.command_execution.finished, 1);
  assert.ok(r.warnings.includes('conflicting_tool_event'));
});

test('event and whole-request limits stop analysis with explicit unknown coverage', () => {
  const r = summarizeTrace(jsonl([start, ...Array.from({ length: 10001 }, (_, n) => event(n + 1, n, 'turn.started')), end]), { provider: 'codex' });
  assert.ok(r.warnings.includes('event_limit'));
  const f = fixture('total-budget', Array.from({ length: 5 }, (_, n) => ({ ...row, id: n + 1 })));
  const text = jsonl([start, end]).padEnd(4 * 1024 * 1024, ' ');
  for (let id = 1; id <= 5; id++) writeFileSync(join(f.dir, `call-${id}-events.jsonl`), text);
  const report = diagnoseRun(f.project);
  assert.ok(report.invocations.at(-1).trace.warnings.includes('read_budget'));
  assert.equal(report.invocations.at(-1).trace.tools, null);
});
