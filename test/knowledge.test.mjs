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
  const manifest = (documents, version = 1) =>
    put('docs/forja/KNOWLEDGE.json', JSON.stringify({ version, documents }));
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

test('explicit references remove lexical report noise while retaining complete mandatory requirements', (t) => {
  const f = fixture(t);
  const invariant = 'Reject duplicate transaction identifiers; preserve existing user records.';
  f.put('contract.md', invariant);
  const reports = Array.from({ length: 20 }, (_, i) => `report-${i}.md`);
  for (const path of reports) f.put(path, `# Retry ${path}\nRetry parser recovery telemetry measurements from an unrelated experiment.`);
  const mandatory = { path: 'contract.md', required: true };
  f.manifest([mandatory, ...reports]);
  const before = retrieveKnowledge(f.root, 'Fix retry parser');
  assert.ok(before.selected.some(e => reports.includes(e.path)));
  f.manifest([mandatory, ...reports.map(path => ({ path, mode: 'reference', when: 'Evaluating the archived retry experiments.' }))], 2);
  const after = retrieveKnowledge(f.root, 'Fix retry parser');
  assert.deepEqual(after.selected.map(e => e.text), [invariant]);
  assert.equal(after.references.length, reports.length);
  assert.equal(after.indexed_bytes, Buffer.byteLength(invariant));
  assert.ok(after.indexed_bytes < before.indexed_bytes);
  assert.equal(after.documents_scanned, 1);
});

test('design, architecture and release references stay discoverable without lexical overlap in every phase', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'archive'));
  const docs = [
    { path: 'design.md', mode: 'reference', when: 'Changing visuals or keyboard interaction.' },
    { path: 'archive/decision.md', mode: 'reference', when: 'Changing the durable queue architecture.' },
    { path: 'release.md', mode: 'reference', when: 'Publishing a release.' },
    { path: 'study.md', mode: 'reference', when: 'Comparing prior experiments.' },
  ];
  for (const {path} of docs) f.put(path, 'Specialist source body must be read on demand.');
  f.manifest(docs, 2);
  for (const [title, phase] of [['Alterar cores', 'plan'], ['Redesenhar fila', 'develop'], ['Publicar versão', 'review'], ['Investigar ensaios', 'develop']]) {
    const task = { id: 'T1', title, criteria: ['Preserve requirements'], files: [], checks: [], risks: [] };
    const p = packet({ root: f.root, run: { goal: title, tasks: [task] }, task: phase === 'plan' ? null : task, phase });
    const data = JSON.parse(p.text);
    assert.deepEqual(data.knowledge.references, docs.map(({path, when}) => ({path, when})));
    assert.deepEqual(data.knowledge.selected, []);
    assert.doesNotMatch(p.text, /Specialist source body/);
    assert.deepEqual(p.retrieval.references, data.knowledge.references);
    assert.equal(p.sources.reduce((n, s) => n + s.characters, 0), p.characters);
  }
});

test('an explicitly indexed ADR outside discovery folders still supplies its decision', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'archive'));
  f.put('archive/accepted.md', 'Queue durability requires an fsync before acknowledging a write.');
  f.manifest([{path: 'archive/accepted.md', mode: 'auto'}], 2);
  assert.match(retrieveKnowledge(f.root, 'queue durability').selected[0].text, /fsync/);
});

test('references consume the shared budget, remain complete, and do not consume excerpt slots', (t) => {
  const f = fixture(t);
  f.put('manual.md', 'manual body '.repeat(20000));
  f.put('rule.md', 'Preserve required invariant.');
  const ref = {path: 'manual.md', mode: 'reference', when: 'Editing the subsystem architecture, persistent storage or its documented recovery guarantees.'};
  f.manifest([{path: 'rule.md', required: true}, ref], 2);
  const r = retrieveKnowledge(f.root, '', {maxChunks: 1});
  assert.equal(r.references.length, 1);
  assert.equal(r.selected.length, 1);
  assert.equal(r.characters, JSON.stringify({selected:r.selected, references:r.references}).length);
  assert.throws(() => retrieveKnowledge(f.root, '', {budget: 256}), /including references/);
  f.manifest([ref], 2);
  const only = retrieveKnowledge(f.root, 'manual');
  assert.equal(only.indexed_bytes, 0);
  assert.equal(only.documents_scanned, 0);
  assert.equal(only.references[0].path, 'manual.md');
});

test('optional excerpts cannot displace references or required requirements under budget pressure', (t) => {
  const f = fixture(t);
  f.put('rule.md', 'Mandatory invariant.');
  f.put('manual.md', 'Manual source.');
  f.put('optional.md', 'Queue recovery '.repeat(70));
  f.manifest([{path:'rule.md', required:true}, {path:'manual.md', mode:'reference', when:'Changing queue architecture.'}, 'optional.md'], 2);
  const r = retrieveKnowledge(f.root, 'queue recovery', {budget:512});
  assert.equal(r.selected.length, 1);
  assert.equal(r.selected[0].text, 'Mandatory invariant.');
  assert.equal(r.references.length, 1);
  assert.ok(r.characters <= 512);
});

