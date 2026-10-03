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
  provider: ['Provider call failed', 'Inspect the local call log and provider authentication or quota. FORJA does not switch providers or retry automatically.'],
  provider_limit: ['Provider reported a usage limit', 'Check the provider account for its reset time or available allowance before explicitly resuming. Increasing FORJA budgets does not increase provider quota.'],
  plan_packet: ['Plan exceeds the task packet budget', 'Two plans in a row had tasks whose develop packet exceeds the planning budget. No task was stored and no implementation attempt was spent. core resume plans again and gives the planner the sizes below. If the goal itself fills most of the packet, abandon this run (core abandon --why "...") and start one whose goal refers to detailed documents instead of copying them.'],
  task_packet: ['Task packet too large', 'The packet below exceeds the limit before any worker launched, so no session or implementation attempt was spent; resume rebuilds the same packet. Shorten the explicit decision data, or abandon this run (core abandon --why "...") and start one with smaller tasks.'],
  check_writes: ['A check changed project files', 'A check must be a read-only verifier; one that writes the project (an artifact, screenshot or report generator) cannot pass on retry. The changed files are preserved: inspect them and restore or keep them. Then save read-only replacement checks as a JSON array of {"command","args"} objects and run core retry --task <id> --checks-file <file.json> --validate-only --why "..."; the replacement is validated like a new plan and recorded in recovery.jsonl. A done task is reopened first (core retry --task <id> --reopen --why "..."). Final checks cannot be replaced inside a run: abandon it and start a new one.'],
  check_targets: ['Acceptance command needs correction', 'Inspect the saved plan. Abandon this run and start a new one with concrete acceptance targets.'],
  operator_stop: ['Stopped by operator request', 'The controller stopped at a boundary as requested; no worker was interrupted and no attempt, rotation or session was consumed. Continue from where it stopped with core resume.'],
  interrupted: ['Execution interrupted', 'Work on disk is preserved. Inspect core status and the current diff before resuming; an unfinished call is not an approved handoff.'],
  inspect: ['Run needs inspection', 'Inspect core status and the local evidence before choosing resume, retry or abandon.'],
};
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
};
export const providerRetryLimit = (run) => run.limits?.providerRetries ?? 1;
const retriesInAttempt = (task) => task?.provider_retries?.attempt === task?.attempts ? task.provider_retries.used : 0;

// Whether a failed provider call is retried automatically, and otherwise the
// sentence that explains why not.
export function providerRetryDecision(run, task, phase, code) {
  if (phase !== 'develop' || !task || !Object.hasOwn(RETRY_HINTS, code))
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
  const attempts = count(task?.attempts), limit = count(run?.limits?.attempts);
  const more = attempts !== null && limit !== null && attempts >= limit && limit < 5
    ? ` ${task.id} has used ${attempts} of ${limit} implementation attempts, so add --max-attempts ${attempts + 1} to the same resume.` : '';
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

export function recoveryInfo(run, { alive = true } = {}) {
  if (['done', 'failed'].includes(run.status) || run.technology?.some(d => !d.selection)) return null;
  if (run.status !== 'blocked' && (run.status !== 'running' || alive)) return null;
  const code = run.status === 'running' && !alive ? 'interrupted' : Object.hasOwn(reasons, run.stopCode) ? run.stopCode : 'inspect';
  const [title, base] = reasons[code];
  const stuck = ['repeated_context_limit', 'no_progress_between_rotations'].includes(code)
    ? (run.tasks || []).find(t => t.status !== 'done' && exhaustedRotations(run, t)) : null;
  const guidance = base + exhaustedRotations(run, stuck) + packetSizes(code, run.stopDetail) + writingCheck(code, run.stopDetail) +
    (code === 'timeout' ? timeoutAdvice(run.stopDetail, run) : '');
  return {
    code, title, guidance,
    sessions: { used: count(run.invocations), limit: count(run.limits?.sessions) },
    cloud_sessions: { used: count(run.cloudInvocations ?? run.invocations), limit: count(run.config?.maxCloudSessions ?? run.limits?.sessions) },
    minutes_per_call: count(run.limits?.minutes),
    context_tokens: count(run.limits?.contextTokens),
    context_note: 'Context stopping is based on observed Claude request usage. Codex/custom do not expose a comparable live context measurement; no context stop is claimed for them.',
  };
}
