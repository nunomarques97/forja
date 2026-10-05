import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditRun, aggregateAudit, audit, findRunDirs, promptParts, streamStats, distribution } from '../tools/efficiency-audit.mjs';
import { decisionMatrix, expandFixture, loadFixtures, normalize, packetSuite, scenarioRun, words } from '../tools/efficiency-bench.mjs';
import { packet, repoMap, PLAN_MAP_CHARACTERS, TASK_MAP_CHARACTERS } from '../lib/core/context.mjs';
import { replay, capMapText, finalRegressionRun, requestSizes, simulateBudget, contextBudgetReplay, developSessions, checkFailureRework } from '../tools/efficiency-replay.mjs';

const FIXTURE = JSON.parse(readFileSync(resolve('test/fixtures/efficiency/audit/run.json'), 'utf8'));
const PRIVATE = ['SECRET', 'PRIVATE', 'secret-project-name', 'D:/', 'D:\\', 'work/a.mjs', 'F-1000000000000', 'Bad Code'];

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'forja-eff-audit-'));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

// <tmp>/<project>/.forja/runs/<id>/ from the JSON fixture.
function materialize(t) {
  const root = tempDir(t);
  const dir = join(root, FIXTURE.project, '.forja', 'runs', FIXTURE.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(FIXTURE.state));
  writeFileSync(join(dir, 'usage.jsonl'), FIXTURE.usage.map((row) => '\n' + JSON.stringify(row) + '\n').join('') + FIXTURE.malformed_usage_line + '\n');
  for (const [id, text] of Object.entries(FIXTURE.prompts)) writeFileSync(join(dir, `call-${id}-prompt.txt`), text);
  for (const [id, value] of Object.entries(FIXTURE.results)) writeFileSync(join(dir, `call-${id}-result.json`), JSON.stringify(value));
  for (const [id, events] of Object.entries(FIXTURE.streams))
    writeFileSync(join(dir, `call-${id}-stream.json`), JSON.stringify({ stdout: events.map((e) => JSON.stringify(e)).join('\n'), stderr: '' }));
  return { root, dir };
}

