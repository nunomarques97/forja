// Forja run state on disk — docs/forja/ inside the PROJECT being worked on
// (docs/ARCHITECTURE.md §7) — plus the global event stream in <forja>/data.
// Used by bin/forja.mjs; no I/O outside the project's docs/forja/ and the
// Forja data dir. Node core only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { detailOf, labelOf, levelOf, readForjalvl } from './models.mjs';
import { autonomyLabelOf, autonomyRule, readAutonomy } from './autonomy.mjs';

export const forjaRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const dataDir = () => process.env.FORJA_DATA_DIR || join(forjaRoot, 'data');
export const eventsPath = () => join(dataDir(), 'events.jsonl');

export function projectKey(cwd) {
  return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
export const pointerName = cwd => projectKey(cwd).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.json';

export function projectRoot() {
  return process.env.FORJA_PROJECT_ROOT || process.cwd();
}
export const stateDir = () => join(projectRoot(), 'docs', 'forja');
export const runPath = () => join(stateDir(), 'RUN.json');
export const tasksPath = () => join(stateDir(), 'TASKS.json');
export const decisionsPath = () => join(stateDir(), 'DECISIONS.md');
export const queuePath = () => join(stateDir(), 'SPONSOR-QUEUE.md');
export const handoverPath = () => join(stateDir(), 'HANDOVER.md');
export const settingsPath = () => join(stateDir(), 'SETTINGS.json');
// Written by the Product Manager and by the Technology Scout, read by everyone
// before a trade-off (forja-crew). No `forja` command writes them; they are
// here so the readers (`forja context`) name them in one place.
export const productProfilePath = () => join(stateDir(), 'PRODUCT-PROFILE.md');
export const technologyPath = () => join(stateDir(), 'TECHNOLOGY.md');
// Hand-backs and verdicts of the run, one file per task and attempt
// (`T<id>-a<n>-dev.md`, `T<id>-a<n>-review.md`): prompts carry the path, never
// the text (lib/runner.mjs `reportPath`).
export const reportsDir = () => join(stateDir(), 'reports');

export function nowIso() { return new Date().toISOString(); }
export function fmtLocal(iso) {
  const d = new Date(iso || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- session / run identity (§3) ----------
export function currentSessionId() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const p = join(dataDir(), 'sessions', pointerName(projectRoot()));
    // The pointer is the last session seen for this project, ended or not:
    // a CLI call right after SessionEnd still belongs to that session.
    if (existsSync(p)) { const j = JSON.parse(readFileSync(p, 'utf8')); if (j.session_id) return String(j.session_id); }
  } catch {}
  return 'cli-' + pointerName(projectRoot()).replace(/.json$/, ''); // per project, so two fresh projects never share a key
}

export function newRunId(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `R-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${randomBytes(2).toString('hex')}`;
}

// ---------- JSON files ----------
export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
// tmp + rename (docs/ARCHITECTURE.md §3c): the guard, the viewer and the
// catalogue read RUN.json while a CLI call writes it, and a plain writeFileSync
// could hand them half a file. On Windows a rename over a file that another
// process has open for reading fails with EPERM/EBUSY for a few milliseconds:
// retried briefly, and as a last resort written in place (the old behaviour)
// rather than lost.
const RENAME_RETRIES = 20;
const pauseMs = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
// Shared by writeJson and the DECISIONS.md index writer below: write to a
// per-process tmp file, then rename over the target. Same Windows retry as
// writeJson (a rename over a file another process has open for reading can
// fail briefly with EPERM/EBUSY) and the same last resort (write in place
// rather than lose the write).
function writeFileAtomic(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, path); return; } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err && err.code) || i >= RENAME_RETRIES) {
        try { unlinkSync(tmp); } catch {}
        writeFileSync(path, body);
        return;
      }
      pauseMs(10);
    }
  }
}
export function writeJson(path, value) {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}
export const readRun = () => readJson(runPath(), null);
export const writeRun = run => writeJson(runPath(), { ...run, updated_at: nowIso() });
export const readTasks = () => readJson(tasksPath(), []);
export const writeTasks = tasks => writeJson(tasksPath(), tasks);

