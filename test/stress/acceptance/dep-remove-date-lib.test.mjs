// Hidden acceptance check: never copied into the scenario project.
// The dependency is gone (not installed, not declared, not imported) and the
// month-end behaviour it was added for is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertOwnSuite, load, projectPath } from './_helpers.mjs';

const sources = dir => readdirSync(projectPath(dir), { recursive: true }).filter(f => /\.(m|c)?js$/.test(f)).map(f => join(dir, f));

test('package.json declares no runtime or development dependencies', () => {
  const pkg = JSON.parse(readFileSync(projectPath('package.json'), 'utf8'));
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])
    assert.deepEqual(Object.keys(pkg[key] ?? {}), [], key);
  assert.equal(pkg.name, 'tallybook');
  assert.equal(pkg.type, 'module');
});

test('no source or test file imports date-fns', () => {
  for (const file of [...sources('src'), ...sources('test')])
    assert.doesNotMatch(readFileSync(projectPath(file), 'utf8'), /(from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]date-fns/, file);
});

test('month arithmetic keeps clamping month ends', async () => {
  const { addMonths, parseDate } = await load('src/dates.mjs');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-08-31', 1), '2026-09-30');
  assert.equal(addMonths('2026-05-15', 12), '2027-05-15');
  assert.equal(addMonths('2026-02-10', -14), '2024-12-10');
  assert.throws(() => parseDate('2026-02-30'), { name: 'ParseError' });
});

test("the project's own tests pass", () => assertOwnSuite(assert, 11));
