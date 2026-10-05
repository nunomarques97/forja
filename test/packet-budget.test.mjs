import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packet } from '../lib/core/context.mjs';
import { PACKET_LIMIT } from '../lib/core/plan-warnings.mjs';
import { REMAINING_CRITERIA_CAP } from '../lib/core/task-scope.mjs';

// A project with enough files and Markdown notes to fill the repository map and
// the knowledge selection, plus a required note that must always stay in full.
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-packet-budget-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  mkdirSync(join(root, 'lib', 'billing'), { recursive: true });
  mkdirSync(join(root, 'docs', 'forja'), { recursive: true });
  for (let i = 0; i < 160; i++)
    writeFileSync(join(root, 'lib', 'billing', `invoice-ledger-reconciliation-module-${String(i).padStart(3, '0')}.mjs`), `export function invoiceLedger${i}() { return ${i}; }\n`);
  for (let i = 0; i < 6; i++)
    writeFileSync(join(root, 'docs', `billing-${i}.md`), `# Invoice ledger ${i}\n\n${'Invoice ledger reconciliation keeps billing totals consistent. '.repeat(30)}\n`);
  writeFileSync(join(root, 'docs', 'forja', 'RULES.md'), '# Rules\n\nInvoice ledger totals are integers in cents.\n');
  writeFileSync(join(root, 'docs', 'forja', 'KNOWLEDGE.json'), JSON.stringify({
    version: 1,
    documents: [{ path: 'docs/forja/RULES.md', required: true }, ...Array.from({ length: 6 }, (_, i) => `docs/billing-${i}.md`)],
  }));
  return root;
}

const criterion = (id, n) => `${id} criterion ${n}: invoice ledger reconciliation ${'keeps every billing total consistent across ledgers and reports '.repeat(14)}`;
const planTask = (n, files) => ({
  id: `T${n}`,
  title: `Invoice ledger step ${n}`,
  criteria: Array.from({ length: 5 }, (_, i) => criterion(`T${n}`, i)),
  files,
  risks: [],
  complexity: 'normal',
  after: n > 1 ? [`T${n - 1}`] : [],
  checks: [{ command: 'node', args: ['--test', `test/step-${n}.test.mjs`] }],
  status: 'todo',
  attempts: 0,
});

// Twelve tasks with long criteria: the odd ones share a file with T1.
function longPlan() {
  const tasks = Array.from({ length: 12 }, (_, i) => planTask(i + 1, i % 2 === 0 ? ['lib/billing/', `test/step-${i + 1}.test.mjs`] : [`lib/other-${i + 1}.mjs`]));
  const run = {
    run_id: 'F-1791000000000-abcdef',
    goal: `Reconcile invoice ledgers. ${'Keep billing totals consistent. '.repeat(40)}`,
    tasks,
    decisions: Array.from({ length: 6 }, (_, i) => `Decision ${i}: ${'keep ledgers append-only '.repeat(10)}`),
    config: { finalChecks: [{ command: 'node', args: ['--test'] }] },
  };
  assert.ok(JSON.stringify(tasks.slice(1).map(x => x.criteria)).length > PACKET_LIMIT, 'the remaining criteria alone exceed the limit');
  return run;
}

const trims = ctx => ctx.sources.filter(s => s.source.startsWith('trimmed ')).map(s => s.source);

test('a 12-task plan with long criteria yields a develop packet under the limit with bounded task_scope', (t) => {
  const root = repo(t);
  const run = longPlan();
  const [current] = run.tasks;
  const ctx = packet({ root, run, task: current, phase: 'develop' });
  assert.ok(ctx.characters <= PACKET_LIMIT, `${ctx.characters} characters`);
  assert.equal(ctx.sources.reduce((n, s) => n + s.characters, 0), ctx.characters);
  const data = JSON.parse(ctx.text);
  assert.deepEqual(data.task.criteria, current.criteria, 'current criteria are never truncated');
  const scope = data.task_scope;
  assert.equal(scope.remaining_tasks.length, 11);
  assert.equal(scope.plan.path, '.forja/runs/F-1791000000000-abcdef/state.json');
  for (const entry of scope.remaining_tasks) {
    const source = run.tasks.find(x => x.id === entry.id);
    assert.equal(entry.title, source.title);
    assert.deepEqual(entry.files, source.files);
    assert.deepEqual(entry.after, source.after);
    const shared = source.files[0] === 'lib/billing/';
    if (!shared) {
      assert.equal('criteria' in entry, false, `${entry.id} shares no file`);
      continue;
    }
    // Capped per task with an ellipsis and a truncation flag.
    assert.ok(entry.criteria.join('').length <= REMAINING_CRITERIA_CAP + 1, entry.id);
    assert.equal(entry.criteria_truncated, true);
    assert.ok(source.criteria[0].startsWith(entry.criteria[0].replace(/…$/, '')));
  }
  // The bounded scope fits without trimming anything else.
  assert.deepEqual(trims(ctx), []);
  assert.ok(data.knowledge.selected.some(k => !k.required && k.text));
  assert.ok(data.repository_map.text.length > 0);
});