function treeState(dir, out = {}) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stat = statSync(path);
    if (stat.isDirectory()) treeState(path, out);
    else out[path] = `${stat.mtimeMs}:${stat.size}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  }
  return out;
}

test('the audit parses a run folder into tokens, rotations, retries, reviews, re-plans and waits', (t) => {
  const { dir } = materialize(t);
  const run = auditRun(dir);
  assert.equal(run.ledger_warnings, 1);
  assert.equal(run.invocations, 6, 'the interrupted record of call 5 is replaced by its final result');
  assert.deepEqual(run.by_phase.plan, { invocations: 1, input_tokens: 1000, input_covered: 1, input_from_stream: 0, output_tokens: 50, duration_ms: 1000, model_calls: 2, calls_covered: 1 });
  assert.equal(run.by_phase.develop.input_tokens, 6000 + 500 + 700, 'the context-limit session is measured from its stream');
  assert.equal(run.by_phase.develop.input_from_stream, 1);
  assert.equal(run.by_phase.review.input_tokens, 500);
  assert.deepEqual(run.rotations, { task_total: 1, stalled: 0, context_limit_rows: 1, context_limit_tokens: 6000 });
  assert.deepEqual(run.failures, { timed_out: 0, rate_limited: 0, error: 0, interrupted: 0, tokens: 0 }, 'a context stop is a rotation, not a failure');
  assert.deepEqual(run.reviews, { approve: 1, reject: 1, other: 0, reject_tokens: 300 });
  assert.deepEqual(run.rework, { develop_attempts_after_first: 1, develop_tokens_after_first: 700 });
  assert.deepEqual(run.retries, { automatic: 1, task_total: 1, attempts_after_first: 1 });
  assert.equal(run.replans, 0);
  assert.deepEqual(run.waits.gaps, [5000, 0, 1200000, 1000, 1000]);
  assert.equal(run.waits.long_waits, 1);
  assert.equal(run.waits.long_wait_ms, 1200000);
  assert.equal(run.waits.check_ms, 1500);
  assert.deepEqual(run.sources, { goal: 800, other: 10, repository_map: 600 }, 'an unexpected source label is reported as other');
  assert.deepEqual(run.repeated.by_source, {
    instructions: { characters: 22 + 24 + 22 + 27, repeated_characters: 22 },
    goal: { characters: 36, repeated_characters: 18 },
    phase: { characters: 15, repeated_characters: 0 },
  });
  assert.equal(run.streams.packet_resent_tokens, 500 * 3);
  assert.equal(run.stop_code, 'other');
});

test('stream statistics count top-level model calls, the resent baseline, repeated reads and tool result resend', () => {
  const text = JSON.stringify({ stdout: FIXTURE.streams['2'].map((e) => JSON.stringify(e)).join('\n') });
  const s = streamStats(text);
  assert.equal(s.model_calls, 3, 'duplicate message events and subagent messages are not top-level calls');
  assert.equal(s.subagent_calls, 1);
  assert.equal(s.context_tokens_total, 6000);
  assert.equal(s.baseline_tokens, 1000);
  assert.equal(s.baseline_resent_tokens, 3000);
  assert.equal(s.max_context_tokens, 3000);
  assert.deepEqual(s.tools, { Read: 2, Bash: 2 });
  assert.equal(s.tool_result_characters, 31 + 31 + 2 + 2);
  assert.equal(s.reads, 2);
  assert.equal(s.repeated_reads, 1, 'the same file in another spelling is a repeated read');
  assert.equal(s.repeated_read_characters, 31);
  assert.equal(s.repeated_commands, 1);
  assert.deepEqual(s.tool_result_resent_tokens, { Read: 8 * 2 + 8 * 1, Bash: 1 });
  assert.deepEqual(s.tokens_above, { 100000: 0, 150000: 0, 200000: 0 });
  assert.equal(streamStats('not json at all').model_calls, 0);
  const mcp = { type: 'assistant', message: { id: 'x', usage: {}, content: [{ type: 'tool_use', id: 't', name: 'mcp__private_server__query', input: {} }] } };
  assert.deepEqual(streamStats(JSON.stringify(mcp)).tools, { mcp: 1 }, 'MCP server names stay out of the report');
});

test('prompt parts split instruction lines from the trailing JSON packet', () => {
  assert.deepEqual(promptParts('a\n\nb\n{"goal":"g"}\n'), { instructions: ['a', 'b'], packet: { goal: 'g' } });
  assert.deepEqual(promptParts('only text'), { instructions: ['only text'], packet: null });
  assert.deepEqual(distribution([5, 1, 3]), { n: 3, sum: 9, mean: 3, p50: 3, p90: 5, max: 5 });
});

test('the audit is read-only and its report carries no goal, prompt, path, project or run name', (t) => {
  const { root } = materialize(t);
  const before = treeState(root);
  const found = findRunDirs([root]);
  assert.equal(found.length, 1);
  assert.equal(findRunDirs([join(root, FIXTURE.project)]).length, 1, 'a project root works as well as a folder of projects');
  assert.equal(findRunDirs([root], { days: 1, now: Date.parse('2026-10-05T00:00:00Z') }).length, 0);
  assert.equal(findRunDirs([root], { days: 7, now: Date.parse('2026-10-05T00:00:00Z') }).length, 1);
  const report = audit([root]);
  assert.equal(report.scope.runs, 1);
  assert.equal(report.scope.projects, 1);
  assert.equal(report.tokens.input_tokens_including_cache, 8700);
  assert.equal(report.rotations.context_limit_share_percent, 69);
  assert.equal(report.reviews.rejection_percent, 50);
  assert.equal(report.idle.long_waits, 1);
  assert.deepEqual(report.scope.stop_codes, { other: 1 });
  const cli = spawnSync(process.execPath, ['tools/efficiency-audit.mjs', '--root', root, '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), report);
  const text = spawnSync(process.execPath, ['tools/efficiency-audit.mjs', '--root', root], { encoding: 'utf8', windowsHide: true });
  assert.equal(text.status, 0, text.stderr);
  for (const output of [cli.stdout, text.stdout, JSON.stringify(aggregateAudit([auditRun(found[0].dir)]))])
    for (const secret of PRIVATE) assert.ok(!output.includes(secret), `report leaked ${secret}`);
  assert.deepEqual(treeState(root), before, 'no file was created, changed or touched');
  const missing = spawnSync(process.execPath, ['tools/efficiency-audit.mjs'], { encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--root/);
});

test('benchmark fixtures expand deterministically and prompts normalize machine-specific text', () => {
  assert.equal(words(12, 7), words(12, 7));
  assert.notEqual(words(12, 7), words(12, 8));
  const fixtures = loadFixtures();
  const small = fixtures.find((f) => f.name === 'small-api'), wide = fixtures.find((f) => f.name === 'wide-plan');
  assert.ok(small);
  assert.equal(wide.plan.tasks.length, 10);
  assert.deepEqual(expandFixture(JSON.parse(readFileSync(resolve('test/fixtures/efficiency/wide-plan.json'), 'utf8'))), wide);
  const root = join(tmpdir(), 'forja-eff-bench-abc');
  const text = `${root}\\x ${JSON.stringify(root)} ${root.replace(/\\/g, '/')}/y F-1791143541726-98a37b 2026-10-04T22:20:08.244Z "duration_ms":1234`;
  assert.equal(normalize(text, root), `<root>\\x "<root>" <root>/y F-0000000000000-000000 2000-01-01T00:00:00.000Z "duration_ms":0`);
});

test('packet measurements are identical for the same input and show the trimming order', () => {
  const measured = {};
  for (const fixture of loadFixtures().filter((f) => f.packets)) {
    measured[fixture.name] = packetSuite(fixture);
    assert.deepEqual(packetSuite(fixture), measured[fixture.name], fixture.name);
  }
  const wide = measured['wide-plan'];
  assert.deepEqual(wide.tasks.M0.limits[48000].trimmed, []);
  assert.deepEqual(wide.tasks.M0.limits[24000].trimmed, ['task_scope.remaining_tasks criteria']);
  assert.equal(wide.tasks.M0.limits[12000].stopped, 'task_packet');
  assert.equal(wide.tasks.M0.task_scope.with_criteria, 9, 'tasks sharing lib/ carry their criteria');
  assert.ok(wide.tasks.M0.knowledge.selected > 0);
  // Quality probes of the kept packet changes stay full.
  for (const [name, m] of Object.entries(measured)) {
    assert.equal(m.quality.map_task_files.listed, m.quality.map_task_files.files, name);
    assert.equal(m.quality.knowledge_expected.selected, m.quality.knowledge_expected.expected, name);
  }
  assert.equal(measured['small-api'].quality.knowledge_expected.expected, 3);
  assert.ok(measured['wide-repo'].tasks.M0.sources.repository_map < TASK_MAP_CHARACTERS + 300, 'task packets use the smaller map budget');
  assert.ok(measured['wide-repo'].plan_characters > measured['wide-repo'].tasks.M0.develop_characters, 'the plan packet keeps the larger map');
});

test('scenario runs give the same numbers twice and spend the expected sessions', async () => {
  const [small] = loadFixtures(undefined, 'small-api');
  const reject = await scenarioRun(small, 'review_reject_once');
  assert.deepEqual(await scenarioRun(small, 'review_reject_once'), reject);
  assert.equal(reject.status, 'done');
  assert.deepEqual(reject.sessions, { plan: 1, develop: 4, review: 4 });
  const rotation = await scenarioRun(small, 'context_rotation');
  assert.equal(rotation.rotations, 1);
  assert.deepEqual(rotation.sessions, { plan: 1, develop: 4, review: 3 });
  const retry = await scenarioRun(small, 'output_retry');
  assert.equal(retry.provider_retries, 1);
  const failing = await scenarioRun(small, 'check_fail_once');
  assert.equal(failing.attempts.T1, 2);
  assert.equal(failing.status, 'done');
});

test('the retry and rotation decision matrix is stable', () => {
  const matrix = decisionMatrix();
  assert.deepEqual(matrix, decisionMatrix());
  assert.equal(matrix.cases, 48);
  assert.equal(matrix.retries, 2, 'only develop output/timeout failures with an unused retry are retried');
  assert.deepEqual(matrix.rotation_cases, ['rotations2/used1:ok', 'rotations2/used2:ok', 'rotations2/used3:exhausted', 'rotations0/used1:exhausted']);
});

// ---------- kept efficiency changes (docs/EFFICIENCY.md) ----------

function mapRepo(t) {
  const root = tempDir(t);
  for (let i = 0; i < 120; i++) {
    mkdirSync(join(root, 'lib', 'billing'), { recursive: true });
    writeFileSync(join(root, 'lib', 'billing', `invoice-ledger-module-${String(i).padStart(3, '0')}.mjs`), `export function ledger${i}() {}\n`);
  }
  mkdirSync(join(root, 'zz'), { recursive: true });
  writeFileSync(join(root, 'zz', 'unrelated-target-module-with-a-long-file-name-for-the-test.mjs'), 'export function target() {}\n');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['add', '.'], { cwd: root }).status, 0);
  return root;
}

test('task packets carry a 3,000-character repository map that lists the task files first; the plan map keeps 6,000', (t) => {
  const root = mapRepo(t);
  // The zz/ task file shares no word with the query, so it ranks last lexically.
  const query = 'Invoice ledger billing module';
  const plain = repoMap(root, query, TASK_MAP_CHARACTERS);
  assert.ok(!plain.text.includes('zz/unrelated-target-module-with-a-long-file-name-for-the-test.mjs'), 'without the pin a low-ranked task file falls outside the budget');
  const pinned = repoMap(root, query, TASK_MAP_CHARACTERS, ['zz/unrelated-target-module-with-a-long-file-name-for-the-test.mjs', 'lib/']);
  assert.equal(pinned.text.split('\n')[0], 'zz/unrelated-target-module-with-a-long-file-name-for-the-test.mjs :: target');
  assert.ok(pinned.text.length <= TASK_MAP_CHARACTERS);
  assert.equal(PLAN_MAP_CHARACTERS, 6000);
  assert.ok(repoMap(root, query).text.length > TASK_MAP_CHARACTERS, 'the plan default still fills 6,000 characters');
  const task = { id: 'T1', title: 'Invoice ledger billing module', criteria: ['x'], files: ['zz/unrelated-target-module-with-a-long-file-name-for-the-test.mjs'], risks: [], checks: [], status: 'todo', after: [] };
  const run = { run_id: 'F-1791000000000-abcdef', goal: 'Billing', decisions: [], config: {}, tasks: [task] };
  for (const phase of ['develop', 'review']) {
    const map = JSON.parse(packet({ root, run, task, phase }).text).repository_map;
    assert.ok(map.text.length <= TASK_MAP_CHARACTERS, phase);
    assert.ok(map.text.startsWith('zz/unrelated-target-module'), phase);
    assert.equal(map.filesTotal, 122);
  }
  const plan = JSON.parse(packet({ root, run: { ...run, tasks: [] }, task: null, phase: 'plan' }).text).repository_map;
  assert.ok(plan.text.length > TASK_MAP_CHARACTERS && plan.text.length <= PLAN_MAP_CHARACTERS);
});

test('the packet replay measures candidates on recorded packets, weighted by model calls, without leaking or writing', (t) => {
  const root = tempDir(t);
  const dir = join(root, 'secret-project-name', '.forja', 'runs', 'F-1000000000000-abcdef');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ status: 'done', created_at: '2026-10-01T00:00:00Z', tasks: [] }));
  const mapLines = [...Array.from({ length: 200 }, (_, i) => `lib/private/module-${String(i).padStart(3, '0')}.mjs :: fn${i}`), 'work/a.mjs :: SECRET, firstLongSymbolName, secondLongSymbolName, thirdLongSymbolName'];
  const develop = {
    goal: 'SECRET-GOAL-TEXT', phase: 'develop',
    task: { id: 'T1', title: 'PRIVATE title', criteria: ['x'], files: ['work/a.mjs'] },
    task_scope: { remaining_tasks: [{ id: 'T2', title: 't', criteria: ['c'.repeat(1000)], files: ['work/a.mjs'], after: [] }] },
    repository_map: { text: mapLines.join('\n') },
    knowledge: { selected: [{ path: 'docs/a.md', start: 1, text: 'k'.repeat(500), score: 4 }, { path: 'docs/b.md', start: 1, text: 'k'.repeat(300), score: 1 }] },
  };
  const review = { ...develop, phase: 'review' };
  writeFileSync(join(dir, 'call-1-prompt.txt'), `RULES\n${JSON.stringify(develop)}`);
  writeFileSync(join(dir, 'call-2-prompt.txt'), `RULES\n${JSON.stringify(review)}`);
  writeFileSync(join(dir, 'usage.jsonl'), [{ id: 1, phase: 'develop', provider: 'claude', calls: 3 }, { id: 2, phase: 'review', provider: 'claude', calls: 2 }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const before = treeState(root);
  const report = replay([root]);
  assert.equal(report.packets, 2);
  assert.equal(report.calls_known, 2);
  const map = report.candidates.map_3000_pinned;
  const mapSaved = JSON.stringify(mapLines.join('\n')).length - JSON.stringify(capMapText([mapLines.at(-1), ...mapLines.slice(0, -1)].join('\n'), 3000)).length;
  assert.equal(map.characters, 2 * mapSaved);
  assert.equal(map.resent_tokens, Math.ceil((mapSaved * 3 + mapSaved * 2) / 4), 'savings are weighted by the calls of each session');
  assert.deepEqual(map.quality.task_files_in_map, { before: 2, after: 2 }, 'the pinned task file stays listed');
  assert.deepEqual(report.candidates.map_3000_work.quality.task_files_in_map, { before: 2, after: 0 }, 'a plain cut drops the low-ranked task file');
  assert.deepEqual(report.candidates.scope_cap_600.quality.sharing_tasks_complete, { before: 2, after: 0 });
  assert.equal(report.candidates.review_no_map.affected_packets, 1, 'only the review packet loses its map');
  assert.deepEqual(report.candidates.knowledge_cut_05.quality.best_knowledge_chunk, { before: 2, after: 2 });
  assert.equal(report.candidates.knowledge_cut_05.characters, 2 * (JSON.stringify(develop.knowledge.selected).length - JSON.stringify(develop.knowledge.selected.slice(0, 1)).length));
  const cli = spawnSync(process.execPath, ['tools/efficiency-replay.mjs', '--root', root, '--json'], { encoding: 'utf8', windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), report);
  const text = spawnSync(process.execPath, ['tools/efficiency-replay.mjs', '--root', root], { encoding: 'utf8', windowsHide: true });
  for (const output of [cli.stdout, text.stdout])
    for (const secret of PRIVATE) assert.ok(!output.includes(secret), `report leaked ${secret}`);
  assert.deepEqual(treeState(root), before, 'no file was created, changed or touched');
  assert.equal(spawnSync(process.execPath, ['tools/efficiency-replay.mjs'], { encoding: 'utf8', windowsHide: true }).status, 2);
});

// A Git project with three empty modules; a check that counts its runs in a
// file outside the project (checks may write only to temporary output).
function checkRepo(t) {
  const root = tempDir(t);
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test']])
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `${name}.mjs`), 'export const done = false;\n');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  const counter = join(tempDir(t), 'runs.txt');
  writeFileSync(counter, '');
  const shared = { command: process.execPath, args: ['-e', `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x')`] };
  const own = (name) => ({ command: process.execPath, args: ['--input-type=module', '-e', `import {done} from './${name}.mjs'; if (done !== true) process.exit(1)`] });
  const step = (id, name, checks, after) => ({ id, title: `Finish ${name}`, criteria: [`${name} is done`], files: [`${name}.mjs`], risks: [], complexity: 'easy', after, checks });
  return { root, counter, shared, own, step };
}
const finish = (root) => async (_, o) => {
  if (o.readOnly) return { code: 0, result: { status: 'approve', summary: 'Approved', findings: [] }, duration_ms: 1, usage: null };
  const name = JSON.parse(o.text).task.files[0];
  writeFileSync(join(root, name), 'export const done = true;\n');
  return { code: 0, result: { status: 'ready_for_validation', summary: 'Implemented', findings: [] }, duration_ms: 1, usage: null };
};

