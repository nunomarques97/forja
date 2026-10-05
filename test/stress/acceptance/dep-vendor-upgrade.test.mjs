// Hidden acceptance check: never copied into the scenario project.
// The upgraded vendor copy stays as released; our code adapts to it,
// including the values that are no longer coerced ("draft: false").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwnSuite, assertUnchanged, load, projectPath } from './_helpers.mjs';

const site = mkdtempSync(join(tmpdir(), 'stress-vendor-'));
mkdirSync(join(site, 'docs'));
writeFileSync(join(site, 'docs', 'docpack.json'), JSON.stringify({ title: 'Upgrade', nav: ['index.md', 'live.md', 'hidden.md', 'plans.md'] }));
writeFileSync(join(site, 'docs', 'index.md'), '# Home\n\nWelcome.\n');
writeFileSync(join(site, 'docs', 'live.md'), '---\ntitle: Live page\ndraft: false\n---\n\n# Ignored heading\n\nText.\n');
writeFileSync(join(site, 'docs', 'hidden.md'), '---\r\ntitle: Hidden\r\ndraft: true\r\n---\r\n\r\nUnpublished plans.\r\n');
writeFileSync(join(site, 'docs', 'plans.md'), '---\ntitle: 2027\n---\n\nPlans.\n');

test('the vendored 2.0.0 release is kept unchanged', () => {
  for (const file of ['index.mjs', 'package.json', 'CHANGELOG.md']) assertUnchanged(assert, `vendor/frontmatter/${file}`, 'dep-vendor-upgrade');
  assert.equal(JSON.parse(readFileSync(projectPath('vendor/frontmatter/package.json'), 'utf8')).version, '2.0.0');
});

test('pages read their front matter through the new API', async () => {
  const { loadPage } = await load('src/pages.mjs');
  const docs = join(site, 'docs');
  assert.equal(loadPage(docs, 'live.md').title, 'Live page');
  assert.equal(loadPage(docs, 'live.md').draft, false);
  assert.equal(loadPage(docs, 'hidden.md').draft, true);
  assert.equal(loadPage(docs, 'index.md').title, 'Home');
  assert.equal(loadPage(docs, 'plans.md').title, '2027');
});

test('the build skips drafts only', async () => {
  const { build } = await load('src/build.mjs');
  const out = join(site, 'out');
  build({ src: join(site, 'docs'), out });
  assert.equal(readFileSync(join(out, 'sitemap.txt'), 'utf8').trim().split(/\r?\n/).join(','), 'index.html,live.html,plans.html');
  assert.equal(existsSync(join(out, 'hidden.html')), false);
  assert.match(readFileSync(join(out, 'live.html'), 'utf8'), /<title>Live page - Upgrade<\/title>/);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 7));
