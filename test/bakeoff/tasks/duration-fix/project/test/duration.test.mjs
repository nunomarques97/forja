import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.mjs';

test('single units', () => {
  assert.equal(parseDuration('45s'), 45);
  assert.equal(parseDuration('2m'), 120);
});