test('missing and stale references are reported and a current source remains selectable', (t) => {
  const f = fixture(t);
  f.put('source.mjs', 'current');
  f.put('old.md', 'Queue used the old protocol.');
  f.put('current.md', 'Queue uses the current protocol.');
  const doc = {path:'old.md', mode:'reference', when:'Changing queue protocol.', source_hashes:{'source.mjs':createHash('sha256').update('current').digest('hex')}};
  f.manifest([doc, 'current.md'], 2);
  assert.equal(retrieveKnowledge(f.root, 'queue').references.length, 1);
  f.put('source.mjs', 'updated');
  f.manifest([doc, 'current.md', {path:'missing.md', mode:'reference', when:'Changing layout.'}], 2);
  const r = retrieveKnowledge(f.root, 'queue');
  assert.equal(r.references.length, 0);
  assert.equal(r.selected[0].path, 'current.md');
  assert.ok(r.warnings.some(w => /Stale.*old.md/.test(w)));
  assert.ok(r.warnings.some(w => /Missing.*missing.md/.test(w)));
});

test('version 2 cannot weaken mandatory freshness or existence checks', (t) => {
  const f = fixture(t);
  f.manifest([{path:'absent.md', required:true}], 2);
  assert.throws(() => retrieveKnowledge(f.root, ''), /Required knowledge missing/);
  f.put('old.md', 'Mandatory contract.');
  f.manifest([{path:'old.md', required:true, source_hashes:{'source.mjs':'0'.repeat(64)}}], 2);
  assert.throws(() => retrieveKnowledge(f.root, ''), /Required knowledge has stale/);
});

test('invalid manifest versions and reference policies fail instead of falling back to discovery', (t) => {
  const f = fixture(t);
  f.put('note.md', 'Potentially irrelevant content.');
  const ref = {path:'note.md', mode:'reference', when:'Changing the parser.'};
  for (const doc of [{...ref, required:true}, {...ref, when:''}, {...ref, when:' '.repeat(10)}, {...ref, when:'x'.repeat(301)}, {...ref, when:3}, {...ref, mode:'refernece'}, {path:'note.md', when:'Forgot mode'}]) {
    f.manifest([doc], 2);
    assert.throws(() => retrieveKnowledge(f.root, 'content'), /Knowledge mode/);
  }
  f.manifest([ref]);
  assert.throws(() => retrieveKnowledge(f.root, ''), /version 2/);
  for (const manifest of [null, {}, {version:3, documents:[]}, {version:2, documents:[null]}]) {
    f.put('docs/forja/KNOWLEDGE.json', JSON.stringify(manifest));
    assert.throws(() => retrieveKnowledge(f.root, ''), /Invalid|Knowledge documents/);
  }
  f.put('docs/forja/KNOWLEDGE.json', '{broken');
  assert.throws(() => retrieveKnowledge(f.root, ''), SyntaxError);
});

test('empty manifests explicitly disable discovery while absent and version 1 manifests retain retrieval', (t) => {
  const f = fixture(t);
  f.put('note.md', 'Queue capacity is eight.');
  assert.equal(retrieveKnowledge(f.root, 'queue').selected.length, 1);
  f.manifest(['note.md']);
  assert.equal(retrieveKnowledge(f.root, 'queue').selected.length, 1);
  for (const version of [1, 2]) {
    f.manifest([], version);
    const r = retrieveKnowledge(f.root, 'queue');
    assert.deepEqual(r.selected, []);
    assert.deepEqual(r.references, []);
    assert.match(r.warnings[0], /Empty.*disabled/);
  }
});

test('reference aliases and traversal cannot evade project boundaries', (t) => {
  const f = fixture(t);
  const ref = {path:'note.md', mode:'reference', when:'Changing the parser.'};
  f.put('note.md', 'Parser contract.');
  f.manifest([ref, {...ref, path:'./note.md'}], 2);
  assert.throws(() => retrieveKnowledge(f.root, ''), /Duplicate/);
  f.manifest([{...ref, path:'../external.md'}], 2);
  assert.throws(() => retrieveKnowledge(f.root, ''), /outside project/);
  const outside = mkdtempSync(join(tmpdir(), 'forja-reference-outside-'));
  t.after(() => rmSync(outside, {recursive:true, force:true}));
  writeFileSync(join(outside, 'note.md'), 'external');
  symlinkSync(outside, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  f.manifest([{...ref, path:'linked/note.md'}], 2);
  assert.throws(() => retrieveKnowledge(f.root, ''), /outside project/);
});
