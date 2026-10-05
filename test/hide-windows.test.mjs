import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import * as named from 'node:child_process';
import { withWindowsHide, install } from './support/hide-windows.mjs';

test('the default windowsHide is added to every call shape and an explicit value is kept', () => {
  const cb = () => {};
  assert.deepEqual(withWindowsHide(['git'], true), ['git', { windowsHide: true }]);
  assert.deepEqual(withWindowsHide(['git', ['status']], true), ['git', ['status'], { windowsHide: true }]);
  assert.deepEqual(withWindowsHide(['git', ['status'], { cwd: 'x' }], true), ['git', ['status'], { cwd: 'x', windowsHide: true }]);
  assert.deepEqual(withWindowsHide(['git', { cwd: 'x' }], true), ['git', { cwd: 'x', windowsHide: true }]);
  assert.deepEqual(withWindowsHide(['git', null, { cwd: 'x' }], true), ['git', null, { cwd: 'x', windowsHide: true }]);
  assert.deepEqual(withWindowsHide(['git', ['status'], cb], true), ['git', ['status'], { windowsHide: true }, cb]);
  assert.deepEqual(withWindowsHide(['git', cb], true), ['git', { windowsHide: true }, cb]);
  assert.deepEqual(withWindowsHide(['dir', cb], false), ['dir', { windowsHide: true }, cb]);
  assert.deepEqual(withWindowsHide(['dir', { cwd: 'x' }, cb], false), ['dir', { cwd: 'x', windowsHide: true }, cb]);
  // An explicit value, false included, is never overridden.
  assert.deepEqual(withWindowsHide(['git', ['status'], { windowsHide: false }], true), ['git', ['status'], { windowsHide: false }]);
  assert.deepEqual(withWindowsHide(['dir', { windowsHide: false }], false), ['dir', { windowsHide: false }]);
  // The caller's options object is not mutated.
  const options = { cwd: 'x' };
  withWindowsHide(['git', [], options], true);
  assert.deepEqual(options, { cwd: 'x' });
});

test('install wraps child_process functions on Windows only, including promisify', async () => {
  const calls = [];
  const record = name => (...args) => { calls.push([name, args]); return name; };
  const fake = { spawn: record('spawn'), execSync: record('execSync'), execFile: record('execFile') };
  fake.execFile[promisify.custom] = async (...args) => { calls.push(['execFile.promise', args]); return { stdout: '' }; };
  assert.equal(install({ ...fake }, 'linux'), false);
  assert.equal(install(fake, 'win32'), true);
  assert.equal(install(fake, 'win32'), false, 'second install is a no-op');
  fake.spawn('git', ['status']);
  fake.spawn('git', ['status'], { windowsHide: false });
  fake.execSync('dir');
  await promisify(fake.execFile)('git', ['status']);
  assert.deepEqual(calls, [
    ['spawn', ['git', ['status'], { windowsHide: true }]],
    ['spawn', ['git', ['status'], { windowsHide: false }]],
    ['execSync', ['dir', { windowsHide: true }]],
    ['execFile.promise', ['git', ['status'], { windowsHide: true }]],
  ]);
});

const preloaded = process.execArgv.some(arg => arg.includes('hide-windows'));

test('under the test preload the named ESM exports are the wrapped functions on Windows', { skip: process.platform !== 'win32' || !preloaded }, () => {
  assert.equal(named.default[Symbol.for('forja.test.windowsHide')], true);
  assert.equal(named.spawnSync, named.default.spawnSync, 'named import sees the wrapper');
  assert.equal(named.spawnSync.name, 'wrapped');
});
