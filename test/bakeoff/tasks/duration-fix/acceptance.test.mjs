// Hidden acceptance check: never copied into the scratch project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { parseDuration } = await import(pathToFileURL(join(process.env.BAKEOFF_PROJECT, 'src/duration.mjs')).href);

test('combined groups', () => {
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('2m5s'), 125);
  assert.equal(parseDuration('45s'), 45);
  assert.equal(parseDuration('1h0m1s'), 3601);
  assert.equal(parseDuration('3h'), 10800);
});

test('anything else throws RangeError', () => {
  for (const bad of ['', 'abc', '5x', '10', '1h30', 'h', '1.5h'])
    assert.throws(() => parseDuration(bad), RangeError, JSON.stringify(bad));
});
