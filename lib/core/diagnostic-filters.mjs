// Shared selectors for read-only diagnostics. Errors are fixed text so neither
// the supplied values nor the project path are ever echoed.
export const DIAGNOSTIC_PHASES = Object.freeze(['plan', 'develop', 'review']);
export const MAX_DIAGNOSTIC_INVOCATION = 200;
export const INVALID_DIAGNOSTIC_FILTERS = 'Invalid diagnostic filters.';

const invalid = () => new Error(INVALID_DIAGNOSTIC_FILTERS);

// Undefined options or fields mean "absent"; unknown extra keys are ignored.
export function diagnosticFilters(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw invalid();
  const { invocationId, phase } = options, filters = {};
  if (invocationId !== undefined) {
    if (!Number.isSafeInteger(invocationId) || invocationId < 1 || invocationId > MAX_DIAGNOSTIC_INVOCATION) throw invalid();
    filters.invocationId = invocationId;
  }
  if (phase !== undefined) {
    if (typeof phase !== 'string' || !DIAGNOSTIC_PHASES.includes(phase)) throw invalid();
    filters.phase = phase;
  }
  return filters;
}

export const matchesDiagnosticFilters = (row, { invocationId, phase }) =>
  (invocationId === undefined || row.id === invocationId) && (phase === undefined || row.phase === phase);

// CLI selectors arrive as text (or `true` when the flag has no value). Only
// canonical decimal 1..200 is accepted, so '02', '+2', '1e0', '0x2' or ' 2'
// fail with the same fixed message before the API touches any project file.
const CANONICAL_INVOCATION = /^(?:[1-9]\d?|1\d\d|200)$/;
export function cliDiagnosticFilters(opt = {}) {
  const options = {};
  if (opt.invocation !== undefined) {
    if (typeof opt.invocation !== 'string' || !CANONICAL_INVOCATION.test(opt.invocation)) throw invalid();
    options.invocationId = Number(opt.invocation);
  }
  if (opt.phase !== undefined) {
    if (typeof opt.phase !== 'string' || !DIAGNOSTIC_PHASES.includes(opt.phase)) throw invalid();
    options.phase = opt.phase;
  }
  return options;
}
