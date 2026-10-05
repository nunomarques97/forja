import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractLessons, readLessonStore, lessonWeight, lessonConfidence, LESSON_KINDS, LESSON_STORE, LESSON_LIMITS, HALF_LIFE_DAYS } from '../lib/core/lessons.mjs';
import { contentFindings } from '../tools/release-check.mjs';

// Credential-shaped and home-path strings are assembled at runtime so this file
// never contains a literal the delivery privacy scan flags.
const credential = ['sk', 'ant', 'x'.repeat(32)].join('-');
const homePath = ['C:', 'Users', 'someone', 'elsewhere', 'notes.txt'].join('\\');
const unixHome = ['', 'home', 'someone', 'work', 'file.txt'].join('/');

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-lessons-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.forja', 'runs'), { recursive: true });
  return root;
}
const row = (id, phase, task, attempt, extra = {}) => ({ id, phase, task, attempt, provider: 'claude', model: 'model-a', result: 'returned', timed_out: false, rate_limited: false, context_limit_reached: false, ...extra });
function writeRun(root, id, { status = 'done', tasks, rows = [], results = {}, logs = {}, finished = '2026-09-01T10:00:00.000Z', ledgerExtra = '' }) {
  const dir = join(root, '.forja', 'runs', id);
  mkdirSync(dir, { recursive: true });
  const state = { version: 1, run_id: id, goal: 'synthetic', status, invocations: rows.length, config: { finalChecks: [] }, tasks,
    updated_at: finished, ...(status === 'done' ? { finished_at: finished } : {}) };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  // Absolute paths like the real ledger, which lessons must never copy.
  writeFileSync(join(dir, 'usage.jsonl'), rows.map(r => '\n' + JSON.stringify({ ...r, events_log: join(dir, `call-${r.id}-events.jsonl`) }) + '\n').join('') + ledgerExtra);
  for (const [n, value] of Object.entries(results)) writeFileSync(join(dir, `call-${n}-result.json`), typeof value === 'string' ? value : JSON.stringify(value));
  for (const [name, text] of Object.entries(logs)) writeFileSync(join(dir, name), text);
  return dir;
}
const check = { command: 'node', args: ['--test', 'test/dates.test.mjs'] };
const failingLog = root => `TAP version 13\nnot ok 1 - parses dates\n  error: expected 1 at ${join(root, 'lib', 'dates.mjs')}:3\n# fail 1\n`;

// Run A (done): T1 fails its check in attempt 1, is rejected in attempt 2
// (after a recovered timeout), then approved in attempt 3. T2 is approved once.
function runA(root) {
  const id = 'F-1000000000001-aaaaaa';
  const dir = join(root, '.forja', 'runs', id);
  return writeRun(root, id, {
    tasks: [
      { id: 'T1', title: 'Parse dates in the importer', files: ['lib/dates.mjs', 'test/dates.test.mjs'], checks: [check], status: 'done', attempts: 3,
        files_changed: ['lib/dates.mjs', 'lib/shared.mjs'],
        validation: [{ ...check, code: 0, passed: true, log: join(dir, 'T1-a3-check-0.log') }] },
      { id: 'T2', title: 'Export the report', files: ['lib/report.mjs'], checks: [], status: 'done', attempts: 1, files_changed: ['lib/shared.mjs', 'lib/report.mjs'], validation: [] },
    ],
    rows: [
      row(1, 'plan', null, 0),
      row(2, 'develop', 'T1', 1),
      row(3, 'develop', 'T1', 2, { result: 'error', timed_out: true }),
      row(4, 'develop', 'T1', 2),
      row(5, 'review', 'T1', 2),
      row(6, 'develop', 'T1', 3),
      row(7, 'review', 'T1', 3),
      row(8, 'develop', 'T2', 1),
      row(9, 'review', 'T2', 1),
    ],
    results: {
      2: { status: 'ready_for_validation', summary: 'Parser added.', findings: [] },
      4: { status: 'ready_for_validation', summary: 'Parser fixed.', findings: [] },
      5: { status: 'reject', summary: `Timezone offsets are ignored in ${join(root, 'lib', 'dates.mjs')} near ${credential}`, findings: [`See ${homePath}`, `and ${unixHome}`] },
      6: { status: 'ready_for_validation', summary: 'Offsets are now applied before formatting.', findings: [] },
      7: { status: 'approve', summary: 'Approved.', findings: [] },
      8: { status: 'done', summary: 'Report exported.', findings: [] },
      9: { status: 'approve', summary: 'Approved.', findings: [] },
    },
    logs: { 'T1-a1-check-0.log': failingLog(root), 'T1-a2-check-0.log': '# pass 1\n# fail 0\n', 'T1-a3-check-0.log': '# pass 1\n# fail 0\n' },
  });
}
// Run B (failed): the same check fails again in the final attempt, and a
// provider limit is not recovered.
function runB(root) {
  const id = 'F-1000000000002-bbbbbb';
  const dir = join(root, '.forja', 'runs', id);
  return writeRun(root, id, {
    status: 'failed', finished: '2026-09-02T10:00:00.000Z',
    tasks: [{ id: 'T1', title: 'Parse dates in the exporter', files: ['lib/dates.mjs'], checks: [check], status: 'blocked', attempts: 1,
      validation: [{ ...check, code: 1, passed: false, log: join(dir, 'T1-a1-check-0.log') }] }],
    rows: [row(1, 'develop', 'T1', 1), row(2, 'review', 'T1', 1, { result: 'error', rate_limited: true })],
    results: { 1: { status: 'ready_for_validation', summary: 'Exporter parses dates.', findings: [] } },
    logs: { 'T1-a1-check-0.log': failingLog(root) },
  });
}
const byKind = (store, kind) => store.lessons.filter(l => l.kind === kind);

