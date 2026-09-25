import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLaunchProblem, checkCommandProblem, npmCli } from '../lib/core/check-commands.mjs';

// A synthetic Windows layout: PATH lookups run against real temporary files,
// with the platform injected, so this runs on every host.
function layout(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-check-commands-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), project = join(root, 'project'), manager = join(root, 'manager');
  for (const dir of [bin, project, join(project, 'node_modules', '.bin'), join(manager, 'node_modules', 'npm', 'bin')]) mkdirSync(dir, { recursive: true });
  for (const file of [join(bin, 'npx.cmd'), join(bin, 'yarn.bat'), join(bin, 'git.exe'), join(bin, 'both.cmd'), join(bin, 'both.exe'),
    join(project, 'node_modules', '.bin', 'tsc'), join(project, 'node_modules', '.bin', 'tsc.cmd'), join(manager, 'npm.cmd'),
    join(manager, 'node_modules', 'npm', 'bin', 'npm-cli.js')]) writeFileSync(file, '');
  const options = { platform: 'win32', env: { Path: bin }, cwd: project, execPath: join(root, 'node', 'node.exe') };
  return { bin, project, manager, options };
}
const check = command => ({ command, args: [] });

test('Windows .cmd/.bat shims are refused before any task with actionable guidance', t => {
  const { options } = layout(t);
  for (const command of ['npx', 'yarn', 'node_modules/.bin/tsc', 'pnpm.cmd', 'tool.BAT']) {
    const problem = checkLaunchProblem(check(command), 'Task T1 checks[0]', options);
    assert.match(problem ?? '', /^Task T1 checks\[0\] command is a \.cmd\/\.bat shim on Windows/, command);
    assert.match(problem, /node node_modules\/typescript\/bin\/tsc/);
  }
  for (const command of ['node', 'git', 'git.exe', 'both'])
    assert.equal(checkLaunchProblem(check(command), 'label', options), null, command);
  assert.doesNotMatch(checkLaunchProblem(check('npx'), 'label', { ...options, platform: 'linux' }), /shim/, 'other platforms have no shims');
});

test('a check whose executable resolves nowhere is refused, unless a task creates that path', t => {
  const { bin, project, options } = layout(t);
  for (const command of ['.venvScriptspython.exe', 'missing-tool'])
    assert.match(checkLaunchProblem(check(command), 'Task T1 checks[0]', options) ?? '', new RegExp(`^Task T1 checks\\[0\\] command "${command.replaceAll('.', '\\.')}" was not found on PATH or in the project root`), command);
  writeFileSync(join(project, 'local.exe'), '');
  assert.equal(checkLaunchProblem(check('local'), 'label', options), null, 'Windows also searches the project root');
  for (const command of ['.venv/Scripts/python.exe', '.venv\\Scripts\\python', 'C:/tools/custom.exe'])
    assert.match(checkLaunchProblem(check(command), 'label', options) ?? '', /does not exist relative to the project root, and no task files scope covers it/, command);
  const creator = [{ id: 'T0', files: ['.venv/'], checks: [] }];
  assert.equal(checkLaunchProblem(check('.venv/Scripts/python.exe'), 'label', { ...options, tasks: creator }), null);
  assert.equal(checkLaunchProblem(check('.venv\\Scripts\\python'), 'label', { ...options, tasks: creator }), null);
  assert.match(checkLaunchProblem(check('../outside.exe'), 'label', { ...options, tasks: [{ id: 'T0', files: ['.'] }] }) ?? '', /does not exist/);

  const linux = { ...options, platform: 'linux', env: { PATH: `/nowhere:${bin}` } };
  writeFileSync(join(bin, 'pytest'), '');
  assert.equal(checkLaunchProblem(check('pytest'), 'label', linux), null);
  assert.equal(checkLaunchProblem(check('npm'), 'label', linux), null);
  assert.match(checkLaunchProblem(check('local'), 'label', linux), /was not found on PATH\. /, 'POSIX does not search the project root');
  assert.match(checkCommandProblem([{ id: 'T2', checks: [check('node'), check('missing-tool')] }], {}, linux), /^Task T2 checks\[1\] command "missing-tool"/);
});

test('npm checks resolve npm-cli.js beside node or beside npm.cmd on PATH, or are refused', t => {
  const { manager, options } = layout(t);
  assert.match(checkLaunchProblem(check('npm'), 'finalChecks[0]', options), /^finalChecks\[0\] uses npm, but npm-cli\.js was found neither/);
  const managed = { ...options, env: { Path: `${options.env.Path};${manager}` } };
  assert.equal(npmCli(managed), join(manager, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  assert.equal(checkLaunchProblem(check('npm'), 'finalChecks[0]', managed), null);
});

test('a run is checked across task and final checks, except inside the Linux sandbox', t => {
  const { options } = layout(t);
  const tasks = [{ id: 'T1', checks: [check('node'), check('npx')] }];
  assert.match(checkCommandProblem(tasks, {}, options), /^Task T1 checks\[1\]/);
  assert.match(checkCommandProblem([], { finalChecks: [check('yarn')] }, options), /^finalChecks\[0\]/);
  assert.equal(checkCommandProblem(tasks, { checkIsolation: { backend: 'bubblewrap' } }, options), null);
});
