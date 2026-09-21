#!/usr/bin/env node
// `npm run check` — the repo invariants a unit test cannot see.
//
// Six checks, all cheap, all deterministic, no network, no install:
//   1. the sample project's crew files are byte-identical to this repo's
//      (`.claude/{agents,skills}/**` vs `examples/sample-project/.claude/…`),
//      because a Sponsor who bootstraps a repo gets the sample's copy;
//   2. no control or invisible character (form feed, zero-width, bidi
//      overrides, word joiner, BOM, soft hyphen) in any versioned text file —
//      the same class of character the viewer refuses in a goal, which can
//      hide text from a reviewer while a model still reads it;
//   3. `data/events.jsonl` still replays through the viewer's reducer with
//      zero bad lines (skipped when the file is not there — `data/` is
//      git-ignored evidence, not every clone has it);
//   4. the model policy is written in words in exactly one place
//      (`lib/models.mjs`, printed by `policyText`) plus the table of
//      `docs/ARCHITECTURE.md` §6; no second copy in `CLAUDE.md`, in the rest
//      of the architecture, in the runner's prompts or in the crew's skills;
//   5. the autonomy rule of a run (lib/autonomy.mjs, docs/ARCHITECTURE.md
//      §6b) still reaches every file that has to carry it: the CLI, the
//      runner's prompts, the four skills, CLAUDE.md, the architecture and the
//      runbook.
//   6. no runner prompt, skill or agent (this repo's or the sample project's
//      copy) commands opening `docs/forja/TASKS.json` directly (D30-b, S7):
//      `forja task show` / `forja status` / `forja context --task` give the
//      same whole information without it.
//
// Prints one line per failure and exits 1; otherwise prints `check ok`.
// Everything is exported and pure enough to test (test/check.test.mjs); the
// script only runs itself when it is the entry point.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- shared ----------
export function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

// ---------- 1. the sample project is a byte-identical copy of the crew ----------
export const CREW_DIRS = ['agents', 'skills'];
const BOOTSTRAP_HINT = 'corre `node bin/forja.mjs bootstrap examples/sample-project`';

// Returns one line per divergence, in reading order. `[]` = the copy is exact.
export function sampleDivergences(srcDir, dstDir, kind = 'skills') {
  const lines = [];
  const ours = walk(srcDir);
  const theirs = walk(dstDir);
  for (const f of ours) {
    const b = join(dstDir, f);
    if (!existsSync(b)) { lines.push(`sample: falta .claude/${kind}/${f} em examples/sample-project — ${BOOTSTRAP_HINT}`); continue; }
    if (!readFileSync(join(srcDir, f)).equals(readFileSync(b))) lines.push(`sample: .claude/${kind}/${f} difere da cópia em examples/sample-project — ${BOOTSTRAP_HINT}`);
  }
  for (const f of theirs) if (!ours.includes(f)) lines.push(`sample: examples/sample-project/.claude/${kind}/${f} não existe em .claude/${kind}/ — apaga-o ou traz a fonte para cá`);
  return lines;
}

export function checkSample(root) {
  const sample = join(root, 'examples', 'sample-project');
  if (!existsSync(sample)) return []; // a bootstrapped repo has no sample
  return CREW_DIRS.flatMap(kind => sampleDivergences(join(root, '.claude', kind), join(sample, '.claude', kind), kind));
}