test('the final regression reuses an identical check already passed on the same tree and re-runs it on another tree', async (t) => {
  const { createRun, drive } = await import('../lib/core/engine.mjs');
  // Reused from the validation that accepted the final task (same tree).
  const one = checkRepo(t);
  createRun(one.root, { goal: 'Finish a and b', plan: { decisions: [], tasks: [one.step('T1', 'a', [one.shared], []), one.step('T2', 'b', [one.own('b'), one.shared], ['T1'])] } });
  const first = await drive(one.root, { log: () => {}, providerCall: finish(one.root) });
  assert.equal(first.status, 'done');
  assert.equal(readFileSync(one.counter, 'utf8').length, 2, 'T1 and T2 validation only; no final re-run');
  assert.deepEqual(first.tasks[0].finalValidation, [{ command: one.shared.command, args: one.shared.args, skipped: 'same_tree_passed', reused: 'T2 validation', passed: true }]);
  // The final task does not run the shared check: T1 runs it again on the
  // final tree (the tree changed since it passed), T2 then reuses that run.
  const two = checkRepo(t);
  createRun(two.root, { goal: 'Finish a, b and c', plan: { decisions: [], tasks: [
    two.step('T1', 'a', [two.shared], []), two.step('T2', 'b', [two.shared], ['T1']), two.step('T3', 'c', [two.own('c')], ['T2'])] } });
  const second = await drive(two.root, { log: () => {}, providerCall: finish(two.root) });
  assert.equal(second.status, 'done');
  assert.equal(readFileSync(two.counter, 'utf8').length, 3, 'T1, T2 validation and one final run on the final tree');
  assert.equal(second.tasks[0].finalValidation.length, 1);
  assert.equal(second.tasks[0].finalValidation[0].passed, true);
  assert.equal(second.tasks[0].finalValidation[0].skipped, undefined, 'a pass on an earlier tree is not reused');
  assert.deepEqual(second.tasks[1].finalValidation, [{ command: two.shared.command, args: two.shared.args, skipped: 'same_tree_passed', reused: 'T1 final check 1', passed: true }]);
  assert.equal(second.tasks[2].finalValidation, undefined, 'the final task is validated on the final tree');
});

