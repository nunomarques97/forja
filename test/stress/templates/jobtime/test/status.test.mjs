import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes } from '../src/format.mjs';
import { statusLine, summary } from '../src/status.mjs';

test('formatBytes', () => {
  assert.equal(formatBytes(900), '900 B');
  assert.equal(formatBytes(1536 * 1024), '1.5 MB');
});

test('status line names the job and its result', () => {
  assert.match(statusLine({ name: 'build', ok: true, durationMs: 1000 }), /^build: ok, took /);
  assert.match(statusLine({ name: 'lint', ok: false, durationMs: 1000, artifactBytes: 2048 }), /^lint: failed, took .*, artifact 2\.0 KB$/);
});

test('summary counts failures', () => {
  assert.match(summary([{ ok: true, durationMs: 1 }, { ok: false, durationMs: 1 }]), /^2 jobs, 1 failed, total /);
});
