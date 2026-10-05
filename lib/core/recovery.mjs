import { checkMinutes, attemptLimit } from './budgets.mjs';

// Closed, public-safe diagnostics. Never copy raw failure/provider text here.
const reasons = {
  repeated_context_limit: ['Repeated forced context stops', 'Three consecutive sessions hit the context limit without an intentional handoff. Source edits and notes are preserved but do not prove useful progress. Inspect the work and split the task, or explicitly revise its context budget before resuming.'],
  timeout: ['Time limit reached', 'A provider call reached the per-call provider timeout (--max-minutes, 1..180). A develop session that times out gets one automatic fresh session per implementation attempt (providerRetries); this stop means that retry was already used in this attempt, providerRetries is 0, or the timeout was in planning or review. Work on disk is preserved: inspect it, then raise the limit with core resume --max-minutes N, or retry validation only if implementation is complete. A route maxMinutes lower than the run limit is fixed for the run and is not raised by --max-minutes.'],
  context: ['Context limit reached', 'Inspect the checkpoint and explicitly increase the rotation budget to continue in a fresh session.'],
  no_progress_between_rotations: ['No progress between context rotations', 'Consecutive context-limit sessions of this task changed no source and no progress notes; another rotation would repeat the same reads. Split the task into smaller read scopes: abandon this run (core abandon --why "...") and start one with narrower tasks. Resume only after raising the context budget explicitly.'],
  rotations: ['Continuation budget exhausted', 'Increase --max-rotations explicitly to continue preserved work. Completed checks and review are still required.'],
  sessions: ['Session budget exhausted', 'Increase --max-sessions explicitly to allow more sessions, including independent review.'],
  cloud_sessions: ['Cloud session budget exhausted', 'Increase --max-cloud-sessions explicitly. Increasing the total session limit does not override an explicit cloud limit.'],
  attempts: ['Implementation attempts exhausted', 'Inspect the task feedback. Increase --max-attempts for another implementation, or use retry --validate-only after inspecting completed work.'],
  output: ['Output limit reached', 'Inspect the saved output and reduce verbose output before explicitly retrying. A develop session that ends on the output budget gets one automatic fresh session per implementation attempt (providerRetries); this stop means that retry was already used in this attempt, providerRetries is 0, or the failure was in planning or review.'],
  provider: ['Provider call failed', 'Inspect the local call log and provider authentication or quota. FORJA does not switch providers or retry automatically; the only exception is the opt-in escalation of a local develop task to the Claude route of the profile (docs/ROUTING.md), which has already run or was refused, as the message says.'],
  provider_limit: ['Provider reported a usage limit', 'The provider account reached its usage limit. Work on disk is preserved and a develop session that hit the limit spent no implementation attempt. Increasing FORJA budgets does not increase provider quota.'],
  plan_packet: ['Plan exceeds the task packet budget', 'Two plans in a row had tasks whose develop packet exceeds the planning budget. No task was stored and no implementation attempt was spent. core resume plans again and gives the planner the sizes below. If the goal itself fills most of the packet, abandon this run (core abandon --why "...") and start one whose goal refers to detailed documents instead of copying them.'],
  task_packet: ['Task packet too large', 'The packet below exceeds the limit before any worker launched, so no session or implementation attempt was spent; resume rebuilds the same packet. Shorten the explicit decision data, or abandon this run (core abandon --why "...") and start one with smaller tasks.'],
  check_writes: ['A check changed project files', 'A check must be a read-only verifier; one that writes the project (an artifact, screenshot or report generator) cannot pass on retry. The changed files are preserved: inspect them and restore or keep them. Then save read-only replacement checks as a JSON array of {"command","args"} objects and run core retry --task <id> --checks-file <file.json> --validate-only --why "..."; the replacement is validated like a new plan and recorded in recovery.jsonl. A done task is reopened first (core retry --task <id> --reopen --why "..."). Final checks cannot be replaced inside a run: abandon it and start a new one.'],
  check_timeout: ['A check reached the check timeout', 'A task or final-regression check was killed by the per-check timeout (checkTimeoutMinutes, 1..180; without it the run uses the smaller of --max-minutes and 10). A killed check is not a failed check: no implementation attempt was spent, no reject feedback was recorded and work on disk is preserved. Raise the limit with core resume --check-timeout-minutes N; resume runs the checks of that task again. If the check hangs instead of being slow, fix the check instead.'],
  check_targets: ['Acceptance command needs correction', 'Inspect the saved plan. Abandon this run and start a new one with concrete acceptance targets.'],
  operator_stop: ['Stopped by operator request', 'The controller stopped at a boundary as requested; no worker was interrupted and no attempt, rotation or session was consumed. Continue from where it stopped with core resume.'],
  interrupted: ['Execution interrupted', 'Work on disk is preserved. Inspect core status and the current diff before resuming; an unfinished call is not an approved handoff.'],
  inspect: ['Run needs inspection', 'Inspect core status and the local evidence before choosing resume, retry or abandon.'],
};
// The closed stop code of a blocked run, for the guard and the viewer.
export const publicStopCode = (run) => run?.status !== 'blocked' ? null : Object.hasOwn(reasons, run.stopCode) ? run.stopCode : 'inspect';

