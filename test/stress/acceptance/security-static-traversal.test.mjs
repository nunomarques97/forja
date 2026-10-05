// Hidden acceptance check: never copied into the scenario project.
// Negative cases: no URL reaches a file outside the root (sibling folder with
// the same prefix, encoded dots and separators, backslashes, absolute paths,
// NUL bytes, malformed encoding); normal files keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwnSuite, load } from './_helpers.mjs';

const { createStaticHandler } = await load('src/static.mjs');

const site = mkdtempSync(join(tmpdir(), 'stress-filedrop-'));
mkdirSync(join(site, 'public', 'docs'), { recursive: true });
mkdirSync(join(site, 'public-old'));
writeFileSync(join(site, 'public', 'index.html'), '<h1>home</h1>');
writeFileSync(join(site, 'public', 'style.css'), 'body{}');
writeFileSync(join(site, 'public', 'docs', 'index.html'), '<h1>docs</h1>');
writeFileSync(join(site, 'public', 'docs', 'release notes.txt'), 'notes');
writeFileSync(join(site, 'public-old', 'leak.txt'), 'LEAKED-OLD');
writeFileSync(join(site, 'private.txt'), 'LEAKED-PRIVATE');
const handle = createStaticHandler(join(site, 'public'));

const attacks = [
  '/../public-old/leak.txt',
  '/%2e%2e/public-old/leak.txt',
  '/..%2fpublic-old%2fleak.txt',
  '/..%5cpublic-old%5cleak.txt',
  '/docs/../../public-old/leak.txt',
  '/../private.txt',
  '/%2E%2E%2Fprivate.txt',
  '/..%5c..%5cprivate.txt',
  `/${encodeURIComponent(join(site, 'private.txt'))}`,
  `/${join(site, 'private.txt').replace(/\\/g, '/')}`,
  '/index.html%00.txt',
  '/%E0%A4%A',
];

for (const url of attacks) {
  test(`blocked: ${url.replace(site, '<site>')}`, () => {
    let res;
    assert.doesNotThrow(() => { res = handle({ method: 'GET', url }); });
    assert.ok([400, 403, 404].includes(res.status), `status ${res.status}`);
    assert.doesNotMatch(String(res.body ?? ''), /LEAKED/);
  });
}

test('normal files still work', () => {
  assert.match(String(handle({ url: '/' }).body), /home/);
  assert.match(String(handle({ url: '/docs/' }).body), /docs/);
  assert.equal(String(handle({ url: '/docs/release%20notes.txt' }).body), 'notes');
  const css = handle({ url: '/style.css?v=2' });
  assert.equal(css.status, 200);
  assert.equal(String(css.body), 'body{}');
  assert.equal(handle({ url: '/missing.txt' }).status, 404);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 4));
