// Regression coverage for command preflight and persisted-state compatibility.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRun, drive, current, validatePlan, validateState, recoverRun } from '../lib/core/engine.mjs';
import { validateFinalChecks } from '../lib/core/quality.mjs';
const dirs = [];
after(() => { for (const p of dirs) rmSync(p, { recursive: true, force: true }); });
function repo() {
  const p = mkdtempSync(join(tmpdir(), 'forja-preflight-'));
  dirs.push(p);
  const git = args => execFileSync('git', args, { cwd: p, stdio: 'pipe' });
  git(['init', '-q']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(p, '.gitignore'), '.forja/\n');
  writeFileSync(join(p, 'value.mjs'), 'export const value=1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
  return p;
}
const good = { command: 'node', args: ['--version'] };
const task = (check = good, id = 'T1') => ({
  id, title: 'Preserve execution contract',
  criteria: ['Reject unresolved check targets before development'],
  files: ['value.mjs'], risks: [], complexity: 'easy', after: [], checks: [check],
});
const plan = check => ({ decisions: [], tasks: [task(check)] });
const invalid=[
 ['blank executable',{command:'   ',args:[]}],
 ['NUL executable',{command:'no\0de',args:[]}],
 ['NUL argument',{command:'node',args:['a\0b']}],
 ['executable marker',{command:'<browser>',args:[]}],
 ['standalone marker',{command:'node',args:['probe.mjs','<port>']}],
 ['flag marker',{command:'node',args:['probe.mjs','--port=<port>']}],
 ['URL port marker',{command:'node',args:['probe.mjs','http://127.0.0.1:<authenticated-port>/core']}],
 ['URL host marker',{command:'node',args:['probe.mjs','https://<host>/health']}],
 ['path marker',{command:'node',args:['probe.mjs','screens/<viewport>.png']}],
];
for (const [name, command, args, accepted] of [
  ['URL in flag', 'node', ['probe.mjs', '--url=http://127.0.0.1:<port>/core'], false],
  ['leading path marker', 'node', ['<root>/probe.mjs'], false],
  ['Windows path marker', 'node', ['tools\\<probe>.mjs'], false],
  ['non-interpreter -e option', 'curl', ['-e', '<host>'], false],
  ['script-owned -p option', 'node', ['probe.mjs', '-p', '<port>'], false],
  ['HTML source argument', 'node', ['probe.mjs', '<div>.hello</div>'], true],
  ['inline URL template data', 'node', ['-e', 'const url="http://<host>:<port>/"; console.log(url)'], true],
  ['inline path template data', 'node', ['-e', 'console.log("screens/<viewport>.png")'], true],
  ['comparison without spaces', 'node', ['-e', 'let a=1,b=2,c=3; console.log(a<b>c)'], true],
  ['concrete IPv6 URL', 'node', ['probe.mjs', 'http://[::1]:4317/core'], true],
]) {
  test(`target boundary: ${name}`, () => {
    const validate = () => validateFinalChecks({ finalChecks: [{ command, args }] });
    if (accepted) assert.doesNotThrow(validate);
    else assert.throws(validate, /placeholder/);
  });
}

test('preflight diagnostics identify the check without copying argument data', () => {
  for (const value of ['https://private-user:private-pass@<host>/?secret=private-value', 'private-value\0<port>']) {
    assert.throws(
      () => validateFinalChecks({ finalChecks: [good, { command: 'node', args: ['probe.mjs', value] }] }),
      error => {
        assert.match(error.message, /finalChecks\[1\] args\[1\]/);
        assert.doesNotMatch(error.message, /private-|\0/);
        return true;
      },
    );
  }
});
for (const [name, check] of invalid) {
  test(`reject ${name} for supplied plans and final checks before writing state`, () => {
    const p = repo();
    assert.throws(() => validatePlan(plan(check), p));
    assert.throws(() => validateFinalChecks({ finalChecks: [check] }));
    assert.throws(() => createRun(p, { goal: 'Validate', plan: plan(check) }));
    assert.equal(existsSync(current(p)), false);
    assert.throws(() => createRun(p, { goal: 'Validate', config: { finalChecks: [check] } }));
    assert.equal(existsSync(current(p)), false);
  });
}

test('allow source, concrete addresses and future helper paths without executing them', () => {
  const p = repo();
  const marker = join(p, 'executed.txt');
  const checks = [
    good,
    { command: 'node', args: ['-e', 'const x="<div>hello</div>"; if (x.length < 2) process.exit(1)'] },
    { command: 'node', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] },
    { command: 'node', args: ['tools/not-created-yet.mjs', 'http://127.0.0.1:4317/core', '[::1]', '--output=reports/result.png', '{{literal}}', ''] },
  ];
  for (const check of checks) {
    assert.doesNotThrow(() => validatePlan(plan(check), p));
    assert.doesNotThrow(() => validateFinalChecks({ finalChecks: [check] }));
  }
  assert.equal(existsSync(marker), false);
});

