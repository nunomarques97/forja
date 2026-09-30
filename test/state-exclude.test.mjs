import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { excludeStateDirectory } from '../lib/core/files.mjs';

const repo = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forja-exclude-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
};
const status = root => execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });

test('run state is excluded locally without touching the project .gitignore', (t) => {
  const root = repo(t);
  mkdirSync(join(root, '.forja'));
  writeFileSync(join(root, '.forja', 'state.json'), '{}');
  assert.match(status(root), /\.forja\//);
  assert.equal(excludeStateDirectory(root), true);
  assert.equal(status(root), '');
  assert.equal(existsSync(join(root, '.gitignore')), false);
  assert.equal(excludeStateDirectory(root), false);
  assert.equal(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').match(/^\.forja\/$/gm).length, 1);
});

test('an existing project ignore rule is respected as is', (t) => {
  const root = repo(t);
  writeFileSync(join(root, '.gitignore'), '.forja/\n');
  const before = existsSync(join(root, '.git', 'info', 'exclude')) ? readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8') : null;
  assert.equal(excludeStateDirectory(root), false);
  const after = existsSync(join(root, '.git', 'info', 'exclude')) ? readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8') : null;
  assert.equal(after, before);
});