test('extractor derives every lesson kind with evidence, counts and decay values', t => {
  const root = project(t);
  runA(root); runB(root);
  const result = extractLessons(root);
  assert.deepEqual(result.ingested, ['F-1000000000001-aaaaaa', 'F-1000000000002-bbbbbb']);
  assert.equal(result.written, true);
  const store = readLessonStore(root);
  assert.deepEqual([...new Set(store.lessons.map(l => l.kind))].sort(), [...LESSON_KINDS].sort());
  for (const lesson of store.lessons) {
    assert.match(lesson.id, /^L-[0-9a-f]{16}$/);
    assert.ok(lesson.text.length > 0 && lesson.text.length <= LESSON_LIMITS.text);
    assert.ok(lesson.count >= 1 && lesson.last_seen >= lesson.first_seen);
    assert.equal(lesson.confidence, lessonConfidence(lesson.count));
    assert.equal(lesson.half_life_days, HALF_LIFE_DAYS);
    assert.ok(lesson.evidence.length >= 1 && lesson.evidence.length <= LESSON_LIMITS.evidence);
    for (const pointer of lesson.evidence) {
      assert.match(pointer.run, /^F-/);
      assert.ok(!/^(?:[A-Za-z]:|[\\/])/.test(pointer.path), pointer.path);
    }
  }
  const [recurring] = byKind(store, 'check_failure');
  assert.equal(byKind(store, 'check_failure').length, 1);
  assert.equal(recurring.count, 2);
  assert.match(recurring.text, /node --test test\/dates\.test\.mjs/);
  assert.match(recurring.text, /parses dates/);
  assert.deepEqual(recurring.evidence.map(e => e.path), ['.forja/runs/F-1000000000002-bbbbbb/T1-a1-check-0.log', '.forja/runs/F-1000000000001-aaaaaa/T1-a1-check-0.log']);
  assert.equal(recurring.last_seen, '2026-09-02T10:00:00.000Z');
  assert.equal(recurring.first_seen, '2026-09-01T10:00:00.000Z');
  const [rejection] = byKind(store, 'review_rejection');
  assert.match(rejection.text, /Timezone offsets are ignored in <project>/);
  assert.match(rejection.text, /<redacted>/);
  assert.match(rejection.text, /<home>/);
  assert.deepEqual(rejection.evidence, [{ run: 'F-1000000000001-aaaaaa', task: 'T1', path: '.forja/runs/F-1000000000001-aaaaaa/call-5-result.json' }]);
  const [fix] = byKind(store, 'fix_after_rejection');
  assert.match(fix.text, /approved fix was: Offsets are now applied before formatting\./);
  assert.deepEqual(fix.files, ['lib/dates.mjs', 'lib/shared.mjs']);
  const providers = byKind(store, 'provider_failure').map(l => l.text).sort();
  assert.equal(providers.length, 2);
  assert.match(providers.find(text => /timeout/.test(text)), /develop call ended with timeout; a later fresh session of the same phase recovered/);
  assert.match(providers.find(text => /provider_limit/.test(text)), /review call ended with provider_limit; not recovered in that run \(run failed\)/);
  const shared = byKind(store, 'relevant_files').find(l => l.files[0] === 'lib/shared.mjs');
  assert.equal(shared.count, 2);
  assert.deepEqual(byKind(store, 'relevant_files').map(l => l.files[0]).sort(), ['lib/dates.mjs', 'lib/report.mjs', 'lib/shared.mjs']);
  assert.ok(lessonWeight(recurring, Date.parse(recurring.last_seen)) > lessonWeight(recurring, Date.parse(recurring.last_seen) + HALF_LIFE_DAYS * 86400000));
  assert.equal(lessonWeight(recurring, Date.parse(recurring.last_seen) + HALF_LIFE_DAYS * 86400000), lessonConfidence(2) / 2);
});

