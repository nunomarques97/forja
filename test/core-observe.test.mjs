import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unwatchFile,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coreObservation, coreAlive } from '../lib/core/observe.mjs';
import { coreSnapshot } from '../viewer/core-api.mjs';
import { guardPlan, EMPTY_STATE, GUARD_DEAD_GRACE_MS } from '../lib/guard.mjs';
import { launchCore } from '../lib/spawn-runner.mjs';
import { upsertProject, projectStatus, runSummary } from '../lib/projects.mjs';
import { renderProject } from '../viewer/assets/core.js';
import { startServer } from '../viewer/server.mjs';
import { once } from 'node:events';
import { isRunnerCmd, planKillTree } from '../lib/up.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-observe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    data = join(root, 'data');
  mkdirSync(join(project, '.forja/runs/F-123-ab'), { recursive: true });
  const state = {
    version: 1,
    run_id: 'F-123-ab',
    status: 'running',
    provider: 'claude',
    goal: '<script>bad()</script>',
    invocations: 2,
    tasks: [
      {
        id: 'fix',
        title: 'Repair paging',
        status: 'review',
        attempts: 2,
        rotations: 0,
        checks: [{}],
        validation: [{ passed: true }],
      },
    ],
  };
  const save = () =>
    writeFileSync(join(project, '.forja/current.json'), JSON.stringify(state));
  save();
  upsertProject({ name: 'Project', path: project }, data);
  return { root, project, data, state, save };
}

test('Core projection attributes partial usage and never emits raw evidence or paths', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.project, '.forja/runs/F-123-ab/usage.jsonl'),
    JSON.stringify({
      id: 1,
      phase: 'develop',
      task: 'fix',
      attempt: 1,
      provider: 'claude',
      model: 'test',
      prompt: 'PRIVATE PROMPT',
      evidence: f.root,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cached_input_tokens: 30,
        output_tokens: 4,
        secret: 'PRIVATE USAGE',
      },
    }) + '\n{"id":',
  );
  const snap = coreSnapshot(f.data),
    c = snap.projects[0].core;
  assert.equal(c.usage.totals.input_tokens_including_cache, 60);
  assert.equal(c.usage.totals.invocations, 2);
  assert.equal(c.usage.totals.input_covered_invocations, 1);
  assert.equal(c.ledger_warnings, 1);
  assert.equal(c.tasks[0].checks_passed, 1);
  assert.doesNotMatch(JSON.stringify(snap), /PRIVATE|forja-observe-/);
  assert.doesNotMatch(renderProject(snap.projects[0]), /<script>/);
  assert.match(renderProject(snap.projects[0]), /&lt;script&gt;/);
});

test('validation_summary counts latest records strictly and reports tasks without records', (t) => {
  const f = fixture(t);
  f.state.tasks = [
    {
      id: 'mixed',
      title: 'Mixed',
      status: 'done',
      attempts: 1,
      rotations: 0,
      checks: [{}, {}],
      validation: [{ passed: true }, { passed: false }, { passed: 'true' }, null, {}],
      review: { status: 'approve' },
    },
    { id: 'empty', validation: [] },
    {},
    { id: 'invalid', checks: 'abc', validation: 'invalid' },
    { id: 'nullish', validation: [{ passed: null }, { passed: 1 }] },
  ];
  f.save();
  const c = coreObservation(f.project, { details: true });
  assert.equal(c.error, undefined);
  assert.deepEqual(c.validation_summary, {
    passed: 1,
    failed: 1,
    unknown: 5,
    tasks_without_records: 3,
  });
  assert.deepEqual(Object.keys(c.validation_summary), ['passed', 'failed', 'unknown', 'tasks_without_records']);
  assert.deepEqual(c.tasks[0], {
    id: 'mixed',
    title: 'Mixed',
    status: 'done',
    attempts: 1,
    rotations: 0,
    checks_total: 5,
    checks_passed: 1,
    review: 'approve',
  });
  assert.deepEqual(c.tasks.map((x) => [x.checks_total, x.checks_passed]), [[5, 1], [0, 0], [0, 0], [0, 0], [2, 0]]);

  f.state.tasks = [{ validation: [{ passed: true }, { passed: false }, { passed: 'true' }, null, {}] }, { validation: [] }, {}, { validation: 'invalid' }];
  f.save();
  assert.deepEqual(coreObservation(f.project, { details: true }).validation_summary, {
    passed: 1,
    failed: 1,
    unknown: 3,
    tasks_without_records: 3,
  });
});

test('validation_summary is all zeros for zero tasks and absent from brief and error projections', (t) => {
  const f = fixture(t);
  f.state.tasks = [];
  f.save();
  const detailed = coreObservation(f.project, { details: true });
  assert.deepEqual(detailed.validation_summary, { passed: 0, failed: 0, unknown: 0, tasks_without_records: 0 });
  assert.deepEqual(detailed.tasks, []);
  assert.equal('validation_summary' in coreObservation(f.project), false);
  writeFileSync(join(f.project, '.forja/current.json'), '{');
  const error = coreObservation(f.project, { details: true });
  assert.match(error.error, /unreadable/);
  assert.equal('validation_summary' in error, false);
});

