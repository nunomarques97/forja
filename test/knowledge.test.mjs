import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  retrieveKnowledge,
  chunks,
  rankChunks,
} from '../lib/core/knowledge.mjs';
import { packet } from '../lib/core/context.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-knowledge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, 'docs/forja'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.forja/\nignored.md\n');
  const put = (p, text) => writeFileSync(join(root, p), text);
  const manifest = (documents) =>
    put('docs/forja/KNOWLEDGE.json', JSON.stringify({ version: 1, documents }));
  return { root, put, manifest };
}

test('retrieval finds content behind generic filenames, abstains on no-match and respects serialized budget', (t) => {
  const f = fixture(t);
  f.put(
    'docs/forja/DECISIONS.md',
    '# Interface\nUse generation counters to prevent stale pagination responses.\n',
  );
  f.put('README.md', '# Install\nRun the build command.\n');
  const r = retrieveKnowledge(f.root, 'stale pagination');
  assert.equal(r.selected[0].path, 'docs/forja/DECISIONS.md');
  assert.match(r.selected[0].text, /generation counters/);
  assert.equal(
    retrieveKnowledge(f.root, 'quasar xylophone').selected.length,
    0,
  );
  const bounded = retrieveKnowledge(f.root, 'pagination', { budget: 256 });
  assert.ok(JSON.stringify(bounded.selected).length <= 256);
});

test('knowledge reflects same-size edits/deletions directly from source', (t) => {
  const f = fixture(t);
  f.put('README.md', '# Cats\nCats are project mascots.\n');
  retrieveKnowledge(f.root, 'cats');
  f.put('README.md', '# Dogs\nDogs are project mascots.\n');
  assert.equal(retrieveKnowledge(f.root, 'cats').selected.length, 0);
  assert.ok(retrieveKnowledge(f.root, 'dogs').selected.length);
  rmSync(join(f.root, 'README.md'));
  assert.equal(retrieveKnowledge(f.root, 'dogs').selected.length, 0);
});

test('mandatory notes are explicit, include ignored files only by manifest, and fail clearly when absent/oversized', (t) => {
  const f = fixture(t);
  f.put('ignored.md', 'Always preserve unknown telemetry values.');
  assert.equal(retrieveKnowledge(f.root, 'telemetry').selected.length, 0);
  f.manifest([{ path: 'ignored.md', required: true }]);
  assert.equal(retrieveKnowledge(f.root, '').selected[0].required, true);
  f.put('ignored.md', 'A'.repeat(7000));
  assert.throws(
    () => retrieveKnowledge(f.root, ''),
    /Required knowledge exceeds/,
  );
  rmSync(join(f.root, 'ignored.md'));
  assert.throws(
    () => retrieveKnowledge(f.root, ''),
    /Required knowledge missing/,
  );
});

test('source hashes suppress stale optional notes and block stale mandatory notes', (t) => {
  const f = fixture(t);
  f.put('contract.mjs', 'export const limit = 5;');
  f.put('README.md', 'Pagination limit is five.');
  const digest = createHash('sha256')
    .update(readFileSync(join(f.root, 'contract.mjs')))
    .digest('hex');
  const doc = { path: 'README.md', source_hashes: { 'contract.mjs': digest } };
  f.manifest([doc]);
  assert.equal(retrieveKnowledge(f.root, 'pagination').selected.length, 1);
  f.put('contract.mjs', 'export const limit = 9;');
  const stale = retrieveKnowledge(f.root, 'pagination');
  assert.equal(stale.selected.length, 0);
  assert.match(stale.warnings[0], /Stale/);
  f.manifest([{ ...doc, required: true }]);
  assert.throws(() => retrieveKnowledge(f.root, ''), /stale source/);
});

test('duplicate manifest aliases cannot silently drop required or freshness constraints', (t) => {
  const f = fixture(t);
  f.manifest(['missing.md', { path: './missing.md', required: true }]);
  assert.throws(
    () => retrieveKnowledge(f.root, ''),
    /Duplicate knowledge document/,
  );
  f.put('note.md', 'Pagination uses generation counters.');
  f.manifest([
    'note.md',
    { path: './note.md', source_hashes: { 'source.mjs': '0'.repeat(64) } },
  ]);
  assert.throws(
    () => retrieveKnowledge(f.root, 'pagination'),
    /Duplicate knowledge document/,
  );
});

test('retrieval refuses traversal and external junctions', (t) => {
  const f = fixture(t);
  f.manifest(['../outside.md']);
  assert.throws(() => retrieveKnowledge(f.root, ''), /outside project/);
  const outside = mkdtempSync(join(tmpdir(), 'forja-knowledge-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'note.md'), 'external note');
  symlinkSync(
    outside,
    join(f.root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  f.manifest(['linked/note.md']);
  assert.throws(() => retrieveKnowledge(f.root, ''), /outside project/);
});

test('chunks preserve bounded text and Unicode/camel-case queries can find identifiers', () => {
  const list = chunks(
    '# Observação\n' +
      'a'.repeat(5000) +
      '\nAtualização de playerRefreshToken.',
  );
  assert.ok(list.every((c) => c.text.length <= 1400));
  assert.ok(
    rankChunks(
      list.map((c) => ({ ...c, path: 'notes.md' })),
      'observacao player refresh token',
    ).length,
  );
});

test('packet accounting reconciles every serialized character without discarding acceptance criteria', (t) => {
  const f = fixture(t);
  f.put('README.md', 'Pagination has a strict query generation contract.');
  const task = {
    id: 'fix',
    title: 'Fix pagination',
    criteria: ['Newest query wins'],
    files: [],
    checks: [],
    risks: [],
  };
  const p = packet({
    root: f.root,
    run: { goal: 'Repair search', decisions: [], tasks: [task] },
    task,
    phase: 'develop',
  });
  assert.equal(
    p.sources.reduce((n, s) => n + s.characters, 0),
    p.text.length,
  );
  assert.match(p.text, /Newest query wins/);
  assert.ok(p.retrieval.selected.length);
  assert.equal(p.retrieval.selected[0].text, undefined);
});