// A task blocked because the Architect re-planned it (`--why "replaneada: <ids>"`,
// runner step 5) is superseded, not stuck: nothing waits on the Sponsor, so it
// never notifies the phone. `isSupersededBlock` also covers the runner's cascade
// line (`dependência T<n> está bloqueada`) when T<n> itself was re-planned.
export const isReplanBlock = why => /^\W*re-?plan(?:ead[ao]|ned)\b/i.test(String(why || ''));
export function isSupersededBlock(why, tasks = []) {
  if (isReplanBlock(why)) return true;
  const m = String(why || '').match(/^depend[eê]ncia\s+(\S+)\s+está\s+bloqueada/i);
  const dep = m && tasks.find(t => t.id === m[1]);
  return !!(dep && dep.status === 'blocked' && isReplanBlock(dep.why));
}

// Per-project defaults (docs/forja/SETTINGS.json, committed): today `forjalvl`
// (docs/ARCHITECTURE.md §6) and `autonomy` (§6b). Written key by key so a file
// with other keys — or written by a later version — keeps them.
//
// No file = no defaults ({}). A file that exists but cannot be read or parsed
// is NOT the same thing and never reads as {}: a truncated or hand-edited
// SETTINGS.json would otherwise run the whole run on the wrong forjalvl without a
// word, and the next `models set` would overwrite it and drop its other keys.
// It throws instead, and every caller turns that into a refusal. A UTF-8 BOM
// (PowerShell's `>`/`Set-Content` default) is accepted: it is a readable file.
export class SettingsError extends Error {
  constructor(detail) { super(`${settingsPath()} ilegível: ${detail} — corrige-o à mão`); this.name = 'SettingsError'; }
}
export function readSettings() {
  let text;
  try { text = readFileSync(settingsPath(), 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new SettingsError(err && err.message ? err.message : String(err));
  }
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (err) { throw new SettingsError(err && err.message ? err.message : String(err)); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError('esperava um objeto JSON');
  return value;
}
export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }; // throws before writing: never overwrite a file we could not read
  // The rename of 17 set 2026 (`model_level` → `forjalvl`): writing the new key
  // retires the old one instead of leaving two names for the same setting in the
  // file. Reading never rewrites anything (lib/models.mjs `readForjalvl`).
  if (patch && patch.forjalvl !== undefined) delete next.model_level;
  writeJson(settingsPath(), next);
  return next;
}

// ---------- markdown logs (append-only) ----------
export function nextId(path, prefix) {
  if (!existsSync(path)) return `${prefix}1`;
  const text = readFileSync(path, 'utf8');
  const ids = [...text.matchAll(new RegExp(`\\b${prefix}(\\d+)\\b`, 'g'))].map(m => Number(m[1]));
  return `${prefix}${(ids.length ? Math.max(...ids) : 0) + 1}`;
}
export function appendMd(path, header, text) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, header);
  appendFileSync(path, text);
}

// ---------- DECISIONS.md index (docs/forja/TECHNOLOGY.md S3, D9/D10) ----------
// A derived, regenerated-whole block at the top of DECISIONS.md so a session
// can read one table instead of the whole append-only log. Two pure functions
// (text in, text out — node:fs only shows up in reindexDecisionsFile, which
// does the atomic write) plus the constants a caller needs to spot the block.
export const DECISIONS_INDEX_START = '<!-- forja:index -->';
export const DECISIONS_INDEX_END = '<!-- /forja:index -->';
export const DECISIONS_INDEX_INSTRUCTION = 'Lê esta tabela primeiro; abre a decisão completa só quando este trabalho depender dela.';
// D10: "abaixo de ~10 000 caracteres"; the generator warns past it but never
// paginates or summarises in this version.
export const DECISIONS_INDEX_BUDGET = 10000;

