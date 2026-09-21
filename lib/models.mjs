// forjalvl (nível de modelos) of a run — docs/ARCHITECTURE.md §6.
//
// The Sponsor picks how much model power a run may spend: `high` (default),
// `max` or `eco`. The forjalvl lives in the run's state (`RUN.json.forjalvl`,
// default from the project's `docs/forja/SETTINGS.json`), never in the agent
// files: the same crew runs cheaper or richer without editing .claude/agents/*.
// (Named `forjalvl` since the Sponsor's decision of 17 set 2026, so it is never
// confused with the session's `effort`; files written before that carry the old
// key `model_level` and are still read — `readForjalvl` below.)
//
// Two invariants hold at every forjalvl, by construction:
//   1. Reviewer and Security Reviewer are never weaker than the Dev they review
//      (they are always "opus", and a Dev never goes above "opus").
//   2. Nobody runs on Fable except the Architect, and only at forjalvl `max`
//      while the run's model floor is still "fable".
// Native Claude Code tools are always "sonnet".
//
// Node core only; no I/O.

export const LEVELS = Object.freeze(['max', 'high', 'eco']);
export const LEVEL_LABEL = Object.freeze({ max: 'máximo', high: 'alto', eco: 'económico' });

// Accepted on the CLI and in SETTINGS.json: the canonical ids and the Portuguese
// names the UI and the docs use (with or without the accent).
const ALIASES = Object.freeze({
  max: 'max', maximo: 'max', máximo: 'max',
  high: 'high', alto: 'high',
  eco: 'eco', economico: 'eco', económico: 'eco',
});

// Empty/missing means "the default forjalvl" (high — Sponsor's correction, 18
// set 2026: max was landing every unattended run on Fable/Opus by default,
// burning through the Sponsor's usage limit faster and risking a mid-run stop
// with nobody watching); anything else unknown throws, so a typo on the CLI or
// in SETTINGS.json is refused instead of silently running the whole run on the
// wrong forjalvl.
export function normalizeLevel(x) {
  if (x === undefined || x === null || x === '') return 'high';
  const k = String(x).trim().toLowerCase();
  // `Object.hasOwn`, never a plain lookup: "constructor", "__proto__" and the
  // rest of Object.prototype must be unknown names, not silent matches.
  if (Object.hasOwn(ALIASES, k)) return ALIASES[k];
  throw new Error(`forjalvl desconhecido: "${String(x)}" — usa max|high|eco (ou máximo|alto|económico)`);
}

// The forjalvl stored in a state file (RUN.json, SETTINGS.json). The current key
// is `forjalvl`; a file written before the rename (17 set 2026) only has
// `model_level` and is read as it is, never rewritten. `undefined` when neither
// key is there, so the caller can tell "not set" from "set to something".
export function readForjalvl(o) {
  if (!o || typeof o !== 'object') return undefined;
  return o.forjalvl !== undefined ? o.forjalvl : o.model_level;
}

// Per-role models of a forjalvl. `floor` is the run's model floor (RUN.json.model_floor)
// and only affects the Architect at forjalvl `max`: Fable while the Fable quota lasts,
// Opus once a fallback dropped the floor.
export function modelsFor(level, floor = 'fable') {
  const lv = normalizeLevel(level);
  const architect = lv === 'max' && String(floor || 'fable').toLowerCase() === 'fable' ? 'fable' : 'opus';
  const onDemand = {
    max: { qa: 'opus', 'product-manager': 'opus', 'product-designer': 'opus', 'technology-scout': 'opus' },
    high: { qa: 'sonnet', 'product-manager': 'opus', 'product-designer': 'opus', 'technology-scout': 'sonnet' },
    eco: { qa: 'sonnet', 'product-manager': 'sonnet', 'product-designer': 'sonnet', 'technology-scout': 'sonnet' },
  }[lv];
  return Object.freeze({ architect, reviewer: 'opus', 'security-reviewer': 'opus', ...onDemand, native: 'sonnet' });
}

// The Dev's model for one attempt at one task. Never fable, at any forjalvl.
export function devModelFor(level, task, attempt = 1) {
  const lv = normalizeLevel(level);
  const c = String((task && task.complexity) || 'medium').toLowerCase();
  const n = Number(attempt) || 1;
  if (lv === 'eco') return n >= 3 ? 'opus' : 'sonnet';
  return c === 'hard' || n >= 2 ? 'opus' : 'sonnet';
}

// Effort of a runner session (docs/ARCHITECTURE.md §6). The Agent tool has no
// effort parameter and a subagent inherits the effort of the session that calls
// it, so the effort is decided per session, by forjalvl and by what the session does:
// the planning/closing phases think for the whole run, a task session thinks as
// much as its complexity (and one step more when the first attempt failed).
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);
const EFFORT_UP = Object.freeze({ low: 'medium', medium: 'high', high: 'high' }); // one step up, capped at `high`: a retry never asks for `max`
const PHASE_EFFORT = Object.freeze({ max: 'max', high: 'high', eco: 'medium' });
const TASK_EFFORT = Object.freeze({
  max: { easy: 'medium', medium: 'medium', hard: 'high' },
  high: { easy: 'medium', medium: 'medium', hard: 'high' },
  eco: { easy: 'low', medium: 'medium', hard: 'medium' },
});
export function effortFor(level, phase = 'task', task = null, attempt = 1) {
  const lv = normalizeLevel(level);
  if (phase !== 'task') return PHASE_EFFORT[lv];
  const c = String((task && task.complexity) || 'medium').toLowerCase();
  // `Object.hasOwn` for the same reason as in normalizeLevel: complexity comes
  // from TASKS.json, and "constructor" must fall back to medium, not to a function.
  const base = Object.hasOwn(TASK_EFFORT[lv], c) ? TASK_EFFORT[lv][c] : TASK_EFFORT[lv].medium;
  return (Number(attempt) || 1) >= 2 ? EFFORT_UP[base] : base;
}

