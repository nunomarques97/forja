// Hidden acceptance check: never copied into the scratch project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { resolveInside } = await import(pathToFileURL(join(process.env.BAKEOFF_PROJECT, 'src/static.mjs')).href);
const root = join(mkdtempSync(join(tmpdir(), 'bakeoff-static-')), 'app');
const inside = path => { const rel = relative(root, path); return !rel.startsWith('..') && !isAbsolute(rel); };
const rejects = request => assert.throws(() => resolveInside(root, request), error => error.code === 'EOUTSIDE', request);

test('paths inside the root resolve there', () => {
  assert.equal(resolve(resolveInside(root, '/index.html')), join(root, 'index.html'));
  assert.equal(resolve(resolveInside(root, '/a/b%20c.txt')), join(root, 'a', 'b c.txt'));
  assert.equal(resolve(resolveInside(root, '/a/../b.txt')), join(root, 'b.txt'));
});

test('traversal out of the root throws EOUTSIDE', () => {
  for (const request of ['../secret', '/../secret', '/a/../../secret', '%2e%2e/secret', '..%2Fsecret', '..%5Csecret', '..\\secret', '/a\\..\\..\\secret']) rejects(request);
});

test('a sibling directory sharing the root name prefix is outside', () => {
  rejects('../app-evil/file.txt');
  rejects('/..%2Fapp-evil%2Ffile.txt');
});

test('absolute paths never escape the root', () => {
  for (const request of ['/etc/passwd', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini', '%2Fetc%2Fpasswd', '\\\\server\\share\\x']) {
    let result;
    try { result = resolveInside(root, request); } catch (error) { assert.equal(error.code, 'EOUTSIDE', request); continue; }
    assert.ok(inside(resolve(result)), `${request} resolved outside: ${result}`);
  }
});

test('malformed encoding throws EOUTSIDE', () => rejects('%E0%A4%A'));