const DECISION_LINE_RE = /^- \*\*D(\d+)\*\*/;
// The same test, anchored to line start anywhere in the file: used to find
// where the corpo begins.
const FIRST_DECISION_RE = new RegExp(DECISION_LINE_RE.source, 'm');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A real index block occupies WHOLE lines: start marker alone on its line, end
// marker alone on its line. Anchoring both to line start (flag `m`) is what
// keeps a decision line that *quotes* the markers inline — D10 in this repo's
// own DECISIONS.md does exactly that — from ever looking like a block. The
// inner part is tempered so it cannot swallow a second start marker: a stray,
// unterminated marker left by a hand edit is skipped over instead of eating
// the real block after it (which would break idempotency).
const INDEX_BLOCK_RE = new RegExp(
  `^${escapeRe(DECISIONS_INDEX_START)}[ \\t]*\\r?\\n`
  + `(?:(?!^${escapeRe(DECISIONS_INDEX_START)})[\\s\\S])*?`
  + `^${escapeRe(DECISIONS_INDEX_END)}[ \\t]*(?:\\r?\\n)*`,
  'gm',
);
// The block is written with the line ending the rest of the file already uses,
// so a CRLF DECISIONS.md does not end up half CRLF and half LF. Derived from
// header+corpo only (never from a previously generated block), so the answer is
// the same every time the generator runs — that is what makes it idempotent.
function dominantEol(text) {
  const all = (text.match(/\n/g) || []).length;
  const crlf = (text.match(/\r\n/g) || []).length;
  return crlf * 2 > all ? '\r\n' : '\n';
}
// One decision line, at its most complete: `- **D<n>** · <data> · <papel> · <run/task> — <texto>`.
// The three middle fields are separated by U+00B7 (·); the text starts after
// the em dash (U+2014). Any of that can be missing on a hand-written line —
// callers below always have a fallback that cannot throw.
const DECISION_FIELDS_RE = /^- \*\*D\d+\*\*\s*·\s*([^·\n]*?)\s*·\s*([^·\n]*?)\s*·[^\n]*?—\s*([\s\S]*)$/;
const REVERSIBLE_RE = /Revers[ií]vel:\s*([^\n]*)/i;
const SUPERSEDES_RE = /Substitui\s+(D\d+)/i;
const TITLE_STOP_RE = /\s(?:Porqu[êe]|Revers[ií]vel):/i;

