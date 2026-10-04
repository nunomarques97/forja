// tools/check.mjs — the repo invariants `npm run check` enforces. The units are
// tested against fixtures in a temp dir (so the test never depends on the state
// of this working tree), plus one run of the real script on this repo to prove
// it is actually clean here.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as check from '../tools/check.mjs';
import { findInvisible, sampleDivergences, checkSample, checkInvisible, runChecks, TEXT_EXT, isTextFile, INVISIBLE_RANGES } from '../tools/check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const root = mkdtempSync(join(tmpdir(), 'forja-check-'));
after(() => rmSync(root, { recursive: true, force: true }));
const ch = code => String.fromCharCode(code);
const write = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8'); };
const CORE_METHODS = ['backend', 'design', 'frontend', 'planner', 'reviewer', 'security'].map(id => `forja-core-${id}`);

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
    const clean = 'a\tb\r\nção — «citação» 🙂  fim';
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
    for (const ext of ['md', 'mjs', 'js', 'json', 'css', 'html', 'py']) assert.ok(TEXT_EXT.test(`x.${ext}`) && isTextFile(`dir/x.${ext}`), ext);
    for (const f of ['.gitignore', '.gitattributes', '.editorconfig', 'LICENSE', 'hooks/pre-commit']) assert.ok(isTextFile(f), f);
    for (const f of ['x.png', 'tools/a.exe', 'fonts/b.woff2']) assert.equal(isTextFile(f), false, f);
  });
  test('the checker\'s own sources carry no forbidden character (it is versioned and scans itself)', () => {
    // The first version of tools/check.mjs declared these characters as literals
    // (a `\\u200B` escape had been turned into the character it names while the
    // file was written): the moment it was committed, `npm run check` would have
    // failed on its own source for ever. They are code points now, and this test
    // is the guard.
    for (const f of ['tools/check.mjs', 'test/check.test.mjs', 'bin/forja.mjs']) {
      const hits = findInvisible(readFileSync(join(repo, f), 'utf8'));
      assert.deepEqual(hits, [], `${f}: ${hits.map(h => `${h.line}:${h.column} ${h.name}`).join(', ')}`);
    }
    assert.deepEqual(checkInvisible(repo, ['tools/check.mjs', 'test/check.test.mjs']), []);
    // And the ranges really are the ones the task named, declared as numbers.
    assert.deepEqual(INVISIBLE_RANGES.map(([a, b]) => [a, b]), [[0x000C, 0x000C], [0x00AD, 0x00AD], [0x200B, 0x200F], [0x202A, 0x202E], [0x2060, 0x2064], [0x2066, 0x2069], [0xFEFF, 0xFEFF]]);
  });
});

describe('the sample project is a byte-identical copy of the Core methods', () => {
  const src = join(root, 'src'); const dst = join(root, 'dst');
  test('identical Core methods pass; a changed, a missing and an extra file are each named', () => {
    write(join(src, 'forja-core-planner', 'SKILL.md'), 'igual\n');
    write(join(src, 'forja-core-reviewer', 'SKILL.md'), 'fonte\n');
    write(join(dst, 'forja-core-planner', 'SKILL.md'), 'igual\n');
    write(join(dst, 'forja-core-reviewer', 'SKILL.md'), 'fonte\n');
    assert.deepEqual(sampleDivergences(src, dst), []);

    write(join(dst, 'forja-core-reviewer', 'SKILL.md'), 'fonte alterada\n');
    write(join(src, 'forja-core-security', 'SKILL.md'), 'novo\n');
    write(join(dst, 'forja-velho', 'SKILL.md'), 'antigo\n');
    const lines = sampleDivergences(src, dst);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^sample: \.claude\/skills\/forja-core-reviewer\/SKILL\.md difere da cópia em examples\/sample-project — copia \.claude\/skills\/forja-core-\*\/ deste repo para examples\/sample-project\/\.claude\/skills\/$/);
    assert.match(lines[1], /^sample: falta \.claude\/skills\/forja-core-security\/SKILL\.md em examples\/sample-project/);
    assert.match(lines[2], /^sample: examples\/sample-project\/\.claude\/skills\/forja-velho\/SKILL\.md não é um método Core deste repo/);
    assert.doesNotMatch(lines.join('\n'), /bootstrap/, 'no hint to the removed crew install');
  });
  test('only forja-core-* is compared: another skill in the source is not expected in the sample', () => {
    const a = join(root, 'only-core-src'); const b = join(root, 'only-core-dst');
    write(join(a, 'forja-core-design', 'SKILL.md'), 'x\n');
    write(join(a, 'forja-other', 'SKILL.md'), 'not a Core method\n');
    write(join(b, 'forja-core-design', 'SKILL.md'), 'x\n');
    assert.deepEqual(sampleDivergences(a, b), []);
  });
  test('a one-byte difference is enough (a trailing newline is not "the same file")', () => {
    const a = join(root, 'a'); const b = join(root, 'b');
    write(join(a, 'forja-core-x', 'x.md'), 'texto');
    write(join(b, 'forja-core-x', 'x.md'), 'texto\n');
    assert.equal(sampleDivergences(a, b).length, 1);
  });
  test('checkSample compares the skills folders of a repo and its sample; a repo without a sample is skipped', () => {
    const r = join(root, 'sample-repo');
    write(join(r, '.claude', 'skills', 'forja-core-backend', 'SKILL.md'), 'm\n');
    write(join(r, 'examples', 'sample-project', '.claude', 'skills', 'forja-core-backend', 'SKILL.md'), 'm\n');
    assert.deepEqual(checkSample(r), []);
    write(join(r, 'examples', 'sample-project', '.claude', 'skills', 'forja-core-backend', 'SKILL.md'), 'changed\n');
    assert.equal(checkSample(r).length, 1);
    assert.deepEqual(checkSample(join(root, 'no-sample')), []);
  });
});

