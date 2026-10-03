// #28: the end of a Core run must not turn the project's quiet sessions into a
// burst of urgent "sessão principal parece morta" alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coreDrivenProjects, coreProjectRuns } from '../viewer/core-api.mjs';
import { watchdogDue, watchdogPlan } from '../viewer/server.mjs';
import { createState, applyEvent, snapshot } from '../viewer/lib/state.mjs';
import { upsertProject } from '../lib/projects.mjs';

const MIN = 60_000;
const iso = ms => new Date(ms).toISOString();

function fixture(t, run = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forja-wd28-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'automacoes-n8n'), data = join(root, 'data');
  mkdirSync(join(project, '.forja'), { recursive: true });
  const save = over => writeFileSync(join(project, '.forja', 'current.json'), JSON.stringify({
    version: 1, run_id: 'F-123-ab', status: 'running', provider: 'claude', goal: 'g', invocations: 3, tasks: [], ...run, ...over,
  }));
  save();
  upsertProject({ name: 'automacoes-n8n', path: project }, data);
  return { project, data, save };
}

// Sessions in the project that never ended their turn: the reducer reports each
// one as "morto" once it has been silent for more than 30 minutes.
function sessions(project, lastEvents) {
  const st = createState();
  lastEvents.forEach((last, i) => {
    const base = { session_id: `sess-${i}`, cwd: project };
    applyEvent(st, { ...base, hook_event_name: 'SessionStart', ts: iso(last - 2 * MIN) });
    applyEvent(st, { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'x', ts: iso(last - MIN) });
    applyEvent(st, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, ts: iso(last) });
  });
  return st;
}

const mainDead = plan => plan.filter(n => /\|main-dead\|/.test(n.key));

test('coreProjectRuns exposes terminal Core runs with their end time', (t) => {
  const f = fixture(t);
  const key = f.project.replace(/\\/g, '/').toLowerCase();
  assert.deepEqual([...coreProjectRuns(f.data)], [[key, { status: 'running', active: true, ended_at: null }]]);
  f.save({ status: 'blocked' });
  assert.equal(coreProjectRuns(f.data).get(key).active, true);
  f.save({ status: 'done', finished_at: '2026-10-03T10:00:00.000Z', updated_at: '2026-10-03T10:05:00.000Z' });
  assert.deepEqual(coreProjectRuns(f.data).get(key), { status: 'done', active: false, ended_at: Date.parse('2026-10-03T10:00:00.000Z') });
  assert.deepEqual([...coreDrivenProjects(f.data)], [], 'coreDrivenProjects still lists only running or blocked runs');
  f.save({ status: 'failed', updated_at: '2026-10-03T11:00:00.000Z' });
  assert.equal(coreProjectRuns(f.data).get(key).ended_at, Date.parse('2026-10-03T11:00:00.000Z'), 'updated_at when finished_at is missing');
  f.save({ status: 'failed' });
  const written = Date.parse('2026-10-02T09:00:00.000Z');
  utimesSync(join(f.project, '.forja', 'current.json'), written / 1000, written / 1000);
  assert.equal(Math.round(coreProjectRuns(f.data).get(key).ended_at / 1000), written / 1000, 'the state file time as last resort');
});

for (const status of ['done', 'failed']) {
  test(`three stale sessions stay quiet when the Core run ends ${status} (#28)`, (t) => {
    const now = Date.now();
    const f = fixture(t);
    // Quiet for 1h49, 3h21 and 4h10; the Core run worked meanwhile and ends now.
    const st = sessions(f.project, [now - 109 * MIN, now - 201 * MIN, now - 250 * MIN]);
    const before = watchdogPlan(snapshot(st, now), now, undefined, { coreRuns: coreProjectRuns(f.data) });
    assert.deepEqual(before, [], 'quiet while the Core run is running');
    f.save({ status, finished_at: iso(now - 10_000), ...(status === 'failed' ? { failure: 'abandoned' } : {}) });
    const notified = {};
    for (let poll = 0; poll < 3; poll++) {
      const at = now + poll * 30_000;
      const plan = watchdogPlan(snapshot(st, at), at, undefined, { coreRuns: coreProjectRuns(f.data) });
      const due = watchdogDue(plan, notified, at);
      if (status === 'done') assert.deepEqual(due, [], 'a Core run that ends done never alerts');
      else assert.ok(mainDead(due).length <= 1, 'at most one alert for the project');
      assert.equal(due.filter(n => n.priority === 'urgent').length, 0, 'no urgent alert for sessions quiet since before the end');
    }
  });
}

test('several dead sessions of one project alert once, and polls do not resend it', () => {
  const now = Date.now();
  const project = ['', 'srv', 'work', 'automacoes-n8n'].join('/');
  const st = sessions(project, [now - 109 * MIN, now - 201 * MIN, now - 250 * MIN]);
  const notified = {};
  const sent = [];
  for (let poll = 0; poll < 4; poll++) {
    const at = now + poll * 30_000;
    sent.push(...watchdogDue(watchdogPlan(snapshot(st, at), at), notified, at));
  }
  assert.equal(sent.length, 1, 'one notification for the project');
  assert.equal(sent[0].priority, 'urgent');
  assert.equal(sent[0].keys.length, 3, 'it covers every dead session');
  assert.match(sent[0].message, /^Forja: sessão principal em automacoes-n8n parece morta \(sem qualquer evento há 1h49/, 'it speaks of the most recent one, in plain Portuguese');
  // A session that comes back and dies again is a new episode.
  const later = now + 40 * MIN;
  const base = { session_id: 'sess-1', cwd: project };
  applyEvent(st, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, ts: iso(now) });
  const again = watchdogDue(watchdogPlan(snapshot(st, later), later), notified, later);
  assert.equal(again.length, 1);
  assert.match(again[0].message, /sem qualquer evento há 40min/);
  assert.deepEqual(watchdogDue(watchdogPlan(snapshot(st, later + 30_000), later + 30_000), notified, later + 30_000), []);
});

test('new activity after the Core run ended that then dies is still alerted, once', (t) => {
  const now = Date.now();
  const f = fixture(t, { status: 'done', finished_at: iso(now - 120 * MIN) });
  // Two sessions quiet since before the end, one that worked after it and then went silent.
  const st = sessions(f.project, [now - 130 * MIN, now - 200 * MIN, now - 45 * MIN]);
  const notified = {};
  const plan = watchdogPlan(snapshot(st, now), now, undefined, { coreRuns: coreProjectRuns(f.data) });
  const due = watchdogDue(plan, notified, now);
  assert.equal(due.length, 1);
  assert.equal(due[0].keys.length, 1, 'only the session active after the end');
  assert.match(due[0].message, /sem qualquer evento há 45min/);
  assert.deepEqual(watchdogDue(watchdogPlan(snapshot(st, now + 30_000), now + 30_000, undefined, { coreRuns: coreProjectRuns(f.data) }), notified, now + 30_000), []);
  // A new Core run that is running suppresses it again, as in #18.
  f.save({ status: 'running', run_id: 'F-456-cd' });
  assert.deepEqual(watchdogPlan(snapshot(st, now), now, undefined, { coreRuns: coreProjectRuns(f.data) }), []);
});
