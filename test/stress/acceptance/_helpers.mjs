// Shared by the hidden acceptance checks. STRESS_PROJECT names the scenario
// project under judgement; these files never enter it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT = process.env.STRESS_PROJECT;
if (!PROJECT) throw Error('Set STRESS_PROJECT to the scenario project to judge.');

const TEMPLATES = fileURLToPath(new URL('../templates/', import.meta.url));
export const projectPath = (...parts) => join(PROJECT, ...parts);
export const load = rel => import(pathToFileURL(projectPath(rel)).href);

// Summary line of node --test in the TAP ("# pass 3") or spec ("ℹ pass 3") reporter.
export const testCount = (text, key) => Number(String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').match(new RegExp(`^(?:# |ℹ )${key} (\\d+)`, 'm'))?.[1] ?? 0);

// The project's own suite, run as a developer would (node --test in its root).
export function ownSuite() {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const out = spawnSync(process.execPath, ['--test'], { cwd: PROJECT, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  return { ok: out.status === 0, pass: testCount(text, 'pass'), fail: testCount(text, 'fail'), text };
}

export function assertOwnSuite(assert, minPass = 1) {
  const suite = ownSuite();
  assert.ok(suite.ok && suite.fail === 0, `the project's own tests fail:\n${suite.text.slice(-1500)}`);
  assert.ok(suite.pass >= minPass, `expected at least ${minPass} passing tests, got ${suite.pass}`);
}

// A test file the scenario forbids changing, compared with its template copy
// (line endings ignored).
export function assertUnchanged(assert, rel, templateDir) {
  const norm = text => text.replace(/\r\n/g, '\n');
  assert.equal(norm(readFileSync(projectPath(rel), 'utf8')), norm(readFileSync(join(TEMPLATES, templateDir, rel), 'utf8')), `${rel} was changed`);
}

// Header lookup that ignores the case of the name.
export const header = (headers, name) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
