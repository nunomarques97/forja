import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { initCore } from '../lib/core/init.mjs';
import { migrateInstructions, disableLegacySkill } from '../lib/core/instructions.mjs';

test('migrate both generations without changing surrounding project instructions', () => {
  const input = 'before\r\n<!-- forja:begin -->\r\nload skill forja-lead\r\n<!-- forja:end -->\r\nbetween\r\n<!-- forja-core:begin -->\r\nstale\r\n<!-- forja-core:end -->\r\nafter';
  const next = migrateInstructions(input, 'CLAUDE.md');
  assert.ok(next.startsWith('before\r\n<!-- forja-core:begin -->\r\n'));
  assert.ok(next.endsWith('<!-- forja-core:end -->\r\nbetween\r\n\r\nafter'));
  assert.doesNotMatch(next, /load skill|<!-- forja:begin -->/);
  assert.equal(migrateInstructions(next, 'CLAUDE.md'), next);
});

test('malformed and overlapping legacy markers refuse before migration', () => {
  for (const input of [
    '<!-- forja:begin -->', '<!-- forja:end -->',
    '<!-- forja:begin --><!-- forja:end --><!-- forja:begin --><!-- forja:end -->',
    '<!-- forja:begin --><!-- forja-core:begin --><!-- forja:end --><!-- forja-core:end -->',
  ]) assert.throws(() => migrateInstructions(input, 'CLAUDE.md'), /markers/);
});

test('legacy method becomes manual-only without changing its body or other metadata', () => {
  const body = '\r\n\r\n# Existing customized method\r\nPreserve this.\r\n';
  const input = '---\r\nname: forja-lead\r\ndescription: Existing description\r\n---' + body;
  const next = disableLegacySkill(input, 'forja-lead');
  assert.ok(next.endsWith('---' + body));
  assert.match(next, /disable-model-invocation: true\r\n/);
  assert.equal(disableLegacySkill(next, 'forja-lead'), next);
  assert.throws(() => disableLegacySkill(input, 'forja-crew'), /Unrecognized/);
});

test('init migrates legacy skills and guidance, preserving active state and user files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forja-migration-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const skill = '.claude/skills/forja-lead/SKILL.md';
  mkdirSync(join(root, '.claude/skills/forja-lead'), { recursive: true });
  mkdirSync(join(root, 'docs/forja'), { recursive: true });
  const state = '{"status":"running","driver":"interactive"}\n';
  writeFileSync(join(root, 'docs/forja/RUN.json'), state);
  writeFileSync(join(root, 'CLAUDE.md'), 'Product rule\n<!-- forja:begin -->\nold\n<!-- forja:end -->\n');
  writeFileSync(join(root, skill), '---\nname: forja-lead\n---\nExisting body\n');
  const result = initCore(root);
  assert.ok(result.files.includes(skill));
  assert.equal(readFileSync(join(root, 'docs/forja/RUN.json'), 'utf8'), state);
  assert.match(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), /^Product rule\n<!-- forja-core:begin -->/);
  assert.match(readFileSync(join(root, skill), 'utf8'), /disable-model-invocation: true/);
  const before = result.files.map(f => readFileSync(join(root, f), 'utf8'));
  initCore(root);
  assert.deepEqual(result.files.map(f => readFileSync(join(root, f), 'utf8')), before);
});
