// Provider usage-limit wait: detection in the Claude adapter, the wait the
// engine records, the attempt it refunds and the guard path that resumes it.
// Temporary Git repositories only; providers are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { core, createRun, current, drive, recoverRun } from '../lib/core/engine.mjs';
import { parseOutput, resetTime } from '../lib/core/providers.mjs';
import {
  USAGE_LIMIT_DEFAULT_MS, USAGE_LIMIT_MARGIN_MS, USAGE_LIMIT_MAX_MS, USAGE_LIMIT_MAX_RESUMES, USAGE_LIMIT_MIN_MS,
  recoveryInfo, usageLimitDue, usageLimitResumeProblem, usageLimitWait, usageLimitWaitStatus,
} from '../lib/core/recovery.mjs';
import { coreObservation } from '../lib/core/observe.mjs';
import { readStopRequest, requestStop, stopRequestPath } from '../lib/core/stop.mjs';

const MIN = 60000;
// One fixed instant for every drive and assertion: the wait is recorded and
// judged due against this injected clock, never against how long a step took,
// so the margins below hold on a loaded machine too.
const T0 = Date.parse('2026-10-04T03:00:00.000Z');
const clock = () => T0;
const quiet = () => {};
const event = info => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info });
const reply = status => ({ code: 0, result: { status, summary: 'Work preserved', findings: [] } });

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-usage-limit-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  writeFileSync(join(root, 'value.mjs'), 'export const value = 1;\n');
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture']])
    execFileSync('git', args, { cwd: root, windowsHide: true });
  return root;
}
const plan = { decisions: [], tasks: [{
  id: 'T1', title: 'Return two', criteria: ['value equals two'], files: ['value.mjs'], complexity: 'easy', risks: [], after: [],
  checks: [{ command: 'node', args: ['--input-type=module', '-e', "import {value} from './value.mjs'; if(value!==2)process.exit(1)"] }],
}] };
function fixture(t, config = {}, withPlan = true) {
  const root = repo(t);
  createRun(root, { goal: 'Return two', provider: 'custom', config: { maxAttempts: 1, ...config }, ...(withPlan ? { plan } : {}) });
  return root;
}
const state = root => JSON.parse(readFileSync(current(root), 'utf8'));
const save = (root, run) => writeFileSync(current(root), JSON.stringify(run, null, 2) + '\n');
// A develop session that ends on the provider usage limit, after editing work.
const limited = (root, resetsAt) => async () => {
  writeFileSync(join(root, 'value.mjs'), 'export const value = 2;\n');
  return { code: 1, error: 'usage limit', rate_limited: true, rate_limit_reset_at: resetsAt ?? null };
};
// Moves the stored reset time so the wait is due (or not) without waiting.
function setReset(root, ms) {
  const run = state(root);
  run.usageLimitWait.reset_at = new Date(ms).toISOString();
  save(root, run);
}

test('parseOutput reports the reset time of a rejected Claude rate_limit_event only', () => {
  const at = Date.parse('2026-10-04T05:00:00.000Z');
  assert.deepEqual(
    [at / 1000, at, '2026-10-04T05:00:00.000Z', '2026-10-04T06:00:00+01:00'].map(resetsAt => {
      const out = parseOutput('claude', event({ status: 'rejected', resetsAt }));
      return [out.rate_limited, out.rate_limit_reset_at];
    }),
    Array(4).fill([true, '2026-10-04T05:00:00.000Z']),
  );
  // Rejected without a usable reset: still a usage limit, with no reported time.
  for (const resetsAt of [undefined, null, '1791090000', 'tomorrow', '2026-10-04', -5, 0, NaN, Infinity, 1e20, {}, [at], true])
    assert.deepEqual(
      (({ rate_limited, rate_limit_reset_at }) => ({ rate_limited, rate_limit_reset_at }))(parseOutput('claude', event({ status: 'rejected', resetsAt }))),
      { rate_limited: true, rate_limit_reset_at: null }, String(resetsAt));
  // Warnings, assistant text and other providers never produce a wait.
  for (const [provider, stdout] of [
    ['claude', event({ status: 'allowed_warning', resetsAt: at / 1000 })],
    ['claude', JSON.stringify({ type: 'assistant', message: { content: 'usage limit rejected, resets at 5am' } })],
    ['claude', JSON.stringify({ type: 'rate_limit_event' })],
    ['codex', event({ status: 'rejected', resetsAt: at / 1000 })],
    ['custom', event({ status: 'rejected', resetsAt: at / 1000 })],
  ]) {
    const out = parseOutput(provider, stdout, join(tmpdir(), 'forja-no-such-result.json'));
    assert.equal(out.rate_limited, false, `${provider} ${stdout}`);
    assert.equal(out.rate_limit_reset_at, null);
  }
  // The last rejection in the stream wins.
  assert.equal(parseOutput('claude', [event({ status: 'rejected', resetsAt: 1 }), event({ status: 'rejected', resetsAt: at / 1000 })].join('\n')).rate_limit_reset_at, '2026-10-04T05:00:00.000Z');
  assert.equal(resetTime('2026-13-45T99:99Z'), null);
});