test('the written store passes the privacy scan and holds no project root or home path', t => {
  const root = project(t);
  runA(root); runB(root);
  extractLessons(root);
  const bytes = readFileSync(join(root, ...LESSON_STORE.split('/')));
  assert.deepEqual(contentFindings(bytes), []);
  const text = bytes.toString('utf8');
  assert.ok(!text.toLowerCase().includes(root.toLowerCase()));
  assert.ok(!text.includes(root.replaceAll('\\', '\\\\')));
  assert.ok(!text.includes(credential));
});

test('re-extraction is idempotent and byte-identical, also when ingested incrementally', t => {
  const root = project(t);
  runA(root); runB(root);
  extractLessons(root);
  const path = join(root, ...LESSON_STORE.split('/'));
  const first = readFileSync(path);
  const again = extractLessons(root);
  assert.equal(again.written, false);
  assert.deepEqual(again.ingested, []);
  assert.deepEqual(readFileSync(path), first);
  rmSync(path);
  assert.deepEqual(extractLessons(root, { maxRuns: 1 }).ingested, ['F-1000000000001-aaaaaa']);
  assert.deepEqual(extractLessons(root, { maxRuns: 1 }).ingested, ['F-1000000000002-bbbbbb']);
  assert.deepEqual(readFileSync(path), first);
});