test('reject generated invalid checks before work; preserve the raw plan', async () => {
  const p = repo();
  createRun(p, { goal: 'Validate checks' });
  const bad = plan(invalid[6][1]), calls = [];
  let checks = 0;
  const r = await drive(p, {
    log: () => {}, notifySponsor: async () => {},
    providerCall: async (_, o) => {
      calls.push(JSON.parse(o.text).phase);
      return { code: 0, result: bad, duration_ms: 1 };
    },
    runCheck: async () => { checks++; return { code: 0, stdout: '', stderr: '' }; },
  });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(calls, ['plan']);
  assert.equal(checks, 0);
  assert.equal(r.invocations, 1);
  assert.equal(r.tasks.length, 0);
  assert.match(r.failure, /check|placeholder|command/i);
  assert.deepEqual(JSON.parse(readFileSync(join(p, '.forja', 'runs', r.run_id, 'call-1-result.json'))), bad);
});

test('an invalid later task blocks the whole plan before the first developer', async () => {
  const p = repo();
  createRun(p, { goal: 'Validate all tasks' });
  const bad = plan(good), calls = [];
  bad.tasks.push({ ...task(invalid[6][1], 'T2'), after: ['T1'] });
  const r = await drive(p, {
    log: () => {}, notifySponsor: async () => {},
    providerCall: async (_, o) => {
      calls.push(JSON.parse(o.text).phase);
      return { code: 0, result: bad, duration_ms: 1 };
    },
    runCheck: async () => ({ code: 0 }),
  });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(calls, ['plan']);
  assert.equal(r.tasks.length, 0);
});

for (const where of ['task', 'final']) {
  test(`legacy ${where} placeholders remain readable/abandonable; resume spends no calls`, async () => {
    const p = repo();
    const r = createRun(p, { goal: 'Legacy fixture', plan: plan(good) });
    if (where === 'task') r.tasks[0].checks = [invalid[6][1]];
    else r.config.finalChecks = [invalid[6][1]];
    writeFileSync(current(p), JSON.stringify(r));
    assert.doesNotThrow(() => validateState(r, p));
    let calls = 0, checks = 0;
    const blocked = await drive(p, {
      log: () => {}, notifySponsor: async () => {},
      providerCall: async () => {
        calls++;
        return { code: 0, result: { status: 'approve', summary: '', findings: [] } };
      },
      runCheck: async () => { checks++; return { code: 0 }; },
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(calls, 0);
    assert.equal(checks, 0);
    assert.equal(blocked.tasks[0].attempts, 0);
    assert.deepEqual(blocked.tasks[0].checks, r.tasks[0].checks);
    assert.deepEqual(blocked.config.finalChecks, r.config.finalChecks);
    assert.doesNotThrow(() => recoverRun(p, { action: 'abandon', reason: 'Invalid legacy check, evidence retained' }));
    assert.equal(JSON.parse(readFileSync(current(p))).status, 'failed');
  });
}