// ---------- 2. no control or invisible characters in versioned text ----------
// The forbidden characters are declared as **code points**, never as literals:
// this file is itself versioned and scanned, so a literal here would make
// `npm run check` fail on its own source for ever. An escape sequence in a
// string is not safe either — an editor, a shell heredoc or a JSON-encoded
// tool call can turn an escape sequence into the character it names — that is
// exactly how the first version of this file got them. Numbers survive it all.
// Form feed; soft hyphen; zero-width space/non-joiner/joiner and the two
// directional marks; the four bidi embedding/override controls; word joiner
// and the invisible maths operators; the four bidi isolates; BOM / zero-width
// no-break space. Tab, CR and LF are legitimate and are deliberately absent.
export const INVISIBLE_RANGES = Object.freeze([
  [0x000C, 0x000C, 'form feed (U+000C)'],
  [0x00AD, 0x00AD, 'soft hyphen (U+00AD)'],
  [0x200B, 0x200F, null],
  [0x202A, 0x202E, null],
  [0x2060, 0x2064, null],
  [0x2066, 0x2069, null],
  [0xFEFF, 0xFEFF, 'BOM / zero-width no-break space (U+FEFF)'],
]);
const cp = n => String.fromCharCode(n);
export const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? cp(a) : `${cp(a)}-${cp(b)}`)).join('')}]`, 'g');
// Versioned text worth scanning: the extensions the repo uses, the text files
// that have no extension at all (`hooks/` scripts without a suffix, `LICENSE`)
// and the dotfiles that are text by definition. Binaries (PNG, fonts) are left
// alone.
export const TEXT_EXT = /\.(md|mjs|js|json|css|html)$/i;
export const TEXT_DOTFILES = new Set(['.gitignore', '.gitattributes', '.gitmodules', '.editorconfig', '.npmrc', '.nvmrc']);
export function isTextFile(f) {
  const name = String(f).split('/').pop();
  if (TEXT_EXT.test(name)) return true;
  if (TEXT_DOTFILES.has(name)) return true;
  return !name.includes('.'); // no extension at all
}
const NAMES = new Map(INVISIBLE_RANGES.filter(([, , name]) => name).map(([code, , name]) => [cp(code), name]));
export const charName = ch => NAMES.get(ch) || `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

// [{ line, column, char, name }] for every invisible character in `text`.
export function findInvisible(text) {
  const hits = [];
  INVISIBLE.lastIndex = 0;
  let m;
  while ((m = INVISIBLE.exec(String(text))) !== null) {
    const before = String(text).slice(0, m.index);
    hits.push({ line: before.split('\n').length, column: m.index - (before.lastIndexOf('\n') + 1) + 1, char: m[0], name: charName(m[0]) });
  }
  return hits;
}

export function versionedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0').filter(Boolean);
}

// At most `max` hits per file: a file with a thousand of them says it once.
export function checkInvisible(root, files, max = 5) {
  const out = [];
  for (const f of files.filter(isTextFile)) {
    const path = join(root, f);
    if (!existsSync(path)) continue; // in the index, deleted in the tree
    for (const hit of findInvisible(readFileSync(path, 'utf8')).slice(0, max)) {
      out.push(`invisíveis: ${f}:${hit.line}:${hit.column} — ${hit.name}`);
    }
  }
  return out;
}

// ---------- 3. the event stream still replays ----------
export async function checkReplay(root, dataDir = process.env.FORJA_DATA_DIR ? resolve(process.env.FORJA_DATA_DIR) : join(root, 'data')) {
  const path = join(dataDir, 'events.jsonl');
  if (!existsSync(path)) return { skipped: true, failures: [] };
  const { createState, applyLine } = await import(`file://${join(root, 'viewer', 'lib', 'state.mjs').replace(/\\/g, '/')}`);
  const state = createState();
  let n = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) applyLine(state, line, ++n);
  const failures = state.badLines > 0
    ? [`replay: o redutor rejeitou ${state.badLines} de ${state.lines} linhas de ${relative(root, path).replace(/\\/g, '/')} — corre \`node --test test/state.test.mjs\` e vê o que mudou`]
    : [];
  return { skipped: false, lines: state.lines, badLines: state.badLines, failures };
}