test('unfinished, malformed, oversized and linked run artifacts are skipped with warnings', t => {
  const root = project(t);
  runA(root);
  writeRun(root, 'F-1000000000003-cccccc', { status: 'running', tasks: [] });
  mkdirSync(join(root, '.forja', 'runs', 'F-1000000000004-dddddd'));
  writeFileSync(join(root, '.forja', 'runs', 'F-1000000000004-dddddd', 'state.json'), '{"version":1,');
  mkdirSync(join(root, '.forja', 'runs', 'F-1000000000005-eeeeee'));
  writeFileSync(join(root, '.forja', 'runs', 'F-1000000000005-eeeeee', 'state.json'), ' '.repeat(LESSON_LIMITS.state + 1));
  writeRun(root, 'F-1000000000006-ffffff', { tasks: [{ id: '../x', title: 'bad' }] });
  // Damaged ledger lines and result files of a finished run are skipped, the rest is used.
  writeRun(root, 'F-1000000000007-gggggg', {
    tasks: [{ id: 'T1', title: 'Damaged history', files: ['lib/x.mjs'], status: 'done', attempts: 2, files_changed: ['lib/x.mjs'] }],
    rows: [row(1, 'develop', 'T1', 1), row(2, 'review', 'T1', 2), row(3, 'review', 'T9', 1)],
    results: { 1: '{not json', 2: { status: 'approve', summary: 'ok', findings: [] } },
    logs: { 'T1-a1-check-0.log': 'x'.repeat(LESSON_LIMITS.log + 1) },
    ledgerExtra: '{broken\n[]\n',
  });
  writeFileSync(join(root, '.forja', 'runs', 'F-1000000000008-hhhhhh'), 'a file, not a run');
  mkdirSync(join(root, '.forja', 'runs', 'not-a-run'));
  const outside = mkdtempSync(join(tmpdir(), 'forja-lessons-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeRun(outside, 'F-1000000000009-iiiiii', { tasks: [] });
  let linked = true;
  try { symlinkSync(join(outside, '.forja', 'runs', 'F-1000000000009-iiiiii'), join(root, '.forja', 'runs', 'F-1000000000009-iiiiii'), 'junction'); }
  catch { linked = false; }
  let result;
  assert.doesNotThrow(() => { result = extractLessons(root); });
  const warned = (run, warning) => result.warnings.some(w => w.run === run && w.warning === warning);
  assert.ok(warned('F-1000000000003-cccccc', 'unfinished_run'));
  assert.ok(warned('F-1000000000004-dddddd', 'malformed_state'));
  assert.ok(warned('F-1000000000005-eeeeee', 'state_file_limit'));
  assert.ok(warned('F-1000000000006-ffffff', 'malformed_state'));
  assert.ok(warned('F-1000000000007-gggggg', 'invalid_ledger_records'));
  assert.ok(warned('F-1000000000007-gggggg', 'malformed_result'));
  assert.ok(warned('F-1000000000007-gggggg', 'check_log_file_limit'));
  assert.ok(warned('F-1000000000008-hhhhhh', 'out_of_project_run'));
  if (linked || process.platform === 'win32') assert.ok(warned('F-1000000000009-iiiiii', 'out_of_project_run'));
  assert.deepEqual(result.ingested, ['F-1000000000001-aaaaaa', 'F-1000000000007-gggggg']);
  // A run that finishes later is ingested by the next extraction.
  writeRun(root, 'F-1000000000003-cccccc', { status: 'done', tasks: [] });
  assert.deepEqual(extractLessons(root).ingested, ['F-1000000000003-cccccc']);
  assert.deepEqual(contentFindings(readFileSync(join(root, ...LESSON_STORE.split('/')))), []);
});

test('a lesson that still has a content finding after redaction is dropped', t => {
  const root = project(t);
  const exported = JSON.stringify({ role: 'user', content: 'private conversation' });
  writeRun(root, 'F-1000000000001-aaaaaa', {
    tasks: [{ id: 'T1', title: 'Leaky', files: [], status: 'done', attempts: 2, files_changed: [] }],
    rows: [row(1, 'review', 'T1', 1), row(2, 'review', 'T1', 2)],
    results: { 1: { status: 'reject', summary: `Pasted ${exported}`, findings: [] }, 2: { status: 'approve', summary: 'ok', findings: [] } },
  });
  const result = extractLessons(root);
  assert.ok(result.warnings.some(w => w.warning === 'lesson_dropped_privacy'));
  assert.equal(readLessonStore(root).lessons.length, 0);
  assert.deepEqual(contentFindings(readFileSync(join(root, ...LESSON_STORE.split('/')))), []);
});

test('forgotten lessons are not re-created and a damaged store is refused, not recounted', t => {
  const root = project(t);
  runA(root);
  extractLessons(root);
  const store = readLessonStore(root);
  const [gone] = byKind(store, 'review_rejection');
  const path = join(root, ...LESSON_STORE.split('/'));
  // The operator forgot one lesson (core lessons forget); the runs are extracted again from scratch.
  writeFileSync(path, JSON.stringify({ ...store, runs: {}, forgotten: [gone.id], lessons: [] }));
  extractLessons(root);
  const after = readLessonStore(root);
  assert.ok(!after.lessons.some(l => l.id === gone.id));
  assert.deepEqual(after.forgotten, [gone.id]);
  assert.equal(after.lessons.length, store.lessons.length - 1);
  writeFileSync(path, '{"version":1');
  assert.throws(() => extractLessons(root), /Lessons store .* is invalid/);
  assert.equal(readFileSync(path, 'utf8'), '{"version":1');
});

test('the extractor has no model, provider, process or network imports', () => {
  const source = readFileSync(new URL('../lib/core/lessons.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.ok(!/child_process|node:https?$|node:net|node:dns|providers|engine|benchmark-provider/.test(name), name);
  assert.equal(existsSync(new URL('../lib/core/lessons.mjs', import.meta.url)), true);
});
