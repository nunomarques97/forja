// TECHNOLOGY.md pagination (docs/forja/TECHNOLOGY.md S7, D9/D30, run
// R-20260920-5ff3, task T7): the two pure functions in lib/state-files.mjs
// (splitTechnologySections, pointerizeTechnologyTable), the atomic file writer
// (splitTechnologyFile) and the `forja technology split` CLI command.
// Everything here runs on synthetic fixtures and temporary copies.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  splitTechnologySections, pointerizeTechnologyTable, splitTechnologyFile,
} from '../lib/state-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'forja.mjs');
const fixture = join(here, 'fixtures', 'technology-3-sections.md');

const root = mkdtempSync(join(tmpdir(), 'forja-technology-split-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('splitTechnologySections — pure, text in, header+sections out', () => {
  const text = readFileSync(fixture, 'utf8');

  test('the fixture really has the three sections the test expects', () => {
    const { sections } = splitTechnologySections(text);
    assert.deepEqual(sections.map(s => s.id), ['S1', 'S2', 'S3']);
  });

  test('header + every section body, concatenated in order, is byte-for-byte the original text', () => {
    const { header, sections } = splitTechnologySections(text);
    assert.equal(header + sections.map(s => s.body).join(''), text);
  });

  test('the header holds the title paragraph and the table, never a section body', () => {
    const { header } = splitTechnologySections(text);
    assert.match(header, /## Decisões em vigor/);
    assert.match(header, /\| Primeira capacidade \| escolha A \| S1 \|/);
    assert.equal(header.includes('Contexto: texto da primeira secção'), false, 'section text is not in the header');
    assert.equal(header.includes('## Primeira capacidade'), false, 'no section heading leaks into the header');
  });

  test('a line that mentions "(S9, ...)" mid-sentence is not mistaken for a heading', () => {
    const { header } = splitTechnologySections(text);
    assert.match(header, /\(S9, nunca\)/, 'the sentence survives, in the header, untouched');
  });

  test('a level-3 sub-heading inside a section does not cut it in two', () => {
    const { sections } = splitTechnologySections(text);
    const s1 = sections.find(s => s.id === 'S1');
    assert.match(s1.body, /### Sub-cabeçalho dentro da secção/);
    assert.match(s1.body, /Limites: revisitar se o contexto mudar\./, 'text after the sub-heading is still part of S1');
  });

  // What actually saves this line is the missing `(S<n>, <date>)` tag, NOT the
  // code fence around it: the cut is line-based and knows nothing about ```
  // fences. A fully tagged heading inside a code block would be cut on — the
  // case below says so out loud rather than pretending otherwise.
  test('a "## " line without the (S<n>, <date>) tag is not mistaken for the next section, code block or not', () => {
    const { sections } = splitTechnologySections(text);
    const s2 = sections.find(s => s.id === 'S2');
    assert.match(s2.body, /## Não é um cabeçalho real, é texto dentro de um bloco de código/);
    assert.match(s2.body, /Dependência nova: não\./, 'the rest of S2 stays with it');
  });

  test('a fully tagged heading inside a code fence IS cut on — the known limit, pinned so nobody assumes otherwise', () => {
    const fenced = '# T\n\nintro\n\n## Uma — a (S1, 2026-01-01)\n\n```\n## Exemplo colado — b (S2, 2026-02-02)\n```\n\nfim de S1.\n';
    const { sections } = splitTechnologySections(fenced);
    assert.deepEqual(sections.map(s => s.id), ['S1', 'S2'], 'the fenced heading starts a section: the tag is the only guard there is');
    // Even at the limit, nothing is lost: the invariant still holds.
    const { header } = splitTechnologySections(fenced);
    assert.equal(header + sections.map(s => s.body).join(''), fenced);
  });

  test('the last section runs to the end of the file, whatever is there', () => {
    const { sections } = splitTechnologySections(text);
    const s3 = sections.find(s => s.id === 'S3');
    assert.ok(s3.body.endsWith('Decisão: **escolha C**.\n'));
  });

  test('a text with no tagged heading at all comes back as pure header, zero sections', () => {
    const headerOnly = '# TECHNOLOGY — vazio\n\nSó texto, sem nenhuma secção S<n> ainda.\n';
    const { header, sections } = splitTechnologySections(headerOnly);
    assert.equal(header, headerOnly);
    assert.deepEqual(sections, []);
  });

  test('an already pointerized document preserves its remaining section bodies', () => {
    const original = splitTechnologySections(text);
    const live = pointerizeTechnologyTable(original.header) + original.sections.map(s => s.body).join('');
    const { header, sections } = splitTechnologySections(live);
    assert.equal(header + sections.map(s => s.body).join(''), live, 'not one character lost or moved');
    for (const s of sections) assert.match(s.id, /^S\d+$/);
  });

  test('two sections sharing one S<n> are both returned here, in order — the pure function never drops one', () => {
    const twice = '# T\n\n## Uma — a (S1, 2026-01-01)\n\ncorpo um\n\n## Outra — b (S1, 2026-02-02)\n\ncorpo dois\n';
    const { header, sections } = splitTechnologySections(twice);
    assert.deepEqual(sections.map(s => s.id), ['S1', 'S1']);
    assert.equal(header + sections.map(s => s.body).join(''), twice);
  });
});

// The failure this block exists for: `split('\n')` leaves the `\r` of a CRLF
// file at the end of every line, so a `$`-anchored regex without `\r?` matches
// nothing at all — and "nothing matched" is indistinguishable, on disk, from
// "nothing left to move". This repo runs with core.autocrlf on and has no
// .gitattributes, so a fresh clone really does have docs/forja/TECHNOLOGY.md
// in CRLF: without these tests the pagination was one clone away from being a
// silent no-op for good. The CRLF text is derived here from the LF fixture
// rather than committed as a second fixture, because a committed CRLF file is
// exactly what autocrlf would normalise back to LF on the next checkout.
describe('CRLF — the very same document with Windows line endings', () => {
  const lf = readFileSync(fixture, 'utf8');
  const crlf = lf.replace(/\r?\n/g, '\r\n');
  const mixedFree = text => /(^|[^\r])\n/.test(text) === false;

  test('the CRLF text really is CRLF, and really is the same document', () => {
    assert.ok(crlf.includes('\r\n'));
    assert.notEqual(crlf, lf);
    assert.equal(crlf.replace(/\r\n/g, '\n'), lf);
  });

  test('every heading is still found: three sections, not zero', () => {
    const { sections } = splitTechnologySections(crlf);
    assert.deepEqual(sections.map(s => s.id), ['S1', 'S2', 'S3']);
  });

  test('the concatenation invariant holds byte for byte, every \\r included', () => {
    const { header, sections } = splitTechnologySections(crlf);
    assert.equal(header + sections.map(s => s.body).join(''), crlf);
    for (const s of sections) assert.ok(mixedFree(s.body), `${s.id} keeps CRLF on every line`);
  });

  test('a CRLF table row is pointerised without leaving the file half CRLF and half LF', () => {
    const { header } = splitTechnologySections(crlf);
    const out = pointerizeTechnologyTable(header);
    assert.match(out, /\| Primeira capacidade \| escolha A \| docs\/forja\/technology\/S1\.md \|\r\n/);
    assert.ok(mixedFree(out), 'not one line ending was rewritten');
    assert.equal((out.match(/\r\n/g) || []).length, (header.match(/\r\n/g) || []).length);
  });

  test('splitTechnologyFile on a CRLF file does the real work — sections out, top file shrunk', () => {
    const dir = join(root, 'crlf');
    const path = join(dir, 'TECHNOLOGY.md');
    const outDir = join(dir, 'technology');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, crlf);
    const { header } = splitTechnologySections(crlf);
    const result = splitTechnologyFile(path, outDir);
    assert.equal(result.changed, true, 'this is exactly the call that used to report changed:false and do nothing');
    assert.equal(result.reason, 'seccoes-movidas');
    assert.deepEqual(result.sections, ['S1', 'S2', 'S3']);
    const parts = ['S1', 'S2', 'S3'].map(id => readFileSync(join(outDir, `${id}.md`), 'utf8'));
    assert.equal(header + parts.join(''), crlf, 'header + generated files reconstruct the CRLF original exactly');
    const top = readFileSync(path, 'utf8');
    assert.ok(top.length < crlf.length);
    assert.match(top, /docs\/forja\/technology\/S1\.md/);
    assert.ok(mixedFree(top) && parts.every(mixedFree), 'nothing written came out with mixed line endings');
  });

  test('and running it again on the CRLF file is the honest no-op: already paginated', () => {
    const path = join(root, 'crlf', 'TECHNOLOGY.md');
    const outDir = join(root, 'crlf', 'technology');
    const before = readFileSync(path, 'utf8');
    const result = splitTechnologyFile(path, outDir);
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'ja-paginado');
    assert.equal(result.suspect, false);
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

describe('pointerizeTechnologyTable — pure', () => {
  const text = readFileSync(fixture, 'utf8');
  const { header } = splitTechnologySections(text);

  test('a bare "S<n>" table cell becomes the path of that section file', () => {
    const out = pointerizeTechnologyTable(header);
    assert.match(out, /\| Primeira capacidade \| escolha A \| docs\/forja\/technology\/S1\.md \|/);
    assert.match(out, /\| Segunda capacidade \| escolha B \| docs\/forja\/technology\/S2\.md \|/);
    assert.match(out, /\| Terceira capacidade \| escolha C \| docs\/forja\/technology\/S3\.md \|/);
  });

  test('everything else in the header is untouched, including the table separator row', () => {
    const out = pointerizeTechnologyTable(header);
    assert.match(out, /\|---\|---\|---\|/);
    assert.match(out, /\(S9, nunca\)/);
    assert.match(out, /## Decisões em vigor/);
    assert.equal(out.split('\n').length, header.split('\n').length, 'no line added or removed');
  });

  test('idempotent: a cell already holding a path never matches again', () => {
    const once = pointerizeTechnologyTable(header);
    const twice = pointerizeTechnologyTable(once);
    assert.equal(twice, once);
  });
});

describe('splitTechnologyFile — the one non-pure function, atomic write', () => {
  const dir = join(root, 'split-file');
  const path = join(dir, 'TECHNOLOGY.md');
  const outDir = join(dir, 'technology');

  test('writes every section to its own file, na íntegra, and leaves only the pointerised header behind', () => {
    mkdirSync(dir, { recursive: true });
    copyFileSync(fixture, path);
    const before = readFileSync(path, 'utf8');
    const { header, sections: expected } = splitTechnologySections(before);
    const result = splitTechnologyFile(path, outDir);
    assert.equal(result.changed, true);
    assert.deepEqual(result.sections, ['S1', 'S2', 'S3']);

    // Criterion 2: the concatenation of the generated files is byte-for-byte
    // the original corpo (here: header + every section, since the fixture's
    // corpo IS everything after the header).
    const concatenated = ['S1', 'S2', 'S3'].map(id => readFileSync(join(outDir, `${id}.md`), 'utf8')).join('');
    assert.equal(concatenated, expected.map(s => s.body).join(''));
    assert.equal(header + concatenated, before, 'header + generated files reconstruct the original file exactly');

    const after = readFileSync(path, 'utf8');
    assert.equal(after, pointerizeTechnologyTable(header));
    for (const id of ['S1', 'S2', 'S3']) assert.equal(after.includes(`## ${id === 'S1' ? 'Primeira' : id === 'S2' ? 'Segunda' : 'Terceira'} capacidade`), false, `${id}'s heading no longer lives in the top file`);
    assert.match(after, /docs\/forja\/technology\/S1\.md/);
  });

  test('a second call is a no-op: nothing left to move, nothing changes on disk', () => {
    const beforeTop = readFileSync(path, 'utf8');
    const beforeS1 = readFileSync(join(outDir, 'S1.md'), 'utf8');
    const result = splitTechnologyFile(path, outDir);
    assert.equal(result.changed, false);
    assert.deepEqual(result.sections, []);
    assert.equal(result.reason, 'ja-paginado', 'the header points at the section files: this no-op is the expected one');
    assert.equal(result.suspect, false);
    assert.equal(result.warning, undefined);
    assert.equal(readFileSync(path, 'utf8'), beforeTop);
    assert.equal(readFileSync(join(outDir, 'S1.md'), 'utf8'), beforeS1);
  });

  test('a file with no tagged section yet (a project the Scout never wrote to) writes nothing to outDir', () => {
    const dir2 = join(root, 'no-sections');
    const path2 = join(dir2, 'TECHNOLOGY.md');
    const outDir2 = join(dir2, 'technology');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(path2, '# TECHNOLOGY\n\nSó cabeçalho, nenhuma secção.\n');
    const result = splitTechnologyFile(path2, outDir2);
    assert.equal(result.changed, false);
    assert.deepEqual(result.sections, []);
    assert.equal(result.reason, 'sem-seccoes');
    assert.equal(result.suspect, false);
    assert.equal(existsSync(outDir2), false, 'nothing was written for a file with nothing to move');
  });

  // The three no-ops above and below look the same on disk (`changed: false`,
  // not a byte touched) and mean completely different things. This is the one
  // that means "look at me": a file far too big to be just a header, where not
  // one heading matched — the shape the CRLF bug had.
  test('a big file where not one heading matched is reported as suspect, with a sentence, not as a quiet no-op', () => {
    const dir3 = join(root, 'nothing-matched');
    const path3 = join(dir3, 'TECHNOLOGY.md');
    const outDir3 = join(dir3, 'technology');
    mkdirSync(dir3, { recursive: true });
    // A heading in a format this code does not know (no comma before the date)
    // plus enough text to be well past a header's size.
    const body = `# TECHNOLOGY\n\n## Capacidade — escolha (S1 2026-01-01)\n\n${'texto a sério, repetido para passar o orçamento de um cabeçalho. '.repeat(120)}\n`;
    assert.ok(body.length > 6000, 'the fixture for this case has to be past the budget');
    writeFileSync(path3, body);
    const result = splitTechnologyFile(path3, outDir3);
    assert.equal(result.changed, false);
    assert.deepEqual(result.sections, []);
    assert.equal(result.reason, 'nada-casou');
    assert.equal(result.suspect, true);
    assert.match(result.warning, /nenhuma secção .* reconhecida/);
    assert.match(result.warning, new RegExp(String(body.length)), 'the sentence says how big the file it refused to understand is');
    assert.equal(readFileSync(path3, 'utf8'), body, 'a file it did not understand is never rewritten');
    assert.equal(existsSync(outDir3), false);
  });

  test('refuses two sections sharing one S<n> instead of letting the second erase the first', () => {
    const dir4 = join(root, 'duplicate-id');
    const path4 = join(dir4, 'TECHNOLOGY.md');
    const outDir4 = join(dir4, 'technology');
    mkdirSync(dir4, { recursive: true });
    const body = '# T\n\n## Uma — a (S1, 2026-01-01)\n\ncorpo um\n\n## Outra — b (S1, 2026-02-02)\n\ncorpo dois\n';
    writeFileSync(path4, body);
    assert.throws(() => splitTechnologyFile(path4, outDir4), err => {
      assert.match(err.message, /mais do que uma secção com o mesmo id \(S1\)/);
      assert.ok(!err.message.includes('\n    at '), 'one sentence, no stack embedded');
      return true;
    });
    assert.equal(readFileSync(path4, 'utf8'), body, 'the file is left exactly as it was');
    assert.equal(existsSync(outDir4), false, 'not one section file was written before the refusal');
  });

  test('refuses a nonexistent file with a plain sentence, not a stack', () => {
    assert.throws(() => splitTechnologyFile(join(dir, 'nope', 'TECHNOLOGY.md'), outDir), err => {
      assert.match(err.message, /não existe/);
      assert.ok(!err.message.includes('\n    at '), 'message is one sentence, no stack embedded');
      return true;
    });
  });
});

describe('forja technology split — CLI command', () => {
  const proj = join(root, 'cli-proj');
  const dataDir = join(root, 'cli-data');
  mkdirSync(join(proj, 'docs', 'forja'), { recursive: true });
  copyFileSync(fixture, join(proj, 'docs', 'forja', 'TECHNOLOGY.md'));
  const env = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };

  test('splits the sections out and reports them', () => {
    const r = forja('technology', 'split');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.sections, ['S1', 'S2', 'S3']);
    assert.equal(r.json.changed, true);
    assert.ok(existsSync(join(proj, 'docs', 'forja', 'technology', 'S2.md')));
  });

  test('running it again does not touch the files a second time (idempotent) and says changed:false, ja-paginado', () => {
    const before = readFileSync(join(proj, 'docs', 'forja', 'TECHNOLOGY.md'), 'utf8');
    const r = forja('technology', 'split');
    assert.equal(r.code, 0);
    assert.equal(r.json.changed, false);
    assert.deepEqual(r.json.sections, []);
    assert.equal(r.json.reason, 'ja-paginado');
    assert.equal(r.json.warning, undefined, 'the expected no-op says nothing on stderr and carries no warning');
    assert.equal(r.err, '');
    assert.equal(readFileSync(join(proj, 'docs', 'forja', 'TECHNOLOGY.md'), 'utf8'), before);
  });

  // Same `changed: false` as the test above, opposite meaning: a person running
  // this by hand has to be able to tell them apart without reading the file.
  test('a big file where nothing matched is not silent: warning on stderr, reason in the JSON, file untouched', () => {
    const odd = join(root, 'cli-proj-odd');
    mkdirSync(join(odd, 'docs', 'forja'), { recursive: true });
    const body = `# TECHNOLOGY\n\n## Capacidade — escolha (S1 2026-01-01)\n\n${'texto a sério, repetido para passar o orçamento de um cabeçalho. '.repeat(120)}\n`;
    writeFileSync(join(odd, 'docs', 'forja', 'TECHNOLOGY.md'), body);
    const r = spawnSync(process.execPath, [cli, 'technology', 'split'], { cwd: odd, env: { ...env, FORJA_DATA_DIR: join(root, 'cli-data-odd') }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.changed, false);
    assert.equal(json.reason, 'nada-casou');
    assert.match(json.warning, /nenhuma secção .* reconhecida/);
    assert.match(r.stderr, /^forja: aviso — .*nenhuma secção/);
    assert.equal(readFileSync(join(odd, 'docs', 'forja', 'TECHNOLOGY.md'), 'utf8'), body);
    assert.equal(existsSync(join(odd, 'docs', 'forja', 'technology')), false);
  });

  test('a CRLF TECHNOLOGY.md is paginated by the command like any other (the clone-fresh case)', () => {
    const win = join(root, 'cli-proj-crlf');
    mkdirSync(join(win, 'docs', 'forja'), { recursive: true });
    const crlf = readFileSync(fixture, 'utf8').replace(/\r?\n/g, '\r\n');
    const target = join(win, 'docs', 'forja', 'TECHNOLOGY.md');
    writeFileSync(target, crlf);
    const r = spawnSync(process.execPath, [cli, 'technology', 'split'], { cwd: win, env: { ...env, FORJA_DATA_DIR: join(root, 'cli-data-crlf') }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.deepEqual(json.sections, ['S1', 'S2', 'S3']);
    assert.equal(json.changed, true);
    assert.equal(json.reason, 'seccoes-movidas');
    const parts = ['S1', 'S2', 'S3'].map(id => readFileSync(join(win, 'docs', 'forja', 'technology', `${id}.md`), 'utf8'));
    const { header } = splitTechnologySections(crlf);
    assert.equal(header + parts.join(''), crlf, 'nothing lost, nothing reflowed, \\r included');
    assert.ok(readFileSync(target, 'utf8').length < crlf.length);
  });

  test('appears in the usage text', () => {
    const r = spawnSync(process.execPath, [cli], { cwd: proj, env, encoding: 'utf8' });
    assert.match(r.stdout, /technology split/);
  });

  test('a project with no TECHNOLOGY.md yet refuses with one sentence, no stack, exit code 2', () => {
    const emptyProj = join(root, 'cli-proj-missing');
    mkdirSync(join(emptyProj, 'docs', 'forja'), { recursive: true });
    const r = spawnSync(process.execPath, [cli, 'technology', 'split'], { cwd: emptyProj, env: { ...env, FORJA_DATA_DIR: join(root, 'cli-data-missing') }, encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^forja: .*não existe/);
    assert.ok(!/\n\s+at /.test(r.stderr), 'no stack trace leaked to the Sponsor-facing stderr');
  });
});
