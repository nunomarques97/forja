import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageLedger, summarizeUsage } from '../lib/core/metrics.mjs';
import { parseOutput } from '../lib/core/providers.mjs';

const row = (id, extra = {}) => ({
  id,
  phase: 'develop',
  task: 't1',
  provider: 'codex',
  result: 'ok',
  duration_ms: 10,
  usage: { input_tokens: 100, output_tokens: 5 },
  at: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const line = (r) => JSON.stringify(r);

test('complete log parses every row with no warnings', () => {
  const rows = [row(1), row(2), row(3, { provider: 'claude' })];
  const out = parseUsageLedger(rows.map(line).join('\n') + '\n');
  assert.deepEqual(out.rows, rows);
  assert.deepEqual(out.warnings, []);
});

test('empty, blank-only and missing input yield nothing', () => {
  for (const text of ['', '\n\n', '  \r\n\t\n', null, undefined])
    assert.deepEqual(parseUsageLedger(text), { rows: [], warnings: [] });
  assert.throws(() => parseUsageLedger(42), TypeError);
});

test('blank lines are ignored but keep one-based line numbers', () => {
  const text = `\n${line(row(1))}\n   \n\n{oops\n${line(row(2))}\n`;
  const out = parseUsageLedger(text);
  assert.deepEqual(
    out.rows.map((r) => r.id),
    [1, 2],
  );
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].line, 5);
});

test('CRLF line endings and a BOM are tolerated', () => {
  const text = '\uFEFF' + [row(1), row(2)].map(line).join('\r\n') + '\r\n';
  const out = parseUsageLedger(text);
  assert.deepEqual(
    out.rows.map((r) => r.id),
    [1, 2],
  );
  assert.deepEqual(out.warnings, []);
});

test('torn final row is skipped with a warning, earlier rows preserved', () => {
  const full = line(row(3));
  const torn = full.slice(0, full.length - 20); // process died mid-append
  const text = `${line(row(1))}\n${line(row(2))}\n${torn}`;
  const out = parseUsageLedger(text);
  assert.deepEqual(out.rows, [row(1), row(2)]);
  assert.equal(out.warnings.length, 1);
  assert.equal(out.warnings[0].line, 3);
  assert.match(out.warnings[0].message, /Malformed JSON/);
});

test('torn final row with trailing newline still reports the right line', () => {
  const torn = line(row(2)).slice(0, 15);
  const out = parseUsageLedger(`${line(row(1))}\n${torn}\n`);
  assert.deepEqual(out.rows, [row(1)]);
  assert.deepEqual(
    out.warnings.map((w) => w.line),
    [2],
  );
});

test('valid rows after a damaged row are preserved', () => {
  const text = [
    line(row(1)),
    '{"id":2,"phase":"dev',
    line(row(3)),
    '\u0000\u0000\u0000',
    line(row(4)),
  ].join('\n');
  const out = parseUsageLedger(text);
  assert.deepEqual(
    out.rows.map((r) => r.id),
    [1, 3, 4],
  );
  assert.deepEqual(
    out.warnings.map((w) => w.line),
    [2, 4],
  );
  for (const w of out.warnings) assert.equal(typeof w.message, 'string');
});

test('a torn row fused with the next row is skipped, not repaired', () => {
  const fused = line(row(2)).slice(0, 25) + line(row(3));
  const out = parseUsageLedger(`${line(row(1))}\n${fused}\n${line(row(4))}\n`);
  assert.deepEqual(
    out.rows.map((r) => r.id),
    [1, 4],
  );
  assert.deepEqual(
    out.warnings.map((w) => w.line),
    [2],
  );
});

test('non-object JSON values are rejected with warnings', () => {
  const text = ['null', '[1,2]', '"text"', '7', 'true', line(row(1))].join(
    '\n',
  );
  const out = parseUsageLedger(text);
  assert.deepEqual(
    out.rows.map((r) => r.id),
    [1],
  );
  assert.deepEqual(
    out.warnings.map((w) => w.line),
    [1, 2, 3, 4, 5],
  );
  for (const w of out.warnings) assert.match(w.message, /JSON object/);
});