test('Core snapshot exposes only validation counts, never commands, logs, paths or output', (t) => {
  const f = fixture(t);
  f.state.tasks[0].validation = [
    { passed: false, command: 'PRIVATE_SENTINEL', log: 'PRIVATE_SENTINEL', output: 'PRIVATE_SENTINEL', path: 'PRIVATE_SENTINEL', args: ['PRIVATE_SENTINEL'] },
    { passed: true, stdout: 'PRIVATE_SENTINEL', stderr: 'PRIVATE_SENTINEL' },
  ];
  f.state.tasks[0].checks = [{ command: 'PRIVATE_SENTINEL', args: ['PRIVATE_SENTINEL'] }];
  f.save();
  const snap = coreSnapshot(f.data),
    c = snap.projects[0].core;
  assert.deepEqual(c.validation_summary, { passed: 1, failed: 1, unknown: 0, tasks_without_records: 0 });
  assert.equal(c.tasks[0].checks_passed, 1);
  assert.equal(c.tasks[0].checks_total, 2);
  assert.doesNotMatch(JSON.stringify(snap), /PRIVATE_SENTINEL/);
  assert.doesNotMatch(renderProject(snap.projects[0]), /PRIVATE_SENTINEL/);
});

test('Core snapshot counts only existing projects with absent Core state', (t) => {
  const f = fixture(t);
  const legacy = join(f.root, 'legacy-private-name');
  const corrupt = join(f.root, 'corrupt-core');
  const unreadable = join(f.root, 'unreadable-core');
  const missing = join(f.root, 'missing-project');
  mkdirSync(legacy, { recursive: true });
  mkdirSync(join(corrupt, '.forja'), { recursive: true });
  mkdirSync(join(unreadable, '.forja/current.json'), { recursive: true });
  mkdirSync(missing, { recursive: true });
  upsertProject({ name: 'Legacy Secret', path: legacy }, f.data);
  upsertProject({ name: 'Broken Core', path: corrupt }, f.data);
  upsertProject({ name: 'Unreadable Core', path: unreadable }, f.data);
  upsertProject({ name: 'Gone Project', path: missing }, f.data);
  writeFileSync(join(corrupt, '.forja/current.json'), '{');
  rmSync(missing, { recursive: true, force: true });

  const snap = coreSnapshot(f.data);
  assert.equal(snap.legacy_only_projects, 1);
  assert.equal(Number.isSafeInteger(snap.legacy_only_projects), true);
  assert.deepEqual(snap.projects.map(p => p.name), ['Broken Core', 'Project', 'Unreadable Core']);
  assert.match(snap.projects[0].core.error, /unreadable/);
  assert.match(snap.projects[2].core.error, /unreadable/);
  assert.doesNotMatch(JSON.stringify(snap), /Legacy Secret|legacy-private-name|Gone Project|missing-project/);
});

test('Core snapshot reports safe zero metadata for an empty registry and preserves registry errors', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forja-observe-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(coreSnapshot(root).projects, []);
  assert.equal(coreSnapshot(root).legacy_only_projects, 0);
  writeFileSync(join(root, 'projects.json'), '{');
  assert.deepEqual(coreSnapshot(root), { ok: false, error: 'Project registry is unreadable.' });
});

test('Core lock protects live orphan and corrupt state does not fall back to legacy', (t) => {
  const f = fixture(t),
    lock = join(f.project, '.forja/lock.json');
  writeFileSync(lock, JSON.stringify({ pid: 10, child: 11 }));
  assert.equal(
    coreAlive(f.project, (pid) => pid === 11),
    true,
  );
  assert.equal(
    coreAlive(f.project, () => false),
    false,
  );
  writeFileSync(lock, '{');
  assert.equal(
    coreAlive(f.project, () => false),
    true,
  );
  writeFileSync(join(f.project, '.forja/current.json'), '{');
  assert.match(coreObservation(f.project).error, /unreadable/);
  assert.deepEqual(projectStatus({ path: f.project }), {
    run: null,
    runnerAlive: true,
  });
});

test('guard uses existing grace/caps for Core and never retries a blocked task', (t) => {
  const f = fixture(t),
    p = { name: 'Project', path: f.project, ...coreObservation(f.project) };
  const first = guardPlan([p], EMPTY_STATE(), 1000);
  const second = guardPlan([p], first.state, 1000 + GUARD_DEAD_GRACE_MS);
  assert.equal(second.actions.length, 1);
  assert.equal(second.actions[0].driver, 'core');
  p.run.status = 'blocked';
  assert.equal(guardPlan([p], second.state, 9999999).actions.length, 0);
  p.run.status = 'running';
  p.runnerAlive = true;
  assert.equal(guardPlan([p], second.state, 9999999).actions.length, 0);
});

