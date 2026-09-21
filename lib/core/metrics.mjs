const count = (value) => Number.isSafeInteger(value) && value >= 0;
const sum = (values) =>
  values.every(count) && Number.isSafeInteger(values.reduce((a, b) => a + b, 0))
    ? values.reduce((a, b) => a + b, 0)
    : null;

export function normalizedUsage(row) {
  const u = row.usage;
  if (!u) return { input: null, output: null, cached: null };
  // Claude's input excludes cache creation/read; Codex's includes cached input.
  const input =
    row.provider === 'claude'
      ? sum([
          u.input_tokens,
          u.cache_creation_input_tokens,
          u.cached_input_tokens,
        ])
      : row.provider === 'codex'
        ? count(u.input_tokens)
          ? u.input_tokens
          : null
        : null;
  return {
    input,
    output: count(u.output_tokens) ? u.output_tokens : null,
    cached: count(u.cached_input_tokens) ? u.cached_input_tokens : null,
  };
}

function aggregate(rows) {
  const measured = rows.map(normalizedUsage);
  const total = (key) => {
    const available = measured.map((m) => m[key]).filter(count);
    return available.length ? sum(available) : null;
  };
  const knownCalls = rows.filter(
    (r) =>
      r.calls_source === 'unique assistant message IDs in provider stream' &&
      count(r.calls),
  );
  const rowTotal = (key) => {
    const available = rows.map((r) => r[key]).filter(count);
    return available.length ? sum(available) : null;
  };
  const costs = rows
    .map((r) => r.reported_cost_usd)
    .filter((n) => Number.isFinite(n) && n >= 0);
  return {
    invocations: rows.length,
    duration_ms: rowTotal('duration_ms'),
    duration_covered_invocations: rows.filter((r) => count(r.duration_ms))
      .length,
    submitted_prompt_characters: rowTotal('prompt_characters'),
    prompt_covered_invocations: rows.filter((r) => count(r.prompt_characters))
      .length,
    observed_model_calls: knownCalls.length
      ? sum(knownCalls.map((r) => r.calls))
      : null,
    calls_covered_invocations: knownCalls.length,
    input_tokens_including_cache: total('input'),
    output_tokens: total('output'),
    cached_input_tokens: total('cached'),
    input_covered_invocations: measured.filter((m) => count(m.input)).length,
    output_covered_invocations: measured.filter((m) => count(m.output)).length,
    cache_covered_invocations: measured.filter((m) => count(m.cached)).length,
    reported_cost_usd:
      costs.length && Number.isFinite(costs.reduce((a, b) => a + b, 0))
        ? costs.reduce((a, b) => a + b, 0)
        : null,
    cost_covered_invocations: costs.length,
  };
}
export function summarizeUsage(rows, { expectedInvocations } = {}) {
  // A process can die after appending a result but before clearing pending state.
  // Prefer the final result over an interrupted record for the same invocation.
  const unique = new Map();
  for (const row of rows) {
    const prior = unique.get(row.id);
    if (!prior || row.result !== 'interrupted') unique.set(row.id, row);
  }
  rows = [...unique.values()];
  const groupBy = (keyOf) => {
    const buckets = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    // fromEntries defines own properties, so a "__proto__" key stays plain data.
    return Object.fromEntries(
      [...buckets].map(([k, group]) => [k, aggregate(group)]),
    );
  };
  const group = (key) => groupBy((r) => r[key] ?? 'unassigned');
  // Multi-model labels stay opaque: no token split without measurements.
  const label = (value) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const modelOf = (r) =>
    label(r.reported_model) ?? label(r.model) ?? 'unassigned';
  const attemptOf = (r) =>
    JSON.stringify([
      r.task ?? 'unassigned',
      Number.isSafeInteger(r.attempt) && r.attempt > 0
        ? r.attempt
        : 'unassigned',
    ]);
  const totals = aggregate(rows),
    by_phase = group('phase');
  totals.recorded_invocations = totals.invocations;
  if (count(expectedInvocations))
    totals.invocations = Math.max(totals.invocations, expectedInvocations);
  for (const phase of Object.values(by_phase))
    phase.measured_input_share_percent =
      totals.input_covered_invocations === totals.invocations &&
      totals.input_tokens_including_cache > 0
        ? Math.round(
            (1000 * phase.input_tokens_including_cache) /
              totals.input_tokens_including_cache,
          ) / 10
        : null;
  return {
    totals,
    by_phase,
    by_task: group('task'),
    by_provider: group('provider'),
    by_backend: groupBy(r => r.backend ?? r.provider ?? 'unassigned'),
    by_model: groupBy(modelOf),
    by_attempt: groupBy(attemptOf),
    rows,
    accounting:
      'Cache reads included once. Null means unavailable; coverage shows partial measurements. Native reported USD is a provider estimate, not a subscription invoice or independently priced bill. Prompt characters exclude provider system/tool/native instruction overhead.',
  };
}

// Recover every intact record from a usage ledger that may be damaged by a crash.
// Damaged or invalid lines are skipped and reported; nothing is repaired or invented.
export function parseUsageLedger(text) {
  if (text == null) return { rows: [], warnings: [] };
  if (typeof text !== 'string')
    throw new TypeError('parseUsageLedger expects a string');
  const rows = [],
    warnings = [];
  text
    .replace(/^\uFEFF/, '')
    .split(/\r\n|\n|\r/)
    .forEach((raw, index) => {
      if (!raw.trim()) return;
      const line = index + 1;
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        warnings.push({ line, message: 'Malformed JSON skipped' });
        return;
      }
      if (
        record === null ||
        typeof record !== 'object' ||
        Array.isArray(record)
      )
        warnings.push({
          line,
          message: 'Invalid record skipped: expected a JSON object',
        });
      else if (!Number.isSafeInteger(record.id) || record.id <= 0)
        warnings.push({
          line,
          message: 'Invalid record skipped: id must be a positive safe integer',
        });
      else rows.push(record);
    });
  return { rows, warnings };
}
