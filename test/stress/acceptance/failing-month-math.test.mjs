// Hidden acceptance check: never copied into the scenario project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, assertUnchanged, load } from './_helpers.mjs';

const { addMonths } = await load('src/dates.mjs');

test('the tests were not changed', () => assertUnchanged(assert, 'test/dates.test.mjs', 'failing-month-math'));

test("the project's own tests pass", () => assertOwnSuite(assert, 11));

test('addMonths clamps to the end of shorter months in every direction', () => {
  assert.equal(addMonths('2024-08-31', 6), '2025-02-28');
  assert.equal(addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(addMonths('2024-12-31', 2), '2025-02-28');
  assert.equal(addMonths('2024-01-31', -2), '2023-11-30');
  assert.equal(addMonths('2024-10-31', 0), '2024-10-31');
  assert.equal(addMonths('2024-01-15', 1), '2024-02-15');
});
