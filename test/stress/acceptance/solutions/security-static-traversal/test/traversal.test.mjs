import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticHandler, resolveStatic } from '../src/static.mjs';

test('URLs cannot leave the root', () => {
  const site = mkdtempSync(join(tmpdir(), 'filedrop-'));
  mkdirSync(join(site, 'public'));
  mkdirSync(join(site, 'public-old'));
  writeFileSync(join(site, 'public-old', 'x.txt'), 'old');
  const root = join(site, 'public');
  for (const url of ['/../public-old/x.txt', '/%2e%2e/public-old/x.txt', '/..%5cpublic-old%5cx.txt', '/a%00b', '/%E0%A4%A'])
    assert.equal(createStaticHandler(root)({ url }).status, 404, url);
  assert.equal(resolveStatic(root, '/a/b.txt'), join(root, 'a', 'b.txt'));
});