// Usage-limit wait: a provider_limit stop records when the account limit
// resets. The guard resumes the run USAGE_LIMIT_MARGIN_MS after that time, at
// most USAGE_LIMIT_MAX_RESUMES times per run, unless the run was started with
// usageLimitResume false. Every resume still spends a session. A pending
// operator stop request (lib/core/stop.mjs) also turns automatic resume off:
// the operator asked the run to stop, so only a person restarts it.
export const USAGE_LIMIT_DEFAULT_MS = 60 * 60000;
export const USAGE_LIMIT_MIN_MS = 60000;
export const USAGE_LIMIT_MAX_MS = 8 * 24 * 60 * 60000;
export const USAGE_LIMIT_MARGIN_MS = 60000;
export const USAGE_LIMIT_MAX_RESUMES = 6;
const usageLimitResumes = (run) => Number.isSafeInteger(run?.usageLimitResumes) && run.usageLimitResumes >= 0 ? run.usageLimitResumes : 0;

// The wait to store for a provider_limit stop; `reported` is the provider's
// reset time (an ISO string from parseOutput) or null.
export function usageLimitWait(run, reported, now = Date.now()) {
  const at = typeof reported === 'string' ? Date.parse(reported) : NaN;
  const reset = Number.isFinite(at) ? Math.min(Math.max(at, now + USAGE_LIMIT_MIN_MS), now + USAGE_LIMIT_MAX_MS) : now + USAGE_LIMIT_DEFAULT_MS;
  return {
    reset_at: new Date(reset).toISOString(),
    source: Number.isFinite(at) ? 'provider' : 'default',
    recorded_at: new Date(now).toISOString(),
    resumes: usageLimitResumes(run),
  };
}

// Public projection of the stored wait; null when the run is not waiting or
// the stored wait is malformed (a malformed wait is never resumed automatically).
// stopRequested: whether an operator stop request for this run is pending.
export function usageLimitWaitStatus(run, { stopRequested = false } = {}) {
  const w = run?.usageLimitWait;
  if (run?.status !== 'blocked' || run.stopCode !== 'provider_limit' || !w || typeof w !== 'object' ||
    typeof w.reset_at !== 'string' || !Number.isFinite(Date.parse(w.reset_at)) || !['provider', 'default'].includes(w.source)) return null;
  const resumes = Math.min(usageLimitResumes(run), USAGE_LIMIT_MAX_RESUMES);
  return {
    reset_at: new Date(Date.parse(w.reset_at)).toISOString(),
    source: w.source,
    auto_resume: run.config?.usageLimitResume !== false && resumes < USAGE_LIMIT_MAX_RESUMES && stopRequested !== true,
    stop_requested: stopRequested === true,
    resumes,
    max_resumes: USAGE_LIMIT_MAX_RESUMES,
  };
}