test('the final regression replay counts checks already passed on the same tree, only in single-pass runs', () => {
  const v = (command, ms, passed = true) => ({ command, args: [], duration_ms: ms, passed });
  const done = {
    status: 'done', finalCheckTaskId: 'T3',
    tasks: [
      { id: 'T1', finalValidation: [v('own1', 5), v('suite', 100), v('lint', 10)] },
      { id: 'T2', finalValidation: [v('own2', 5), v('suite', 100), { command: 'git', args: ['diff'], skipped: 'snapshot_bound', passed: true }] },
      { id: 'T3', validated_tree: 'x', validation: [v('own3', 5), v('lint', 10)] },
    ],
  };
  assert.deepEqual(finalRegressionRun(done), { runs: 1, single_pass_runs: 1, checks: 5, check_ms: 220, repeated_in_pass: 1, repeated_in_pass_ms: 100, repeated_final_task: 1, repeated_final_task_ms: 10 });
  const repaired = { ...done, tasks: [{ id: 'T1', finalValidation: [v('suite', 100), v('suite', 100, false)] }] };
  assert.deepEqual(finalRegressionRun(repaired), { runs: 1, single_pass_runs: 0, checks: 0, check_ms: 0, repeated_in_pass: 0, repeated_in_pass_ms: 0, repeated_final_task: 0, repeated_final_task_ms: 0 });
  assert.equal(finalRegressionRun(null).runs, 0);
});

