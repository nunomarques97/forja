// DECISIONS.md index generator (docs/forja/TECHNOLOGY.md S3, D9/D10, run
// R-20260920-c2b7, task T1): the two pure functions in lib/state-files.mjs
// (buildDecisionsIndex, withDecisionsIndex), the atomic file writer
// (reindexDecisionsFile) and the `forja decisions reindex` CLI command.
// Everything here runs on fixtures and temp copies — never on the live
// docs/forja/DECISIONS.md of this repo (D16 condition B).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDecisionsIndex, withDecisionsIndex, reindexDecisionsFile,
  DECISIONS_INDEX_START, DECISIONS_INDEX_END, DECISIONS_INDEX_BUDGET, DECISIONS_HEADER,
} from '../lib/state-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'forja.mjs');
const fixture22 = join(here, 'fixtures', 'decisions-index-22.md');
const fixtureEmpty = join(here, 'fixtures', 'decisions-index-empty.md');
const fixtureMarkers = join(here, 'fixtures', 'decisions-index-markers.md');

const root = mkdtempSync(join(tmpdir(), 'forja-decisions-index-'));
after(() => rmSync(root, { recursive: true, force: true }));

// The corpo is everything from the first decision line on, whatever its id.
const bodyOf = text => text.slice(text.search(/^- \*\*D\d+\*\*/m));
const rowLines = block => block.split(/\r?\n/).filter(l => /^\| D\d+ \|/.test(l));
const decisionLines = text => text.split(/\r?\n/).filter(l => /^- \*\*D\d+\*\*/.test(l));
const markerCount = text => (text.match(new RegExp(DECISIONS_INDEX_START, 'g')) || []).length;
// How many REAL blocks there are: a marker alone on its line, not quoted inside
// a sentence or a decision.
const blockCount = text => text.split(/\r?\n/).filter(l => l === DECISIONS_INDEX_START).length;

describe('buildDecisionsIndex — pure, text in, block out', () => {
  const fixtureText = readFileSync(fixture22, 'utf8');
  const bodyDecisionLines = fixtureText.split('\n').filter(l => /^- \*\*D\d+\*\*/.test(l));

  test('the fixture really has the 22 decisions the test expects', () => {
    assert.equal(bodyDecisionLines.length, 22);
  });

  test('covers every decision, including the superseded one (D3, substituted by D9)', () => {
    const block = buildDecisionsIndex(fixtureText);
    assert.equal(rowLines(block).length, bodyDecisionLines.length, 'one index row per decision line');
    const d3 = rowLines(block).find(l => l.startsWith('| D3 |'));
    assert.ok(d3, 'D3 has a row');
    assert.match(d3, /\|\s*D9\s*\|$/, 'D3 row is marked as substituted by D9');
    const d9 = rowLines(block).find(l => l.startsWith('| D9 |'));
    assert.match(d9, /\|\s*\|$/, 'D9 itself was not substituted by anything');
  });

  test('the instruction line above the table matches the TECHNOLOGY.md wording', () => {
    const block = buildDecisionsIndex(fixtureText);
    assert.match(block, /Lê esta tabela primeiro; abre a decisão completa só quando este trabalho depender dela\./);
  });

  test('titles are cut to ~70 characters at a word boundary', () => {
    const block = buildDecisionsIndex(fixtureText);
    for (const row of rowLines(block)) {
      const title = row.split('|')[4].trim();
      assert.ok(title.length <= 70, `title too long: "${title}" (${title.length})`); // the ellipsis counts
      if (title.endsWith('…')) assert.ok(!title.includes('  '), 'no double space left by the cut');
    }
  });

  test('an empty corpo (header-only file) produces no block at all', () => {
    const emptyText = readFileSync(fixtureEmpty, 'utf8');
    // Normalised: this repo has core.autocrlf=true and no .gitattributes, so a
    // fresh clone checks the fixture out with CRLF. The header CONTENT is what
    // must match `appendMd`'s; byte-for-byte equality is asserted below on what
    // the generator returns, which is the part that matters.
    assert.equal(emptyText.replace(/\r\n/g, '\n'), DECISIONS_HEADER, 'fixture matches the real header exactly');
    assert.equal(buildDecisionsIndex(emptyText), '');
  });
});

