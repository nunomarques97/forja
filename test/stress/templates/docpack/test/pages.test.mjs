import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadPage, pageUrl, relativeUrl } from '../src/pages.mjs';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));

test('page URLs and relative links', () => {
  assert.equal(pageUrl('guide/install.md'), 'guide/install.html');
  assert.equal(relativeUrl('guide/install.html', 'index.html'), '../index.html');
  assert.equal(relativeUrl('index.html', 'guide/config.html'), 'guide/config.html');
  assert.equal(relativeUrl('guide/install.html', ''), '../');
});

test('front matter gives the title and draft flag', () => {
  const install = loadPage(SITE, 'guide/install.md');
  assert.equal(install.title, 'Installing');
  assert.equal(install.draft, false);
  assert.match(install.html, /<h1>Installing docpack<\/h1>/);
  assert.equal(loadPage(SITE, 'guide/config.md').title, 'Configuration: docpack.json');
  assert.equal(loadPage(SITE, 'roadmap.md').draft, true);
  assert.equal(loadPage(SITE, 'index.md').title, 'Docpack');
});
