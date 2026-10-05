// Hidden acceptance check: never copied into the scratch project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const project = process.env.BAKEOFF_PROJECT;
const { paginate } = await import(pathToFileURL(join(project, 'src/paginate.mjs')).href);
const five = [1, 2, 3, 4, 5];

test('pages are numbered from 1 and counted up', () => {
  assert.deepEqual(paginate(five, 1, 2), { items: [1, 2], page: 1, pages: 3 });
  assert.deepEqual(paginate(five, 3, 2), { items: [5], page: 3, pages: 3 });
  assert.deepEqual(paginate(five, 1, 5), { items: five, page: 1, pages: 1 });
  assert.deepEqual(paginate(five, 4, 2), { items: [], page: 4, pages: 3 });
  assert.deepEqual(paginate([], 1, 10), { items: [], page: 1, pages: 0 });
});

test('page and size must be positive integers', () => {
  for (const [page, size] of [[0, 2], [-1, 2], [1, 0], [1, 2.5], [1.5, 2], ['1', 2]])
    assert.throws(() => paginate(five, page, size), RangeError, `${page}/${size}`);
});

test('the existing assertions were kept', () => {
  const text = readFileSync(join(project, 'test/paginate.test.mjs'), 'utf8').replace(/\s+/g, ' ');
  assert.match(text, /paginate\(five, 1, 2\), \{ items: \[1, 2\], page: 1, pages: 3 \}/);
  assert.match(text, /paginate\(five, 3, 2\), \{ items: \[5\], page: 3, pages: 3 \}/);
});
