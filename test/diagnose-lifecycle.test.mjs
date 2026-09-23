import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseRun, summarizeTrace } from '../lib/core/diagnose.mjs';

const root = mkdtempSync(join(tmpdir(), 'forja-lifecycle-'));
after(() => rmSync(root, { recursive: true, force: true }));
const jsonl = rows => rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n';
const start = { kind: 'start', version: 1, provider: 'codex' };
const end = { kind: 'end', dropped_events: 0, unparsed_lines: 0 };
const vocabulary = new Set(['missing_start_record', 'unsupported_trace', 'invalid_record', 'dropped_events',
  'unparsed_provider_lines', 'record_count_mismatch', 'event_limit', 'sequence_gap', 'clock_order',
  'unknown_event_type', 'unknown_item_type', 'unknown_tool_status', 'conflicting_tool_event',
  'missing_tool_start', 'missing_tool_finish', 'missing_end_record', 'duration_conflict']);
const keys = ['coverage', 'warnings', 'tools', 'first_event_ms', 'last_event_ms', 'first_tool_start_ms',
  'first_file_change_ms', 'last_tool_finish_ms', 'observed_tool_span_ms', 'outside_observed_tool_spans_ms', 'after_last_event_ms'];

// Events are numbered automatically so every trace keeps a valid sequence.
function trace(steps, durationMs = 1000) {
  let sequence = 0;
  const rows = steps.map(s => Array.isArray(s)
    ? { kind: 'event', sequence: ++sequence, elapsed_ms: s[0], type: s[1], ...(s[2] ? { item: s[2] } : {}) }
    : s);
  const r = summarizeTrace(jsonl([start, ...rows]), { provider: 'codex', durationMs });
  assert.deepEqual(Object.keys(r), keys);
  for (const w of r.warnings) assert.ok(vocabulary.has(w), w);
  return r;
}
const cmd = (status, exit_code = null, id = 'a') => ({ id, type: 'command_execution', status, exit_code });
const file = (status, id = 'f') => ({ id, type: 'file_change', status });
const only = (r, ...w) => assert.deepEqual([...r.warnings].sort(), [...w].sort());

test('valid controls stay recorded, replay equivalent completions silently and union overlapping intervals', () => {
  const r = trace([
    [10, 'item.started', cmd('in_progress', null, 'a')],
    [20, 'item.started', cmd('in_progress', null, 'b')],
    [25, 'item.updated', cmd('in_progress', null, 'b')],
    [30, 'item.completed', cmd('completed', 0, 'b')],
    [40, 'item.started', cmd('in_progress', null, 'c')],
    [50, 'item.completed', cmd('completed', 0, 'a')],
    [55, 'item.completed', cmd('completed', 0, 'a')],
    [70, 'item.completed', cmd('failed', null, 'c')],
    [75, 'item.completed', { id: 'c', type: 'command_execution', status: 'failed' }],
    [100, 'item.started', file('in_progress')],
    [110, 'item.completed', file('completed')],
    end,
  ], 200);
  only(r);
  assert.equal(r.coverage, 'recorded');
  assert.deepEqual(r.tools.command_execution, { observed: 3, finished: 3, failed: 1, open: 0 });
  assert.equal(r.observed_tool_span_ms, 70); // [10,70] union [100,110]
  assert.equal(r.first_tool_start_ms, 10);
  assert.equal(r.last_tool_finish_ms, 110);
  assert.equal(r.first_file_change_ms, 110);
  assert.equal(r.outside_observed_tool_spans_ms, 130);
  assert.equal(r.after_last_event_ms, 90);
});

test('an unfinished tool keeps coverage partial even with a valid end record', () => {
  const r = trace([[10, 'item.started', cmd('in_progress')], [20, 'item.started', file('in_progress')],
    [30, 'item.completed', file('completed')], end]);
  only(r, 'missing_tool_finish');
  assert.equal(r.coverage, 'partial');
  assert.equal(r.tools.command_execution.open, 1);
  assert.equal(r.observed_tool_span_ms, 10);
  const updated = trace([[10, 'item.updated', cmd('in_progress')], end]);
  only(updated, 'missing_tool_finish');
  assert.equal(updated.tools.command_execution.open, 1);
});

