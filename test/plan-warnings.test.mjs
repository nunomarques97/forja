import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRun, drive } from '../lib/core/engine.mjs';
import { planWarnings, planningContract } from '../lib/core/plan-warnings.mjs';

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-plan-warnings-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test']])
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  for (const dir of ['src', 'test', 'docs', 'benchmarks']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}
const check = { command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] };
const task = (over = {}) => ({ id: 'T1', title: 'Return two', criteria: ['value equals 2'], files: ['value.mjs'], risks: [], complexity: 'easy', after: [], checks: [check], ...over });
const audit = () => task({ id: 'audit', title: 'Audit modules A-D and fix the defects found', files: ['src/', 'test/', 'docs/', 'README.md', 'benchmarks'], complexity: 'hard' });

test('a read-heavy task over several whole directories is flagged against the working context budget', (t) => {
  const root = repo(t);
  const run = { limits: { contextTokens: 120000 }, config: {}, tasks: [audit(), task({ id: 'bounded', files: ['src/', 'value.mjs'] })] };
  const warnings = planWarnings(run, root);
  assert.deepEqual(warnings.map((w) => [w.code, w.task]), [['context_scope', 'audit']]);
  assert.match(warnings[0].message, /4 whole directories \(src\/, test\/, docs\/, benchmarks\)/);
  assert.match(warnings[0].message, /about 85000 tokens/);
  assert.match(warnings[0].message, /Split read-heavy work by area/);
  const wide = task({ id: 'wide', title: 'Rename the logger', files: ['src', 'test', 'docs', 'benchmarks'] });
  assert.deepEqual(planWarnings({ limits: {}, config: {}, tasks: [wide] }, root).map((w) => w.task), ['wide']);
  assert.deepEqual(planWarnings({ limits: {}, config: {}, tasks: [task()] }, root), []);
});

test('the planner receives the context contract and plan warnings are logged and reported by status', async (t) => {
  const root = repo(t);
  createRun(root, { goal: 'Audit A-D and fix', provider: 'custom' });
  const lines = [];
  let planning;
  const blocked = await drive(root, {
    log: (line) => lines.push(line),
    providerCall: async (_, options) => {
      const ctx = JSON.parse(options.text);
      if (ctx.phase === 'plan') {
        planning = { ctx, input: options.input };
        return { code: 0, result: { decisions: [], tasks: [audit()] } };
      }
      return { code: 0, result: { status: 'blocked', summary: 'Stop here', findings: [] } };
    },
  });
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(planning.ctx.planning_contract, planningContract(blocked));
  assert.equal(planning.ctx.planning_contract.working_context_tokens_estimate, 85000);
  assert.match(planning.input, /Split audit, review or investigation work over several areas or modules by area/);
  assert.ok(lines.some((line) => /^FORJA plan warning: audit reads 4 whole directories/.test(line)));
  const status = spawnSync(process.execPath, [resolve('bin/forja.mjs'), 'core', 'status', '--project', root], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).plan_warnings.map((w) => w.code), ['context_scope']);
});

test('a later task that needs committed HEAD is flagged with the delivery mode of the run', (t) => {
  const root = repo(t);
  const build = task({ id: 'build' });
  const exporter = task({ id: 'export', title: 'Export the public edition', criteria: ['The export reads committed content (HEAD) and includes the work of earlier tasks.'], after: ['build'] });
  const warnings = planWarnings({ limits: {}, config: {}, tasks: [build, exporter] }, root);
  assert.deepEqual(warnings.map((w) => [w.code, w.task]), [['head_dependency', 'export']]);
  assert.match(warnings[0].message, /no commit happens between tasks; this run has no delivery and creates no commit/);
  const delivered = planWarnings({ limits: {}, config: { delivery: { mode: 'commit' } }, tasks: [build, exporter] }, root);
  assert.match(delivered[0].message, /delivery commit creates at most one commit after the run/);
  const first = task({ id: 'diff', criteria: ['Compare the working tree with HEAD before editing'] });
  assert.deepEqual(planWarnings({ limits: {}, config: {}, tasks: [first] }, root), [], 'the first task sees the starting HEAD');
  assert.deepEqual(planningContract({ limits: {}, config: { delivery: { mode: 'push' } } }).delivery, 'push');
  assert.equal(planningContract({ limits: {}, config: {} }).delivery, 'none');
  assert.equal(planningContract({ limits: {}, config: {} }).commits_during_run, false);
});

test('a git diff --exit-code check in a multi-task plan is flagged as task-local', (t) => {
  const root = repo(t);
  const analysis = task({ id: 'analyse', checks: [{ command: 'git', args: ['diff', '--exit-code', '--', 'src'] }] });
  const warnings = planWarnings({ limits: {}, config: {}, tasks: [analysis, task({ after: ['analyse'] })] }, root);
  assert.deepEqual(warnings.map((w) => [w.code, w.task]), [['snapshot_check', 'analyse']]);
  assert.match(warnings[0].message, /the final regression skips it/);
  assert.deepEqual(planWarnings({ limits: {}, config: {}, tasks: [analysis] }, root), [], 'a single task has no later work');
});

test('the planner is told that no commit happens between tasks', async (t) => {
  const root = repo(t);
  createRun(root, { goal: 'Build then export HEAD', provider: 'custom' });
  let input;
  await drive(root, { log: () => {}, providerCall: async (_, options) => {
    if (JSON.parse(options.text).phase === 'plan') {
      input = options.input;
      return { code: 0, result: { decisions: [], tasks: [task()] } };
    }
    return { code: 0, result: { status: 'blocked', summary: 'Stop here', findings: [] } };
  } });
  assert.match(input, /"planning_contract":\{[^}]*"delivery":"none","commits_during_run":false\}/);
  assert.match(input, /Workers never commit\. .*Without commits_during_run, HEAD stays at the starting commit for the whole run/);
  assert.match(input, /defer them to a later run and say so in decisions/);
});
