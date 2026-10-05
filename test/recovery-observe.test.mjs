import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryInfo } from '../lib/core/recovery.mjs';
import { coreObservation } from '../lib/core/observe.mjs';
import { renderProject } from '../viewer/assets/core.js';
import { parseOutput } from '../lib/core/providers.mjs';

test('public recovery uses closed reasons and never exposes raw errors or persisted extras', t => {
  const root = mkdtempSync(join(tmpdir(), 'forja-recovery-view-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.forja'), { recursive: true });
  const state = { version: 1, run_id: 'F-123-ab', status: 'blocked', provider: 'claude', goal: 'Preserve work', tasks: [], invocations: 2, stopCode: 'timeout', failure: 'PRIVATE FAILURE /home/secret', config: { maxCloudSessions: 4, secret: 'PRIVATE CONFIG' }, limits: { sessions: 6, minutes: 5, contextTokens: 50000 } };
  writeFileSync(join(root, '.forja/current.json'), JSON.stringify(state));
  const observed = coreObservation(root, { details: true, alive: () => false });
  assert.equal(observed.recovery.code, 'timeout');
  assert.equal(observed.recovery.sessions.limit, 6);
  assert.equal(observed.recovery.cloud_sessions.limit, 4);
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE|\/home\/secret/);
  const html = renderProject({ name: 'Example', core: observed });
  assert.match(html, /Time limit reached/);
  assert.match(html, /Execution limits/);
  assert.doesNotMatch(html, /PRIVATE/);
  assert.equal(recoveryInfo({ ...state, stopCode: '<script>bad()</script>' }).code, 'inspect');
  assert.equal(recoveryInfo({ ...state, status: 'running' }, { alive: false }).code, 'interrupted');
  assert.equal(recoveryInfo({ ...state, status: 'running' }, { alive: true }), null);
  assert.equal(recoveryInfo({ ...state, status: 'done' }), null);
  assert.equal(recoveryInfo({ ...state, technology: [{ selection: null }] }), null);
});

test('legacy blocked states receive cautious guidance and malformed counters remain unknown', () => {
  const info = recoveryInfo({ status: 'blocked', failure: 'timeout PRIVATE', invocations: '99', limits: { sessions: -1 }, config: {} });
  assert.equal(info.code, 'inspect');
  assert.equal(info.sessions.used, null);
  assert.equal(info.sessions.limit, null);
  assert.doesNotMatch(JSON.stringify(info), /PRIVATE/);
});

test('a provider usage-limit diagnosis requires an explicit rejected rate event', () => {
  const event = status => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status } });
  assert.equal(parseOutput('claude', event('allowed_warning')).rate_limited, false);
  assert.equal(parseOutput('claude', event('rejected')).rate_limited, true);
  assert.equal(parseOutput('claude', event('rejected')).rate_limit_reset_at, null);
  assert.equal(parseOutput('claude', event('allowed_warning')).rate_limit_reset_at, null);
  assert.equal(parseOutput('claude', JSON.stringify({ type: 'assistant', message: { content: 'quota rejected' } })).rate_limited, false);
});

test('the observation exposes the closed stop code and a bounded usage-limit wait, never the provider text', t => {
  const root = mkdtempSync(join(tmpdir(), 'forja-wait-view-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.forja'), { recursive: true });
  const wait = { reset_at: '2026-10-04T05:00:00.000Z', source: 'default', recorded_at: '2026-10-04T04:00:00.000Z', resumes: 2, extra: 'PRIVATE' };
  const state = { version: 1, run_id: 'F-123-ab', status: 'blocked', provider: 'claude', goal: 'Goal', tasks: [], invocations: 3, stopCode: 'provider_limit',
    failure: 'PRIVATE provider limit text', config: {}, usageLimitWait: wait, usageLimitResumes: 2, limits: { sessions: 6 } };
  const observe = run => { writeFileSync(join(root, '.forja/current.json'), JSON.stringify(run)); return coreObservation(root, { details: true, alive: () => false }); };
  const observed = observe(state);
  const expected = { reset_at: wait.reset_at, source: 'default', auto_resume: true, stop_requested: false, resumes: 2, max_resumes: 6 };
  assert.equal(observed.run.stop_code, 'provider_limit');
  assert.deepEqual(observed.run.usage_limit_wait, expected);
  assert.deepEqual(observed.recovery.usage_limit_wait, expected);
  assert.match(observed.recovery.guidance, /resets at 2026-10-04T05:00:00.000Z \(no reset time reported; default estimate of 60 minutes\)/);
  assert.match(observed.recovery.guidance, /automatic resume 3 of 6/);
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE/);
  // Opt-out and cap are named; the wait stays visible.
  assert.match(observe({ ...state, config: { usageLimitResume: false } }).recovery.guidance, /Automatic resume is off for this run/);
  assert.equal(observe({ ...state, usageLimitResumes: 6 }).run.usage_limit_wait.auto_resume, false);
  // Malformed or absent waits (an older run) are null and keep the old advice.
  for (const usageLimitWait of [undefined, null, 'soon', { reset_at: 'soon', source: 'provider' }, { reset_at: wait.reset_at, source: 'guess' }]) {
    const view = observe({ ...state, usageLimitWait });
    assert.equal(view.run.usage_limit_wait, null, JSON.stringify(usageLimitWait));
    assert.equal(view.run.stop_code, 'provider_limit');
    assert.match(view.recovery.guidance, /Check the provider account for its reset time/);
  }
  // Other stops and states never show a wait; unknown codes read as inspect.
  assert.equal(observe({ ...state, stopCode: 'timeout' }).run.usage_limit_wait, null);
  assert.equal(observe({ ...state, stopCode: '<b>x</b>' }).run.stop_code, 'inspect');
  for (const status of ['running', 'done', 'failed']) {
    const view = observe({ ...state, status });
    assert.equal(view.run.stop_code, null, status);
    assert.equal(view.run.usage_limit_wait, null, status);
  }
});
