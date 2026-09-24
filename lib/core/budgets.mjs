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

export function coreBudgets(config = {}) {
  return {
    sessions: budget(config.maxSessions, 30, 1, 200),
    attempts: budget(config.maxAttempts, 2, 1, 5),
    minutes: budget(config.maxMinutes, 30, 1, 180),
    rotations: budget(config.maxRotations, 2, 0, 5),
    contextTokens: budget(
      config.maxContextTokens,
      120000,
      1000,
      1000000,
    ),
  };
}