test('the stored wait defaults to 60 minutes and clamps a reported time to [1 minute, 8 days]', () => {
  const now = Date.parse('2026-10-04T01:00:00.000Z');
  const iso = ms => new Date(ms).toISOString();
  assert.deepEqual(usageLimitWait({}, null, now), { reset_at: iso(now + USAGE_LIMIT_DEFAULT_MS), source: 'default', recorded_at: iso(now), resumes: 0 });
  assert.equal(USAGE_LIMIT_DEFAULT_MS, 60 * MIN);
  assert.equal(usageLimitWait({}, 'not a time', now).source, 'default');
  assert.deepEqual(usageLimitWait({ usageLimitResumes: 2 }, iso(now + 30 * MIN), now), { reset_at: iso(now + 30 * MIN), source: 'provider', recorded_at: iso(now), resumes: 2 });
  assert.equal(usageLimitWait({}, iso(now - 5 * MIN), now).reset_at, iso(now + USAGE_LIMIT_MIN_MS));
  assert.equal(usageLimitWait({}, iso(now + 30 * 24 * 60 * MIN), now).reset_at, iso(now + USAGE_LIMIT_MAX_MS));
  assert.equal(USAGE_LIMIT_MAX_MS, 8 * 24 * 60 * MIN);
});

test('a develop session on the usage limit records the wait, refunds the attempt and keeps the session count', async t => {
  const root = fixture(t);
  const reported = new Date(T0 + 90 * MIN).toISOString();
  const blocked = await drive(root, { log: quiet, clock, providerCall: limited(root, reported) });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.stopCode, 'provider_limit');
  assert.equal(blocked.invocations, 1, 'the session still counts');
  assert.equal(blocked.tasks[0].attempts, 0, 'no implementation attempt was spent');
  assert.equal(blocked.tasks[0].status, 'todo');
  assert.equal(readFileSync(join(root, 'value.mjs'), 'utf8'), 'export const value = 2;\n', 'work on disk is preserved');
  const wait = state(root).usageLimitWait;
  assert.deepEqual(Object.keys(wait).sort(), ['recorded_at', 'reset_at', 'resumes', 'source']);
  assert.equal(wait.reset_at, reported);
  assert.equal(wait.source, 'provider');
  assert.equal(wait.resumes, 0);
  assert.equal(wait.recorded_at, new Date(T0).toISOString());
  // Public projections: status, recovery guidance and the observation.
  const status = usageLimitWaitStatus(state(root));
  assert.deepEqual(status, { reset_at: reported, source: 'provider', auto_resume: true, stop_requested: false, resumes: 0, max_resumes: USAGE_LIMIT_MAX_RESUMES });
  const info = recoveryInfo(state(root), { alive: false });
  assert.equal(info.code, 'provider_limit');
  assert.match(info.guidance, new RegExp(`resets at ${reported.replace(/[.]/g, '\\.')}`));
  assert.match(info.guidance, /guard resumes this run automatically/);
  assert.deepEqual(info.usage_limit_wait, status);
  const observed = coreObservation(root, { alive: () => false });
  assert.equal(observed.run.stop_code, 'provider_limit');
  assert.deepEqual(observed.run.usage_limit_wait, status);
  const detailed = coreObservation(root, { details: true, alive: () => false });
  assert.deepEqual(detailed.run.usage_limit_wait, status);
  assert.doesNotMatch(JSON.stringify(observed), /usage limit"|error/i, 'no raw provider text in the summary');
});

test('without a reported reset the wait is recorded at 60 minutes from the stop', async t => {
  const root = fixture(t);
  await drive(root, { log: quiet, clock, providerCall: limited(root, null) });
  const wait = state(root).usageLimitWait;
  assert.equal(wait.source, 'default');
  assert.equal(Date.parse(wait.reset_at) - Date.parse(wait.recorded_at), 60 * MIN);
  assert.match(recoveryInfo(state(root)).guidance, /default estimate of 60 minutes/);
});