test('invalid lifecycle statuses are rejected before creating or mutating a tool', () => {
  for (const [type, status] of [['item.started', 'completed'], ['item.started', null], ['item.started', undefined],
    ['item.updated', 'failed'], ['item.updated', 'PRIVATE_STATUS'], ['item.completed', 'in_progress'],
    ['item.completed', null], ['item.completed', 'PRIVATE_STATUS'], ['item.completed', 7]]) {
    const r = trace([[10, type, { id: 'PRIVATE_ID', type: 'command_execution', status, exit_code: 0 }], end]);
    only(r, 'unknown_tool_status');
    assert.equal(r.tools.command_execution.observed, 0, `${type} ${status}`);
    assert.equal(r.first_tool_start_ms, null);
    assert.equal(r.last_tool_finish_ms, null);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  }
  const r = trace([[10, 'item.started', cmd('in_progress')], [20, 'item.started', cmd('failed')],
    [30, 'item.updated', cmd('completed')], [40, 'item.completed', cmd('in_progress')],
    [50, 'item.completed', cmd('completed', 0)], [60, 'item.completed', cmd('bogus', 1)], end]);
  only(r, 'unknown_tool_status');
  assert.deepEqual(r.tools.command_execution, { observed: 1, finished: 1, failed: 0, open: 0 });
  assert.equal(r.first_tool_start_ms, 10);
  assert.equal(r.observed_tool_span_ms, 40);
});

test('a duplicate start is a conflict and keeps the first interval', () => {
  const r = trace([[10, 'item.started', cmd('in_progress')], [15, 'item.updated', cmd('in_progress')],
    [20, 'item.started', cmd('in_progress')], [30, 'item.completed', cmd('completed', 0)], end]);
  only(r, 'conflicting_tool_event');
  assert.equal(r.first_tool_start_ms, 10);
  assert.equal(r.observed_tool_span_ms, 20);
  assert.equal(r.tools.command_execution.observed, 1);
});

test('an update before the first start keeps the open entry and accepts that start', () => {
  const r = trace([[5, 'item.updated', cmd('in_progress')], [10, 'item.started', cmd('in_progress')],
    [30, 'item.completed', cmd('completed', 0)], end]);
  only(r);
  assert.equal(r.first_tool_start_ms, 10);
  assert.equal(r.observed_tool_span_ms, 20);
});

test('starts and updates after completion are conflicts that never reopen or move the lifecycle', () => {
  for (const type of ['item.started', 'item.updated']) {
    const r = trace([[10, 'item.started', cmd('in_progress')], [20, 'item.completed', cmd('failed', 2)],
      [40, type, cmd('in_progress')], [50, 'item.completed', cmd('failed', 2)], end]);
    only(r, 'conflicting_tool_event');
    assert.deepEqual(r.tools.command_execution, { observed: 1, finished: 1, failed: 1, open: 0 });
    assert.equal(r.first_tool_start_ms, 10);
    assert.equal(r.last_tool_finish_ms, 20);
    assert.equal(r.observed_tool_span_ms, 10);
  }
  // Orphan completion: a later start neither creates an interval nor a first start.
  const orphan = trace([[20, 'item.completed', file('completed')], [30, 'item.started', file('in_progress')], end]);
  only(orphan, 'missing_tool_start', 'conflicting_tool_event');
  assert.equal(orphan.first_tool_start_ms, null);
  assert.equal(orphan.observed_tool_span_ms, 0);
  assert.equal(orphan.first_file_change_ms, 20);
});

