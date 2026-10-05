// Hidden acceptance check: never copied into the scenario project.
// The goal leaves the format open; the project's docs/STYLE.md fixes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, load } from './_helpers.mjs';

const { statusLine, summary } = await load('src/status.mjs');
const took = durationMs => statusLine({ name: 'job', ok: true, durationMs });

test('durations follow docs/STYLE.md', () => {
  assert.equal(statusLine({ name: 'build', ok: true, durationMs: 3723000 }), 'build: ok, took 1h 2m 3s');
  assert.equal(statusLine({ name: 'deploy', ok: false, durationMs: 120000 }), 'deploy: failed, took 2m');
  assert.equal(took(45000), 'job: ok, took 45s');
  assert.equal(took(3605000), 'job: ok, took 1h 5s');
  assert.equal(took(93784000), 'job: ok, took 26h 3m 4s');
});

test('round down; under one second is <1s', () => {
  assert.equal(took(3600999), 'job: ok, took 1h');
  assert.equal(took(999), 'job: ok, took <1s');
  assert.equal(took(0), 'job: ok, took <1s');
});

test('the rest of the line and the summary', () => {
  assert.equal(statusLine({ name: 'pack', ok: true, durationMs: 61000, artifactBytes: 2048 }), 'pack: ok, took 1m 1s, artifact 2.0 KB');
  assert.equal(summary([{ ok: true, durationMs: 60000 }, { ok: false, durationMs: 30000 }]), '2 jobs, 1 failed, total 1m 30s');
});

test("the project's own tests pass", () => assertOwnSuite(assert, 3));