// Whether a public wait is due for an automatic resume now.
export function usageLimitDue(wait, now = Date.now()) {
  if (!wait || wait.auto_resume !== true || typeof wait.reset_at !== 'string') return false;
  const at = Date.parse(wait.reset_at);
  return Number.isFinite(at) && at + USAGE_LIMIT_MARGIN_MS <= now && Number.isSafeInteger(wait.resumes) && wait.resumes < USAGE_LIMIT_MAX_RESUMES;
}

// Why the engine refuses an automatic resume of this blocked run, or null.
export function usageLimitResumeProblem(run, now = Date.now(), { stopRequested = false } = {}) {
  if (run?.status !== 'blocked' || run.stopCode !== 'provider_limit') return 'the run is not waiting for a provider usage limit';
  const wait = usageLimitWaitStatus(run, { stopRequested });
  if (!wait) return 'the usage-limit wait is missing or malformed';
  if (run.config?.usageLimitResume === false) return 'automatic resume is disabled for this run (usageLimitResume false)';
  if (wait.stop_requested) return 'an operator stop request is pending for this run';
  if (wait.resumes >= USAGE_LIMIT_MAX_RESUMES) return `the run already used ${USAGE_LIMIT_MAX_RESUMES} automatic usage-limit resumes`;
  if (!usageLimitDue(wait, now)) return 'the usage-limit reset time has not passed yet';
  return null;
}

function usageLimitAdvice(run, stopRequested) {
  const wait = usageLimitWaitStatus(run, { stopRequested });
  if (!wait) return ' Check the provider account for its reset time or available allowance before explicitly resuming with core resume.';
  const when = ` Usage limit resets at ${wait.reset_at} (${wait.source === 'provider' ? 'reported by the provider' : 'no reset time reported; default estimate of 60 minutes'}).`;
  if (run.config?.usageLimitResume === false) return `${when} Automatic resume is off for this run (usageLimitResume false); resume with core resume after that time.`;
  if (wait.stop_requested) return `${when} An operator stop request is pending, so the guard does not resume this run; resume with core resume after that time.`;
  if (!wait.auto_resume) return `${when} The run already used all ${wait.max_resumes} automatic resumes; resume with core resume after that time.`;
  return `${when} The guard resumes this run automatically about a minute after that time (automatic resume ${wait.resumes + 1} of ${wait.max_resumes}); each resume uses a session.`;
}
export class RunStop extends Error {
  constructor(code, message, detail = null) { super(message); this.stopCode = Object.hasOwn(reasons, code) ? code : 'inspect'; if (detail) this.detail = detail; }
}
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;

// Packet stops name the tasks and sizes from structured state only; anything
// that is not a task ID, a phase or a count is dropped.
function packetSizes(code, detail) {
  if (!['plan_packet', 'task_packet'].includes(code) || !Array.isArray(detail?.tasks)) return '';
  const limit = count(detail.limit), budget = count(detail.budget);
  const sizes = detail.tasks
    .filter(e => (e?.task === null || /^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(e?.task)) && count(e?.characters) !== null && (e.task !== null || ['plan', 'develop', 'review'].includes(e.phase)))
    .slice(0, 30)
    .map(e => `${e.task === null ? `${e.phase} packet` : `task ${e.task}`}: ${e.characters.toLocaleString('en-US')} characters${count(e.own) === null ? '' : ` (own entry ${e.own.toLocaleString('en-US')})`}`);
  if (!sizes.length || limit === null) return '';
  return ` Measured: ${sizes.join('; ')}; ${budget === null ? '' : `planning budget ${budget.toLocaleString('en-US')} characters, `}limit ${limit.toLocaleString('en-US')} characters.`;
}

