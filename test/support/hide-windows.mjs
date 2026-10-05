// Test preload: on Windows, every child process started by the test suite
// defaults to `windowsHide: true`, so a run from a parent without a console
// does not flash a console window per child. Production code in lib/ already
// passes the option itself; this covers tests and the helpers they use.
// Loaded with `node --import ./test/support/hide-windows.mjs --test ...`.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

// Functions whose second argument may be an argv array.
const WITH_ARGV = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
// Functions whose options come right after the command string.
const WITHOUT_ARGV = ['exec', 'execSync'];

const isOptions = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Returns a copy of `args` (the call's arguments) whose options object has
// `windowsHide: true` unless the caller set `windowsHide` explicitly.
export function withWindowsHide(args, hasArgv) {
  const out = [...args];
  let i = 1;
  if (hasArgv && (Array.isArray(out[i]) || (out[i] == null && i + 1 < out.length && !isOptions(out[i])))) i++;
  const options = out[i];
  if (isOptions(options)) {
    if (!Object.hasOwn(options, 'windowsHide')) out[i] = { ...options, windowsHide: true };
  } else if (options == null && i < out.length) {
    out[i] = { windowsHide: true };
  } else {
    out.splice(i, 0, { windowsHide: true });
  }
  return out;
}

const PATCHED = Symbol.for('forja.test.windowsHide');

// Wraps the child_process functions of `target` in place. Idempotent.
export function install(target = childProcess, platform = process.platform) {
  if (platform !== 'win32' || target[PATCHED]) return false;
  for (const [names, hasArgv] of [[WITH_ARGV, true], [WITHOUT_ARGV, false]]) {
    for (const name of names) {
      const original = target[name];
      if (typeof original !== 'function') continue;
      const wrapped = function (...args) { return original.apply(this, withWindowsHide(args, hasArgv)); };
      if (original[promisify.custom]) {
        const custom = original[promisify.custom];
        wrapped[promisify.custom] = (...args) => custom(...withWindowsHide(args, hasArgv));
      }
      target[name] = wrapped;
    }
  }
  target[PATCHED] = true;
  return true;
}

if (install()) syncBuiltinESMExports();
