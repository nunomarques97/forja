// Hidden acceptance check: never copied into the scenario project.
// The project is copied into a folder whose name has spaces, parentheses and
// "#", then built from there with the CLI, as a user would. This fails
// untouched on Windows and on Linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PROJECT, assertOwnSuite } from './_helpers.mjs';

const root = mkdtempSync(join(tmpdir(), 'stress-spaces-'));
const copy = join(root, 'My Docs (v2) #1', 'docpack');
cpSync(PROJECT, copy, { recursive: true, filter: src => !['.git', 'node_modules', 'dist'].includes(basename(src)) });

function cli(args) {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const out = spawnSync(process.execPath, [join('src', 'cli.mjs'), ...args], { cwd: copy, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { code: out.status, text: `${out.stdout ?? ''}${out.stderr ?? ''}` };
}

test('the CLI builds the sample site from a folder with spaces and #', () => {
  const out = join(root, 'Output Folder #2');
  const res = cli(['build', 'site', out]);
  assert.equal(res.code, 0, res.text.slice(0, 1200));
  assert.match(readFileSync(join(out, 'guide', 'install.html'), 'utf8'), /<title>Installing - Docpack<\/title>/);
  assert.equal(readFileSync(join(out, 'style.css'), 'utf8'), readFileSync(join(copy, 'theme', 'style.css'), 'utf8'));
  assert.ok(existsSync(join(out, 'sitemap.txt')));
});

test('a relative output folder with spaces works too', () => {
  const res = cli(['build', 'site', 'built site']);
  assert.equal(res.code, 0, res.text.slice(0, 1200));
  assert.ok(existsSync(join(copy, 'built site', 'index.html')));
});

test("the project's own tests pass", () => assertOwnSuite(assert, 7));
