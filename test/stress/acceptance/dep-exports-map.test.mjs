// Hidden acceptance check: never copied into the scenario project.
// The package is judged as a consumer sees it: copied into a consumer's
// node_modules and imported by name. Negative case: private files stay
// unreachable, so the exports map must be kept, not deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PROJECT, assertOwnSuite } from './_helpers.mjs';

const consumer = mkdtempSync(join(tmpdir(), 'stress-consumer-'));
mkdirSync(join(consumer, 'node_modules'));
cpSync(PROJECT, join(consumer, 'node_modules', 'routekit'), { recursive: true, filter: src => !['.git', 'node_modules'].includes(basename(src)) });
writeFileSync(join(consumer, 'package.json'), '{ "name": "consumer", "private": true, "type": "module" }\n');

let n = 0;
function consume(code) {
  const file = join(consumer, `check-${++n}.mjs`);
  writeFileSync(file, code);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const out = spawnSync(process.execPath, [file], { cwd: consumer, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { ok: out.status === 0, stdout: (out.stdout ?? '').trim(), stderr: out.stderr ?? '' };
}
const assertRuns = (code, expected) => {
  const res = consume(code);
  assert.ok(res.ok, res.stderr.slice(0, 800));
  assert.equal(res.stdout, expected);
};

test('the main entry point works for a consumer', () => {
  assertRuns(`import { createApp, parseQuery, createLru, HttpError } from 'routekit';
const app = createApp().route('GET', '/u/:id', ctx => ({ body: ctx.params.id }));
const res = await app.handle({ url: '/u/7' });
console.log([res.body, parseQuery('a=1').a, typeof createLru, typeof HttpError].join(','));`, '7,1,function,function');
});

test('the documented subpaths work', () => {
  assertRuns(`import { createRouter } from 'routekit/router';
import { parseQuery, stringifyQuery } from 'routekit/query';
console.log([typeof createRouter, parseQuery('t=a&t=b').t.join('+'), stringifyQuery({ x: 1 })].join(','));`, 'function,a+b,x=1');
  assertRuns(`import pkg from 'routekit/package.json' with { type: 'json' };
console.log(pkg.name);`, 'routekit');
});

test('private files stay unreachable', () => {
  const res = consume(`try { await import('routekit/src/cache.mjs'); console.log('reachable'); } catch (error) { console.log(error.code); }`);
  assert.ok(res.ok, res.stderr.slice(0, 800));
  assert.equal(res.stdout, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
});

test("the project's own tests pass", () => assertOwnSuite(assert, 12));