// `max` counts the ellipsis too: a cut title is never longer than 70 characters
// (criterion 2, "título curto (<= 70 caracteres)").
function truncateTitle(text, max = 70) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '(sem texto)';
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const atWord = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return `${atWord.trimEnd()}…`;
}
function escapeCell(text) {
  return String(text || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}
function extractReversible(line) {
  const m = line.match(REVERSIBLE_RE);
  if (!m) return '-';
  const v = m[1].trim().toLowerCase();
  if (/^n[aã]o indicado/.test(v)) return '-';
  if (/^sim/.test(v)) return 'sim';
  if (/^n[aã]o/.test(v)) return 'não';
  return '-';
}
function extractTitle(rest) {
  const stop = rest.search(TITLE_STOP_RE);
  return truncateTitle(stop === -1 ? rest : rest.slice(0, stop));
}
// One line → one index row. Never throws (criterion 6): a line that does not
// match the full pattern still gets a best-effort title from whatever text it
// has, cut to ~70 chars at a word boundary.
function parseDecisionLine(line) {
  const idm = line.match(DECISION_LINE_RE);
  if (!idm) return null;
  const id = `D${idm[1]}`;
  let date = '-', role = '-', title = '(sem texto)';
  try {
    const fm = line.match(DECISION_FIELDS_RE);
    if (fm) {
      date = fm[1].trim() || '-';
      role = fm[2].trim() || '-';
      title = extractTitle(fm[3]);
    } else {
      const rest = line.slice(idm[0].length).replace(/^[\s·]+/, '');
      title = extractTitle(rest);
    }
  } catch { title = truncateTitle(line.slice(idm[0].length)); }
  let reversible = '-';
  try { reversible = extractReversible(line); } catch { reversible = '-'; }
  let supersedesTarget = null;
  try { const sm = line.match(SUPERSEDES_RE); if (sm) supersedesTarget = sm[1].toUpperCase(); } catch {}
  return { id, date, role, title, reversible, supersedesTarget };
}
// Everything before the first `- **D<n>**` line is "header" (title paragraph +
// blank line, plus any index block already there); everything from there to the
// end of the file is "corpo" and is NEVER touched — not even a character of it.
// The corpo boundary is found on the file as it is, and the old index block is
// stripped from the header region ONLY. That ordering is the whole point: the
// corpo of this repo's own DECISIONS.md contains a decision line (D10) that
// quotes both markers, and a whole-file strip deletes 44 characters out of the
// middle of it — silent loss in an append-only log (D9).
function splitHeaderAndBody(text) {
  const m = text.match(FIRST_DECISION_RE);
  const cut = m ? m.index : text.length;
  return { header: text.slice(0, cut).replace(INDEX_BLOCK_RE, ''), body: text.slice(cut) };
}

// buildDecisionsIndex(texto) — pure: the whole DECISIONS.md text in (with or
// without an existing index, does not matter), the index block out (markers
// included), or '' when the corpo has no decision line yet. Covers EVERY
// decision line found, including ones a later line says it substitutes.
export function buildDecisionsIndex(text) {
  const { header, body } = splitHeaderAndBody(String(text || ''));
  const rawLines = body.split('\n').map(l => l.replace(/\r$/, '')).filter(l => DECISION_LINE_RE.test(l));
  if (!rawLines.length) return '';
  const rows = rawLines.map(parseDecisionLine);
  const supersededBy = new Map();
  for (const row of rows) if (row.supersedesTarget) supersededBy.set(row.supersedesTarget, row.id);
  const lines = [
    DECISIONS_INDEX_START,
    DECISIONS_INDEX_INSTRUCTION,
    '',
    '| id | data | papel | título | reversível | substituída |',
    '|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.id} | ${escapeCell(r.date)} | ${escapeCell(r.role)} | ${escapeCell(r.title)} | ${r.reversible} | ${escapeCell(supersededBy.get(r.id) || '')} |`),
    DECISIONS_INDEX_END,
  ];
  return lines.join(dominantEol(header + body));
}

// withDecisionsIndex(texto) — pure: the whole file, header + freshly-built
// index block + corpo untouched, or the text unchanged when there is no
// decision line yet (no block is ever added to a header-only file). Applying
// this twice in a row gives the same bytes both times (D10).
export function withDecisionsIndex(text) {
  const original = String(text || '');
  const { header, body } = splitHeaderAndBody(original);
  const block = buildDecisionsIndex(original);
  if (!block) return header + body;
  const eol = dominantEol(header + body);
  return `${header}${block}${eol}${eol}${body}`;
}

// extractDecisionsIndex(texto) — pure, and the mirror of buildDecisionsIndex:
// the index block EXACTLY as it is on disk (markers included, trailing blank
// lines dropped), or '' when the file has none. A reader (`forja context`)
// prints this one, never a freshly built block: what a session reads has to be
// the bytes of the file it would have opened, or the two could disagree.
export function extractDecisionsIndex(text) {
  const m = String(text || '').match(INDEX_BLOCK_RE);
  return m ? m[0].replace(/(?:\r?\n)+$/, '') : '';
}

// extractMarkdownSection(texto, título) — pure: one `## <título>` section, from
// its heading to the next `## ` (or the end of the file), trailing blank lines
// dropped; '' when there is no such heading. Cutting Markdown by heading with
// nothing but string operations is decision S7 in docs/forja/TECHNOLOGY.md, and
// this module is where it lives. Used for the decisions table at the top of
// TECHNOLOGY.md, which a session reads before the full section of a capability.
export function extractMarkdownSection(text, title) {
  const lines = String(text || '').split('\n');
  const clean = l => l.replace(/\r$/, '').trim();
  const start = lines.findIndex(l => clean(l) === `## ${title}`);
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (clean(lines[i]).startsWith('## ')) { end = i; break; }
  return lines.slice(start, end).join('\n').replace(/(?:\r?\n)+$/, '');
}
// The heading of that table, written once here (the Technology Scout keeps the
// table itself up to date in every project's TECHNOLOGY.md).
export const TECHNOLOGY_TABLE_TITLE = 'Decisões em vigor';

// The one non-pure user of the two functions above: read DECISIONS.md, write
// it back (atomically) only if the index changed, and report what a caller
// (the `decisions reindex` CLI command) prints. Refuses in one sentence — no
// stack — when the file does not exist yet; never touches the corpo.
export function reindexDecisionsFile(path = decisionsPath()) {
  if (!existsSync(path)) throw new Error(`${path} não existe — corre \`forja run start --goal "…"\` ou \`forja bootstrap\` primeiro`);
  const before = readFileSync(path, 'utf8');
  const block = buildDecisionsIndex(before);
  const after = withDecisionsIndex(before);
  const changed = after !== before;
  if (changed) writeFileAtomic(path, after);
  const count = (block.match(/^\| D\d+ \|/gm) || []).length;
  return { path, count, size: block.length, overBudget: block.length > DECISIONS_INDEX_BUDGET, changed };
}

// ---------- TECHNOLOGY.md pagination (docs/forja/TECHNOLOGY.md S7, D30) ----------
// The mirror problem of the DECISIONS.md index above: there the corpo stays put
// and a derived summary is added on top; here each `## <capability> — … (S<n>,
// <date>)` section is the corpo itself, and it is what MOVES — out to its own
// file, `docs/forja/technology/S<n>.md`, in the íntegra (D9/D30: nothing is
// summarised, only relocated). What stays in TECHNOLOGY.md is the header
// (title paragraph + the "Decisões em vigor" table), rewritten so its last
// column is the path a session opens for the full section, never a bare `S<n>`.
export const technologyDir = () => join(stateDir(), 'technology');
// A section heading, anchored to line start: two literal `#`, a space, then
// anything, ending in `(S<n>, <date>)` with only trailing whitespace after the
// closing paren — and then, optionally, the `\r` of a CRLF file. That `\r?` is
// not decoration: the match runs on lines produced by `split('\n')`, and in
// JavaScript `.` never matches `\r` either, so without it EVERY heading of a
// CRLF TECHNOLOGY.md fails to match and the whole pagination becomes a silent
// no-op. The neighbouring mechanism over the same kind of document — the
// DECISIONS.md index above — is CRLF-aware for exactly this reason
// (`INDEX_BLOCK_RE`, `dominantEol`), and this repo runs with `core.autocrlf`
// on, so a fresh clone really does have this file in CRLF on disk.
// A `### ` sub-heading never matches (its third character is `#`, not a
// space), so nested headings inside a section are never mistaken for the start
// of the next one. What is NOT protected: fenced code blocks. The cut is
// line-based and knows nothing about ``` fences, so a line inside a code block
// that is itself a complete, well-formed `## … (S<n>, <date>)` heading WOULD
// be cut on. The tag is the only guard there is; it holds in practice because
// a quoted example almost never carries a full `(S<n>, <date>)` tag.
const TECHNOLOGY_SECTION_RE = /^## .*\(S(\d+),[^)]*\)[ \t]*\r?$/;
// The bare "S<n>" a table row's last cell holds before it is pointerised —
// nothing else in that cell, so a cell that is already a path never matches
// twice (idempotent). The CRLF `\r` sits INSIDE the trailing group, which the
// replacement writes back as it found it: a CRLF file stays CRLF on every
// line, never half one ending and half the other.
const TECHNOLOGY_TABLE_CELL_RE = /^(\|.*\|[ \t]*)S(\d+)([ \t]*\|[ \t]*\r?)$/;
// A header that already points at the section files: what tells "already
// paginated" apart from "nothing matched" when there is no section to move.
const TECHNOLOGY_POINTER_RE = /docs\/forja\/technology\/S\d+\.md/;
// How big TECHNOLOGY.md can be and still plausibly be *just* a header: this
// repo's paginated file is around 2 300 characters and S7's criterion asks for
// under 6 000. Past this size, a file where not one heading matched is far
// likelier to be an unpaginated file this code failed to read than a file with
// genuinely nothing to move — and that difference has to be said out loud,
// because the failure mode of a splitter is silence.
export const TECHNOLOGY_HEADER_BUDGET = 6000;

// splitTechnologySections(text) — pure: { header, sections }, where `header`
// is everything up to the first tagged heading (the title paragraph and the
// "Decisões em vigor" table) and `sections` is one `{ id: 'S<n>', body }` per
// capability, in file order. `header` followed by every `body`, concatenated
// in order, is byte-for-byte the original `text` — that equality is the whole
// split, nothing is trimmed, reflowed or reformatted.
export function splitTechnologySections(text) {
  const original = String(text || '');
  const lines = original.split('\n');
  const lineStart = []; // char offset where line i begins, given the '\n' join above
  let acc = 0;
  for (let i = 0; i < lines.length; i++) { lineStart.push(acc); acc += lines[i].length + 1; }
  const starts = [];
  lines.forEach((line, i) => { const m = line.match(TECHNOLOGY_SECTION_RE); if (m) starts.push({ i, id: `S${m[1]}` }); });
  if (!starts.length) return { header: original, sections: [] };
  const header = original.slice(0, lineStart[starts[0].i]);
  const sections = starts.map((s, idx) => {
    const from = lineStart[s.i];
    const to = idx + 1 < starts.length ? lineStart[starts[idx + 1].i] : original.length;
    return { id: s.id, body: original.slice(from, to) };
  });
  return { header, sections };
}

// pointerizeTechnologyTable(header) — pure: the header text with every table
// row whose last cell is a bare `S<n>` rewritten to the path of that section's
// file (`docs/forja/technology/S<n>.md`); every other line (the title
// paragraph, the table's own header/separator rows, a cell already pointing at
// a path) passes through untouched. Idempotent: running it twice gives the
// same bytes both times, because a cell that already holds a path no longer
// matches the bare-`S<n>` pattern.
export function pointerizeTechnologyTable(header) {
  return String(header || '').split('\n')
    .map(line => line.replace(TECHNOLOGY_TABLE_CELL_RE, (_, before, n, after) => `${before}docs/forja/technology/S${n}.md${after}`))
    .join('\n');
}

// The one non-pure user of the two functions above: read TECHNOLOGY.md, write
// every tagged section out to its own file under `outDir` (atomically), then
// rewrite the file itself to just the pointerised header. With no tagged
// section it changes nothing — but it says WHICH nothing it found, because on
// disk the three look identical and only two of them are fine:
//   `ja-paginado` — the header already points at docs/forja/technology/S<n>.md
//     (the sections moved out on an earlier run): the expected no-op, which is
//     what makes the command safe to run any number of times.
//   `sem-seccoes` — a small file with no decision recorded yet (a project the
//     Scout has not written to): also fine.
//   `nada-casou`  — a file past TECHNOLOGY_HEADER_BUDGET where NOT ONE heading
//     matched: `suspect: true` plus a sentence the CLI prints on stderr. This
//     is the state a CRLF file used to land in, quietly, and the reason the
//     caller gets a reason at all instead of a bare `changed: false`.
// Mirrors `reindexDecisionsFile`'s shape: refuses in one sentence, no stack.
// It refuses rather than lose text in one more case — two sections sharing an
// S<n> would write the same file twice and the second would erase the first,
// which is exactly what D9/D30 say never happens.
export function splitTechnologyFile(path = technologyPath(), outDir = technologyDir()) {
  if (!existsSync(path)) throw new Error(`${path} não existe — corre \`forja bootstrap\` ou pede a decisão ao Technology Scout primeiro`);
  const before = readFileSync(path, 'utf8');
  const { header, sections } = splitTechnologySections(before);
  if (!sections.length) {
    const suspect = before.length > TECHNOLOGY_HEADER_BUDGET;
    const reason = suspect ? 'nada-casou' : TECHNOLOGY_POINTER_RE.test(before) ? 'ja-paginado' : 'sem-seccoes';
    const warning = suspect
      ? `${path} tem ${before.length} caracteres e nenhuma secção "## … (S<n>, <data>)" reconhecida: nada foi movido — se este ficheiro ainda não está paginado, os cabeçalhos não estão no formato esperado`
      : undefined;
    return { path, outDir, sections: [], changed: false, reason, suspect, warning, sizeBefore: before.length, sizeAfter: before.length };
  }
  const ids = sections.map(s => s.id);
  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (repeated.length) throw new Error(`${path} tem mais do que uma secção com o mesmo id (${repeated.join(', ')}) — dá um id novo a cada decisão antes de paginar, senão uma secção escrevia por cima da outra e o texto da primeira desaparecia`);
  for (const s of sections) writeFileAtomic(join(outDir, `${s.id}.md`), s.body);
  const after = pointerizeTechnologyTable(header);
  const changed = after !== before;
  if (changed) writeFileAtomic(path, after);
  return { path, outDir, sections: ids, changed, reason: 'seccoes-movidas', suspect: false, warning: undefined, sizeBefore: before.length, sizeAfter: after.length };
}

export const DECISIONS_HEADER = `# Decisões — registo append-only\n\nUma linha por decisão tomada dentro de um run do Forja (quem, quando, o quê, porquê, reversível?). Nunca se apaga; uma decisão revertida ganha uma linha nova "substituída por".\n\n`;
export const QUEUE_HEADER = `# Fila para o Sponsor\n\nPerguntas que só o Sponsor pode responder. Cada uma tem o default que o Forja aplicou para não parar. Para responder: pelo viewer (telemóvel ou desktop), ou escreve a resposta na secção da pergunta abaixo (linha "Resposta:") e o Lead recolhe-a com \`forja answers\`.\n\n`;

// Parse SPONSOR-QUEUE.md into entries: [{ id, question, default, why, status, answer, ts }]
export function readQueue() {
  if (!existsSync(queuePath())) return [];
  const text = readFileSync(queuePath(), 'utf8');
  const out = [];
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const [head, ...rest] = part.split('\n');
    const m = head.match(/^(Q\d+)\s*[—-]\s*(.*)$/);
    if (!m) continue;
    const body = rest.join('\n');
    const get = k => (body.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1]?.trim() ?? null;
    out.push({ id: m[1], question: m[2].trim(), status: (get('Estado') || 'aberta').toLowerCase(), default: get('Default aplicado'), why: get('Porquê só o Sponsor'), answer: get('Resposta') || null, ts: get('Aberta em') });
  }
  return out;
}

