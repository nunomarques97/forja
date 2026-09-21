// tools/check.mjs — the repo invariants `npm run check` enforces. The units are
// tested against fixtures in a temp dir (so the test never depends on the state
// of this working tree), plus one run of the real script on this repo to prove
// the invisible-character and model-policy checks are actually clean here.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findInvisible, sampleDivergences, policyMarkersIn, checkPolicySource, stripPolicySection, checkInvisible, checkAutonomyRule, AUTONOMY_FILES, findTasksJsonOpenCommands, checkNoTasksJsonRead, tasksJsonScanList, runChecks, TEXT_EXT, isTextFile, INVISIBLE_RANGES } from '../tools/check.mjs';
import { policyText, LEVELS } from '../lib/models.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const root = mkdtempSync(join(tmpdir(), 'forja-check-'));
after(() => rmSync(root, { recursive: true, force: true }));
const ch = code => String.fromCharCode(code);
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8'); };

describe('invisible characters', () => {
  test('every forbidden code point is found, with line and column and a name', () => {
    for (const [code, name] of [[0x0C, 'form feed (U+000C)'], [0x00AD, 'soft hyphen (U+00AD)'], [0xFEFF, 'BOM / zero-width no-break space (U+FEFF)'], [0x200B, 'U+200B'], [0x200F, 'U+200F'], [0x202E, 'U+202E'], [0x2060, 'U+2060'], [0x2069, 'U+2069']]) {
      const hits = findInvisible(`linha um\nab${ch(code)}cd`);
      assert.equal(hits.length, 1, `U+${code.toString(16)} detected`);
      assert.equal(hits[0].line, 2);
      assert.equal(hits[0].column, 3);
      assert.equal(hits[0].name, name);
    }
  });
  test('tab, CR, LF, accents and emoji are legitimate; the scan is not stateful between calls', () => {
    const clean = 'a\tb\r\nção — «citação» 🙂  fim';
    assert.deepEqual(findInvisible(clean), []);
    assert.deepEqual(findInvisible(clean), [], 'the global regex is reset every call');
    assert.equal(findInvisible(`x${ch(0x200B)}y${ch(0x200B)}z`).length, 2, 'every occurrence, not just the first');
  });
  test('text files are scanned (extensions, no extension at all, text dotfiles); binaries are not; at most `max` hits per file', () => {
    write(join(root, 'inv', 'a.md'), `${ch(0x200B)}${ch(0x200B)}${ch(0x200B)}`);
    write(join(root, 'inv', 'b.png'), `${ch(0x200B)}`);
    write(join(root, 'inv', '.gitignore'), `data${ch(0x00AD)}/`);
    write(join(root, 'inv', 'hooks', 'pre-commit'), `#!/bin/sh${ch(0x000C)}`);
    const lines = checkInvisible(join(root, 'inv'), ['a.md', 'b.png', '.gitignore', 'hooks/pre-commit', 'gone.md'], 2);
    assert.equal(lines.length, 4, 'two of the three hits in a.md, one in .gitignore, one in the extension-less hook; the .png is not text; a missing file is skipped');
    assert.equal(lines.filter(l => l.startsWith('invisíveis: a.md:')).length, 2);
    assert.match(lines.find(l => l.includes('.gitignore')), /^invisíveis: \.gitignore:1:5 — soft hyphen \(U\+00AD\)$/);
    assert.match(lines.find(l => l.includes('pre-commit')), /^invisíveis: hooks\/pre-commit:1:10 — form feed \(U\+000C\)$/);
    assert.equal(lines.some(l => l.includes('b.png')), false);
    for (const ext of ['md', 'mjs', 'js', 'json', 'css', 'html']) assert.ok(TEXT_EXT.test(`x.${ext}`) && isTextFile(`dir/x.${ext}`), ext);
    for (const f of ['.gitignore', '.gitattributes', '.editorconfig', 'LICENSE', 'hooks/pre-commit']) assert.ok(isTextFile(f), f);
    for (const f of ['x.png', 'tools/a.exe', 'fonts/b.woff2']) assert.equal(isTextFile(f), false, f);
  });
  test('the checker\'s own sources carry no forbidden character (it is versioned and scans itself)', () => {
    // The first version of tools/check.mjs declared these characters as literals
    // (a `\\u200B` escape had been turned into the character it names while the
    // file was written): the moment it was committed, `npm run check` would have
    // failed on its own source for ever. They are code points now, and this test
    // is the guard.
    for (const f of ['tools/check.mjs', 'test/check.test.mjs', 'test/spawn-runner.test.mjs', 'lib/models.mjs', 'lib/runner.mjs', 'bin/forja.mjs']) {
      const hits = findInvisible(readFileSync(join(repo, f), 'utf8'));
      assert.deepEqual(hits, [], `${f}: ${hits.map(h => `${h.line}:${h.column} ${h.name}`).join(', ')}`);
    }
    assert.deepEqual(checkInvisible(repo, ['tools/check.mjs', 'test/check.test.mjs', 'test/spawn-runner.test.mjs']), []);
    // And the ranges really are the ones the task named, declared as numbers.
    assert.deepEqual(INVISIBLE_RANGES.map(([a, b]) => [a, b]), [[0x000C, 0x000C], [0x00AD, 0x00AD], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2064], [0x2066, 0x2069], [0xFEFF, 0xFEFF]]);
  });
});