describe('degradação suave — malformed decision lines never throw', () => {
  const malformed = [
    '- **D101** · 2026-01-01 08:00 · Backend Dev · run R-x — Uma decisão sem a palavra reversibilidade no fim.',
    '- **D102** isto não tem os separadores do meio nem travessão nenhum, só texto corrido a seguir ao id.',
    '- **D9**',
  ];
  const text = DECISIONS_HEADER + malformed.join('\n') + '\n';

  test('buildDecisionsIndex never throws and still produces one row per line', () => {
    let block;
    assert.doesNotThrow(() => { block = buildDecisionsIndex(text); });
    assert.equal(rowLines(block).length, 3);
  });

  test('each malformed row still has some title text and a dash where reversível/substituída are unknown', () => {
    const block = buildDecisionsIndex(text);
    const rows = rowLines(block);
    for (const row of rows) {
      const cells = row.split('|').map(c => c.trim());
      // cells: ['', 'D<n>', date, role, title, reversível, substituída, '']
      assert.ok(cells[4].length > 0, 'title cell is never empty');
      assert.equal(cells[5], '-', 'no Reversível: sim/não found, so the column is a dash');
    }
    const bare = rows.find(r => r.startsWith('| D9 |'));
    assert.match(bare, /\(sem texto\)/, 'a line with only the id marker falls back to a placeholder title');
  });

  test('withDecisionsIndex on the same malformed text is idempotent too', () => {
    const once = withDecisionsIndex(text);
    const twice = withDecisionsIndex(once);
    assert.equal(twice, once);
  });
});

describe('withDecisionsIndex — pure, whole file in, whole file out', () => {
  const fixtureText = readFileSync(fixture22, 'utf8');

  test('inserts the block between header and corpo; the corpo is byte-identical', () => {
    const out = withDecisionsIndex(fixtureText);
    assert.equal(markerCount(out), 1);
    assert.ok(out.indexOf(DECISIONS_INDEX_START) < out.indexOf('- **D1**'), 'block sits before the first decision line');
    assert.equal(bodyOf(out), bodyOf(fixtureText), 'corpo untouched, byte for byte');
  });

  test('idempotent: applying it twice gives the same bytes both times', () => {
    const once = withDecisionsIndex(fixtureText);
    const twice = withDecisionsIndex(once);
    assert.equal(twice, once);
    assert.equal(markerCount(twice), 1, 'never a second block');
  });

  test('a header-only file (0 decisions) comes back byte-identical — no block is ever added', () => {
    const emptyText = readFileSync(fixtureEmpty, 'utf8');
    const out = withDecisionsIndex(emptyText);
    assert.equal(out, emptyText);
    const twice = withDecisionsIndex(out);
    assert.equal(twice, emptyText);
  });

  test('a stale block in a file whose decisions are all gone is removed, not kept as a lie', () => {
    const emptyText = readFileSync(fixtureEmpty, 'utf8');
    const stale = `${emptyText}${DECISIONS_INDEX_START}\nLinha velha\n${DECISIONS_INDEX_END}\n\n`;
    assert.equal(withDecisionsIndex(stale), emptyText);
  });

  test('re-running on a file that already has a (hand-edited) stale block replaces it whole, never appends a second', () => {
    const stale = withDecisionsIndex(fixtureText).replace('| D1 |', '| D1 | STALE COPY THAT SHOULD DISAPPEAR |');
    const fixed = withDecisionsIndex(stale);
    assert.equal(markerCount(fixed), 1);
    assert.ok(!fixed.includes('STALE COPY'), 'the whole old block was thrown away, not patched');
    assert.equal(fixed, withDecisionsIndex(fixtureText), 'converges back to the canonical block');
  });
});