test('task_scope size depends on the number of remaining tasks, not on their criteria length', (t) => {
  const root = repo(t);
  const longer = factor => {
    const run = longPlan();
    for (const x of run.tasks.slice(1)) x.criteria = x.criteria.map(c => c.repeat(factor));
    return run;
  };
  const size = run => JSON.stringify(JSON.parse(packet({ root, run, task: run.tasks[0], phase: 'develop' }).text).task_scope).length;
  const base = size(longPlan());
  assert.equal(size(longer(40)), size(longer(20)));
  assert.ok(Math.abs(size(longer(20)) - base) < 200);
  // Each capped entry stays within its cap plus identity and framing.
  assert.ok(base < 11 * (REMAINING_CRITERIA_CAP + 300), `${base} characters`);
});

test('a review packet with feedback and changes degrades optional context in order and keeps the current criteria', (t) => {
  const root = repo(t);
  const run = longPlan();
  const [current] = run.tasks;
  const feedback = { status: 'checks_failed', summary: 'Checks failed', findings: Array.from({ length: 90 }, (_, i) => `finding ${i}: ${'ledger total mismatch in report '.repeat(9)}`) };
  const changes = { files: Array.from({ length: 120 }, (_, i) => `lib/billing/invoice-ledger-reconciliation-module-${String(i).padStart(3, '0')}.mjs`), patch: '.forja/runs/F-1791000000000-abcdef/change.patch' };
  const ctx = packet({ root, run, task: current, phase: 'review', feedback, changes });
  assert.ok(ctx.characters <= PACKET_LIMIT, `${ctx.characters} characters`);
  assert.equal(ctx.sources.reduce((n, s) => n + s.characters, 0), ctx.characters);
  assert.deepEqual(trims(ctx), ['trimmed task_scope.remaining_tasks criteria', 'trimmed knowledge excerpts', 'trimmed repository_map']);
  for (const s of ctx.sources.filter(s => s.source.startsWith('trimmed ')))
    assert.ok(s.characters === 0 && s.trimmed_characters > 0, s.source);
  const data = JSON.parse(ctx.text);
  assert.deepEqual(data.task.criteria, current.criteria);
  assert.deepEqual(data.feedback, feedback);
  assert.deepEqual(data.changes, changes);
  assert.deepEqual(data.decisions, run.decisions);
  assert.equal(data.goal, run.goal);
  // Remaining tasks keep their identity and the pointer to the full plan.
  assert.deepEqual(data.task_scope.remaining_tasks.map(x => Object.keys(x)), Array(11).fill(['id', 'title', 'files', 'after']));
  assert.equal(data.task_scope.plan.path, '.forja/runs/F-1791000000000-abcdef/state.json');
  // Knowledge keeps paths and the required note in full; optional text is gone.
  const required = data.knowledge.selected.find(k => k.required);
  assert.match(required.text, /integers in cents/);
  const optional = data.knowledge.selected.filter(k => !k.required);
  assert.ok(optional.length > 0 && optional.every(k => k.path && !('text' in k) && k.excerpt_omitted));
  assert.equal(data.repository_map.text, '');
  assert.ok(data.repository_map.filesTotal > 0 && data.repository_map.omitted);
});

test('degradation stops at the first step that fits', (t) => {
  const root = repo(t);
  const run = longPlan();
  const changes = { files: Array.from({ length: 60 }, (_, i) => `lib/billing/invoice-ledger-reconciliation-module-${String(i).padStart(3, '0')}.mjs`) };
  const ctx = packet({ root, run, task: run.tasks[0], phase: 'review', feedback: { status: 'rejected', summary: 'x'.repeat(25000), findings: [] }, changes });
  assert.deepEqual(trims(ctx), ['trimmed task_scope.remaining_tasks criteria']);
  const data = JSON.parse(ctx.text);
  assert.ok(data.knowledge.selected.some(k => !k.required && k.text));
  assert.ok(data.repository_map.text.length > 0);
});

test('a packet whose mandatory parts exceed the limit still throws task_packet', (t) => {
  const root = repo(t);
  const run = longPlan();
  const current = run.tasks[0];
  current.criteria = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(c => c.repeat(7000));
  assert.throws(() => packet({ root, run, task: current, phase: 'develop' }), (error) => {
    assert.equal(error.stopCode, 'task_packet');
    assert.match(error.message, /^Task packet for T1 \(develop\) has \d{2},\d{3} characters, over the limit of 48,000 characters after trimming optional context \(task_scope\.remaining_tasks criteria, knowledge excerpts, repository_map\); its mandatory parts alone exceed the limit/);
    assert.match(error.message, /Criteria were not truncated/);
    assert.equal(error.detail.limit, PACKET_LIMIT);
    assert.equal(error.detail.tasks[0].task, 'T1');
    assert.ok(error.characters > PACKET_LIMIT);
    return true;
  });
  // Feedback is mandatory too.
  const small = longPlan();
  assert.throws(() => packet({ root, run: small, task: small.tasks[0], phase: 'review', feedback: { status: 'rejected', summary: 'y'.repeat(50000), findings: [] } }), /mandatory parts alone exceed the limit/);
});
