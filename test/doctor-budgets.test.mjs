import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { coreBudgets } from '../lib/core/budgets.mjs';
import { doctor } from '../lib/core/doctor.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-doctor-budgets-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Fixture',
    ],
    { cwd: root },
  );
  return root;
}

test('shared core budgets preserve startup defaults and numeric coercion', () => {
  assert.deepEqual(coreBudgets(), {
    sessions: 30,
    attempts: 2,
    minutes: 30,
    rotations: 2,
    contextTokens: 120000,
  });
  assert.deepEqual(
    coreBudgets({
      maxSessions: '200',
      maxAttempts: '5',
      maxMinutes: '180',
      maxRotations: '0',
      maxContextTokens: '1000',
    }),
    {
      sessions: 200,
      attempts: 5,
      minutes: 180,
      rotations: 0,
      contextTokens: 1000,
    },
  );
});

test('doctor rejects each invalid execution budget before provider inspection', (t) => {
  const root = fixture(t);
  const invalid = {
    maxSessions: 201,
    maxAttempts: 0,
    maxMinutes: 1.5,
    maxRotations: -1,
    maxContextTokens: 1000001,
  };

  for (const [name, value] of Object.entries(invalid)) {
    let inspections = 0;
    const report = doctor(root, {
      config: { [name]: value },
      inspectProvider: () => {
        inspections += 1;
        return { provider: 'claude', installed: true, note: 'Synthetic' };
      },
    });
    assert.equal(report.ready, false, name);
    assert.equal(inspections, 0, name);
    assert.equal(
      report.checks.find((check) => check.name === 'configuration')?.status,
      'error',
      name,
    );
    assert.deepEqual(report.providers, [], name);
  }
});

test('doctor accepts numeric strings without mutating config or relaxing cloud routing', (t) => {
  const root = fixture(t);
  const config = {
    maxSessions: '6',
    maxAttempts: '2',
    maxMinutes: '12',
    maxRotations: '2',
    maxContextTokens: '160000',
  };
  const before = structuredClone(config);
  const inspectProvider = (provider) => ({
    provider,
    installed: true,
    note: 'Synthetic',
  });

  assert.equal(doctor(root, { config, inspectProvider }).ready, true);
  assert.deepEqual(config, before);
  assert.equal(
    doctor(root, {
      config: { ...config, maxCloudSessions: '2' },
      inspectProvider: () => {
        throw new Error('must not inspect invalid routing');
      },
    }).ready,
    false,
  );
});

test('doctor budget diagnostics do not expose supplied values', (t) => {
  const root = fixture(t);
  const marker = 'PRIVATE-BUDGET-MARKER';
  const report = doctor(root, {
    config: { maxMinutes: marker },
    inspectProvider: () => {
      throw new Error('must not inspect invalid budgets');
    },
  });

  assert.equal(report.ready, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(marker));
});


test('doctor checks every budget boundary and leaves project files and index untouched', t => {
  const root = fixture(t);
  const files = readdirSync(root), index = readFileSync(join(root, '.git/index'));
  for (const [key, min, max] of [
    ['maxSessions', 1, 200], ['maxAttempts', 1, 5], ['maxMinutes', 1, 180],
    ['maxRotations', 0, 5], ['maxContextTokens', 1000, 1000000],
  ]) {
    for (const value of [min - 1, max + 1, min + 0.5, 'invalid']) {
      assert.equal(doctor(root, { config: { [key]: value }, inspectProvider() {
        assert.fail('invalid budgets must not inspect providers');
      } }).ready, false, key);
    }
    for (const value of [min, max, String(min), String(max)]) {
      assert.equal(doctor(root, { config: Object.freeze({ [key]: value }),
        inspectProvider: provider => ({ provider, installed: true }) }).ready, true, key);
    }
  }
  assert.deepEqual(readdirSync(root), files);
  assert.deepEqual(readFileSync(join(root, '.git/index')), index);
});
