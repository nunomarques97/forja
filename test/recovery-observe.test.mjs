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
  assert.equal(parseOutput('claude', JSON.stringify({ type: 'assistant', message: { content: 'quota rejected' } })).rate_limited, false);
});