// ---------- 4. the model policy has exactly one source ----------
// `lib/models.mjs` builds the sentence (`policyText`); §6 of the architecture
// keeps the table for a human reader. Anywhere else these words mean a second
// copy, which is exactly what drifts.
export const POLICY_MARKERS = [/sonnet em tasks/i, /devs em sonnet/i];
export const policyMarkersIn = text => POLICY_MARKERS.map(re => String(text).match(re)).filter(Boolean);
export const policyScanList = root => [
  'CLAUDE.md',
  'docs/ARCHITECTURE.md',
  'bin/forja.mjs',
  ...walk(join(root, 'lib')).filter(f => f.endsWith('.mjs') && f !== 'models.mjs').map(f => `lib/${f}`),
  ...walk(join(root, '.claude', 'skills')).map(f => `.claude/skills/${f}`),
  ...walk(join(root, '.claude', 'agents')).map(f => `.claude/agents/${f}`),
];
// §6 is the one section allowed to restate the table in prose.
export function stripPolicySection(text) {
  const start = text.indexOf('\n## 6. forjalvl e effort');
  if (start === -1) return text;
  const after = text.indexOf('\n## ', start + 1);
  return text.slice(0, start) + (after === -1 ? '' : text.slice(after));
}

export function checkPolicySource(root, files = policyScanList(root)) {
  const out = [];
  for (const f of files) {
    const path = join(root, f);
    if (!existsSync(path)) continue;
    let text = readFileSync(path, 'utf8');
    if (f.endsWith('ARCHITECTURE.md')) text = stripPolicySection(text);
    for (const m of policyMarkersIn(text)) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push(`política de modelos: ${f}:${line} escreve a tabela ("${m[0]}") — a fonte é lib/models.mjs (policyText); aponta para docs/ARCHITECTURE.md §6`);
    }
  }
  return out;
}

// ---------- 5. the autonomy rule reaches the crew ----------
// The opposite problem of check 4. The model policy must exist in ONE place
// because it is a table; the autonomy rule (`lib/autonomy.mjs`, docs/ARCHITECTURE.md
// §6b) must exist in SEVERAL, because each of these files is what an agent or the
// Sponsor actually reads at the moment it matters — and the failure mode seen on
// 17 set 2026 was precisely a rule that lived only in the Sponsor's head while
// the crew kept queueing free dependencies. This check does not compare wording
// (the skills explain the rule to their own role): it refuses a file that stopped
// mentioning autonomy at all.
export const AUTONOMY_MARKER = /autonom(y|ia)/i;
export const AUTONOMY_FILES = [
  "CLAUDE.md",
  "docs/ARCHITECTURE.md",
  "docs/RUNBOOK-UNATTENDED.md",
  "lib/runner.mjs",
  "bin/forja.mjs",
  ".claude/skills/forja-crew/SKILL.md",
  ".claude/skills/forja-lead/SKILL.md",
  ".claude/skills/forja-product/SKILL.md",
  ".claude/skills/forja-scout/SKILL.md",
];
export function checkAutonomyRule(root, files = AUTONOMY_FILES) {
  // Only this repo: the rule lives in lib/autonomy.mjs, and a repo without it
  // (a bootstrapped project, a fixture) has no crew of ours to keep honest.
  if (!existsSync(join(root, "lib", "autonomy.mjs"))) return [];
  const out = [];
  for (const f of files) {
    const path = join(root, f);
    if (!existsSync(path)) continue; // a bootstrapped repo has no docs/ of ours
    if (!AUTONOMY_MARKER.test(readFileSync(path, "utf8"))) {
      out.push(`autonomia: ${f} não diz nada sobre a autonomia do run — a regra vive em lib/autonomy.mjs e tem de chegar a este ficheiro (docs/ARCHITECTURE.md §6b)`);
    }
  }
  return out;
}