test('a usage limit while planning (no task yet) is also a wait', async t => {
  const root = fixture(t, {}, false);
  const blocked = await drive(root, { log: quiet, clock, providerCall: async () => ({ code: 0, result: null, rate_limited: true, rate_limit_reset_at: null }) });
  assert.equal(blocked.stopCode, 'provider_limit');
  assert.equal(blocked.tasks.length, 0);
  assert.equal(state(root).usageLimitWait.source, 'default');
});

test('any other stop never writes a wait, and resume or a later stop clears a stale one', async t => {
  const root = fixture(t, { maxAttempts: 2 });
  await drive(root, { log: quiet, clock, providerCall: async () => ({ code: 1, timedOut: true }) });
  assert.equal(state(root).stopCode, 'timeout');
  assert.equal(state(root).usageLimitWait, undefined);
  assert.equal(recoveryInfo(state(root)).usage_limit_wait, undefined);
  // A wait followed by an operator resume that stops for another reason.
  const limitedRoot = fixture(t, { maxAttempts: 2 });
  await drive(limitedRoot, { log: quiet, clock, providerCall: limited(limitedRoot) });
  assert.ok(state(limitedRoot).usageLimitWait);
  const again = await drive(limitedRoot, { log: quiet, clock, providerCall: async () => ({ code: 1, error: 'other failure' }) });
  assert.equal(again.stopCode, 'provider');
  assert.equal(state(limitedRoot).usageLimitWait, undefined);
  assert.equal(coreObservation(limitedRoot).run.usage_limit_wait, null);
  // A resume that finishes clears it too.
  const doneRoot = fixture(t);
  await drive(doneRoot, { log: quiet, clock, providerCall: limited(doneRoot) });
  const done = await drive(doneRoot, { log: quiet, clock, providerCall: async (_, o) => reply(o.readOnly ? 'approve' : 'ready_for_validation') });
  assert.equal(done.status, 'done', done.failure);
  assert.equal(done.tasks[0].attempts, 1, 'only the completed session spent an attempt');
  assert.equal(state(doneRoot).usageLimitWait, undefined);
  assert.equal(state(doneRoot).usageLimitResumes, undefined, 'an operator resume is not an automatic one');
});

test('the guard path resumes a due wait once per call, counts it and stops at the cap', async t => {
  const root = fixture(t, { maxSessions: 20 });
  const { run_id } = await drive(root, { log: quiet, clock, providerCall: limited(root) });
  const untouched = readFileSync(current(root), 'utf8');
  let calls = 0;
  const provider = limited(root);
  const counting = async (...a) => { calls++; return provider(...a); };
  // Not yet due: refused, nothing changed and no session spent.
  await assert.rejects(drive(root, { log: quiet, clock, expectedRunId: run_id, providerCall: counting }), /has not passed yet; nothing was changed/);
  assert.equal(readFileSync(current(root), 'utf8'), untouched);
  // Due only after the reset plus the margin.
  setReset(root, T0 - USAGE_LIMIT_MARGIN_MS + 1);
  await assert.rejects(drive(root, { log: quiet, clock, expectedRunId: run_id, providerCall: counting }), /has not passed yet/);
  assert.equal(calls, 0);
  // Another run identity is refused.
  setReset(root, T0 - 2 * MIN);
  await assert.rejects(drive(root, { log: quiet, clock, expectedRunId: 'F-1-abcdef', providerCall: counting }), /identity or status changed/);
  for (let n = 1; n <= USAGE_LIMIT_MAX_RESUMES; n++) {
    setReset(root, T0 - 2 * MIN);
    const resumed = await drive(root, { log: quiet, clock, expectedRunId: run_id, providerCall: counting });
    assert.equal(resumed.stopCode, 'provider_limit', resumed.failure);
    assert.equal(resumed.usageLimitResumes, n);
    assert.equal(resumed.usageLimitWait.resumes, n);
    assert.equal(resumed.tasks[0].attempts, 0);
  }
  assert.equal(calls, USAGE_LIMIT_MAX_RESUMES);
  setReset(root, T0 - 2 * MIN);
  assert.equal(usageLimitWaitStatus(state(root)).auto_resume, false);
  assert.match(recoveryInfo(state(root)).guidance, /already used all 6 automatic resumes/);
  const capped = readFileSync(current(root), 'utf8');
  await assert.rejects(drive(root, { log: quiet, clock, expectedRunId: run_id, providerCall: counting }), /already used 6 automatic usage-limit resumes/);
  assert.equal(readFileSync(current(root), 'utf8'), capped);
  assert.equal(calls, USAGE_LIMIT_MAX_RESUMES);
  // A plain operator resume still works after the cap.
  const manual = await drive(root, { log: quiet, clock, providerCall: async (_, o) => reply(o.readOnly ? 'approve' : 'ready_for_validation') });
  assert.equal(manual.status, 'done', manual.failure);
});