test('invalid ids are rejected with warnings', () => {
  const bad = [
    {},
    { id: 0 },
    { id: -1 },
    { id: 1.5 },
    { id: '1' },
    { id: null },
    { id: true },
    { id: [1] },
    { id: NaN },
    { id: Number.MAX_SAFE_INTEGER + 1 },
  ];
  const text = [...bad.map(line), '{"id":1e400}', line(row(9))].join('\n');
  const out = parseUsageLedger(text);
  assert.deepEqual(
    out.rows.map((r) => r.id),
    [9],
  );
  assert.equal(out.warnings.length, bad.length + 1);
  assert.deepEqual(
    out.warnings.map((w) => w.line),
    Array.from({ length: bad.length + 1 }, (_, i) => i + 1),
  );
  for (const w of out.warnings) assert.match(w.message, /id/);
});

test('boundary ids and duplicate ids are retained as-is', () => {
  const rows = [
    row(1),
    row(Number.MAX_SAFE_INTEGER),
    row(1, { result: 'interrupted' }),
  ];
  const out = parseUsageLedger(rows.map(line).join('\n'));
  assert.deepEqual(out.rows, rows);
  assert.deepEqual(out.warnings, []);
});

test('recovered rows feed summarizeUsage without invented usage', () => {
  const text = `${line(row(1))}\n${line(row(2, { usage: null }))}\n{"id":3,"usage":{"input_tok`;
  const { rows, warnings } = parseUsageLedger(text);
  assert.equal(warnings.length, 1);
  const s = summarizeUsage(rows);
  assert.equal(s.totals.invocations, 2);
  assert.equal(s.totals.input_tokens_including_cache, 100);
  assert.equal(s.totals.input_covered_invocations, 1);
});

test('summarizeUsage behavior is unchanged: final result beats interrupted', () => {
  const s = summarizeUsage([
    row(1, { result: 'interrupted', usage: null }),
    row(1),
    row(2),
  ]);
  assert.equal(s.totals.invocations, 2);
  assert.equal(s.totals.input_tokens_including_cache, 200);
});

test('missing invocation records prevent apparently complete percentage attribution', () => {
  const report = summarizeUsage([row(1)], { expectedInvocations: 2 });
  assert.equal(report.totals.invocations, 2);
  assert.equal(report.totals.recorded_invocations, 1);
  assert.equal(report.totals.input_covered_invocations, 1);
  assert.equal(report.by_phase.develop.measured_input_share_percent, null);
});

test('native cost estimates preserve missing coverage and crash deduplication', () => {
  const native = parseOutput(
    'claude',
    JSON.stringify({
      type: 'result',
      total_cost_usd: 1.25,
      structured_output: { status: 'done' },
    }),
  );
  assert.equal(native.reported_cost_usd, 1.25);
  assert.equal(
    parseOutput(
      'claude',
      JSON.stringify({ type: 'result', total_cost_usd: -1 }),
    ).reported_cost_usd,
    null,
  );
  const report = summarizeUsage(
    [
      row(1, { reported_cost_usd: 1.25 }),
      row(1, { result: 'interrupted', reported_cost_usd: null }),
      row(2),
      row(3, { reported_cost_usd: 0 }),
    ],
    { expectedInvocations: 4 },
  );
  assert.equal(report.totals.reported_cost_usd, 1.25);
  assert.equal(report.totals.cost_covered_invocations, 2);
  assert.equal(report.totals.invocations, 4);
  assert.equal(summarizeUsage([row(1)]).totals.reported_cost_usd, null);
});

const attributed = () => [
  row(1, {
    task: 'a',
    attempt: 1,
    model: 'alias',
    reported_model: ' actual ',
    usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 3 },
    reported_cost_usd: 0.2,
  }),
  row(1, { result: 'interrupted', model: 'wrong', usage: null }),
  row(2, {
    provider: 'claude',
    task: 'a',
    attempt: 2,
    model: ' fallback ',
    reported_model: '  ',
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cached_input_tokens: 30,
      output_tokens: 4,
    },
  }),
  row(3, {
    task: 'b',
    attempt: 1,
    model: 'alias',
    reported_model: 'actual',
    usage: null,
  }),
  row(4, { provider: 'custom', task: null, attempt: 0, usage: undefined }),
  row(5, {
    task: 'a',
    attempt: '1',
    model: '__proto__',
    usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 },
  }),
];

