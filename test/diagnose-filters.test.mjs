import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseRun } from '../lib/core/diagnose.mjs';
import { diagnosticFilters, INVALID_DIAGNOSTIC_FILTERS } from '../lib/core/diagnostic-filters.mjs';

const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
const start = { kind: 'start', version: 1, provider: 'codex' };
const end = { kind: 'end', dropped_events: 0, unparsed_lines: 0 };
const event = (sequence, elapsed_ms, type, item) => ({ kind: 'event', sequence, elapsed_ms, type, ...(item ? { item } : {}) });
const item = (id, type, status, exit_code = null) => ({ id, type, status, exit_code });
// The later contradictory completion is flagged, never merged (first accepted lifecycle wins).
const trace = jsonl([start,
  event(1, 5, 'item.started', item('a', 'command_execution', 'in_progress')),
  event(2, 9, 'item.completed', item('a', 'command_execution', 'completed', 0)),
  event(3, 12, 'item.completed', item('a', 'command_execution', 'failed', 1)), end]);

function project(t, { current = {}, ledger, traces = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'forja-diagnose-filters-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.forja/runs/F-filters');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, '.forja/current.json'), JSON.stringify({ version: 1, run_id: 'F-filters', status: 'running', ...current }));
  writeFileSync(join(dir, 'usage.jsonl'), jsonl(ledger));
  for (const [id, content] of Object.entries(traces)) {
    if (content === 'directory') mkdirSync(join(dir, `call-${id}-events.jsonl`));
    else writeFileSync(join(dir, `call-${id}-events.jsonl`), content);
  }
  return root;
}
const row = (id, phase, extra = {}) => ({ id, phase, provider: 'codex', result: 'returned', duration_ms: 50, ...extra });

// Records every path the diagnostic touches through node:fs, including its ESM named imports.
function watchFiles(t) {
  const seen = [];
  for (const name of ['openSync', 'lstatSync']) {
    const original = fs[name];
    fs[name] = (path, ...rest) => { seen.push(String(path)); return original(path, ...rest); };
    t.after(() => { fs[name] = original; syncBuiltinESMExports(); });
  }
  syncBuiltinESMExports();
  return seen;
}
const tracePaths = seen => seen.filter(p => /call-\d+-events\.jsonl$/.test(p));

test('invalid filters throw a fixed message before any project file access', t => {
  const secret = join(tmpdir(), 'PRIVATE-ROOT-does-not-exist');
  const seen = watchFiles(t);
  const invalid = [null, [], ['plan'], 'plan', 7, true, () => {},
    { invocationId: null }, { invocationId: '2' }, { invocationId: 0 }, { invocationId: 201 }, { invocationId: -1 },
    { invocationId: 1.5 }, { invocationId: NaN }, { invocationId: Infinity }, { invocationId: 2 ** 53 }, { invocationId: 2n },
    { invocationId: [2] }, { phase: null }, { phase: 'PRIVATE_PHASE' }, { phase: 'Plan' }, { phase: '' }, { phase: true },
    { phase: ['review'] }, { invocationId: 2, phase: 'PRIVATE_PHASE' }, { invocationId: 'PRIVATE_ID', phase: 'plan' }];
  for (const options of invalid) {
    assert.throws(() => diagnoseRun(secret, options), e => e instanceof Error && e.message === INVALID_DIAGNOSTIC_FILTERS
      && !/PRIVATE|does-not-exist/.test(e.message));
  }
  assert.deepEqual(seen, []);
  // Valid or absent filters on the same root reach the state read and fail differently.
  assert.throws(() => diagnoseRun(secret), /Invalid Core diagnostic state/);
  assert.throws(() => diagnoseRun(secret, { invocationId: 200, phase: 'review' }), /Invalid Core diagnostic state/);
});

test('absent options, empty options, undefined fields and unknown keys match the no-options report', t => {
  const root = project(t, { current: { invocations: 2 }, ledger: [row(1, 'plan'), row(2, 'develop')], traces: { 1: trace, 2: trace } });
  const base = diagnoseRun(root);
  assert.equal(base.invocations.length, 2);
  assert.deepEqual(base.invocations[0].trace.warnings, ['conflicting_tool_event']);
  for (const options of [undefined, {}, { invocationId: undefined }, { phase: undefined },
    { invocationId: undefined, phase: undefined }, { unknown: 'x', invocation: 1, Phase: 'plan' }]) {
    assert.deepEqual(diagnoseRun(root, options), base);
  }
  assert.deepEqual(diagnosticFilters(undefined), {});
  assert.deepEqual(diagnosticFilters({ invocationId: 200, phase: 'develop', other: null }), { invocationId: 200, phase: 'develop' });
});

