// Closed, public-safe diagnostics. Never copy raw failure/provider text here.
const reasons = {
  timeout: ['Time limit reached', 'Inspect preserved work. Retry validation only if implementation is complete; otherwise explicitly allow another attempt. Route time limits can be lower than the run limit.'],
  context: ['Context limit reached', 'Inspect the checkpoint and explicitly increase the rotation budget to continue in a fresh session.'],
  no_progress_between_rotations: ['No progress between context rotations', 'Consecutive context-limit sessions of this task changed no source and no progress notes; another rotation would repeat the same reads. Split the task into smaller read scopes: abandon this run (core abandon --why "...") and start one with narrower tasks. Resume only after raising the context budget explicitly.'],
  rotations: ['Continuation budget exhausted', 'Increase --max-rotations explicitly to continue preserved work. Completed checks and review are still required.'],
  sessions: ['Session budget exhausted', 'Increase --max-sessions explicitly to allow more sessions, including independent review.'],
  cloud_sessions: ['Cloud session budget exhausted', 'Increase --max-cloud-sessions explicitly. Increasing the total session limit does not override an explicit cloud limit.'],
  attempts: ['Implementation attempts exhausted', 'Inspect the task feedback. Increase --max-attempts for another implementation, or use retry --validate-only after inspecting completed work.'],
  output: ['Output limit reached', 'Inspect the saved output and reduce verbose output before explicitly retrying.'],
  provider: ['Provider call failed', 'Inspect the local call log and provider authentication or quota. FORJA does not switch providers or retry automatically.'],
  provider_limit: ['Provider reported a usage limit', 'Check the provider account for its reset time or available allowance before explicitly resuming. Increasing FORJA budgets does not increase provider quota.'],
  check_targets: ['Acceptance command needs correction', 'Inspect the saved plan. Abandon this run and start a new one with concrete acceptance targets.'],
  interrupted: ['Execution interrupted', 'Work on disk is preserved. Inspect core status and the current diff before resuming; an unfinished call is not an approved handoff.'],
  inspect: ['Run needs inspection', 'Inspect core status and the local evidence before choosing resume, retry or abandon.'],
};
export class RunStop extends Error {
  constructor(code, message) { super(message); this.stopCode = Object.hasOwn(reasons, code) ? code : 'inspect'; }
}
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
export function recoveryInfo(run, { alive = true } = {}) {
  if (['done', 'failed'].includes(run.status) || run.technology?.some(d => !d.selection)) return null;
  if (run.status !== 'blocked' && (run.status !== 'running' || alive)) return null;
  const code = run.status === 'running' && !alive ? 'interrupted' : Object.hasOwn(reasons, run.stopCode) ? run.stopCode : 'inspect';
  const [title, guidance] = reasons[code];
  return {
    code, title, guidance,
    sessions: { used: count(run.invocations), limit: count(run.limits?.sessions) },
    cloud_sessions: { used: count(run.cloudInvocations ?? run.invocations), limit: count(run.config?.maxCloudSessions ?? run.limits?.sessions) },
    minutes_per_call: count(run.limits?.minutes),
    context_tokens: count(run.limits?.contextTokens),
    context_note: 'Context stopping is based on observed Claude request usage. Codex/custom do not expose a comparable live context measurement; no context stop is claimed for them.',
  };
}