test('completions are idempotent only for the same status and normalized exit code', () => {
  const conflicts = [
    [cmd('failed', 1), cmd('declined', 1)],
    [cmd('completed', 0), cmd('completed', null)],
    [cmd('completed', 0), cmd('completed', 1)],
    [cmd('completed', 3), cmd('failed', 3)],
    [cmd('completed', 0), cmd('completed', 1.5)],
    [cmd('completed', 0), cmd('completed', '0')],
    [cmd('failed', 2 ** 53), cmd('failed', 0)],
  ];
  for (const [first, second] of conflicts) {
    const r = trace([[10, 'item.started', cmd('in_progress')], [20, 'item.completed', first],
      [30, 'item.completed', second], end]);
    only(r, 'conflicting_tool_event');
    assert.equal(r.last_tool_finish_ms, 20, JSON.stringify([first, second]));
    assert.equal(r.observed_tool_span_ms, 10);
    assert.deepEqual(r.tools.command_execution, { observed: 1, finished: 1, failed: first.status === 'completed' && first.exit_code === 0 ? 0 : 1, open: 0 });
  }
  // Non-safe-integer exit codes normalize to null, so these replays are equivalent.
  for (const [first, second] of [[cmd('completed', 1.5), cmd('completed', null)], [cmd('failed', '1'), cmd('failed', 2 ** 53)],
    [cmd('declined', -3), cmd('declined', -3)]]) {
    const r = trace([[10, 'item.started', cmd('in_progress')], [20, 'item.completed', first],
      [30, 'item.completed', second], end]);
    only(r);
    assert.equal(r.coverage, 'recorded');
    assert.equal(r.tools.command_execution.failed, first.status === 'completed' ? 0 : 1);
  }
});

test('conflicting file completions preserve the first file-change timestamp and failure count', () => {
  const ok = trace([[10, 'item.started', file('in_progress')], [20, 'item.completed', file('completed')],
    [30, 'item.completed', file('failed')], end]);
  only(ok, 'conflicting_tool_event');
  assert.equal(ok.first_file_change_ms, 20);
  assert.equal(ok.tools.file_change.failed, 0);
  const failed = trace([[10, 'item.started', file('in_progress')], [20, 'item.completed', file('declined')],
    [30, 'item.completed', file('completed')], end]);
  only(failed, 'conflicting_tool_event');
  assert.equal(failed.first_file_change_ms, null);
  assert.equal(failed.tools.file_change.failed, 1);
  assert.equal(failed.last_tool_finish_ms, 20);
});

test('each malformed end field is an invalid record that neither closes nor derives warnings', () => {
  const bad = [-1, 1.5, '0', null, 2 ** 53, undefined];
  const variants = [
    ...bad.map(v => ({ ...end, dropped_events: v })),
    ...bad.map(v => ({ ...end, unparsed_lines: v })),
    ...[-1, 1.5, '1', null, 2 ** 53].map(v => ({ ...end, recorded_events: v })),
    { ...end, dropped_events: 5, unparsed_lines: -1, recorded_events: 9 },
    { ...end, dropped_events: -1, unparsed_lines: 3, recorded_events: 9 },
    { ...end, dropped_events: 5, unparsed_lines: 3, recorded_events: 'PRIVATE' },
  ];
  for (const bogus of variants) {
    const r = trace([[10, 'item.started', cmd('in_progress')], bogus, [20, 'item.completed', cmd('completed', 0)]]);
    only(r, 'invalid_record', 'missing_end_record');
    assert.equal(r.tools.command_execution.finished, 1, JSON.stringify(bogus));
    assert.equal(r.last_event_ms, 20);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  }
});

test('a later valid end recovers after a malformed end and counts every accepted event', () => {
  const r = trace([[10, 'item.started', cmd('in_progress')], { ...end, unparsed_lines: -1 }, { ...end, recorded_events: null },
    [30, 'item.completed', cmd('completed', 0)], { ...end, recorded_events: 2 }]);
  only(r, 'invalid_record');
  assert.equal(r.observed_tool_span_ms, 20);
  const counted = trace([[10, 'turn.started'], { ...end, dropped_events: -1 }, [20, 'turn.completed'],
    { ...end, dropped_events: 1, unparsed_lines: 2, recorded_events: 3 }]);
  only(counted, 'invalid_record', 'dropped_events', 'unparsed_provider_lines', 'record_count_mismatch');
});

