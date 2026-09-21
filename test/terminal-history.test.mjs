import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { projectStatus, runSummary } from '../lib/projects.mjs';
import { EMPTY_STATE, GUARD_DEAD_GRACE_MS, guardPlan } from '../lib/guard.mjs';

const NOW = Date.parse('2026-09-21T12:00:00.000Z');
const CORE_CREATED = '2026-09-20T12:00:00.000Z';
const LEGACY_STARTED = '2026-09-21T11:00:00.000Z';

function fixture(t, coreStatus, legacy, liveCore = false) {
  const temp = resolve(tmpdir());
  const root = mkdtempSync(join(temp, 'forja-terminal-history-'));
  t.after(() => {
    // Delete only this test's directly owned temporary directory.
    assert.equal(dirname(root), temp);
    assert.match(relative(temp, root), /^forja-terminal-history-[A-Za-z0-9]+$/);
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  });
  const project = { name: 'history-project', path: join(root, 'project') };
  const data = join(root, 'data');
  const core = {
    version: 1,
    run_id: 'F-history-001',
    status: coreStatus,
    tasks: [],
    created_at: CORE_CREATED,
    goal: 'Retained Core history',
  };
  function json(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), 'utf8');
  }
  mkdirSync(data);
  // These are isolated fixture files, never the repository's scheduler state.
  json(join(project.path, '.forja', 'current.json'), core);
  json(join(project.path, 'docs', 'forja', 'RUN.json'), legacy);
  if (liveCore)
    json(join(project.path, '.forja', 'lock.json'), { pid: process.pid });
  return { project, data, core };
}

function legacyRun(status) {
  return {
    run_id: 'R-20260921-ab12',
    status,
    driver: 'runner',
    started_at: LEGACY_STARTED,
    goal: 'Current legacy work',
    visible: true,
  };
}

function assertSelection(f, expected, driver, alive) {
  const observed = projectStatus(f.project, f.data, NOW);
  const summary = runSummary(f.project.path, f.data);
  for (const run of [observed.run, summary]) {
    assert.ok(run, 'a valid run must be selected');
    assert.equal(run.run_id, expected.run_id);
    assert.equal(run.status, expected.status);
    assert.equal(run.driver, driver);
    assert.equal(run.goal, expected.goal);
    assert.equal(run.started_at, expected.created_at ?? expected.started_at);
  }
  assert.deepEqual(summary, observed.run, 'both public readers must agree');
  assert.equal(observed.runnerAlive, alive);
  return { ...f.project, ...observed };
}

test('failed Core yields to running legacy; recovery waits for the full grace period', (t) => {
  const legacy = legacyRun('running');
  const f = fixture(t, 'failed', legacy);
  const selected = assertSelection(f, legacy, 'runner', false);
  assert.equal(selected.run.visible, true);
  const initialState = EMPTY_STATE();
  const first = guardPlan([selected], initialState, NOW);
  assert.deepEqual(first.actions, []);
  assert.deepEqual(first.giveUps, []);
  assert.equal(first.state.projects[f.project.name].run_id, legacy.run_id);
  assert.equal(
    first.state.projects[f.project.name].dead_since,
    new Date(NOW).toISOString(),
  );
  assert.deepEqual(
    initialState,
    EMPTY_STATE(),
    'planning must not mutate its input',
  );

  const before = guardPlan(
    [selected],
    first.state,
    NOW + GUARD_DEAD_GRACE_MS - 1,
  );
  assert.deepEqual(
    before.actions,
    [],
    'one millisecond before grace is too early',
  );
  const after = guardPlan([selected], before.state, NOW + GUARD_DEAD_GRACE_MS);
  assert.deepEqual(
    after.actions,
    [
      {
        name: f.project.name,
        path: f.project.path,
        visible: true,
        attempt: 1,
      },
    ],
    'propose exactly one legacy recovery, preserving visibility',
  );
  assert.deepEqual(after.giveUps, []);
  assert.equal(after.state.projects[f.project.name].run_id, legacy.run_id);
});

test('done Core yields to blocked legacy without proposing recovery', (t) => {
  const legacy = legacyRun('blocked');
  const f = fixture(t, 'done', legacy);
  const selected = assertSelection(f, legacy, 'runner', false);
  // An already elapsed death clock must not make a blocked run recoverable.
  let state = {
    version: 1,
    projects: {
      [f.project.name]: {
        run_id: legacy.run_id,
        dead_since: new Date(NOW - 2 * GUARD_DEAD_GRACE_MS).toISOString(),
      },
    },
  };
  for (const now of [NOW, NOW + GUARD_DEAD_GRACE_MS, NOW + 86_400_000]) {
    const plan = guardPlan([selected], state, now);
    assert.deepEqual(plan.actions, []);
    assert.deepEqual(plan.giveUps, []);
    assert.equal(plan.state.projects[f.project.name].run_id, legacy.run_id);
    assert.equal(plan.state.projects[f.project.name].dead_since, null);
    state = plan.state;
  }
});

test('a malformed legacy object retains valid terminal Core history', (t) => {
  const f = fixture(t, 'done', {
    ...legacyRun('running'),
    status: { invalid: true },
  });
  const selected = assertSelection(f, f.core, 'core', false);
  const plan = guardPlan([selected], EMPTY_STATE(), NOW + GUARD_DEAD_GRACE_MS);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.giveUps, []);
  assert.equal(plan.state.projects[f.project.name].run_id, f.core.run_id);
});

test('a live Core lock retains terminal Core over running legacy and reports runnerAlive', (t) => {
  const f = fixture(t, 'failed', legacyRun('running'), true);
  const selected = assertSelection(f, f.core, 'core', true);
  const plan = guardPlan([selected], EMPTY_STATE(), NOW + GUARD_DEAD_GRACE_MS);
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.giveUps, []);
  assert.equal(plan.state.projects[f.project.name].run_id, f.core.run_id);
});