// ---------- calls candidates measured without a code change ----------

test('the context budget replay cuts sessions at the budget, adds the re-orientation and counts blocking risks', () => {
  const sizes = [10, 50, 90, 130, 170];
  // Cut before 130 (context 90 dropped to 10 + 20) and again before 170.
  assert.deepEqual(simulateBudget(sizes, 100, { calls: 2, growth: 20 }), { actual: 450, simulated: 390, cuts: 2 });
  assert.deepEqual(simulateBudget(sizes, 200, { calls: 2, growth: 20 }), { actual: 450, simulated: 450, cuts: 0 });
  assert.deepEqual(simulateBudget(sizes, 100, { calls: 2, growth: 95 }), { actual: 450, simulated: 450, cuts: 0 }, 'no cut when a fresh session would start above the budget');
  const big = Array.from({ length: 40 }, (_, i) => 30000 + i * 10000); // up to 420k
  const session = (extra) => ({ taskKey: 'r\0T1', limit: 300000, rotationBudget: 2, taskRotations: 0, sizes: big, firstEdit: null, afterContextLimit: false, ...extra });
  const report = contextBudgetReplay([
    session({ afterContextLimit: true, firstEdit: 5, sizes: [30000, 40000, 50000, 60000, 70000] }),
    session({}),
  ]);
  assert.deepEqual(report.reorientation, { sessions: 1, calls: 4, growth: 40000 });
  const b120 = report.budgets[120000], b200 = report.budgets[200000];
  assert.equal(b200.sessions_affected, 1);
  assert.ok(b200.saved_tokens > 0 && b200.simulated_tokens < b200.actual_tokens);
  assert.ok(b120.extra_rotations > b200.extra_rotations, 'a lower budget rotates more often');
  assert.equal(b120.tasks_over_rotation_budget, 1, 'more rotations than the run allows would block');
  assert.equal(b120.sessions_at_streak_limit, 1);
  assert.equal(contextBudgetReplay([session({ limit: 120000 })]).budgets[120000].sessions_affected, 0, 'a run already at the budget is unaffected');
});