// Automatic provider retries: at most limits.providerRetries (0..1) fresh
// develop sessions per implementation attempt in total, whatever the failure
// kind. A retry keeps the work on disk and the progress notes, spends no
// attempt and still counts against the session and cloud budgets.
const minutesText = (minutes) => `${minutes} minute${minutes === 1 ? '' : 's'}`;
const RETRY_HINTS = {
  output: (id) => `the previous develop session of this attempt (call-${id}) ended on the provider output budget. Never print binary or base64 to the terminal; inspect images with the image read tool; keep command output short.`,
  timeout: (id, minutes) => `the previous develop session of this attempt (call-${id}) reached the per-call provider timeout${count(minutes) ? ` of ${minutesText(minutes)}` : ''}. Give every long command its own bounded timeout, never leave background processes running, keep progress_notes current and return a checkpoint before the limit instead of working until it.`,
  provider: (id) => `the previous local develop session of this attempt (call-${id}) failed without a result (for example its context compaction failed or it ended on prose). Read narrowly, keep progress_notes current and end with the final JSON result.`,
  result: (id) => `the previous local develop session of this attempt (call-${id}) returned no valid result. End with exactly one JSON object whose status is ready_for_validation, done, blocked or checkpoint, with summary and findings.`,
};
// Local sessions (stress suite, 2026-10-04) end without a usable result far
// more often than cloud ones; only local routes retry those two kinds.
const LOCAL_ONLY = ['provider', 'result'];
export const providerRetryLimit = (run) => run.limits?.providerRetries ?? 1;
const retriesInAttempt = (task) => task?.provider_retries?.attempt === task?.attempts ? task.provider_retries.used : 0;

// Whether a failed provider call is retried automatically, and otherwise the
// sentence that explains why not.
export function providerRetryDecision(run, task, phase, code, route = null) {
  if (phase !== 'develop' || !task || !Object.hasOwn(RETRY_HINTS, code) || (LOCAL_ONLY.includes(code) && !route?.local))
    return { retry: false, note: ` No automatic retry of ${phase === 'develop' ? 'provider failures' : `${phase} provider failures`}.` };
  const limit = providerRetryLimit(run);
  if (!limit) return { retry: false, note: ' Automatic provider retries are disabled (providerRetries 0).' };
  if (retriesInAttempt(task) >= limit)
    return { retry: false, note: ` The automatic retry of implementation attempt ${task.attempts} of ${task.id} was already used.` };
  return { retry: true, note: '' };
}

export function recordProviderRetry(task, code, invocation, minutes = null) {
  const last = { reason: code, after_invocation: invocation, ...(count(minutes) ? { minutes } : {}) };
  task.provider_retries = {
    attempt: task.attempts,
    used: retriesInAttempt(task) + 1,
    total: (task.provider_retries?.total || 0) + 1,
    last,
  };
  return { ...last };
}

// Feedback for the fresh session: the hint first, then the earlier feedback of
// this attempt (for example a review rejection) so it is not lost.
export function providerRetryFeedback(code, invocation, previous, minutes = null) {
  return {
    status: 'checkpoint',
    summary: `Automatic fresh session for the same implementation attempt: ${RETRY_HINTS[code](invocation, minutes)} Work on disk and progress_notes are preserved; continue from them and the current diff instead of starting over.`,
    findings: [
      ...(typeof previous?.summary === 'string' && previous.summary ? [`Earlier feedback of this attempt: ${previous.summary}`] : []),
      ...(Array.isArray(previous?.findings) ? previous.findings : []),
    ],
  };
}

// Feedback for the one fresh plan or review session after a local session of
// that phase returned no usable result; earlier feedback is kept after it.
const RESULT_RETRY_ASK = {
  plan: 'You are the planner: read what you need, do not implement, and return only the plan JSON with tasks and decisions.',
  review: 'You are the reviewer: inspect the change read-only and return status approve or reject with summary and findings.',
};
export function resultRetryFeedback(phase, retry, previous = null) {
  return {
    status: 'result_retry',
    summary: `Automatic fresh ${phase} session: call-${retry.after_invocation} returned no usable ${phase} result (${String(retry.problem).slice(0, 500)}). ${RESULT_RETRY_ASK[phase] ?? ''}`.trim(),
    findings: [
      ...(typeof previous?.summary === 'string' && previous.summary ? [`Earlier feedback: ${previous.summary}`] : []),
      ...(Array.isArray(previous?.findings) ? previous.findings : []),
    ],
    ...(previous && typeof previous === 'object' && !('summary' in previous) ? { earlier: previous } : {}),
  };
}