describe('the crew-only checks are gone', () => {
  test('tools/check.mjs no longer exports the model-policy, autonomy-rule or TASKS.json checks', () => {
    for (const name of ['checkPolicySource', 'policyMarkersIn', 'stripPolicySection', 'POLICY_MARKERS', 'checkAutonomyRule', 'AUTONOMY_FILES', 'findTasksJsonOpenCommands', 'checkNoTasksJsonRead', 'tasksJsonScanList', 'CREW_DIRS']) {
      assert.equal(Object.hasOwn(check, name), false, name);
    }
  });
  test('this repo and its sample carry no crew agents and only the six Core methods', () => {
    for (const base of [repo, join(repo, 'examples', 'sample-project')]) {
      assert.equal(existsSync(join(base, '.claude', 'agents')), false, base);
      assert.deepEqual(readdirSync(join(base, '.claude', 'skills')).sort(), CORE_METHODS);
    }
  });
});

describe('the whole check', () => {
  test('a clean fixture repo has no failures; a planted invisible character and a planted sample divergence are both reported', async () => {
    const clean = join(root, 'clean');
    write(join(clean, 'CLAUDE.md'), 'projeto limpo\n');
    const ok = await runChecks({ root: clean, files: ['CLAUDE.md'] });
    assert.deepEqual(ok.failures, []);
    assert.equal(ok.replay.skipped, true, 'no data/events.jsonl in the fixture: check 3 is skipped, not failed');

    const dirty = join(root, 'dirty');
    write(join(dirty, 'CLAUDE.md'), `Devs em Sonnet, Opus em tasks hard\num${ch(0x200B)}dois\n`);
    write(join(dirty, '.claude', 'skills', 'forja-core-planner', 'SKILL.md'), 'method\n');
    write(join(dirty, 'examples', 'sample-project', '.claude', 'skills', 'forja-old', 'SKILL.md'), 'old\n');
    const bad = await runChecks({ root: dirty, files: ['CLAUDE.md'] });
    assert.equal(bad.failures.length, 3, 'a missing and an extra sample file plus one invisible character; model-policy words are no longer checked');
    assert.match(bad.failures[0], /^sample: falta \.claude\/skills\/forja-core-planner\/SKILL\.md/);
    assert.match(bad.failures[1], /^sample: examples\/sample-project\/\.claude\/skills\/forja-old\/SKILL\.md não é um método Core/);
    assert.match(bad.failures[2], /^invisíveis: CLAUDE\.md:2:3 — U\+200B$/);
  });
  test('on this repo the script runs and passes', () => {
    const r = spawnSync(process.execPath, [join(repo, 'tools', 'check.mjs')], { cwd: repo, encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, out);
    assert.match(out, /^check ok — \d+ ficheiros versionados, métodos Core do sample idênticos, /);
  });
});