test('retained terminal Core history does not hide a later legacy run from status or guard', (t) => {
  const f = fixture(t);
  f.state.status = 'done';
  f.state.created_at = '2026-09-20T10:00:00.000Z';
  f.save();
  mkdirSync(join(f.project, 'docs/forja'), { recursive: true });
  const legacy = {
    run_id: 'R-later',
    status: 'running',
    driver: 'runner',
    started_at: '2026-09-21T10:00:00.000Z',
  };
  const saveLegacy = () =>
    writeFileSync(
      join(f.project, 'docs/forja/RUN.json'),
      JSON.stringify(legacy),
    );
  saveLegacy();
  const status = projectStatus({ path: f.project }, f.data);
  assert.equal(status.run.run_id, 'R-later');
  assert.equal(status.run.driver, 'runner');
  assert.equal(runSummary(f.project, f.data).run_id, 'R-later');
  const project = { name: 'Project', path: f.project, ...status };
  const first = guardPlan([project], EMPTY_STATE(), 1000);
  assert.deepEqual(
    guardPlan([project], first.state, 1000 + GUARD_DEAD_GRACE_MS).actions,
    [{ name: 'Project', path: f.project, visible: false, attempt: 1 }],
  );
  legacy.status = 'finished';
  saveLegacy();
  assert.equal(runSummary(f.project, f.data).run_id, 'R-later');
  legacy.started_at = '2026-09-19T10:00:00.000Z';
  saveLegacy();
  assert.equal(runSummary(f.project, f.data).driver, 'core');
  legacy.status = 'running';
  saveLegacy();
  f.state.status = 'blocked';
  f.save();
  assert.equal(runSummary(f.project, f.data).driver, 'core');
});

test('Core recovery launch uses argv and strips inherited runner/provider session', (t) => {
  const f = fixture(t);
  let call;
  const pid = launchCore({
    dataDir: f.data,
    forjaRoot: f.root,
    project: { name: 'Project', path: f.project },
    spawnRunner: (...args) => {
      call = args;
      return { pid: 123 };
    },
  });
  assert.equal(pid, 123);
  assert.deepEqual(call[1], [
    join(f.root, 'bin/forja.mjs'),
    'core',
    'resume',
    '--expected-run',
    'F-123-ab',
  ]);
  assert.equal(call[2].cwd, f.project);
  assert.equal(call[2].env.CLAUDECODE, undefined);
  assert.equal(call[2].env.FORJA_PROJECT_ROOT, undefined);
});

test('Core viewer uses existing authentication and refuses legacy launch on a Core project', async (t) => {
  const f = fixture(t),
    server = startServer({
      dataDir: f.data,
      port: 0,
      noWatchdog: true,
      spawnRunner: () => ({ pid: 123 }),
    });
  await once(server.server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.server.address().port}`;
    assert.equal((await fetch(base + '/api/core')).status, 401);
    assert.match(await (await fetch(base + '/core')).text(), /login/);
    const headers = { Cookie: `forja_k=${server.token}` };
    for (const route of ['/', '/core', '/m', '/m/']) {
      const page = await fetch(base + route, { headers });
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /<html lang="en">/);
      assert.match(html, /Your work, at a glance/);
      assert.doesNotMatch(html, /role="tablist"|Modelos e ligações|Eventos clássicos/);
      assert.match(html, /href="\/legacy"/);
    }
    for (const route of ['/legacy', '/legacy/m']) {
      const login = await (await fetch(base + route)).text();
      assert.match(login, /form method="post" action="\/login"/);
      const legacy = await (await fetch(base + route, { headers })).text();
      assert.match(legacy, /Modelos e ligações/);
    }
    const response = await fetch(base + '/api/core', { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.projects[0].core.run.driver, 'core');
    assert.deepEqual(body.projects[0].core.validation_summary, {
      passed: 1,
      failed: 0,
      unknown: 0,
      tasks_without_records: 0,
    });
    assert.equal(
      (
        await fetch(base + '/runs', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: 'Project', resume: true }),
        })
      ).status,
      409,
    );
    f.state.status = 'done';
    f.save();
    mkdirSync(join(f.project, 'docs/forja'), { recursive: true });
    writeFileSync(
      join(f.project, 'docs/forja/RUN.json'),
      JSON.stringify({
        run_id: 'R-later',
        status: 'running',
        driver: 'runner',
      }),
    );
    const resumed = await fetch(base + '/runs', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Project', resume: true }),
    });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).action, 'resume');
  } finally {
    unwatchFile(join(f.data, 'events.jsonl'));
    await new Promise((resolve) => server.server.close(resolve));
  }
});

test('stopping the viewer preserves Core executors and their provider subtrees', () => {
  for (const action of [
    'start --goal example',
    'core resume',
    'core retry --task fix',
  ])
    assert.equal(isRunnerCmd('node "C:/forja/bin/forja.mjs" ' + action), true);
  assert.equal(isRunnerCmd('node C:/forja/bin/forja.mjs core status'), false);
  const tree = [
    {
      ProcessId: 100,
      ParentProcessId: 1,
      CommandLine: 'node viewer/server.mjs',
    },
    {
      ProcessId: 200,
      ParentProcessId: 100,
      CommandLine: 'node C:/forja/bin/forja.mjs core resume',
    },
    { ProcessId: 300, ParentProcessId: 200, CommandLine: 'claude -p' },
  ];
  assert.deepEqual(planKillTree(100, tree), { kill: [100], spared: [200] });
});