// Feedback for the first session on the escalation route: why the local route
// was left, then the earlier feedback (a reject keeps its actionable findings).
const ESCALATION_HINTS = {
  attempts: 'the local route used every implementation attempt of this task without approval',
  timeout: 'the local develop session reached its per-call timeout',
  output: 'the local develop session ended on the output budget',
  provider: 'the local develop session failed',
  invalid_result: 'the local develop session returned no valid result',
};
export const ESCALATION_REASONS = Object.keys(ESCALATION_HINTS);
export function escalationFeedback(reason, invocation, previous) {
  return {
    status: 'checkpoint',
    summary: `Escalated from the local route: ${ESCALATION_HINTS[reason]}${count(invocation) ? ` (call-${invocation})` : ''}. Work on disk and progress_notes are preserved; check the current diff and continue from it instead of starting over.`,
    findings: [
      ...(typeof previous?.summary === 'string' && previous.summary ? [`Earlier feedback: ${previous.summary}`] : []),
      ...(Array.isArray(previous?.findings) ? previous.findings : []),
    ],
  };
}

// Structured record of a provider call that reached its per-call timeout:
// the minutes applied, the run limit and the route that may have lowered it.
export function providerTimeout(run, phase, task, route, invocation) {
  const routeMinutes = run.config?.routes?.[route.selector]?.maxMinutes;
  return {
    phase, task: task?.id || null, invocation, minutes: route.maxMinutes, run_minutes: run.limits.minutes,
    route: route.selector, route_minutes: Number.isSafeInteger(routeMinutes) ? routeMinutes : null,
  };
}

// How to raise the per-call timeout that was reached, from structured fields
// only. A route below the run limit is named: --max-minutes cannot raise it.
export function timeoutAdvice(detail, run = null) {
  const minutes = count(detail?.minutes), runMinutes = count(detail?.run_minutes);
  if (!minutes || !runMinutes || !['plan', 'develop', 'review'].includes(detail.phase) || !count(detail.invocation) ||
    (detail.task !== null && !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(detail.task)) || !/^[a-z]+(\.[a-z]+)?$/.test(detail.route)) return '';
  const call = `${detail.phase}${detail.task ? ` ${detail.task}` : ''} call-${detail.invocation}`;
  const raise = runMinutes >= 180
    ? ' The run limit is already the maximum of 180 minutes; split the task or make its commands faster.'
    : ` Raise it with core resume --max-minutes N (N from ${runMinutes + 1} to 180; now ${runMinutes}).`;
  const routed = minutes < runMinutes
    ? ` Route ${detail.route} sets maxMinutes ${minutes}, below the run limit of ${runMinutes}; --max-minutes does not raise a route limit, which is fixed for this run.`
    : '';
  // A resume after a develop timeout starts a new implementation attempt.
  const task = detail.phase === 'develop' ? run?.tasks?.find(t => t.id === detail.task) : null;
  // An escalated task's limit only grows with a later --max-attempts increase.
  const runLimit = count(run?.limits?.attempts), attempts = count(task?.attempts);
  const limit = runLimit !== null ? count(attemptLimit(run, task)) : null;
  const needed = limit !== null ? runLimit + (attempts ?? 0) + 1 - limit : null;
  const more = attempts !== null && limit !== null && attempts >= limit && needed <= 5
    ? ` ${task.id} has used ${attempts} of ${limit} implementation attempts, so add --max-attempts ${needed} to the same resume.` : '';
  return ` Per-call provider timeout reached: ${minutesText(minutes)} (${call}).${routed || raise}${more}`;
}

// core status: the per-call provider timeout of the run, the routes that
// lower it, and the last limit that was reached with its invocation.
export function providerTimeoutStatus(run) {
  const minutes = count(run.limits?.minutes);
  const routes = Object.entries(run.config?.routes || {})
    .filter(([, route]) => count(route?.maxMinutes) && minutes && route.maxMinutes < minutes)
    .map(([route, { maxMinutes }]) => ({ route, minutes: maxMinutes }));
  const last = run.lastProviderTimeout;
  return {
    minutes_per_call: minutes,
    lower_route_limits: routes,
    last_reached: last && count(last.invocation) && count(last.minutes)
      ? { invocation: last.invocation, phase: last.phase, task: last.task ?? null, minutes: last.minutes, route: last.route ?? null }
      : null,
  };
}