// ---------- 6. nothing commands opening docs/forja/TASKS.json directly ----------
// D30-b / S7: a Dev, the QA and the Lead get the SAME whole information through
// `forja task show T<n>` / `forja status` / `forja context --task T<n>` (D30-a:
// take away the reason before the instruction) — so no prompt or skill needs to
// name `TASKS.json` as a thing to open. Naming the file as a FORMAT or a WRITE
// target stays legitimate (the Architect writes the plan there through the CLI,
// `lib/state-files.mjs` defines the path, `docs/ARCHITECTURE.md` describes the
// format): this only fires when a read/open verb sits on the SAME LINE, before
// the mention, and that line does not already say, in the same breath, that the
// file is never opened directly (the pattern this repo already uses in
// `lib/runner.mjs` and in forja-lead's own §"You know nothing but the disk").
export const TASKS_JSON_OPEN_VERBS = /\b(read|reading|lendo|lê|ler|leia|abrir|abre|abrindo|open|opens|opening|carregar|carrega)\b/i;
export const TASKS_JSON_NEGATION = /\b(instead of|em vez de|never|nunca|not\b|não\b|does not|doesn't|don't)\b/i;

// [{ line, excerpt }] for every line of `text` that commands opening TASKS.json.
export function findTasksJsonOpenCommands(text) {
  const hits = [];
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    let idx = line.indexOf('TASKS.json');
    while (idx !== -1) {
      const before = line.slice(0, idx);
      if (TASKS_JSON_OPEN_VERBS.test(before) && !TASKS_JSON_NEGATION.test(line)) {
        hits.push({ line: i + 1, excerpt: line.trim().slice(0, 160) });
        break; // one hit per line is enough to name it
      }
      idx = line.indexOf('TASKS.json', idx + 1);
    }
  });
  return hits;
}

// The prompts and crew files a specialist or the Lead actually reads: the
// runner's prompts, every skill and every agent (this repo's and the sample
// project's byte-identical copy), and the resume prompt in bin/forja.mjs.
export function tasksJsonScanList(root) {
  const files = ['lib/runner.mjs', 'bin/forja.mjs'];
  const dirs = [
    ['.claude/skills', f => f.endsWith('SKILL.md')],
    ['.claude/agents', f => f.endsWith('.md')],
    ['examples/sample-project/.claude/skills', f => f.endsWith('SKILL.md')],
    ['examples/sample-project/.claude/agents', f => f.endsWith('.md')],
  ];
  for (const [dir, keep] of dirs) {
    for (const f of walk(join(root, ...dir.split('/')))) if (keep(f)) files.push(`${dir}/${f}`);
  }
  return files;
}

export function checkNoTasksJsonRead(root, files = tasksJsonScanList(root)) {
  const out = [];
  for (const f of files) {
    const path = join(root, f);
    if (!existsSync(path)) continue;
    for (const hit of findTasksJsonOpenCommands(readFileSync(path, 'utf8'))) {
      out.push(`TASKS.json: ${f}:${hit.line} manda abrir/ler docs/forja/TASKS.json diretamente — usa \`forja task show T<n>\` ou \`forja context --task T<n>\` ("${hit.excerpt}")`);
    }
  }
  return out;
}
// ---------- everything, in order ----------
export async function runChecks({ root = REPO_ROOT, files = null } = {}) {
  const failures = [];
  let list = files;
  if (list === null) {
    try { list = versionedFiles(root); }
    catch (err) { failures.push(`invisíveis: não consegui listar os ficheiros versionados (${err.message}) — a verificação 2 não correu`); list = []; }
  }
  failures.push(...checkSample(root));
  failures.push(...checkInvisible(root, list));
  failures.push(...checkPolicySource(root));
  failures.push(...checkAutonomyRule(root));
  failures.push(...checkNoTasksJsonRead(root));
  const replay = await checkReplay(root);
  failures.push(...replay.failures);
  return { failures, files: list, replay };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { failures, files, replay } = await runChecks({});
  if (failures.length) {
    console.error(`check: ${failures.length} falha${failures.length === 1 ? '' : 's'}`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }
  console.log(`check ok — ${files.length} ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, regra de autonomia em todos os ficheiros que a carregam, nenhum ficheiro manda abrir TASKS.json diretamente, ${replay.skipped ? 'sem data/events.jsonl para reproduzir' : `${replay.lines} eventos reproduzidos sem linhas más`}`);
}
