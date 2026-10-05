// Only integers and plain decimal digit strings: no booleans, arrays, hex,
// exponents, signs, fractions or whitespace are coerced into a budget.
export function budget(value, defaultValue, min, max) {
  if (value === undefined) return defaultValue;
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && /^[0-9]{1,16}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`Budget must be an integer in ${min}..${max}`);
  return number;
}

// Per-check timeout bounds. Without checkTimeoutMinutes a run keeps the
// earlier min(maxMinutes, 10), so existing and legacy runs read unchanged.
export const CHECK_MINUTES_MAX = 180;
export const checkMinutes = (limits) => limits?.checkMinutes ?? Math.min(limits?.minutes ?? 10, 10);

// An escalated task gets exactly escalation.attempts on the Claude route after
// the ones it spent locally (routing.mjs escalation), whatever attempts the run
// still had; only a later explicit --max-attempts increase adds to it. Others
// keep the run limit.
export const attemptLimit = (run, task) => {
  const escalation = task?.escalation;
  if (!escalation) return run.limits.attempts;
  return escalation.attempt_limit + Math.max(0, run.limits.attempts - (escalation.run_attempts ?? run.limits.attempts));
};

export function coreBudgets(config = {}) {
  return {
    sessions: budget(config.maxSessions, 30, 1, 200),
    attempts: budget(config.maxAttempts, 2, 1, 5),
    minutes: budget(config.maxMinutes, 30, 1, 180),
    rotations: budget(config.maxRotations, 2, 0, 5),
    providerRetries: budget(config.providerRetries, 1, 0, 1),
    ...(config.checkTimeoutMinutes === undefined ? {} : { checkMinutes: budget(config.checkTimeoutMinutes, undefined, 1, CHECK_MINUTES_MAX) }),
    contextTokens: budget(
      config.maxContextTokens,
      120000,
      1000,
      1000000,
    ),
  };
}