test('a mismatched valid end still closes; later records and duplicate ends are ignored', () => {
  const r = trace([[10, 'item.started', cmd('in_progress')], [20, 'item.completed', cmd('completed', 0)],
    { ...end, recorded_events: 5 }, [30, 'item.started', cmd('in_progress', null, 'late')],
    { ...end, dropped_events: 4, unparsed_lines: 1 }, { ...end, dropped_events: -1 }]);
  only(r, 'record_count_mismatch', 'invalid_record');
  assert.equal(r.tools.command_execution.observed, 1);
  assert.equal(r.last_event_ms, 20);
  const duplicate = trace([[10, 'turn.started'], end, end]);
  only(duplicate, 'invalid_record');
});

test('adversarial lifecycles never leak identifiers, statuses or content', () => {
  const secret = { command: 'PRIVATE_COMMAND', aggregated_output: 'PRIVATE_OUTPUT', message: 'PRIVATE_MESSAGE' };
  const r = trace([
    [10, 'item.started', { ...cmd('in_progress', null, 'PRIVATE_ID'), ...secret }],
    [20, 'item.started', { ...cmd('in_progress', null, 'PRIVATE_ID'), ...secret }],
    [30, 'item.updated', { ...cmd('PRIVATE_STATUS', null, 'PRIVATE_ID'), ...secret }],
    [40, 'item.completed', { ...cmd('failed', 1, 'PRIVATE_ID'), ...secret }],
    [50, 'item.completed', { ...cmd('declined', 'PRIVATE_EXIT', 'PRIVATE_ID'), ...secret }],
    [60, 'item.started', { ...cmd('in_progress', null, 'PRIVATE_OPEN'), ...secret }],
    { ...end, recorded_events: 'PRIVATE_COUNT' },
  ]);
  only(r, 'conflicting_tool_event', 'unknown_tool_status', 'missing_tool_finish', 'invalid_record', 'missing_end_record');
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
});

test('diagnoseRun projects lifecycle warnings per invocation and leaves .forja untouched', () => {
  const project = join(root, 'project'), dir = join(project, '.forja', 'runs', 'F-life');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, '.forja', 'current.json'), JSON.stringify({ version: 1, run_id: 'F-life', status: 'failed', invocations: 2 }));
  writeFileSync(join(dir, 'usage.jsonl'), jsonl([
    { id: 1, phase: 'develop', provider: 'codex', duration_ms: 100, result: 'returned', timed_out: false },
    { id: 2, phase: 'review', provider: 'codex', duration_ms: 100, result: 'returned', timed_out: false },
  ]));
  let n = 0;
  const ev = (elapsed_ms, type, item) => ({ kind: 'event', sequence: ++n, elapsed_ms, type, item });
  writeFileSync(join(dir, 'call-1-events.jsonl'), jsonl([start,
    ev(10, 'item.started', cmd('in_progress', null, 'PRIVATE_ID')),
    ev(20, 'item.completed', cmd('completed', 0, 'PRIVATE_ID')),
    ev(30, 'item.completed', cmd('failed', 0, 'PRIVATE_ID')),
    ev(40, 'item.started', cmd('in_progress', null, 'PRIVATE_OPEN')),
    { ...end, recorded_events: 4 }]));
  n = 0;
  writeFileSync(join(dir, 'call-2-events.jsonl'), jsonl([start,
    ev(10, 'item.started', file('in_progress')), ev(20, 'item.completed', file('completed')), { ...end, recorded_events: 2 }]));
  const snapshot = () => {
    const files = {};
    const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else files[p] = [readFileSync(p, 'utf8'), statSync(p).mtimeMs];
    } };
    walk(join(project, '.forja'));
    return files;
  };
  const before = snapshot();
  const report = diagnoseRun(project);
  assert.deepEqual(snapshot(), before);
  const [first, second] = report.invocations.map(i => i.trace);
  assert.deepEqual([...first.warnings].sort(), ['conflicting_tool_event', 'missing_tool_finish']);
  assert.equal(first.coverage, 'partial');
  assert.deepEqual(first.tools.command_execution, { observed: 2, finished: 1, failed: 0, open: 1 });
  assert.equal(first.observed_tool_span_ms, 10);
  assert.equal(second.coverage, 'recorded');
  assert.equal(second.first_file_change_ms, 20);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.equal(JSON.stringify(report).includes(project), false);
});
