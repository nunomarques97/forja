import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../src/build.mjs';
import { normalizeEntry } from '../src/config.mjs';

test('nav entries may use Windows separators', () => {
  assert.equal(normalizeEntry('guide\\install.md'), 'guide/install.md');
  assert.equal(normalizeEntry('.\\faq.md'), 'faq.md');
  const src = mkdtempSync(join(tmpdir(), 'docpack-nav-'));
  mkdirSync(join(src, 'guide'));
  writeFileSync(join(src, 'index.md'), '# Home');
  writeFileSync(join(src, 'guide', 'install.md'), '# Install');
  writeFileSync(join(src, 'docpack.json'), JSON.stringify({ nav: ['index.md', 'guide\\install.md'] }));
  const out = join(src, 'out');
  assert.deepEqual(build({ src, out }), ['index.html', 'guide/install.html']);
  assert.match(readFileSync(join(out, 'guide', 'install.html'), 'utf8'), /href="\.\.\/style\.css"/);
});