// Regression for the REJECT of attempt 1: a decision line that QUOTES both
// markers (this repo's own D10 does) used to be matched by the whole-file strip
// and lost 44 characters out of the middle of an append-only line.
describe('marcas citadas no corpo — o corpo continua byte a byte igual (critério 4, D9)', () => {
  const text = readFileSync(fixtureMarkers, 'utf8');
  const d10 = text.split('\n').find(l => l.startsWith('- **D10**'));
  const headerNote = text.split('\n').find(l => l.startsWith('Nota de cabeçalho'));

  test('the fixture really is the trap: a decision line quoting both markers inline', () => {
    assert.ok(d10.includes(DECISIONS_INDEX_START), 'D10 quotes the start marker');
    assert.ok(d10.includes(DECISIONS_INDEX_END), 'D10 quotes the end marker');
    assert.ok(!d10.startsWith(DECISIONS_INDEX_START), 'quoted mid-line, never alone on its line');
    assert.equal(blockCount(text), 0, 'and there is no real block in the fixture yet');
  });

  test('the rejected algorithm (unanchored whole-file strip) really did eat the corpo here', () => {
    // Kept as the shape of the bug, so a future "simplification" back to an
    // unanchored strip fails this file instead of a real DECISIONS.md.
    const rejected = text.replace(new RegExp(`${DECISIONS_INDEX_START}[\\s\\S]*?${DECISIONS_INDEX_END}\\n*`), '');
    assert.notEqual(bodyOf(rejected), bodyOf(text), 'the fixture is a genuine trap, not a decoration');
    assert.ok(bodyOf(rejected).length < bodyOf(text).length, 'it removed append-only text');
  });

  test('withDecisionsIndex keeps the corpo byte for byte, quoted markers included', () => {
    const out = withDecisionsIndex(text);
    assert.equal(bodyOf(out), bodyOf(text), 'corpo untouched, byte for byte');
    assert.ok(out.includes(d10), 'the D10 line survives verbatim, all of it');
    assert.equal(blockCount(out), 1, 'exactly one real block was added');
    assert.equal(rowLines(buildDecisionsIndex(text)).length, decisionLines(text).length);
  });

  test('a header sentence quoting the markers mid-line is not mistaken for a block either', () => {
    const out = withDecisionsIndex(text);
    assert.ok(out.includes(headerNote), 'the header note survives verbatim');
    assert.equal(withDecisionsIndex(out), out, 'and it stays idempotent');
  });

  test('reindexDecisionsFile on a copy: the file on disk keeps the quoted line whole', () => {
    const dir = join(root, 'markers-file');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'DECISIONS.md');
    copyFileSync(fixtureMarkers, path);
    const before = readFileSync(path, 'utf8');
    reindexDecisionsFile(path);
    const after = readFileSync(path, 'utf8');
    assert.equal(bodyOf(after), bodyOf(before));
    assert.ok(after.includes(d10));
    const eol = before.includes('\r\n') ? '\r\n' : '\n';
    assert.equal(after.length - before.length, buildDecisionsIndex(before).length + 2 * eol.length, 'only the block (+ blank line) was added');
    reindexDecisionsFile(path);
    assert.equal(readFileSync(path, 'utf8'), after, 'second run changes nothing on disk');
  });

  test('an indexed synthetic document with quoted markers preserves its body on reindex', () => {
    const live = withDecisionsIndex(readFileSync(fixtureMarkers, 'utf8'));
    assert.ok(live.includes(DECISIONS_INDEX_START), 'sanity: D10 in this repo quotes the marker');
    const out = withDecisionsIndex(live);
    assert.equal(bodyOf(out), bodyOf(live), 'not one character removed from the append-only corpo');
    assert.equal(rowLines(buildDecisionsIndex(live)).length, decisionLines(live).length);
    assert.equal(withDecisionsIndex(out), out);
  });

  test('a stray, unterminated marker left by hand never swallows the real block', () => {
    const stray = `${DECISIONS_INDEX_START}\n${text}`;
    const once = withDecisionsIndex(stray);
    assert.equal(withDecisionsIndex(once), once, 'still idempotent');
    assert.equal(bodyOf(once), bodyOf(text), 'corpo still untouched');
    assert.equal(blockCount(once), 2, 'the stray line stays where the person left it; one real block is generated');
  });
});