// Reading a forjalvl already on disk (RUN.json) never throws: a corrupted value
// must not brick every `forja` command mid-run — it reads as the default.
// Input from a person (CLI flag, SETTINGS.json) goes through normalizeLevel,
// which refuses it loudly before the run starts.
export const levelOf = value => { try { return normalizeLevel(value); } catch { return 'high'; } };
export const labelOf = level => LEVEL_LABEL[levelOf(level)];

// ---------- the policy sentence: one source, derived, never hand-written ----------
//
// The model policy is stated in words in a lot of places (the runner's prompts,
// `forja status`, `forja resume`, the handover, CLAUDE.md, docs/ARCHITECTURE.md
// §6). Every one of those is a copy that can drift from the code that actually
// decides the models. `policyText(level)` builds that sentence *from*
// `modelsFor` / `devModelFor` / `effortFor`, so a change to the table can only
// be made in one place; `npm run check` (tools/check.mjs) refuses a second copy
// of the sentence anywhere else in the repo.
const MODEL_NAME = Object.freeze({ fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' });
const EFFORT_PT = Object.freeze({ low: 'baixo', medium: 'médio', high: 'alto', max: 'máximo' });
// The on-demand roles, in the order the sentence lists them (the two review
// gates first: they are the invariant a reader must see).
const POLICY_ROLES = Object.freeze([
  ['reviewer', 'Reviewer'], ['security-reviewer', 'Security Reviewer'], ['qa', 'QA'],
  ['product-manager', 'Product Manager'], ['product-designer', 'Product Designer'], ['technology-scout', 'Technology Scout'],
]);
const COMPLEXITIES = Object.freeze(['easy', 'medium', 'hard']);
// "A", "A e B", "A, B e C" — Portuguese enumeration.
const enumerate = xs => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}`);

function devsPhrase(lv) {
  const base = devModelFor(lv, { complexity: 'easy' }, 1);
  const hard = devModelFor(lv, { complexity: 'hard' }, 1);
  const upAt = [2, 3].find(n => devModelFor(lv, { complexity: 'easy' }, n) !== base);
  const up = upAt ? devModelFor(lv, { complexity: 'easy' }, upAt) : base;
  if (hard !== base) return `Devs em ${MODEL_NAME[base]}, ${MODEL_NAME[hard]} em tasks hard e a partir da ${upAt}.ª tentativa`;
  return `Devs em ${MODEL_NAME[base]}, ${MODEL_NAME[up]} só a partir da ${upAt}.ª tentativa`;
}
function rolesPhrases(lv, floor) {
  const m = modelsFor(lv, floor);
  const byModel = new Map();
  for (const [key, label] of POLICY_ROLES) {
    if (!byModel.has(m[key])) byModel.set(m[key], []);
    byModel.get(m[key]).push(label);
  }
  // Strongest first, so "Reviewer … em Opus" always leads.
  const order = ['fable', 'opus', 'sonnet', 'haiku'].filter(x => byModel.has(x));
  return order.map(model => `${enumerate(byModel.get(model))} em ${MODEL_NAME[model]}`);
}
function effortPhrase(lv) {
  const phase = effortFor(lv, 'plan');
  const groups = new Map(); // effort → complexities, in easy/medium/hard order
  for (const c of COMPLEXITIES) {
    const e = effortFor(lv, 'task', { complexity: c }, 1);
    if (!groups.has(e)) groups.set(e, []);
    groups.get(e).push(c);
  }
  const ordered = [...EFFORTS].reverse().filter(e => groups.has(e)); // max → low
  let head = `effort ${EFFORT_PT[phase]} nas fases de plano e fecho`;
  let rest = ordered;
  if (groups.has(phase)) { // the phase effort and a task group coincide: say it once
    head += ` e nas tasks ${groups.get(phase).join('/')}`;
    rest = ordered.filter(e => e !== phase);
  } else {
    rest = ordered.slice(1);
    head = `${head}, ${EFFORT_PT[ordered[0]]} nas tasks ${groups.get(ordered[0]).join('/')}`;
  }
  return [head, ...rest.map(e => `${EFFORT_PT[e]} nas ${groups.get(e).join('/')}`)].join(', ');
}
// One line in Portuguese for prompts, `forja status`, the handover and the docs.
// `floor` only moves the Architect, and only at `max`; the sentence names the
// fallback explicitly there instead of pretending the floor never drops.
export function policyText(level, floor = 'fable') {
  const lv = levelOf(level);
  const architect = modelsFor(lv, floor).architect;
  const arch = architect === 'fable' ? 'Architect em Fable (Opus depois de um fallback)' : `Architect em ${MODEL_NAME[architect]}`;
  return [arch, devsPhrase(lv), ...rolesPhrases(lv, floor), `ferramentas nativas em ${MODEL_NAME[modelsFor(lv, floor).native]}`, effortPhrase(lv)].join('; ');
}
// `detailOf` is the same line without the label, for places that already print it.
export const detailOf = level => policyText(level);
export function describeLevel(level) {
  return `${labelOf(level)} — ${policyText(level)}`;
}
