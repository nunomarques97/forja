import { createHash } from 'node:crypto';
import { modelEvidence } from './model-evidence.mjs';

const invalid = () => Error('Invalid evaluation run selection.');
function selection(ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 10 ||
      Array.from(ids).some(id => typeof id !== 'string' || id !== id.trim() || !/^F-[A-Za-z0-9-]{1,98}$/.test(id)) ||
      new Set(ids).size !== ids.length) throw invalid();
  return [...ids].sort();
}

export function cliEvaluationRuns(value) {
  if (typeof value !== 'string' || value.length > 1009) throw invalid();
  return selection(value.split(','));
}

// A deterministic triage rule, not a statistical test or an execution engine.
// Explicit selection prevents an unbounded scan or silent cherry-picking by us.
export function evaluationPlan(root, runIds) {
  const ids = selection(runIds);
  const observations = ids.map(run => {
    try { return { run, evidence: modelEvidence(root, { runId: run }) }; }
    catch { return { run, unavailable: true }; }
  });
  const runs = observations.map(({ run, evidence: e }) => {
    if (!e) return { run, status: 'unavailable', blockers: ['repair_evidence'], concerns: [] };
    const blockers = [], concerns = [];
    if (!['done', 'failed'].includes(e.status)) blockers.push('finish_run');
    if (e.signals.includes('measurement_gaps') || !e.coverage.expected_invocations ||
        e.groups.some(g => g.outcomes.unknown || g.outcomes.pending)) blockers.push('repair_evidence');
    if (e.signals.includes('inspect_execution_failures')) blockers.push('inspect_execution');
    if (e.signals.includes('inspect_review_findings')) concerns.push('review_rejection');
    if (e.signals.includes('inspect_check_failures')) concerns.push('latest_check_failure');
    if (e.status === 'failed' && !concerns.length && !blockers.includes('inspect_execution')) blockers.push('inspect_run_failure');
    return { run, status: e.status, blockers, concerns, warnings: e.warnings };
  });
  const eligible = runs.filter(r => !r.blockers.length);
  const concerning = eligible.filter(r => r.concerns.length);
  const repeated = concerning.length >= 3;
  const actions = [...new Set(runs.flatMap(r => r.blockers))].sort();
  // Blocked runs never count towards the threshold. Other complete runs can
  // still justify investigation; unavailable evidence is never silently dropped.
  if (repeated) actions.push('investigate_quality');
  else actions.push('continue_observing');
  return {
    version: 1,
    policy: { id: 'model-triage-v1', minimum_concerning_runs: 3, max_selected_runs: 10,
      basis: 'Heuristic over explicitly selected runs; not a trend, causal attribution or statistical significance.' },
    evidence_sha256: createHash('sha256').update(JSON.stringify(observations)).digest('hex'),
    runs,
    coverage: { selected: runs.length, available: observations.filter(o => o.evidence).length,
      eligible: eligible.length, concerning: concerning.length },
    actions,
    comparison: repeated ? {
      status: 'draft_requires_investigation',
      source_runs: concerning.map(r => r.run),
      prerequisites: [
        'Inspect findings and failing checks; confirm substantive defects, valid checks and relevant task difficulty before attributing them to a model.',
        'Define the affected role, current baseline and candidate with exact provider/model/effort and native CLI version; verify reported model identity.',
        'Freeze representative tasks, source snapshots, prompts, tool access, budgets and independent acceptance checks with content hashes before calling candidates.',
        'Validate the checks against a correct reference and known defects; include acceptance and rejection controls for reviewers.',
        'For creative planning, freeze multiple briefs and a rubric for distinct directions, specificity, feasibility and justified technology choices; do not reward a library name.',
        'Set repetitions, stopping rules and acceptance criteria before execution; use at least three repeats per candidate/task, alternate candidate order and retain every attempt.',
        'Confirm available execution budget and permitted provider access before any calls; isolate benchmark work from project state.',
      ],
      decision_rules: [
        'Assess correctness, regressions, review false positives/negatives and creative rubric results before latency or token cost; report environment failures separately.',
        'Compare only matched tasks and conditions; incomplete identity or measurements cannot establish superiority. Preserve negative and inconclusive outcomes.',
        'A positive comparison proposes an explicit, reversible profile change for new runs, followed by monitoring. Never migrate active runs or promote automatically.',
      ],
    } : null,
    interpretation: 'Local read-only triage. A rejection followed by repair remains a concern, not proof of a defective model. Different tasks and selected runs are not independent benchmark samples. No comparison executed, provider invoked, profile changed or files written. The digest binds the sanitized observations, not original artifacts or a frozen benchmark. Active-run reads are non-atomic.',
  };
}
