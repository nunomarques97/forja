// The release version lives in four places that drift apart easily: package.json,
// the README version badge (image, alt text and release link), the README
// "Current release" link and the top CHANGELOG heading. They must all agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
const RELEASES = 'https://github.com/nunomarques97/forja/releases/tag/';
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Returns one message per place that does not name `version`.
export function versionMismatches(version, readme, changelog) {
  const v = escape(version);
  const tag = escape(`${RELEASES}v${version}`);
  const problems = [];
  const badge = readme.split(/\r?\n/).find(line => line.includes('img.shields.io/badge/version-'));
  if (!badge) problems.push('README has no version badge');
  else {
    if (!new RegExp(`<a href="${tag}">`).test(badge)) problems.push('README badge link is not the v' + version + ' release');
    if (!new RegExp(`img\\.shields\\.io/badge/version-${v}-`).test(badge)) problems.push('README badge image does not say ' + version);
    if (!new RegExp(`alt="Version ${v}"`).test(badge)) problems.push('README badge alt text does not say ' + version);
  }
  if (!new RegExp(`\\*\\*Current release: \\[v${v}\\]\\(${tag}\\)\\.\\*\\*`).test(readme)) problems.push('README current release link does not say v' + version);
  const heading = changelog.split(/\r?\n/).find(line => line.startsWith('## '));
  if (!heading || !new RegExp(`^## ${v} — \\S`).test(heading)) problems.push(`top CHANGELOG heading is not ${version}: ${heading ?? 'none'}`);
  return problems;
}

test('package version, README badge and release links and the top CHANGELOG heading agree', () => {
  const { version } = JSON.parse(read('package.json'));
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(versionMismatches(version, read('README.md'), read('CHANGELOG.md')), []);
});

test('the version check reports every place that names another version', () => {
  const readme = [
    `<a href="${RELEASES}v1.2.3"><img src="https://img.shields.io/badge/version-1.2.3-ff9955" alt="Version 1.2.3"></a>`,
    `**Current release: [v1.2.3](${RELEASES}v1.2.3).** Notes.`,
  ].join('\n');
  const changelog = '# Changelog\n\n## 1.2.3 — Title\n\n## 1.2.2 — Older\n';
  assert.deepEqual(versionMismatches('1.2.3', readme, changelog), []);
  assert.equal(versionMismatches('1.2.4', readme, changelog).length, 5);
  // A partial version must not match a longer one (1.2.3 inside 1.2.30).
  assert.equal(versionMismatches('1.2.3', readme.replaceAll('1.2.3', '1.2.30'), changelog.replace('1.2.3', '1.2.30')).length, 5);
  // Only the first CHANGELOG heading counts.
  assert.deepEqual(versionMismatches('1.2.3', readme, '# Changelog\n\n## 1.2.2 — Older\n\n## 1.2.3 — Title\n'), ['top CHANGELOG heading is not 1.2.3: ## 1.2.2 — Older']);
  assert.deepEqual(versionMismatches('1.2.3', 'no badge here', changelog), ['README has no version badge', 'README current release link does not say v1.2.3']);
});

test('the forja-office section follows the badges block and links the demo video', () => {
  const readme = read('README.md');
  const lines = readme.split(/\r?\n/);
  const badge = lines.findIndex(line => line.includes('img.shields.io/badge/version-'));
  const badgesEnd = lines.findIndex((line, index) => index > badge && line.trim() === '</p>');
  const next = lines.slice(badgesEnd + 1).find(line => line.trim() !== '');
  assert.equal(next, '<h2 align="center">See it live: forja-office</h2>');

  const start = readme.indexOf('<h2 align="center">See it live: forja-office</h2>');
  const section = readme.slice(start, readme.indexOf('\n## ', start));
  assert.ok(readme.indexOf('img.shields.io/badge/version-') < start);
  assert.match(section, /<a href="https:\/\/github\.com\/nunomarques97\/forja-office">forja-office<\/a> is a separate, read-only 3D view of FORJA Core runs/);
  for (const room of ['whiteboard', 'desks', 'server rack', 'independent review', "Sponsor's door", 'break room']) assert.ok(section.includes(room), room);
  assert.match(section, /reads FORJA's registry and run state files and never writes them/);
  assert.match(section, /<a href="https:\/\/youtu\.be\/EXVfoSOA7j8"><img src="https:\/\/img\.youtube\.com\/vi\/EXVfoSOA7j8\/hqdefault\.jpg"[^>]*alt="[^"]+"><\/a>/);
  assert.match(section, /<a href="https:\/\/youtu\.be\/EXVfoSOA7j8">[^<]+<\/a> \(demo mode with fictional projects\)/);
  for (const line of section.split(/\r?\n/).filter(line => line.trim())) assert.match(line, /^(<h2 align="center">|<p align="center">|  <a |<\/p>)/);
});