export function markAnswered(id, answer, when = nowIso()) {
  if (!existsSync(queuePath())) return false;
  let text = readFileSync(queuePath(), 'utf8');
  const re = new RegExp(`(^## ${id}\\s*[—-][^\\n]*\\n)([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  if (!m) return false;
  let body = m[2];
  body = body.replace(/^Estado:.*$/m, `Estado: respondida (${fmtLocal(when)})`);
  if (/^Resposta:/m.test(body)) body = body.replace(/^Resposta:.*$/m, `Resposta: ${answer}`); else body += `Resposta: ${answer}\n`;
  text = text.replace(re, m[1] + body);
  writeFileSync(queuePath(), text);
  return true;
}

// ---------- events into the global stream ----------
export function emit(kind, fields, { run, session } = {}) {
  const cwd = projectRoot();
  const rec = {
    ts: nowIso(),
    project: basename(cwd),
    session_id: session || currentSessionId(),
    cwd,
    hook_event_name: 'Forja',
    forja: { kind, run_id: run ? run.run_id : (readRun() || {}).run_id || null, ...fields },
  };
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(eventsPath(), JSON.stringify(rec) + '\n');
  } catch (err) {
    try { appendFileSync(join(dataDir(), 'hook-errors.log'), `${nowIso()} cli-emit: ${err && err.message}\n`); } catch {}
  }
  return rec;
}

// ---------- handover ----------
// How many of the most recent decisions the handover quotes in full (T3,
// docs/forja/TECHNOLOGY.md S3): the rest stay only in DECISIONS.md, reachable
// by the count-and-path line below (D9 — nothing that leaves a summary becomes
// unreachable). Extracts corpo lines only ("- **D<n>** …"): the index block's
// table rows start with "|" and its markers with "<", so a plain "- " prefix
// filter already skips both without knowing anything about the block's shape.
const HANDOVER_DECISIONS = 5;
export function recentDecisionLines(text) {
  return String(text || '').split('\n').filter(l => l.startsWith('- '));
}

export function writeHandover(note = null) {
  const run = readRun();
  const tasks = readTasks();
  const queue = readQueue();
  const open = queue.filter(q => q.status.startsWith('aberta'));
  const allDecisionLines = existsSync(decisionsPath()) ? recentDecisionLines(readFileSync(decisionsPath(), 'utf8')) : [];
  const decisions = allDecisionLines.slice(-HANDOVER_DECISIONS);
  const omitted = allDecisionLines.length - decisions.length;
  const doing = tasks.find(t => t.status === 'doing') || tasks.find(t => t.status === 'review');
  const next = tasks.find(t => t.status === 'todo' && (!t.after || tasks.find(x => x.id === t.after)?.status === 'done'));
  const lines = [];
  lines.push(`# Handover — ${run ? run.project : basename(projectRoot())}`);
  lines.push('');
  lines.push(`Gerado automaticamente em ${fmtLocal()} por \`forja\`. Uma sessão nova lê isto e continua de onde a anterior ficou. Não editar à mão: é regenerado por cada comando \`forja run *\` / \`forja task *\`.`);
  lines.push('');
  if (!run) { lines.push('Sem run ativo neste projeto. Arrancar com `forja run start --goal "…"`.'); writeFileSync(handoverPath(), lines.join('\n') + '\n'); return; }
  lines.push(`## Run ${run.run_id} — ${run.status}`);
  lines.push(`- Objetivo: ${run.goal}`);
  lines.push(`- Começou: ${fmtLocal(run.started_at)} · checkpoints: ${(run.checkpoints || []).length} · piso de modelo: **${run.model_floor}**${run.fallbacks && run.fallbacks.length ? ` (fallbacks: ${run.fallbacks.map(f => f.id).join(', ')})` : ''}`);
  lines.push(`- forjalvl (nível de modelos): **${labelOf(readForjalvl(run))}** (\`${levelOf(readForjalvl(run))}\`) — ${detailOf(readForjalvl(run))}`);
  lines.push(`- Autonomia: **${autonomyLabelOf(readAutonomy(run))}** — ${autonomyRule(readAutonomy(run))}`);
  // Who drives the run (docs/ARCHITECTURE.md §3c). Written raw here: the
  // resolution with runner evidence lives in lib/driver.mjs, and `forja run
  // driver show` prints it.
  lines.push(`- Responsável: **${run.driver === 'interactive' ? 'conversa interativa' : run.driver === 'runner' ? 'runner autónomo' : 'não registado (run anterior ao campo — `forja run driver show`)'}**${run.driver_request && run.driver_request.to ? ` · transferência pedida para ${run.driver_request.to === 'interactive' ? 'uma conversa interativa' : 'o runner'}` : ''}`);
  lines.push(`- Sessões: ${(run.sessions || []).join(', ')}`);
  if (note) lines.push(`- Nota do último checkpoint: ${note}`);
  lines.push('');
  lines.push('## Tasks');
  if (!tasks.length) lines.push('(nenhuma — o Architect ainda não planeou)');
  for (const t of tasks) lines.push(`- ${t.id} [${t.status}] ${t.title} — dono: ${t.owner || '?'}, tentativas: ${t.attempts || 0}${t.why ? `, último motivo: ${t.why}` : ''}${t.after ? `, depende de ${t.after}` : ''}`);
  lines.push('');
  lines.push('## Próxima ação exata');
  if (run.status === 'finished') lines.push('Run terminado. Nada a fazer; ler `REPORT-*.md`.');
  else if (run.status === 'failed') lines.push(`Run falhou: ${run.why || '?'}. Decidir com o Sponsor se se reabre.`);
  else if (run.status === 'blocked') lines.push(`Run bloqueado: ${run.why || '?'}. Só o Sponsor desbloqueia; depois \`forja run resume\`.`);
  else if (doing) lines.push(`Continuar ${doing.id} (${doing.status === 'review' ? 'à espera do veredicto do Reviewer' : `em curso, tentativa ${doing.attempts}`}): ${doing.title}. Se a sessão anterior morreu a meio, verificar \`git status\` e repetir \`forja task start ${doing.id}\` com o mesmo especialista.`);
  else if (next) lines.push(`Arrancar ${next.id}: \`forja task start ${next.id}\` e delegar a ${next.owner || 'um especialista'}.`);
  else if (tasks.length && tasks.every(t => ['done', 'failed', 'blocked'].includes(t.status))) lines.push('Todas as tasks fechadas: pedir o relatório ao Product Manager (`R · Product Manager: relatório do run`) e correr `forja run finish`.');
  else lines.push('Sem tasks por fazer: pedir plano ao Architect (`P · Architect: plano do run`).');
  lines.push('');
  lines.push(`## Fila do Sponsor (${open.length} aberta${open.length === 1 ? '' : 's'})`);
  for (const q of open) lines.push(`- ${q.id}: ${q.question} — default aplicado: ${q.default || '?'}`);
  if (!open.length) lines.push('(nenhuma pergunta aberta)');
  lines.push('');
  lines.push('## Últimas decisões');
  lines.push(...(decisions.length ? decisions : ['(nenhuma)']));
  if (omitted > 0) lines.push(`_(mais ${omitted} decisões em docs/forja/DECISIONS.md)_`);
  lines.push('');
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(handoverPath(), lines.join('\n') + '\n');
}

export function listAnswerFiles() {
  const dir = join(dataDir(), 'answers');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f));
}
