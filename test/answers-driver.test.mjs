import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLock, lockPath } from '../lib/runner.mjs';
import { mutexPath } from '../lib/driver.mjs';

const cli = resolve('bin/forja.mjs');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forja-answers-driver-'));
  const cleanup = [];
  t.after(async () => {
    try { for (const dispose of cleanup.toReversed()) await dispose(); }
    finally { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); }
  });
  const project = join(root, 'project'), data = join(root, 'data'); mkdirSync(project); mkdirSync(data);
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_TOPIC: '' };
  for (const key of ['FORJA_RUNNER', 'FORJA_PROJECT_ROOT', 'CLAUDE_CODE_SESSION_ID']) delete env[key];
  const call = args => spawnSync(process.execPath, [cli, ...args], { cwd: project, env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const runFile = join(project, 'docs/forja/RUN.json');
  return { root, project, data, env, call, runFile, cleanup, read: () => JSON.parse(readFileSync(runFile)) };
}
async function pausedAnswers(f, targetRead = 1) {
  const marker = join(f.root, 'read.done'), release = join(f.root, 'read.release'), preload = join(f.root, 'pause.mjs');
  // Pause a selected RUN.json read after capturing its bytes. The first read
  // tests stale snapshots; the second checks the critical section itself.
  writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.readFileSync;let reads=0;
fs.readFileSync=function(path,...args){const value=original.call(this,path,...args);if(String(path)===process.env.TEST_RUN&&++reads===Number(process.env.TEST_READ)){fs.writeFileSync(process.env.TEST_MARK,'ready');const until=Date.now()+30000;while(!fs.existsSync(process.env.TEST_RELEASE)){if(Date.now()>until)throw Error('test barrier timed out');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);}}return value;};syncBuiltinESMExports();`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'answers'], { cwd: f.project, env: { ...f.env, TEST_RUN: f.runFile, TEST_READ: String(targetRead), TEST_MARK: marker, TEST_RELEASE: release }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
  const exited = new Promise((res, rej) => { child.on('error', rej); child.on('close', code => res({ code, output })); });
  f.cleanup.push(async () => { writeFileSync(release, 'release'); if (child.exitCode === null) child.kill(); await exited; });
  const until = Date.now() + 20000;
  while (!existsSync(marker) && Date.now() < until && child.exitCode === null) await new Promise(r => setTimeout(r, 20));
  assert.ok(existsSync(marker), output || 'answers reached snapshot barrier');
  return async () => { writeFileSync(release, 'release'); return exited; };
}

for (const mode of ['pending', 'owner', 'replacement']) test(`answers preserves a concurrent ${mode} transition`, async t => {
  const f = fixture(t);
  const start = f.call(['run', 'start', '--goal', 'Synthetic handoff', '--driver', mode === 'pending' ? 'runner' : 'interactive']);
  assert.equal(start.status, 0, start.stderr);
  let decoy;
  if (mode === 'pending') {
    decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', '--', 'forja.mjs', 'runner'], { windowsHide: true, stdio: 'ignore' });
    const closed = new Promise(r => decoy.on('close', r));
    f.cleanup.push(async () => { decoy.kill(); await closed; });
    acquireLock(lockPath(f.project, join(f.data, 'runner')), { pid: decoy.pid, project: f.project, runId: f.read().run_id, alive: () => true });
  }
  const release = await pausedAnswers(f);
  const changed = f.call(mode === 'replacement' ? ['run', 'start', '--goal', 'Replacement run', '--force'] : ['run', 'driver', 'set', mode === 'pending' ? 'interactive' : 'runner']);
  assert.equal(changed.status, 0, changed.stderr);
  const expected = f.read(), result = await release(), actual = f.read();
  assert.equal(actual.run_id, expected.run_id, result.output);
  assert.equal(actual.driver, expected.driver, result.output);
  assert.deepEqual(actual.driver_request, expected.driver_request, result.output);
  assert.deepEqual(actual.checkpoints, expected.checkpoints, result.output);
  assert.equal(result.code, mode === 'replacement' ? 1 : 0, result.output);
  if (mode === 'replacement') assert.deepEqual(actual, expected, 'replacement state is untouched');
  assert.equal(existsSync(mutexPath(f.project, f.data)), false, 'mutex released on success or refusal');
});

test('answers still applies a queued answer once under the claim mutex', t => {
  const f = fixture(t);
  assert.equal(f.call(['run', 'start', '--goal', 'Synthetic answers']).status, 0);
  assert.equal(f.call(['ask', 'Choose format', '--default', 'JSON', '--why', 'Contract choice']).status, 0);
  mkdirSync(join(f.data, 'answers'), { recursive: true });
  writeFileSync(join(f.data, 'answers/project.jsonl'), JSON.stringify({ id: 'Q1', answer: 'JSON', ts: '2026-01-01T00:00:00.000Z' }) + '\n');
  for (const applied of [1, 0]) {
    const result = f.call(['answers']); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).applied, applied);
  }
  assert.equal(f.read().answers_applied.length, 1);
});


test('answers holds the claim mutex while reading fresh state', async t => {
  const f = fixture(t);
  assert.equal(f.call(['run', 'start', '--goal', 'Synthetic mutex']).status, 0);
  const release = await pausedAnswers(f, 2);
  const lock = mutexPath(f.project, f.data);
  assert.ok(existsSync(lock), 'fresh state is read inside the claim mutex');
  assert.equal((await release()).code, 0);
  assert.equal(existsSync(lock), false, 'mutex is released after applying answers');
});