describe('the sample project is a byte-identical copy of the crew', () => {
  const src = join(root, 'src'); const dst = join(root, 'dst');
  test('identical trees pass; a changed, a missing and an extra file are each named', () => {
    write(join(src, 'forja-lead', 'SKILL.md'), 'igual\n');
    write(join(src, 'forja-crew', 'SKILL.md'), 'fonte\n');
    write(join(dst, 'forja-lead', 'SKILL.md'), 'igual\n');
    write(join(dst, 'forja-crew', 'SKILL.md'), 'fonte\n');
    assert.deepEqual(sampleDivergences(src, dst), []);

    write(join(dst, 'forja-crew', 'SKILL.md'), 'fonte alterada\n');
    write(join(src, 'forja-qa', 'SKILL.md'), 'novo\n');
    write(join(dst, 'forja-velho', 'SKILL.md'), 'legado\n');
    const lines = sampleDivergences(src, dst, 'skills');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^sample: \.claude\/skills\/forja-crew\/SKILL\.md difere da cópia em examples\/sample-project — corre `node bin\/forja\.mjs bootstrap examples\/sample-project`$/);
    assert.match(lines[1], /^sample: falta \.claude\/skills\/forja-qa\/SKILL\.md em examples\/sample-project/);
    assert.match(lines[2], /^sample: examples\/sample-project\/\.claude\/skills\/forja-velho\/SKILL\.md não existe em \.claude\/skills\//);
  });
  test('a one-byte difference is enough (a trailing newline is not "the same file")', () => {
    const a = join(root, 'a'); const b = join(root, 'b');
    write(join(a, 'x.md'), 'texto');
    write(join(b, 'x.md'), 'texto\n');
    assert.equal(sampleDivergences(a, b).length, 1);
  });
});

describe('the model policy has exactly one source', () => {
  test('the markers catch the sentence policyText really prints, at every level', () => {
    for (const lv of LEVELS) assert.equal(policyMarkersIn(policyText(lv)).length > 0, true, `${lv}: a pasted copy of the policy is caught`);
    assert.deepEqual(policyMarkersIn('ver §6 — gerado de `lib/models.mjs`'), [], 'a pointer to §6 is not a copy');
    assert.deepEqual(policyMarkersIn('the Devs run on the model given in the delegation step'), []);
  });
  test('a copy in a scanned file is reported with its line; §6 of the architecture is exempt', () => {
    const r = join(root, 'policy');
    write(join(r, 'CLAUDE.md'), `linha um\nDevs em Sonnet, Opus em tasks hard\n`);
    assert.deepEqual(checkPolicySource(r, ['CLAUDE.md']).map(l => l.replace(/\(".*"\)/, '(marcador)')), [
      'política de modelos: CLAUDE.md:2 escreve a tabela (marcador) — a fonte é lib/models.mjs (policyText); aponta para docs/ARCHITECTURE.md §6',
    ]);
    const arch = `## 5. Antes\ntexto\n\n## 6. forjalvl e effort\nDevs em Sonnet, o resto aqui\n\n## 7. Depois\nnada\n`;
    write(join(r, 'docs', 'ARCHITECTURE.md'), arch);
    assert.deepEqual(checkPolicySource(r, ['docs/ARCHITECTURE.md']), [], '§6 may keep the table');
    assert.equal(stripPolicySection(`\n${arch}`).includes('o resto aqui'), false);
    assert.equal(stripPolicySection(`\n${arch}`).includes('## 7. Depois'), true, 'only §6 is removed');
    write(join(r, 'docs', 'ARCHITECTURE.md'), `${arch}\n## 8. Outra\nsonnet em tasks fáceis\n`);
    assert.equal(checkPolicySource(r, ['docs/ARCHITECTURE.md']).length, 1, 'a copy outside §6 is still caught');
    assert.deepEqual(checkPolicySource(r, ['nao-existe.md']), []);
  });
});