describe('ficheiro com fins de linha CRLF', () => {
  const crlfText = readFileSync(fixture22, 'utf8').replace(/\r?\n/g, '\r\n');

  test('the block is written with the file line ending, no mixed endings', () => {
    const out = withDecisionsIndex(crlfText);
    assert.equal(bodyOf(out), bodyOf(crlfText), 'corpo byte for byte');
    assert.equal((out.match(/(?<!\r)\n/g) || []).length, 0, 'no lone LF introduced by the generator');
    assert.equal(rowLines(buildDecisionsIndex(crlfText)).length, 22);
  });

  test('idempotent on CRLF too', () => {
    const once = withDecisionsIndex(crlfText);
    assert.equal(withDecisionsIndex(once), once);
    assert.equal(blockCount(once), 1);
  });
});

describe('budget (D10): warns past ~10 000 characters, never paginates', () => {
  // Long, realistic-shaped decision lines so the index block itself — not the
  // corpo — crosses the 10 000-character mark well before 63 decisions (the
  // crypto-radar number D10 cites for ~6 070 characters at normal length).
  const longText = 'x'.repeat(90);
  const lines = [];
  for (let i = 1; i <= 140; i++) {
    lines.push(`- **D${i}** · 2026-01-01 08:00 · Product Manager · run R-budget — Decisão longa número ${i} sobre ${longText} Porquê: encher o índice para o teste de orçamento. Reversível: sim.`);
  }
  const bigText = DECISIONS_HEADER + lines.join('\n') + '\n';

  test('the block exceeds the budget and still contains every decision, uncut', () => {
    const block = buildDecisionsIndex(bigText);
    assert.ok(block.length > DECISIONS_INDEX_BUDGET, `block is ${block.length} chars, expected > ${DECISIONS_INDEX_BUDGET}`);
    assert.equal(rowLines(block).length, 140, 'no pagination: all 140 rows are present');
  });
});

