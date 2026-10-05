import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/build.mjs';

const SITE = fileURLToPath(new URL('../site/', import.meta.url));

test('builds the sample site without drafts', () => {
  const out = mkdtempSync(join(tmpdir(), 'docpack-'));
  assert.deepEqual(build({ src: SITE, out }), ['index.html', 'guide/install.html', 'guide/config.html']);
  assert.equal(readFileSync(join(out, 'sitemap.txt'), 'utf8'), 'index.html\nguide/install.html\nguide/config.html\n');
  assert.equal(existsSync(join(out, 'roadmap.html')), false);
  assert.ok(existsSync(join(out, 'style.css')));
});

test('nested pages link back up', () => {
  const out = mkdtempSync(join(tmpdir(), 'docpack-'));
  build({ src: SITE, out });
  const html = readFileSync(join(out, 'guide', 'install.html'), 'utf8');
  assert.match(html, /<title>Installing - Docpack<\/title>/);
  assert.match(html, /href="\.\.\/style\.css"/);
  assert.match(html, /<a href="\.\.\/index\.html">Docpack<\/a>/);
  assert.match(html, /<a href="install\.html"|<a href="\.\.\/guide\/install\.html"/);
  assert.match(html, /<a href="\.\.\/index\.html">start page<\/a>/);
});
