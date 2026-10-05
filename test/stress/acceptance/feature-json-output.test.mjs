// Hidden acceptance check: never copied into the scenario project.
// The CLI is judged as a user runs it: a child process in the project root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT, assertOwnSuite } from './_helpers.mjs';

const JOBS = [
  { name: 'build', ok: true, durationMs: 120000, artifactBytes: 2048 },
  { name: 'lint', ok: false, durationMs: 30000 },
  { name: 'e2e', ok: true, durationMs: 450000 },
];
const file = join(mkdtempSync(join(tmpdir(), 'stress-jobs-')), 'jobs.json');
writeFileSync(file, JSON.stringify(JOBS));
const cli = (...args) => {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const out = spawnSync(process.execPath, ['src/cli.mjs', ...args], { cwd: PROJECT, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { code: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
};
const lines = text => text.split(/\r?\n/).filter(Boolean);

test('--json prints one JSON document with the jobs and a summary', () => {
  for (const args of [['--json', file], [file, '--json']]) {
    const { code, stdout } = cli(...args);
    assert.equal(code, 0, args.join(' '));
    const doc = JSON.parse(stdout);
    assert.deepEqual(doc.jobs.map(job => job.name), ['build', 'lint', 'e2e']);
    assert.deepEqual(doc.jobs.map(job => job.ok), [true, false, true]);
    assert.deepEqual(doc.summary, { jobs: 3, failed: 1, totalMs: 600000 });
  }
});

test('--failed shows only failed jobs; the summary still counts every job', () => {
  const text = cli(file, '--failed');
  assert.equal(text.code, 0);
  const out = lines(text.stdout);
  assert.equal(out.length, 2, text.stdout);
  assert.match(out[0], /^lint: failed/);
  assert.match(out[1], /^3 jobs, 1 failed/);
  const json = JSON.parse(cli('--failed', '--json', file).stdout);
  assert.deepEqual(json.jobs.map(job => job.name), ['lint']);
  assert.deepEqual(json.summary, { jobs: 3, failed: 1, totalMs: 600000 });
});

test('unknown options and a missing file exit 2 with usage on stderr', () => {
  for (const args of [['--bogus', file], [], ['--json']]) {
    const { code, stdout, stderr } = cli(...args);
    assert.equal(code, 2, args.join(' '));
    assert.match(stderr, /usage/i);
    assert.equal(stdout, '');
  }
});

test('plain text output is unchanged', () => {
  const { code, stdout } = cli(file);
  assert.equal(code, 0);
  const out = lines(stdout);
  assert.equal(out.length, 4);
  assert.match(out[0], /^build: ok, took .*, artifact 2\.0 KB$/);
  assert.match(out[3], /^3 jobs, 1 failed, total /);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 4));
