import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { diagnoseRun } from '../lib/core/diagnose.mjs';
import { cliDiagnosticFilters, INVALID_DIAGNOSTIC_FILTERS } from '../lib/core/diagnostic-filters.mjs';

const bin = fileURLToPath(new URL('../bin/forja.mjs', import.meta.url));
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
const trace = jsonl([{ kind: 'start', version: 1, provider: 'codex' }, { kind: 'end', dropped_events: 0, unparsed_lines: 0, recorded_events: 0 }]);

// Four ledger rows plus a claimed fifth invocation, so the run has a global warning.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-diagnose-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.forja/runs/F-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, '.forja/current.json'), JSON.stringify({ version: 1, run_id: 'F-cli', status: 'done', invocations: 5 }));
  const phases = ['plan', 'develop', 'review', 'develop'];
  writeFileSync(join(dir, 'usage.jsonl'), jsonl(phases.map((phase, i) => ({ id: i + 1, phase, provider: 'codex', result: 'returned', duration_ms: 10 }))));
  for (const id of [1, 2, 3, 4]) writeFileSync(join(dir, `call-${id}-events.jsonl`), trace);
  return root;
}
const cli = (root, args, env = process.env) => spawnSync(process.execPath, [bin, 'core', 'diagnose', '--project', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 20000, env });

test('CLI without selectors prints exactly the unfiltered API report and changes nothing', t => {
  const root = fixture(t), before = readFileSync(join(root, '.forja/current.json'));
  const r = cli(root, []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, JSON.stringify(diagnoseRun(root), null, 2) + '\n');
  assert.deepEqual(JSON.parse(r.stdout).invocations.map(x => x.id), [1, 2, 3, 4]);
  assert.deepEqual(readFileSync(join(root, '.forja/current.json')), before);
});

test('CLI selectors are optional, combine with AND and keep global warnings unfiltered', t => {
  const root = fixture(t), before = readFileSync(join(root, '.forja/current.json')), all = diagnoseRun(root);
  assert.ok(all.warnings.includes('missing_invocation_records'));
  const cases = [
    [['--invocation', '2'], [2]],
    [['--phase', 'develop'], [2, 4]],
    [['--phase', 'develop', '--invocation', '4'], [4]],
    [['--invocation', '3', '--phase', 'develop'], []],
    [['--invocation', '200'], []],
    [['--invocation', '1'], [1]],
  ];
  for (const [args, ids] of cases) {
    const r = cli(root, args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.invocations.map(x => x.id), ids, args.join(' '));
    assert.deepEqual({ ...report, invocations: [] }, { ...all, invocations: [] }, args.join(' '));
    assert.deepEqual(report.invocations, all.invocations.filter(x => ids.includes(x.id)));
  }
  assert.deepEqual(readFileSync(join(root, '.forja/current.json')), before);
});

test('CLI rejects missing, noncanonical, out-of-range and unknown selectors with one generic error before reading files', t => {
  const root = fixture(t), before = readFileSync(join(root, '.forja/current.json'));
  // A missing project proves validation happens first: a valid selector would fail differently.
  const absent = join(root, 'PRIVATE_PROJECT');
  const invalid = [
    ['--invocation'], ['--phase'], ['--invocation', '--phase', 'plan'], ['--phase', '--invocation', '2'],
    ['--invocation', '0'], ['--invocation', '201'], ['--invocation', '02'], ['--invocation', '+2'],
    ['--invocation', '-1'], ['--invocation', '1e0'], ['--invocation', '0x2'], ['--invocation', '2.0'],
    ['--invocation', ' 2'], ['--invocation', '2 '], ['--invocation', '9007199254740993'], ['--invocation', 'PRIVATE_VALUE'],
    ['--phase', 'PRIVATE_VALUE'], ['--phase', 'Review'], ['--phase', ' plan'], ['--invocation', '2', '--phase', 'PRIVATE_VALUE'],
  ];
  for (const args of invalid) {
    for (const project of [root, absent]) {
      const r = cli(project, args);
      assert.equal(r.status, 1, JSON.stringify(args));
      assert.equal(r.stdout, '', JSON.stringify(args));
      assert.equal(r.stderr.trim(), `forja: ${INVALID_DIAGNOSTIC_FILTERS}`, JSON.stringify(args));
    }
  }
  const control = cli(absent, ['--invocation', '2']);
  assert.notEqual(control.status, 0);
  assert.doesNotMatch(control.stderr, /Invalid diagnostic filters/);
  assert.equal(existsSync(absent), false);
  assert.deepEqual(readFileSync(join(root, '.forja/current.json')), before);
});

test('CLI diagnose with selectors never launches a provider executable', t => {
  const root = fixture(t), shims = join(root, 'shims'), marker = join(shims, 'called');
  mkdirSync(shims);
  for (const name of ['codex', 'claude']) {
    writeFileSync(join(shims, `${name}.cmd`), `@echo called> "${marker}"\r\n`);
    writeFileSync(join(shims, name), `#!/bin/sh\necho called > "${marker}"\n`);
    chmodSync(join(shims, name), 0o755);
  }
  const env = { ...process.env, PATH: `${shims}${delimiter}${process.env.PATH || process.env.Path || ''}`, Path: undefined };
  for (const args of [[], ['--invocation', '2', '--phase', 'develop'], ['--phase', 'review']]) {
    const r = cli(root, args, Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)));
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(existsSync(marker), false);
});

test('cliDiagnosticFilters translates canonical text to API options', () => {
  assert.deepEqual(cliDiagnosticFilters({}), {});
  assert.deepEqual(cliDiagnosticFilters({ project: 'x', details: true }), {});
  assert.deepEqual(cliDiagnosticFilters({ invocation: '2' }), { invocationId: 2 });
  assert.deepEqual(cliDiagnosticFilters({ invocation: '99', phase: 'plan' }), { invocationId: 99, phase: 'plan' });
  for (const id of ['1', '9', '10', '100', '199', '200']) assert.equal(cliDiagnosticFilters({ invocation: id }).invocationId, Number(id));
  for (const opt of [{ invocation: true }, { phase: true }, { invocation: 2 }, { invocation: '' }, { phase: '' }, { phase: 'constructor' }, { invocation: '1\n' }]) {
    assert.throws(() => cliDiagnosticFilters(opt), e => e.message === INVALID_DIAGNOSTIC_FILTERS);
  }
});