describe('the whole check', () => {
  test('a clean fixture repo has no failures; a planted invisible character and a planted copy are both reported', async () => {
    const clean = join(root, 'clean');
    write(join(clean, 'CLAUDE.md'), 'projeto limpo\n');
    const ok = await runChecks({ root: clean, files: ['CLAUDE.md'] });
    assert.deepEqual(ok.failures, []);
    assert.equal(ok.replay.skipped, true, 'no data/events.jsonl in the fixture: check 3 is skipped, not failed');

    const dirty = join(root, 'dirty');
    write(join(dirty, 'CLAUDE.md'), `Devs em Sonnet, Opus em tasks hard\num${ch(0x200B)}dois\n`);
    const bad = await runChecks({ root: dirty, files: ['CLAUDE.md'] });
    assert.equal(bad.failures.length, 2);
    assert.match(bad.failures[0], /^invisíveis: CLAUDE\.md:2:3 — U\+200B$/);
    assert.match(bad.failures[1], /^política de modelos: CLAUDE\.md:1 /);
  });
  test('on this repo the script runs, and the invisible-character and policy checks are clean', () => {
    const r = spawnSync(process.execPath, [join(repo, 'tools', 'check.mjs')], { cwd: repo, encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    assert.ok([0, 1].includes(r.status), `exit ${r.status}: ${out}`);
    assert.equal(/^- invisíveis:/m.test(out), false, `no invisible characters in versioned files:\n${out}`);
    assert.equal(/^- política de modelos:/m.test(out), false, `the policy is written in one place only:\n${out}`);
    assert.equal(/^- replay:/m.test(out), false, `the event stream still replays:\n${out}`);
    assert.equal(/^- TASKS\.json:/m.test(out), false, `nothing commands opening TASKS.json directly:\n${out}`);
    if (r.status === 0) assert.match(out, /check ok/);
    else assert.match(out, /^- sample:/m, 'the only failure a clean tree may have here is the sample copy waiting for a bootstrap');
  });
});

describe('the autonomy rule reaches every file that carries it', () => {
  test('a file of the list that stopped mentioning it is reported; a repo without lib/autonomy.mjs is not ours to check', () => {
    const r = join(root, 'aut');
    write(join(r, 'lib', 'autonomy.mjs'), 'export const AUTONOMIES = [];\n');
    write(join(r, 'CLAUDE.md'), 'regras do projeto, sem uma palavra sobre o assunto\n');
    assert.deepEqual(checkAutonomyRule(r, ['CLAUDE.md']), [
      'autonomia: CLAUDE.md não diz nada sobre a autonomia do run — a regra vive em lib/autonomy.mjs e tem de chegar a este ficheiro (docs/ARCHITECTURE.md §6b)',
    ]);
    write(join(r, 'CLAUDE.md'), 'em `autonomy: total` o run decide sozinho\n');
    assert.deepEqual(checkAutonomyRule(r, ['CLAUDE.md']), [], 'the English word counts');
    write(join(r, 'CLAUDE.md'), 'a autonomia do run está em RUN.json\n');
    assert.deepEqual(checkAutonomyRule(r, ['CLAUDE.md']), [], 'and so does the Portuguese one');
    assert.deepEqual(checkAutonomyRule(r, ['nao-existe.md']), [], 'a file that is not there is not a failure');
    // A bootstrapped project or a fixture has its own CLAUDE.md and none of our code.
    const other = join(root, 'nao-forja');
    write(join(other, 'CLAUDE.md'), 'outro projeto qualquer\n');
    assert.deepEqual(checkAutonomyRule(other, ['CLAUDE.md']), [], 'without lib/autonomy.mjs there is nothing to keep honest');
  });
  test('the list names the files an agent or the Sponsor actually reads, and this repo passes', () => {
    for (const f of ['CLAUDE.md', 'lib/runner.mjs', 'bin/forja.mjs', '.claude/skills/forja-lead/SKILL.md', '.claude/skills/forja-product/SKILL.md', '.claude/skills/forja-scout/SKILL.md', '.claude/skills/forja-crew/SKILL.md', 'docs/ARCHITECTURE.md', 'docs/RUNBOOK-UNATTENDED.md']) {
      assert.ok(AUTONOMY_FILES.includes(f), `${f} tem de estar na lista`);
    }
    assert.deepEqual(checkAutonomyRule(repo), [], 'this repo carries the rule everywhere it must');
  });
});

describe('nothing commands opening docs/forja/TASKS.json directly (D30-b, S7)', () => {
  test('a read/open verb on the same line as TASKS.json is caught, with the line and an excerpt', () => {
    const hits = findTasksJsonOpenCommands('linha um\nRead CLAUDE.md, then docs/forja/TASKS.json, then go on\nmore text');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 2);
    assert.match(hits[0].excerpt, /^Read CLAUDE\.md, then docs\/forja\/TASKS\.json, then go on$/);
  });
  test('the Portuguese verbs are caught too (ler, abrir, abre)', () => {
    for (const line of ['Contexto: ler CLAUDE.md, docs/forja/TASKS.json (T1).', 'manda abrir o docs/forja/TASKS.json inteiro', 'a sessão abre docs/forja/TASKS.json para ver o estado']) {
      assert.equal(findTasksJsonOpenCommands(line).length, 1, line);
    }
  });
  test('naming the file as a format or a write target is legitimate and is not caught', () => {
    for (const line of [
      'the plan lives in `docs/forja/TASKS.json` (3–10 small tasks, `forja task add`)',
      'Decomposes a project or phase ONCE into the plan file docs/forja/TASKS.json',
      'every task in `docs/forja/TASKS.json` must be small enough for one dev session',
      'the owner comes from TASKS.json, so "constructor" needs Object.hasOwn',
    ]) {
      assert.deepEqual(findTasksJsonOpenCommands(line), [], line);
    }
  });
  test('a line that says, in the same breath, that the file is never opened directly passes (the pattern already used in this repo)', () => {
    for (const line of [
      'task T<n> in full (id, state, criteria, verdicts — read it instead of opening TASKS.json)',
      '// never has to read (and re-read into its context) the whole TASKS.json:',
      'task state comes from `status` below, never from opening TASKS.json directly.',
    ]) {
      assert.deepEqual(findTasksJsonOpenCommands(line), [], line);
    }
  });
  test('checkNoTasksJsonRead scans a file list and reports path:line; a clean file is silent', () => {
    const r = join(root, 'tasksjson');
    write(join(r, '.claude', 'skills', 'forja-bad', 'SKILL.md'), 'a\nb\n1. Read CLAUDE.md and docs/forja/TASKS.json for your task.\n');
    write(join(r, '.claude', 'skills', 'forja-good', 'SKILL.md'), 'run `forja task show T<n>` for your task — never open TASKS.json directly.\n');
    write(join(r, 'lib', 'runner.mjs'), 'export const x = 1; // TASKS.json is the plan file, written through the CLI\n');
    const out = checkNoTasksJsonRead(r, ['.claude/skills/forja-bad/SKILL.md', '.claude/skills/forja-good/SKILL.md', 'lib/runner.mjs', 'nao-existe.md']);
    assert.equal(out.length, 1);
    assert.match(out[0], /^TASKS\.json: \.claude\/skills\/forja-bad\/SKILL\.md:3 manda abrir\/ler docs\/forja\/TASKS\.json diretamente/);
  });
  test('the scan list reaches the runner, every skill, every agent and the sample project\'s copies', () => {
    const list = tasksJsonScanList(repo);
    for (const f of ['lib/runner.mjs', 'bin/forja.mjs', '.claude/skills/forja-lead/SKILL.md', '.claude/agents/architect.md', 'examples/sample-project/.claude/skills/forja-lead/SKILL.md', 'examples/sample-project/.claude/agents/architect.md']) {
      assert.ok(list.includes(f), `${f} tem de estar na lista`);
    }
  });
  test('this repo has zero files that command opening TASKS.json directly', () => {
    assert.deepEqual(checkNoTasksJsonRead(repo), [], 'D30-b: de N para 0');
  });
});
