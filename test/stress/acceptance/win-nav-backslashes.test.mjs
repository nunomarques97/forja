// Hidden acceptance check: never copied into the scenario project.
// Nav entries typed on Windows must give the same site on every OS (the
// check fails untouched on Windows and on Linux). Negative case: a missing
// page is still reported by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOwnSuite, load } from './_helpers.mjs';

const { build } = await load('src/build.mjs');

function site(nav) {
  const src = mkdtempSync(join(tmpdir(), 'stress-nav-'));
  mkdirSync(join(src, 'guide', 'deep'), { recursive: true });
  writeFileSync(join(src, 'index.md'), '# Home\n\nSee [install](guide/install.md).\n');
  writeFileSync(join(src, 'faq.md'), '# FAQ\n');
  writeFileSync(join(src, 'guide', 'install.md'), '# Install\n');
  writeFileSync(join(src, 'guide', 'deep', 'tuning.md'), '# Tuning\n');
  writeFileSync(join(src, 'docpack.json'), JSON.stringify({ title: 'Nav', nav }));
  return src;
}
const hrefs = html => [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);

test('backslash and .\\ entries build the same site as forward slashes', () => {
  const src = site(['index.md', 'guide\\install.md', '.\\faq.md', 'guide\\deep\\tuning.md']);
  const out = join(src, 'out');
  build({ src, out });
  assert.equal(readFileSync(join(out, 'sitemap.txt'), 'utf8').trim().split(/\r?\n/).join(','), 'index.html,guide/install.html,faq.html,guide/deep/tuning.html');
  for (const page of ['index.html', 'faq.html', 'guide/install.html', 'guide/deep/tuning.html']) assert.ok(existsSync(join(out, ...page.split('/'))), page);
  const install = readFileSync(join(out, 'guide', 'install.html'), 'utf8');
  const tuning = readFileSync(join(out, 'guide', 'deep', 'tuning.html'), 'utf8');
  for (const html of [install, tuning, readFileSync(join(out, 'index.html'), 'utf8')])
    for (const href of hrefs(html)) assert.doesNotMatch(href, /\\/, href);
  assert.ok(hrefs(install).includes('../style.css'), hrefs(install).join(' '));
  assert.ok(hrefs(install).includes('../faq.html'), hrefs(install).join(' '));
  assert.ok(hrefs(tuning).includes('../../style.css'), hrefs(tuning).join(' '));
  assert.ok(hrefs(tuning).includes('../../index.html'), hrefs(tuning).join(' '));
});

test('forward-slash entries keep working and a missing page is named', () => {
  const src = site(['index.md', 'guide/install.md']);
  build({ src, out: join(src, 'out') });
  assert.equal(readFileSync(join(src, 'out', 'sitemap.txt'), 'utf8').trim().split(/\r?\n/).join(','), 'index.html,guide/install.html');
  const broken = site(['index.md', 'guide\\nope.md']);
  assert.throws(() => build({ src: broken, out: join(broken, 'out') }), /nope\.md/);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 8));