// core status: the effective per-check timeout and where it comes from.
export function checkTimeoutStatus(run) {
  return { minutes: count(checkMinutes(run.limits)), source: run.limits?.checkMinutes === undefined ? 'default (smaller of --max-minutes and 10)' : 'checkTimeoutMinutes' };
}

// A check killed by the timeout is named by task ID, check label and minutes.
function timedOutCheck(code, detail) {
  if (code !== 'check_timeout' || !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(detail?.task) ||
    !/^(checks|finalChecks)\[\d{1,4}\]$/.test(detail?.check) || !count(detail?.minutes)) return '';
  const raise = detail.minutes >= 180 ? ' The limit is already the maximum of 180 minutes.' : ` Raise it with core resume --check-timeout-minutes N (N from ${detail.minutes + 1} to 180).`;
  return ` Timed-out check: task ${detail.task} ${detail.check} after ${minutesText(detail.minutes)}.${raise}`;
}

// A writing check is named by task ID, check label and path count only; the
// paths themselves stay in the stop message and the validation entry.
function writingCheck(code, detail) {
  if (code !== 'check_writes' || !/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(detail?.task) ||
    !/^(checks|finalChecks)\[\d{1,4}\]$/.test(detail?.check) || count(detail?.paths) === null) return '';
  return ` Writing check: task ${detail.task} ${detail.check}, ${detail.paths} changed path(s).${detail.check.startsWith('finalChecks') ? ' It is a final check, so it cannot be replaced by retry.' : ` Replace with: core retry --task ${detail.task} --checks-file <file.json> --validate-only --why "...".`}`;
}

// A context stop that also used up the task's rotations would block a second
// time on a resume that raises only the context budget; name both flags.
export function exhaustedRotations(run, task) {
  const limit = count(run.limits?.rotations), used = count(task?.rotations);
  if (limit === null || used === null || used <= limit) return '';
  return ` ${task.id} has also used ${used} context rotations against a limit of ${limit}, so raise --max-rotations to at least ${used + 1} in the same resume (for example core resume --max-context-tokens <tokens> --max-rotations ${used + 1}).`;
}

export function recoveryInfo(run, { alive = true, stopRequested = false } = {}) {
  if (['done', 'failed'].includes(run.status) || run.technology?.some(d => !d.selection)) return null;
  if (run.status !== 'blocked' && (run.status !== 'running' || alive)) return null;
  const code = run.status === 'running' && !alive ? 'interrupted' : Object.hasOwn(reasons, run.stopCode) ? run.stopCode : 'inspect';
  const [title, base] = reasons[code];
  const stuck = ['repeated_context_limit', 'no_progress_between_rotations'].includes(code)
    ? (run.tasks || []).find(t => t.status !== 'done' && exhaustedRotations(run, t)) : null;
  const guidance = base + exhaustedRotations(run, stuck) + packetSizes(code, run.stopDetail) + writingCheck(code, run.stopDetail) + timedOutCheck(code, run.stopDetail) +
    (code === 'timeout' ? timeoutAdvice(run.stopDetail, run) : '') + (code === 'provider_limit' ? usageLimitAdvice(run, stopRequested) : '');
  return {
    code, title, guidance,
    ...(code === 'provider_limit' ? { usage_limit_wait: usageLimitWaitStatus(run, { stopRequested }) } : {}),
    sessions: { used: count(run.invocations), limit: count(run.limits?.sessions) },
    cloud_sessions: { used: count(run.cloudInvocations ?? run.invocations), limit: count(run.config?.maxCloudSessions ?? run.limits?.sessions) },
    minutes_per_call: count(run.limits?.minutes),
    check_timeout_minutes: checkTimeoutStatus(run).minutes,
    context_tokens: count(run.limits?.contextTokens),
    context_note: 'Context stopping is based on observed Claude request usage. Codex/custom do not expose a comparable live context measurement; no context stop is claimed for them.',
  };
}