test('global warnings and reconciliation use the complete ledger; filters combine with AND in id order', t => {
  const root = project(t, {
    current: { invocations: 7, pending: { id: 6, phase: 'review', provider: 'codex' } },
    ledger: [row(5, 'review'), row(2, 'develop', { result: 'interrupted' }), row(2, 'develop'), row(3, 'develop'),
      row(3, 'develop', { result: 'interrupted' }), row(1, 'plan'), row(201, 'review'), 'not an object'],
    traces: { 1: trace, 2: trace, 3: trace, 5: trace },
  });
  const all = diagnoseRun(root);
  assert.deepEqual([...all.warnings].sort(), ['invalid_ledger_records', 'invocation_limit', 'missing_invocation_records']);
  assert.deepEqual(all.invocations.map(x => [x.id, x.outcome]), [[1, 'returned'], [2, 'returned'], [3, 'returned'], [5, 'returned'], [6, 'pending']]);
  const byId = id => all.invocations.find(x => x.id === id);
  const select = options => diagnoseRun(root, options);

  assert.deepEqual(select({ invocationId: 1 }), { ...all, invocations: [byId(1)] });
  assert.deepEqual(select({ invocationId: 2 }).invocations, [byId(2)]);
  assert.deepEqual(select({ phase: 'develop' }), { ...all, invocations: [byId(2), byId(3)] });
  assert.deepEqual(select({ phase: 'review' }).invocations, [byId(5), byId(6)]);
  assert.deepEqual(select({ phase: 'review', invocationId: 6 }).invocations, [byId(6)]);
  assert.deepEqual(select({ phase: 'develop', invocationId: 3 }).invocations, [byId(3)]);
  assert.deepEqual(select({ phase: 'plan', invocationId: 2 }).invocations, []);
  // Id 201 is excluded by the ledger bound, so it can never be selected.
  assert.deepEqual(select({ invocationId: 200, phase: 'review' }).invocations, []);
});

test('no match keeps the report shape, global warnings and interpretation', t => {
  const root = project(t, { current: { invocations: 3 }, ledger: [row(1, 'plan'), row(2, 'develop')], traces: { 1: trace, 2: trace } });
  const all = diagnoseRun(root);
  assert.deepEqual(all.warnings, ['missing_invocation_records']);
  for (const options of [{ invocationId: 4 }, { phase: 'review' }, { invocationId: 1, phase: 'develop' }]) {
    const r = diagnoseRun(root, options);
    assert.deepEqual(Object.keys(r), Object.keys(all));
    assert.deepEqual(r, { ...all, invocations: [] });
  }
});

test('unselected traces are never opened and do not spend the request read budget', t => {
  // Four unselected traces fit their per-file limit but together leave < 4 KiB of the 16 MiB request budget.
  const big = 'x'.repeat(4 * 1024 * 1024 - 1024), padded = trace + '\n'.repeat(8192);
  const root = project(t, {
    current: { invocations: 6 },
    ledger: [row(1, 'plan'), row(2, 'develop'), row(3, 'develop'), row(4, 'develop'), row(5, 'review'), row(6, 'review')],
    traces: { 1: big, 2: big, 3: big, 4: big, 5: padded, 6: 'directory' },
  });
  const all = diagnoseRun(root);
  assert.deepEqual(all.invocations.map(x => x.trace.warnings[0]), ['missing_start_record', 'missing_start_record', 'missing_start_record', 'missing_start_record', 'read_budget', 'not_regular_file']);

  const seen = watchFiles(t);
  const one = diagnoseRun(root, { invocationId: 5 });
  assert.deepEqual(one.warnings, all.warnings);
  assert.equal(one.invocations.length, 1);
  assert.equal(one.invocations[0].trace.coverage, 'partial');
  assert.deepEqual(one.invocations[0].trace.warnings, ['conflicting_tool_event']);
  assert.ok(tracePaths(seen).length > 0 && tracePaths(seen).every(p => p.endsWith('call-5-events.jsonl')), tracePaths(seen).join(','));

  seen.length = 0;
  const review = diagnoseRun(root, { phase: 'review' });
  assert.deepEqual(review.invocations.map(x => [x.id, x.trace.warnings]), [[5, ['conflicting_tool_event']], [6, ['not_regular_file']]]);
  assert.ok(tracePaths(seen).every(p => /call-[56]-events\.jsonl$/.test(p)));

  // An unreadable unselected trace adds nothing to the selected invocation.
  assert.deepEqual(diagnoseRun(root, { invocationId: 4 }).invocations[0].trace.warnings, ['missing_start_record']);
});