test('develop sessions record request sizes, the first edit and check-log reads, and mark rework after failed checks', (t) => {
  const assistant = (id, size, uses = [], extra = {}) => ({ type: 'assistant', ...extra, message: { id, usage: { input_tokens: size, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: uses.map((u, i) => ({ type: 'tool_use', id: `${id}-${i}`, ...u })) } });
  const stream = (events) => JSON.stringify({ stdout: events.map((e) => JSON.stringify(e)).join('\n'), stderr: '' });
  const rework = stream([
    assistant('m1', 100, [{ name: 'Read', input: { file_path: '.forja/runs/F-1/T1-a1-check-0.log' } }]),
    assistant('m1', 100),
    assistant('s1', 999, [], { parent_tool_use_id: 'x' }),
    assistant('m2', 200, [{ name: 'Edit', input: { file_path: 'a.mjs' } }]),
  ]);
  assert.deepEqual(requestSizes(rework), { sizes: [100, 200], firstEdit: 2, firstLogRead: 1 });
  const dir = tempDir(t);
  const rows = [
    { id: 1, phase: 'develop', task: 'T1', provider: 'claude', result: 'returned' },
    { id: 2, phase: 'develop', task: 'T1', provider: 'claude', result: 'returned' },
    { id: 3, phase: 'review', task: 'T1', provider: 'claude', result: 'returned' },
    { id: 4, phase: 'develop', task: 'T1', provider: 'claude', result: 'returned' },
  ];
  writeFileSync(join(dir, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const id of [1, 2, 4]) writeFileSync(join(dir, `call-${id}-stream.json`), id === 2 ? rework : stream([assistant(`a${id}`, 50)]));
  for (const id of [1, 2]) writeFileSync(join(dir, `call-${id}-result.json`), JSON.stringify({ status: 'ready_for_validation' }));
  writeFileSync(join(dir, 'call-3-result.json'), JSON.stringify({ status: 'reject' }));
  const sessions = developSessions(dir, { limits: { contextTokens: 300000, rotations: 2 }, tasks: [{ id: 'T1', rotations: 0 }] }, 'run');
  assert.deepEqual(sessions.map((s) => s.afterCheckFailure), [false, true, false], 'a review between sessions is a rejection, not a failed check');
  assert.deepEqual(checkFailureRework(sessions), { sessions: 1, read_log: 1, read_on_first_call: 1, first_read_call_p50: 1, calls_p50: 2 });
});

test('the live A/B off arm undoes only the kept map call, and the padded projects make the arms differ', async (t) => {
  const { MAP_CHANGE, buildOffCopy, materialize: build, paddingFiles, undoMapChange } = await import('../tools/efficiency-live.mjs');
  const { loadTasks } = await import('../tools/local-bakeoff.mjs');
  const source = readFileSync(resolve('lib/core/context.mjs'), 'utf8');
  const off = undoMapChange(source);
  assert.equal(off.split(MAP_CHANGE.off).length, 2);
  assert.ok(!off.includes('TASK_MAP_CHARACTERS, task.files'));
  assert.equal(off.length, source.replace(/\r\n/g, '\n').length - MAP_CHANGE.on.length + MAP_CHANGE.off.length);
  assert.throws(() => undoMapChange(off), /exactly once/);
  assert.throws(() => undoMapChange(source + '\n' + MAP_CHANGE.on), /exactly once/);

  const padding = paddingFiles();
  assert.deepEqual(paddingFiles(), padding);
  assert.equal(Object.keys(padding).length, 150);
  const tasks = loadTasks().filter((task) => ['duration-fix', 'paginate-regression', 'coupon-feature'].includes(task.id));
  for (const task of tasks)
    for (const query of task.plan.tasks.map((x) => `${x.title} ${x.files.join(' ')}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && w !== 'mjs')))
      for (const path of Object.keys(padding)) assert.ok(!query.some((w) => path.includes(w)), `${path} matches the ${task.id} query`);
  for (const path of Object.keys(padding)) assert.ok(!/(^|\/)test\/|[.\-_]test\.m?js$|(^|\/)test[-.]|token|secret/.test(path), path);

  const dir = tempDir(t);
  const copy = buildOffCopy(join(dir, 'forja-off'));
  assert.notEqual(copy.context_on_sha256, copy.context_off_sha256);
  assert.equal(readFileSync(join(dir, 'forja-off', 'lib/core/engine.mjs'), 'utf8'), readFileSync(resolve('lib/core/engine.mjs'), 'utf8'));
  const task = tasks.find((x) => x.id === 'paginate-regression'), planned = task.plan.tasks[0];
  const project = join(dir, 'project');
  build(task, project, padding);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' }).stdout.trim(), '');
  const query = `${planned.title} ${planned.files.join(' ')}`;
  const on = repoMap(project, query, TASK_MAP_CHARACTERS, planned.files), before = repoMap(project, query);
  assert.ok(on.text.length <= 3000 && before.text.length > 5000, `${on.text.length} / ${before.text.length}`);
  for (const file of planned.files) assert.ok(on.text.split('\n').some((line) => line.split(' :: ')[0] === file), file);
});

test('the live A/B profile stays local and the schedule alternates the first arm of each pair', async () => {
  const { liveProfile, schedule } = await import('../tools/efficiency-live.mjs');
  const profile = liveProfile();
  assert.equal(profile.maxCloudSessions, 0);
  assert.equal(profile.maxSessions, 4);
  for (const route of Object.values(profile.routes)) assert.equal(route.localProvider, 'ollama');
  const local = { maxCloudSessions: 0, routes: { develop: { provider: 'kilo', localProvider: 'ollama', model: 'm' } } };
  assert.throws(() => liveProfile({ ...local, maxCloudSessions: 1 }), /local models only/);
  assert.throws(() => liveProfile({ ...local, escalation: { route: { provider: 'claude' } } }), /local models only/);
  assert.throws(() => liveProfile({ ...local, routes: { review: { provider: 'claude' } } }), /route review/);
  const runs = schedule(['a', 'b'], 2);
  assert.deepEqual(runs.map((r) => r.id), ['a:r1:on', 'a:r1:off', 'b:r1:off', 'b:r1:on', 'a:r2:on', 'a:r2:off', 'b:r2:off', 'b:r2:on']);
});

test('the live A/B summary pairs arms and applies the fixed verdict rules', async () => {
  const { summarizeLive, median, runMetrics } = await import('../tools/efficiency-live.mjs');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  const metrics = runMetrics([{ phase: 'develop', calls: 10, input_tokens: 1000, output_tokens: 50, duration_ms: 5 }, { phase: 'review', calls: 4, input_tokens: 400, output_tokens: 20, duration_ms: 5, status: 'done', follow_up: true }],
    { prompt_characters: 1, map_characters: 2, map_characters_max: 2 });
  assert.deepEqual({ sessions: metrics.sessions, calls: metrics.calls, input: metrics.input_tokens, verdicts: metrics.review_verdicts, follow_ups: metrics.follow_ups }, { sessions: 2, calls: 14, input: 1400, verdicts: ['done'], follow_ups: 1 });
  const run = (pair, arm, input, calls, passed) => ({ kind: 'run', status: 'done', pair, arm, duration_ms: 1000, acceptance: { passed, own_tests: passed },
    metrics: { sessions: 2, calls, input_tokens: input, output_tokens: 1, provider_ms: 1, map_characters_max: arm === 'on' ? 3000 : 6000 } });
  const confirms = summarizeLive([run('a', 'on', 900, 10, true), run('a', 'off', 1000, 10, true), run('b', 'off', 2000, 20, false), run('b', 'on', 1900, 20, false), run('c', 'on', 1, 1, true)]);
  assert.equal(confirms.paired.pairs, 2);
  assert.equal(confirms.arms.on.runs, 3);
  assert.equal(confirms.paired.median_input_tokens, -100);
  assert.equal(confirms.verdict, 'confirms');
  assert.equal(summarizeLive([run('a', 'on', 900, 10, false), run('a', 'off', 1000, 10, true), run('b', 'on', 900, 10, true), run('b', 'off', 1000, 10, true)]).verdict, 'contradicts');
  assert.equal(summarizeLive([run('a', 'on', 1100, 10, true), run('a', 'off', 1000, 10, true), run('b', 'on', 1100, 10, true), run('b', 'off', 1000, 10, true)]).verdict, 'contradicts');
  assert.equal(summarizeLive([run('a', 'on', 900, 10, true), run('a', 'off', 1000, 10, true)]).verdict, 'inconclusive');
  assert.equal(summarizeLive([run('a', 'on', 900, 5, true), run('a', 'off', 1000, 10, true), run('b', 'on', 900, 5, true), run('b', 'off', 1000, 10, true)]).verdict, 'inconclusive');
});

test('the live A/B reads the first request of each session from the Kilo stream', async (t) => {
  const { sessionBaselines } = await import('../tools/efficiency-live.mjs');
  const dir = tempDir(t);
  assert.deepEqual(sessionBaselines(dir), []);
  writeFileSync(join(dir, 'usage.jsonl'), ['{"id":1,"phase":"develop"}', 'not json', '{"id":2,"phase":"review"}', '{"id":3,"phase":"review"}', ''].join('\n'));
  const step = (input, read) => JSON.stringify({ type: 'step_finish', part: { tokens: { input, output: 5, cache: { read, write: 0 } } } });
  writeFileSync(join(dir, 'call-1-stream.json'), JSON.stringify({ stdout: ['{"type":"step_start"}', 'noise', step(11013, 2270), step(228, 13327)].join('\n'), stderr: '' }));
  writeFileSync(join(dir, 'call-2-stream.json'), JSON.stringify({ stdout: step(9000, 0), stderr: '' }));
  assert.deepEqual(sessionBaselines(dir), [{ id: 1, phase: 'develop', tokens: 13283 }, { id: 2, phase: 'review', tokens: 9000 }]);
});