test('usageLimitResume false records and shows the wait but the guard path never resumes it', async t => {
  const root = fixture(t, { usageLimitResume: false });
  const { run_id } = await drive(root, { log: quiet, clock, providerCall: limited(root) });
  setReset(root, T0 - 10 * MIN);
  const wait = usageLimitWaitStatus(state(root));
  assert.equal(wait.auto_resume, false);
  assert.equal(usageLimitDue(wait), false);
  assert.match(recoveryInfo(state(root)).guidance, /Automatic resume is off for this run \(usageLimitResume false\)/);
  const before = readFileSync(current(root), 'utf8');
  await assert.rejects(drive(root, { log: quiet, clock, expectedRunId: run_id, providerCall: async () => assert.fail('no session') }), /automatic resume is disabled/);
  assert.equal(readFileSync(current(root), 'utf8'), before);
  // The operator resumes it explicitly.
  const resumed = await drive(root, { log: quiet, clock, providerCall: async (_, o) => reply(o.readOnly ? 'approve' : 'ready_for_validation') });
  assert.equal(resumed.status, 'done', resumed.failure);
});

// An operator stop requested while the session that hit the limit was running
// must survive the wait: the guard never restarts a run a person asked to stop.
for (const afterTask of [true, false]) {
  test(`a pending ${afterTask ? 'after-task' : 'default'} operator stop turns automatic resume off and is never cleared by the guard path`, async t => {
    const root = fixture(t);
    const { run_id } = await drive(root, { log: quiet, clock, providerCall: async () => {
      requestStop(root, { afterTask, controllerAlive: () => true });
      return limited(root)();
    } });
    assert.equal(state(root).stopCode, 'provider_limit');
    const request = readStopRequest(root, run_id);
    assert.equal(request.mode, afterTask ? 'task' : 'invocation');
    setReset(root, T0 - 10 * MIN);
    // Status, recovery guidance and the observation show no automatic resume.
    const wait = usageLimitWaitStatus(state(root), { stopRequested: true });
    assert.equal(wait.auto_resume, false);
    assert.equal(wait.stop_requested, true);
    assert.equal(usageLimitDue(wait), false);
    assert.match(usageLimitResumeProblem(state(root), T0, { stopRequested: true }), /operator stop request is pending/);
    const observed = coreObservation(root, { details: true, alive: () => false });
    assert.deepEqual(observed.run.usage_limit_wait, wait);
    assert.match(observed.recovery.guidance, /operator stop request is pending, so the guard does not resume/);
    const lines = [];
    t.mock.method(console, 'log', line => lines.push(line));
    try { await core({ pos: ['status'], opt: { project: root } }); } finally { t.mock.restoreAll(); }
    assert.deepEqual(JSON.parse(lines.join('\n')).usage_limit_wait, wait);
    // The guard path refuses under the lock: no session, state and request unchanged.
    const before = readFileSync(current(root), 'utf8');
    const stopFile = readFileSync(stopRequestPath(root), 'utf8');
    await assert.rejects(drive(root, { log: quiet, clock, expectedRunId: run_id, providerCall: async () => assert.fail('no session') }),
      /operator stop request is pending for this run; nothing was changed/);
    assert.equal(readFileSync(current(root), 'utf8'), before);
    assert.equal(readFileSync(stopRequestPath(root), 'utf8'), stopFile);
    // A person resumes explicitly: the old request belongs to the ended session.
    const resumed = await drive(root, { log: quiet, clock, providerCall: async (_, o) => reply(o.readOnly ? 'approve' : 'ready_for_validation') });
    assert.equal(resumed.status, 'done', resumed.failure);
    assert.equal(existsSync(stopRequestPath(root)), false);
  });
}

test('createRun refuses a non-boolean usageLimitResume before writing any state', t => {
  for (const value of ['false', 0, 1, null, {}]) {
    const root = repo(t);
    assert.throws(() => createRun(root, { goal: 'Return two', provider: 'custom', config: { usageLimitResume: value }, plan }), /usageLimitResume must be true or false/);
    assert.equal(existsSync(join(root, '.forja')), false, JSON.stringify(value));
  }
  const root = repo(t);
  assert.equal(createRun(root, { goal: 'Return two', provider: 'custom', config: { usageLimitResume: true }, plan }).config.usageLimitResume, true);
});

