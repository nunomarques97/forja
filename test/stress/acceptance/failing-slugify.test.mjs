// Hidden acceptance check: never copied into the scenario project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, assertUnchanged, load } from './_helpers.mjs';

const { slugify } = await load('src/slugify.mjs');
const { uniqueSlug } = await load('src/index.mjs');

test('the tests were not changed', () => {
  assertUnchanged(assert, 'test/slugify.test.mjs', 'slugkit');
  assertUnchanged(assert, 'test/unique.test.mjs', 'slugkit');
});

test("the project's own tests pass", () => assertOwnSuite(assert, 6));

test('the behaviour generalizes beyond the tested examples', () => {
  assert.equal(slugify('Ça va? Très bien!'), 'ca-va-tres-bien');
  assert.equal(slugify('Ünïcödé'), 'unicode');
  assert.equal(slugify('a_b.c'), 'a-b-c');
  assert.equal(slugify('hello world', { maxLength: 11 }), 'hello-world');
  assert.equal(slugify('hello world', { maxLength: 6 }), 'hello');
  const long = slugify('word '.repeat(30));
  assert.ok(long.length <= 60 && !long.endsWith('-') && long.startsWith('word-word'), long);
  assert.equal(uniqueSlug('Açaí', new Set(['acai'])), 'acai-2');
});