describe('reindexDecisionsFile — the one non-pure function, atomic write', () => {
  const dir = join(root, 'reindex-file');
  const path = join(dir, 'DECISIONS.md');

  test('creates the parent folder and writes the index atomically', () => {
    mkdirSync(dir, { recursive: true });
    copyFileSync(fixture22, path);
    const before = readFileSync(path, 'utf8');
    const result = reindexDecisionsFile(path);
    assert.equal(result.changed, true);
    assert.equal(result.count, 22);
    assert.equal(result.overBudget, false);
    const after = readFileSync(path, 'utf8');
    assert.notEqual(after, before);
    assert.equal(bodyOf(after), bodyOf(before), 'corpo on disk is untouched');
    assert.equal(markerCount(after), 1);
  });

  test('a second call is a no-op on disk (idempotent) and reports changed:false', () => {
    const before = readFileSync(path, 'utf8');
    const result = reindexDecisionsFile(path);
    assert.equal(result.changed, false);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  test('refuses a nonexistent file with a plain sentence, not a stack', () => {
    assert.throws(() => reindexDecisionsFile(join(dir, 'nope', 'DECISIONS.md')), err => {
      assert.match(err.message, /não existe/);
      assert.ok(!err.message.includes('\n    at '), 'message is one sentence, no stack embedded');
      return true;
    });
  });
});

describe('forja decisions reindex — CLI command', () => {
  const proj = join(root, 'cli-proj');
  const dataDir = join(root, 'cli-data');
  mkdirSync(join(proj, 'docs', 'forja'), { recursive: true });
  copyFileSync(fixture22, join(proj, 'docs', 'forja', 'DECISIONS.md'));
  const env = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
  const decisionsFile = () => readFileSync(join(proj, 'docs', 'forja', 'DECISIONS.md'), 'utf8');

  test('works with no run open, reports how many decisions and the block size', () => {
    const r = forja('decisions', 'reindex');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.decisions, 22);
    assert.ok(r.json.size > 0);
    assert.equal(r.json.changed, true);
    assert.equal(markerCount(decisionsFile()), 1);
  });

  test('running it again does not touch the file a second time (idempotent) and says changed:false', () => {
    const before = decisionsFile();
    const r = forja('decisions', 'reindex');
    assert.equal(r.code, 0);
    assert.equal(r.json.changed, false);
    assert.equal(decisionsFile(), before);
  });

  test('appears in the usage text', () => {
    const r = spawnSync(process.execPath, [cli], { cwd: proj, env, encoding: 'utf8' });
    assert.match(r.stdout, /decisions reindex/);
  });

  test('a project with no DECISIONS.md yet refuses with one sentence, no stack, exit code 2', () => {
    const emptyProj = join(root, 'cli-proj-missing');
    mkdirSync(join(emptyProj, 'docs', 'forja'), { recursive: true });
    const r = spawnSync(process.execPath, [cli, 'decisions', 'reindex'], { cwd: emptyProj, env: { ...env, FORJA_DATA_DIR: join(root, 'cli-data-missing') }, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^forja: .*não existe/);
    assert.ok(!/\n\s+at /.test(r.stderr), 'no stack trace leaked to the Sponsor-facing stderr');
  });

  test('warns on stderr and reports overBudget when the block passes ~10 000 characters, without dropping rows', () => {
    const bigProj = join(root, 'cli-proj-big');
    mkdirSync(join(bigProj, 'docs', 'forja'), { recursive: true });
    const longText = 'y'.repeat(90);
    const lines = [];
    for (let i = 1; i <= 140; i++) lines.push(`- **D${i}** · 2026-01-01 08:00 · Product Manager · run R-budget — Decisão longa número ${i} sobre ${longText} Porquê: encher o índice. Reversível: sim.`);
    writeFileSync(join(bigProj, 'docs', 'forja', 'DECISIONS.md'), DECISIONS_HEADER + lines.join('\n') + '\n');
    const r = spawnSync(process.execPath, [cli, 'decisions', 'reindex'], { cwd: bigProj, env: { ...env, FORJA_DATA_DIR: join(root, 'cli-data-big') }, encoding: 'utf8' });
    assert.equal(r.status, 0);
    const json = JSON.parse(r.stdout);
    assert.equal(json.decisions, 140);
    assert.equal(json.overBudget, true);
    assert.match(r.stderr, /orçamento/);
  });
});

// T2 of the same run (D15/D16 condition C): from here on `forja decide` is the
// command that puts the index in the file a session actually reads. T1's gate
// (decide writes no block) was the temporary state between the two commits and
// is deliberately inverted here — what stays fixed is the corpo: the decision
// line is appended exactly as before, byte for byte.
describe('forja decide — appends the decision and regenerates the index (T2, D15)', () => {
  const proj = join(root, 'decide-index-proj');
  const dataDir = join(root, 'decide-index-data');
  const env = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
  const decisionsFile = () => readFileSync(join(proj, 'docs', 'forja', 'DECISIONS.md'), 'utf8');

  test('the corpo is still the append-only header + one line per decision, unchanged word for word', () => {
    mkdirSync(proj, { recursive: true });
    assert.equal(forja('run', 'start', '--goal', 'Testar o índice em uso real').code, 0);
    const first = forja('decide', 'Primeira decisão de teste', '--why', 'testar', '--reversible', 'yes');
    assert.equal(first.code, 0, first.err);
    assert.equal(first.json.id, 'D1');
    assert.equal(first.json.index, 1, 'the command reports how many rows the index now has');
    assert.equal(forja('decide', 'Segunda decisão de teste', '--why', 'testar mais', '--reversible', 'no').code, 0);
    const text = decisionsFile();
    // Same two lines, same order, same wording as before T2 — only the block
    // above them is new.
    assert.match(bodyOf(text),/^- \*\*D1\*\* .* Primeira decisão de teste Porquê: testar Reversível: sim\.\n- \*\*D2\*\* .* Segunda decisão de teste Porquê: testar mais Reversível: não\.\n$/);
    assert.equal(decisionLines(text).length, 2);
  });

  test('the index block is there, above the corpo, with one row per decision', () => {
    const text = decisionsFile();
    assert.equal(blockCount(text), 1, 'exactly one real index block');
    assert.ok(text.indexOf(DECISIONS_INDEX_END) < text.indexOf('- **D1**'), 'the block sits between the header and the corpo');
    assert.equal(rowLines(text).length, 2);
    assert.match(text, /\| D1 \|.*Primeira decisão de teste.*\| sim \|/);
    assert.match(text, /\| D2 \|.*Segunda decisão de teste.*\| não \|/);
    assert.ok(text.includes('Lê esta tabela primeiro; abre a decisão completa só quando este trabalho depender dela.'));
  });

  test('a third decision regenerates the block whole: still one block, three rows, corpo intact', () => {
    const corpoBefore = bodyOf(decisionsFile());
    const r = forja('decide', 'Terceira decisão, substitui a primeira', '--why', 'mudou o contexto', '--reversible', 'yes', '--supersedes', 'D1');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.index, 3);
    const text = decisionsFile();
    assert.equal(blockCount(text), 1);
    assert.equal(rowLines(text).length, 3);
    assert.ok(bodyOf(text).startsWith(corpoBefore), 'the corpo only grew at the end — nothing rewritten');
    assert.match(rowLines(text).find(l => l.startsWith('| D1 |')), /\|\s*D3\s*\|$/, 'D1 is marked as substituted by D3');
    // D9: every decision is in both places. Nothing vanishes.
    assert.equal(rowLines(text).length, decisionLines(text).length);
  });

  test('`forja decisions reindex` right after has nothing left to do (same bytes)', () => {
    const before = decisionsFile();
    const r = forja('decisions', 'reindex');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.changed, false, 'decide already left the index up to date');
    assert.equal(decisionsFile(), before);
  });

  // Criterion 8: HANDOVER.md quotes decisions by taking the lines that start
  // with "- ". The index rows start with "|" and the markers with "<", so the
  // extractor can only ever pick corpo lines — asserted here against a file
  // that really has the block.
  test('the HANDOVER decision extractor takes corpo lines only, never index rows', () => {
    assert.equal(forja('run', 'checkpoint', '--note', 'com índice no ficheiro').code, 0);
    const handover = readFileSync(join(proj, 'docs', 'forja', 'HANDOVER.md'), 'utf8');
    const section = handover.slice(handover.indexOf('## Últimas decisões'));
    assert.match(section, /- \*\*D1\*\* .* Primeira decisão de teste/);
    assert.match(section, /- \*\*D3\*\* .* Terceira decisão, substitui a primeira/);
    assert.equal(/^\| D\d+ \|/m.test(section), false, 'no index row leaked into the handover');
    assert.equal(section.includes(DECISIONS_INDEX_START) || section.includes(DECISIONS_INDEX_END), false, 'no marker leaked either');
    assert.equal(section.includes('Lê esta tabela primeiro'), false, 'the instruction line is not a decision');
    assert.equal(section.split('\n').filter(l => l.startsWith('- **D')).length, 3, 'the three decisions, whole');
  });

  test('`forja ask` (another appendMd caller) is unaffected: its file has no index concept at all', () => {
    assert.equal(forja('ask', 'Pergunta de teste?', '--default', 'sim', '--why', 'testar').code, 0);
    const text = readFileSync(join(proj, 'docs', 'forja', 'SPONSOR-QUEUE.md'), 'utf8');
    assert.match(text, /^# Fila para o Sponsor/);
    assert.ok(!text.includes('forja:index'));
  });
});