test('the guard path refuses every other blocked stop code unchanged, even with a forged due wait', async t => {
  const root = fixture(t);
  const { run_id } = await drive(root, { log: quiet, clock, providerCall: limited(root) });
  setReset(root, T0 - 10 * MIN);
  const base = state(root);
  const codes = ['timeout', 'provider', 'output', 'attempts', 'operator_stop', 'inspect', 'check_writes', 'check_timeout', 'check_targets',
    'sessions', 'cloud_sessions', 'rotations', 'context', 'repeated_context_limit', 'no_progress_between_rotations', 'plan_packet', 'task_packet', 'interrupted', 'unknown_code'];
  for (const stopCode of codes) {
    save(root, { ...base, stopCode });
    const before = readFileSync(current(root), 'utf8');
    await assert.rejects(drive(root, { log: quiet, clock, expectedRunId: run_id, providerCall: async () => assert.fail('no session') }),
      /Guard recovery cancelled: run identity or status changed/, stopCode);
    assert.equal(readFileSync(current(root), 'utf8'), before, stopCode);
    assert.equal(usageLimitResumeProblem(state(root)), 'the run is not waiting for a provider usage limit');
  }
  // A pending technology choice, a malformed wait, a done or failed run.
  const technology = { id: 'D1', capability: 'Storage', constraints: 'Free', recommended: 'a', rationale: 'r', selection: null,
    options: [{ id: 'a', name: 'A', cost: 'free', cost_basis: 'Open source', tradeoffs: 't', evidence: ['e'] }, { id: 'b', name: 'B', cost: 'paid', cost_basis: 'Plan', tradeoffs: 't', evidence: ['e'] }] };
  for (const [label, run, why] of [
    ['malformed wait', { ...base, usageLimitWait: { reset_at: 'soon', source: 'provider' } }, /missing or malformed/],
    ['missing wait', { ...base, usageLimitWait: undefined }, /missing or malformed/],
    ['done', { ...base, status: 'done' }, /identity or status changed/],
    ['failed', { ...base, status: 'failed' }, /identity or status changed/],
  ]) {
    save(root, run);
    const before = readFileSync(current(root), 'utf8');
    await assert.rejects(drive(root, { log: quiet, clock, expectedRunId: run_id, providerCall: async () => assert.fail('no session') }), why, label);
    assert.equal(readFileSync(current(root), 'utf8'), before, label);
  }
  save(root, { ...base, stopCode: 'inspect', technology: [technology] });
  const before = readFileSync(current(root), 'utf8');
  await assert.rejects(drive(root, { log: quiet, clock, expectedRunId: run_id, providerCall: async () => assert.fail('no session') }), /identity or status changed/);
  assert.equal(readFileSync(current(root), 'utf8'), before);
});

test('core resume --expected-run refuses budget flags before any effect', async t => {
  const root = fixture(t);
  const { run_id } = await drive(root, { log: quiet, clock, providerCall: limited(root) });
  const before = readFileSync(current(root), 'utf8');
  await assert.rejects(core({ pos: ['resume'], opt: { project: root, 'expected-run': run_id, 'max-minutes': 30 } }), /takes no budget flags; nothing was changed/);
  assert.equal(readFileSync(current(root), 'utf8'), before);
  assert.equal(existsSync(join(root, '.forja', 'runs', run_id, 'recovery.jsonl')), false);
  // A plain operator budget change keeps working on the same block.
  recoverRun(root, { reason: 'Longer calls', limits: { minutes: 30 } });
  assert.equal(state(root).limits.minutes, 30);
  assert.equal(state(root).stopCode, 'provider_limit');
});

test('core status JSON reports usage_limit_wait, and null when the run is not waiting', async t => {
  const root = fixture(t);
  const status = async () => {
    const lines = [];
    t.mock.method(console, 'log', line => lines.push(line));
    try { await core({ pos: ['status'], opt: { project: root } }); } finally { t.mock.restoreAll(); }
    return JSON.parse(lines.join('\n'));
  };
  assert.equal((await status()).usage_limit_wait, null);
  await drive(root, { log: quiet, clock, providerCall: limited(root) });
  const json = await status();
  assert.deepEqual(json.usage_limit_wait, usageLimitWaitStatus(state(root)));
  assert.equal(json.usage_limit_wait.auto_resume, true);
  assert.equal(json.recovery.code, 'provider_limit');
  assert.deepEqual(json.recovery.usage_limit_wait, json.usage_limit_wait);
});