test('by_model prefers reported_model, then model, then unassigned', () => {
  const { by_model } = summarizeUsage(attributed(), { expectedInvocations: 6 });
  assert.deepEqual(Object.keys(by_model).sort(), [
    '__proto__',
    'actual',
    'fallback',
    'unassigned',
  ]);
  assert.equal(by_model.actual.invocations, 2);
  assert.equal(by_model.actual.input_tokens_including_cache, 100);
  assert.equal(by_model.actual.cached_input_tokens, 70);
  assert.equal(by_model.actual.input_covered_invocations, 1);
  assert.equal(by_model.actual.reported_cost_usd, 0.2);
  assert.equal(by_model.actual.cost_covered_invocations, 1);
  // Claude input includes cache creation and reads; the blank reported_model is ignored.
  assert.equal(by_model.fallback.input_tokens_including_cache, 60);
  assert.equal(by_model.unassigned.invocations, 1);
  assert.equal(by_model.unassigned.input_tokens_including_cache, null);
  assert.equal(by_model.wrong, undefined);
});

test('by_model keeps a multi-model label opaque and treats __proto__ as an own key', () => {
  const { by_model } = summarizeUsage([
    row(1, { reported_model: 'gpt-a, gpt-b' }),
    row(2, { model: '__proto__' }),
  ]);
  assert.deepEqual(Object.keys(by_model).sort(), ['__proto__', 'gpt-a, gpt-b']);
  assert.equal(by_model['gpt-a, gpt-b'].input_tokens_including_cache, 100);
  assert.ok(Object.hasOwn(by_model, '__proto__'));
  assert.equal(Object.getPrototypeOf(by_model), Object.prototype);
  assert.equal(by_model['__proto__'].invocations, 1);
});

test('by_attempt keys are task and attempt pairs and never merge tasks', () => {
  const { by_attempt } = summarizeUsage(attributed(), {
    expectedInvocations: 6,
  });
  assert.deepEqual(Object.keys(by_attempt).sort(), [
    '["a","unassigned"]',
    '["a",1]',
    '["a",2]',
    '["b",1]',
    '["unassigned","unassigned"]',
  ]);
  assert.equal(by_attempt['["a",1]'].input_tokens_including_cache, 100);
  assert.equal(by_attempt['["a",1]'].invocations, 1);
  assert.equal(by_attempt['["a",2]'].input_tokens_including_cache, 60);
  assert.equal(by_attempt['["b",1]'].input_tokens_including_cache, null);
  assert.equal(by_attempt['["b",1]'].input_covered_invocations, 0);
  assert.equal(
    by_attempt['["a","unassigned"]'].input_tokens_including_cache,
    5,
  );
  assert.equal(by_attempt['["unassigned","unassigned"]'].invocations, 1);
});

test('invalid attempts become unassigned', () => {
  const { by_attempt } = summarizeUsage(
    [-1, 0, 1.5, '2', null, NaN, Number.MAX_SAFE_INTEGER + 1, undefined].map(
      (attempt, i) => row(i + 1, { attempt }),
    ),
  );
  assert.deepEqual(Object.keys(by_attempt), ['["t1","unassigned"]']);
  assert.equal(by_attempt['["t1","unassigned"]'].invocations, 8);
});

test('groups cover deduplicated recorded rows only and totals are unchanged', () => {
  const report = summarizeUsage(attributed(), { expectedInvocations: 6 });
  assert.equal(report.totals.invocations, 6);
  assert.equal(report.totals.recorded_invocations, 5);
  assert.equal(report.totals.input_tokens_including_cache, 165);
  for (const groups of [report.by_model, report.by_attempt])
    assert.equal(
      Object.values(groups).reduce((n, g) => n + g.invocations, 0),
      5,
    );
  // Existing groups still work alongside the new ones.
  assert.equal(report.by_task.a.invocations, 3);
  assert.equal(report.by_provider.codex.invocations, 3);
  assert.equal(report.by_phase.develop.measured_input_share_percent, null);
});

test('empty input yields empty attribution groups', () => {
  const report = summarizeUsage([]);
  assert.deepEqual(report.by_model, {});
  assert.deepEqual(report.by_attempt, {});
  assert.deepEqual(summarizeUsage([], { expectedInvocations: 3 }).by_model, {});
});
