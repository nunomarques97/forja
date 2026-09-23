// Conservative check-target contract. Checks are argv launched without a shell,
// so an unresolved <name> marker reaches the executable literally and burns a
// developer/check invocation. This is a token-level contract, not a shell or
// code parser: markers inside code/HTML or next to identifiers are allowed.
// Commands are never rewritten, expanded or executed and paths are not tested.

const MARKER = '<[A-Za-z][A-Za-z0-9_.-]*>';
const WHOLE = new RegExp(`^\\s*(${MARKER})\\s*$`);
const FLAG = /^--?[A-Za-z0-9][A-Za-z0-9_.-]*=(.*)$/s;
const URL_PARTS = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)(.*)$/s;
const ANY = new RegExp(MARKER);
// A whole path segment: after start, / or \; before end, /, \, ., :, ? or #.
const SEGMENT = new RegExp(`(?:^|[\\\\/])(${MARKER})(?=$|[\\\\/.:?#])`);
const QUERY = new RegExp(`[?&][^=&#?]*=(${MARKER})(?=$|[&#])`);

// Returns the unresolved marker in one command/argument value, or null.
export function placeholderIn(value) {
  // Only inspect complete target-like values, not substrings of source/data.
  // Removing recognized markers leaves HTML closing tags, quotes and code
  // delimiters intact. Do not infer interpreter semantics from -e or -p:
  // those flags can belong to an unrelated executable or a script's own CLI.
  const remainder = value.replace(new RegExp(MARKER, 'g'), 'target');
  if (/[<>"'`{}();\r\n]/.test(remainder)) return null;
  let flag;
  while ((flag = FLAG.exec(value))) value = flag[1];
  let m = WHOLE.exec(value);
  if (m) return m[1];
  const url = URL_PARTS.exec(value);
  if (url) {
    // An authority/port never legitimately contains an angle-bracket marker.
    if ((m = ANY.exec(url[1]))) return m[0];
    if ((m = QUERY.exec(url[2]))) return m[1];
  }
  m = SEGMENT.exec(value);
  return m ? m[1] : null;
}

// Returns an actionable message for the first invalid target, or null.
export function checkTargetProblem(check, label) {
  if (!check || typeof check.command !== 'string' || !Array.isArray(check.args))
    return `${label} must be an executable command with an argument array.`;
  if (!check.command.trim())
    return `${label} has a blank executable name; supply a concrete executable.`;
  const values = [['command', check.command], ...check.args.map((a, i) => [`args[${i}]`, a])];
  for (const [where, value] of values) {
    if (typeof value !== 'string') return `${label} ${where} must be a string.`;
    if (value.includes('\0'))
      return `${label} ${where} contains a NUL byte; supply a concrete value without NUL.`;
    const marker = placeholderIn(value);
    if (marker)
      return `${label} ${where} contains an unresolved target placeholder; supply a concrete value. FORJA never expands or rewrites check commands; derive dynamic values (ports, paths) inside a helper the task creates.`;
  }
  return null;
}

export function assertCheckTargets(checks, label) {
  for (let i = 0; i < checks.length; i++) {
    const problem = checkTargetProblem(checks[i], `${label}[${i}]`);
    if (problem) throw new Error(problem);
  }
}

// Every task check and final check, for gating persisted runs before any call.
export function planCheckProblem(tasks = [], finalChecks = []) {
  try {
    for (const t of tasks) assertCheckTargets(t.checks || [], `Task ${t.id} checks`);
    assertCheckTargets(finalChecks || [], 'finalChecks');
    return null;
  } catch (e) {
    return e.message;
  }
}
