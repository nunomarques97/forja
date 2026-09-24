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

export function disableLegacySkill(text, name) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  if (!match || !new RegExp(`^name: *${name}\\s*$`, 'm').test(match[1]))
    throw new Error(`Unrecognized legacy skill: ${name}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const header = /^disable-model-invocation:/m.test(match[1])
    ? match[1].replace(/^disable-model-invocation:.*$/m, 'disable-model-invocation: true')
    : `${match[1]}${eol}disable-model-invocation: true`;
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
