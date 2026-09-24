// Portable project guidance: never publish the installing user's home path.
export const LEGACY_SKILLS = [
  'forja-lead', 'forja-crew', 'forja-plan', 'forja-product', 'forja-scout',
  'forja-design', 'forja-implementer', 'forja-review', 'forja-qa',
  'forja-security', 'forja-debug', 'forja-performance', 'forja-release',
  'forja-visual-check', 'forja-decide',
];

export function coreInstructions() {
  return [
    '## FORJA core',
    'New FORJA tasks use Core. The conversation agent prepares the goal, starts the controller and reports its result; it does not act as Lead or manually dispatch the legacy crew.',
    'Resolve `<forja>` from the caller-provided installation, `FORJA_ROOT`, or an existing FORJA hook path in `.claude/settings.json`. If unavailable, ask for the installation path; do not guess or install another copy.',
    'Read `<forja>/docs/CORE.md` and `<forja>/docs/CORE-RUNBOOK.md`. From this project: `node "<forja>/bin/forja.mjs" start --goal "..." --provider claude|codex`. Supply the explicitly selected profile with `--config`; installing or updating FORJA does not select models.',
    'The controller owns planning, development, checks and independent review. Workers read only the phase and applicable domain methods supplied in `specialist_context`. Do not load `forja-lead` or other legacy crew skills for Core work.',
    'Core state and usage live in `.forja/`. Inspect existing changes before starting; preserve them and use `--allow-dirty` only when work on that snapshot is authorized. Git delivery requires explicit configuration and the controller delivery contract.',
    'Preparation does not start a run. Never silently resume or replace an active Core or legacy run. Stop existing executors before an explicitly authorized handover; preserve their state and unfinished work.',
    'Legacy `runner` and `run start` are compatibility commands only when explicitly requested. Their state remains in `docs/forja/`; read legacy methods as files for that workflow. Restart the conversation after migration to discard previously loaded legacy instructions.',
  ].join('\n');
}

// Skill frontmatter is YAML, and Claude Code ignores all of it when it does not
// parse. Core only edits flat `key: scalar` headers (plus simple lists and block
// scalars), so it validates that subset and refuses anything else.
const PLAIN_INVALID = /^[-?:,[\]{}#&*!|>'"%@`]|: |:$|\s#/;
function scalarProblem(value) {
  if (value === '') return null;
  if (value.startsWith('"')) return /^"(?:[^"\\]|\\.)*"$/.test(value) ? null : 'malformed double-quoted value';
  if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? null : 'malformed single-quoted value';
  return PLAIN_INVALID.test(value) ? 'plain value needs quoting' : null;
}
export function frontmatterProblems(header) {
  const problems = [], keys = new Set();
  let list = false, block = false;
  header.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    if (/^\s/.test(line)) {
      const item = line.match(/^\s+- (.*?)\s*$/);
      if (block || (list && item && !scalarProblem(item[1]))) return;
      problems.push({ line: index + 1, reason: 'unsupported indented entry' });
      return;
    }
    const entry = line.match(/^([A-Za-z_][\w-]*):(?: +(.*?))?\s*$/);
    list = block = false;
    if (!entry) return problems.push({ line: index + 1, reason: 'expected key: value' });
    const [, key, value = ''] = entry;
    if (keys.has(key)) problems.push({ line: index + 1, key, reason: 'duplicate key' });
    keys.add(key);
    block = /^[|>][+-]?[1-9]?$/.test(value);
    list = value === '';
    const reason = block ? null : scalarProblem(value);
    if (reason) problems.push({ line: index + 1, key, value, reason, repairable: reason === 'plain value needs quoting' });
  });
  return problems;
}
const quoted = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

// Quotes plain values that YAML would reject, adds the flag, and verifies the
// result. Anything it cannot repair throws before the caller writes a file.
export function disableLegacySkill(text, name) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match || !new RegExp(`^name: *${name}\\s*$`, 'm').test(match[1]))
    throw new Error(`Unrecognized legacy skill: ${name}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = match[1].split(/\r?\n/);
  for (const problem of frontmatterProblems(match[1])) {
    if (!problem.repairable)
      throw new Error(`Invalid YAML frontmatter in legacy skill ${name} (line ${problem.line}: ${problem.reason}); repair it by hand. Nothing was written.`);
    lines[problem.line - 1] = `${problem.key}: ${quoted(problem.value)}`;
  }
  const repaired = lines.join(eol);
  const header = /^disable-model-invocation:/m.test(repaired)
    ? repaired.replace(/^disable-model-invocation:.*$/m, 'disable-model-invocation: true')
    : `${repaired}${eol}disable-model-invocation: true`;
  const remaining = frontmatterProblems(header);
  if (remaining.length)
    throw new Error(`Invalid YAML frontmatter in legacy skill ${name} (line ${remaining[0].line}: ${remaining[0].reason}); repair it by hand. Nothing was written.`);
  return `---${eol}${header}${eol}---` + text.slice(match[0].length);
}

// Validate both generations before writing any file. Only managed text changes.
export function migrateInstructions(text, name) {
  const block = `<!-- forja-core:begin -->\n${coreInstructions()}\n<!-- forja-core:end -->`;
  const ranges = [];
  for (const prefix of ['forja', 'forja-core']) {
    const begin = `<!-- ${prefix}:begin -->`, end = `<!-- ${prefix}:end -->`;
    const start = text.indexOf(begin), finish = text.indexOf(end);
    if ((start < 0) !== (finish < 0) || finish < start ||
        (start >= 0 && (text.indexOf(begin, start + begin.length) >= 0 || text.indexOf(end, finish + end.length) >= 0)))
      throw new Error(`Unmatched managed markers in ${name}`);
    if (start >= 0) ranges.push({ start, end: finish + end.length });
  }
  ranges.sort((a, b) => a.start - b.start);
  if (ranges.length === 2 && ranges[0].end > ranges[1].start)
    throw new Error(`Overlapping managed markers in ${name}`);
  if (!ranges.length) return `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${block}\n`;
  let result = text;
  const eol = text.slice(ranges[0].start).split('\n', 1)[0].endsWith('\r') ? '\r\n' : '\n';
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    result = result.slice(0, r.start) + (i === 0 ? block.replaceAll('\n', eol) : '') + result.slice(r.end);
  }
  return result;
}
