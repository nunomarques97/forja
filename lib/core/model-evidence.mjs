// Read-only evidence for a human model decision. Never rank models or interpret
// provider completion, reviewer approval or test counts as a quality score.
import { readMetadata } from './diagnose.mjs';
import { parseUsageLedger, summarizeUsage } from './metrics.mjs';

const phases = ['plan', 'develop', 'review'];
const runId = value => typeof value === 'string' && value === value.trim() && /^F-[A-Za-z0-9-]{1,98}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const label = value => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,119}$/.test(value) ? value : null;
const statuses = { develop: ['done', 'ready_for_validation', 'checkpoint', 'blocked'], review: ['approve', 'reject', 'blocked'] };
const outcome = row => row.result === 'pending' ? 'pending'
  : row.result === 'interrupted' ? 'interrupted'
  : row.rate_limited === true ? 'provider_limit'
  : row.context_limit_reached === true ? 'context_limit'
  : row.timed_out === true ? 'timeout'
  : row.result === 'returned' ? 'returned'
  : row.result === 'error' ? 'provider_error' : 'unknown';

export function modelEvidence(root, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (options.runId !== undefined && !runId(options.runId))) throw Error('Invalid model evidence options.');
  const budget = { left: 16 * 1024 * 1024 }, warnings = new Set();
  const statePath = options.runId === undefined ? '.forja/current.json' : `.forja/runs/${options.runId}/state.json`;
  const state = readMetadata(root, statePath, budget);
  let run;
  try { run = JSON.parse(state.text); } catch { throw Error('Invalid Core model evidence state.'); }
  if (run?.version !== 1 || !runId(run.run_id) ||
      (options.runId !== undefined && run.run_id !== options.runId) ||
      !['running', 'blocked', 'done', 'failed'].includes(run.status) ||
      !count(run.invocations) || run.invocations > 200) throw Error('Invalid Core model evidence state.');
  const prefix = `.forja/runs/${run.run_id}`;
  const ledger = readMetadata(root, `${prefix}/usage.jsonl`, budget);
  if (ledger.warning) warnings.add('ledger_' + ledger.warning);
  const parsed = parseUsageLedger(ledger.text ?? '');
  if (parsed.warnings.length) warnings.add('invalid_ledger_records');
  const rows = new Map(), conflicts = new Set();
  for (const row of parsed.rows) {
    if (row.id > run.invocations || row.id > 200) { warnings.add('unexpected_invocation_id'); continue; }
    const prior = rows.get(row.id);
    if (!prior || prior.result === 'interrupted') rows.set(row.id, row);
    else if (row.result !== 'interrupted' && JSON.stringify(prior) !== JSON.stringify(row)) {
      conflicts.add(row.id); warnings.add('conflicting_invocation_records');
    }
  }
  for (const id of conflicts) rows.set(id, { id, result: 'unknown' });
  const recorded = rows.size;
  if (recorded < run.invocations) warnings.add('missing_invocation_records');
  if (Number.isSafeInteger(run.pending?.id) && run.pending.id > 0 && run.pending.id <= run.invocations && !rows.has(run.pending.id)) {
    rows.set(run.pending.id, { ...run.pending, result: 'pending', usage: null, duration_ms: null });
  }
  const buckets = new Map();
  for (const row of [...rows.values()].sort((a, b) => a.id - b.id)) {
    const identity = {
      provider: ['claude', 'codex', 'custom'].includes(row.provider) ? row.provider : null,
      phase: phases.includes(row.phase) ? row.phase : null,
      requested_model: label(row.model),
      reported_model: label(row.reported_model),
      effort: ['low', 'medium', 'high', 'max', 'xhigh'].includes(row.effort) ? row.effort : null,
    };
    if (!identity.provider || !identity.phase || !identity.requested_model || !identity.effort) warnings.add('incomplete_identity');
    if (!identity.reported_model) warnings.add('unconfirmed_model_identity');
    const key = JSON.stringify(identity);
    if (!buckets.has(key)) buckets.set(key, { ...identity, invocations: [], outcomes: {}, recorded_responses: {}, missing_responses: 0, rows: [] });
    const group = buckets.get(key), result = outcome(row);
    group.invocations.push(row.id);
    group.outcomes[result] = (group.outcomes[result] || 0) + 1;
    // Only accounting fields enter the existing aggregator; never export raw rows.
    group.rows.push({ id: row.id, provider: identity.provider, result: row.result, usage: row.usage, duration_ms: row.duration_ms });
    if (!statuses[identity.phase] || !['returned', 'context_limit'].includes(result)) continue;
    const response = readMetadata(root, `${prefix}/call-${row.id}-result.json`, budget, 64 * 1024);
    let value;
    try { value = JSON.parse(response.text); } catch {}
    if (!response.warning && value && !Array.isArray(value) && statuses[identity.phase].includes(value.status)) {
      group.recorded_responses[value.status] = (group.recorded_responses[value.status] || 0) + 1;
    } else {
      group.missing_responses++;
      warnings.add('response_' + (response.warning || 'invalid_record'));
    }
  }
  const groups = [...buckets.values()].map(({ rows: groupRows, ...group }) => {
    const totals = summarizeUsage(groupRows).totals;
    return { ...group, measurements: Object.fromEntries([
      'duration_ms', 'duration_covered_invocations', 'input_tokens_including_cache',
      'input_covered_invocations', 'output_tokens', 'output_covered_invocations',
    ].map(key => [key, totals[key]])) };
  });
  // Latest task state is reported at run level only: it cannot reconstruct a
  // per-model history of checks/rework or prove which model caused a failure.
  // Attempts are latest counters within the engine budget (0..5), never coerced.
  let tasks = null;
  if (Array.isArray(run.tasks) && run.tasks.length <= 30) {
    tasks = { total: run.tasks.length, done: 0, blocked: 0, other: 0, latest_checks: { passed: 0, failed: 0, unknown: 0, tasks_without_records: 0 },
      attempts: { recorded_tasks: 0, unknown_tasks: 0, total_attempts: 0, retried_tasks: 0, extra_attempts: 0 } };
    for (const task of run.tasks) {
      if (task?.status === 'done') tasks.done++;
      else if (task?.status === 'blocked') tasks.blocked++;
      else tasks.other++;
      const attempts = task !== null && typeof task === 'object' ? task.attempts : undefined;
      if (Number.isSafeInteger(attempts) && attempts >= 0 && attempts <= 5) {
        tasks.attempts.recorded_tasks++;
        tasks.attempts.total_attempts += attempts;
        if (attempts > 1) tasks.attempts.retried_tasks++;
        tasks.attempts.extra_attempts += Math.max(0, attempts - 1);
      } else tasks.attempts.unknown_tasks++;
      if (!Array.isArray(task?.validation) || !task.validation.length || task.validation.length > 200) { tasks.latest_checks.tasks_without_records++; continue; }
      for (const check of task.validation) tasks.latest_checks[check?.passed === true ? 'passed' : check?.passed === false ? 'failed' : 'unknown']++;
    }
    if (tasks.latest_checks.unknown || tasks.latest_checks.tasks_without_records) warnings.add('incomplete_check_evidence');
    if (tasks.attempts.unknown_tasks) {
      warnings.add('incomplete_attempt_evidence');
      if (!tasks.attempts.recorded_tasks) Object.assign(tasks.attempts, { total_attempts: null, retried_tasks: null, extra_attempts: null });
    }
  } else warnings.add('task_state_unavailable');
  const signals = [];
  // Attempt counters are not measurements: missing ones must not change triage of older runs.
  if ([...warnings].some(w => w !== 'incomplete_attempt_evidence') || groups.some(g => Object.entries(g.measurements).some(([k, v]) => v === null || (k.endsWith('_covered_invocations') && v < g.invocations.length)))) signals.push('measurement_gaps');
  if (groups.some(g => ['provider_limit', 'context_limit', 'timeout', 'provider_error', 'interrupted'].some(k => g.outcomes[k]))) signals.push('inspect_execution_failures');
  if (groups.some(g => g.recorded_responses.reject)) signals.push('inspect_review_findings');
  if (tasks?.latest_checks.failed) signals.push('inspect_check_failures');
  return {
    version: 1, run: run.run_id, status: run.status,
    coverage: { expected_invocations: run.invocations, recorded_invocations: recorded, represented_invocations: rows.size },
    tasks, groups, warnings: [...warnings], signals,
    interpretation: 'Read-only, non-atomic snapshot of local evidence, not a benchmark or model ranking. Requested and reported model labels stay separate; missing identity/usage is unknown. Responses are recorded worker statuses, not proof of current approval, delivery or model quality. Latest checks are not a check history and are not attributed to a model. Task attempts are latest per-task counters, not proof of bugs, autonomous fixes or model blame. Execution failures do not establish model defects. Compare equivalent frozen tasks before changing a profile. No providers invoked or routing changed.',
  };
}
