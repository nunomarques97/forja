import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { initCore } from '../lib/core/init.mjs';
import { migrateInstructions, disableLegacySkill, frontmatterProblems } from '../lib/core/instructions.mjs';

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

test('a legacy description containing ": " is quoted so the disable flag is readable YAML', () => {
  const input = '---\nname: forja-lead\ndescription: The manual, in two modes: interactive and runner. Say "go" #1\n---\n# Body\n';
  const next = disableLegacySkill(input, 'forja-lead');
  assert.equal(next, '---\nname: forja-lead\ndescription: "The manual, in two modes: interactive and runner. Say \\"go\\" #1"\ndisable-model-invocation: true\n---\n# Body\n');
  assert.deepEqual(frontmatterProblems(next.split('---')[1].trim()), []);
  assert.equal(disableLegacySkill(next, 'forja-lead'), next);
  assert.deepEqual(frontmatterProblems('description: a: b').map(p => p.reason), ['plain value needs quoting']);
  assert.deepEqual(frontmatterProblems('name: x\ntools:\n  - Read\nnote: |\n  free: text'), []);
});

test('unrepairable frontmatter fails clearly and init writes nothing', (t) => {
  for (const header of ['description: "unterminated', 'description: ok\ndescription: twice', '  nested: value', 'just text']) {
    assert.throws(() => disableLegacySkill(`---\nname: forja-lead\n${header}\n---\nBody\n`, 'forja-lead'), /Invalid YAML frontmatter in legacy skill forja-lead .*Nothing was written/);
  }
  const root = mkdtempSync(join(tmpdir(), 'forja-migration-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, '.claude/skills/forja-lead'), { recursive: true });
  const broken = '---\nname: forja-lead\ndescription: "unterminated\n---\nBody\n';
  writeFileSync(join(root, '.claude/skills/forja-lead/SKILL.md'), broken);
  writeFileSync(join(root, 'CLAUDE.md'), 'Product rule\n');
  assert.throws(() => initCore(root), /Invalid YAML frontmatter/);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), 'Product rule\n');
  assert.equal(readFileSync(join(root, '.claude/skills/forja-lead/SKILL.md'), 'utf8'), broken);
  assert.ok(!existsSync(join(root, '.forja')));
});

test('init repairs a project migrated before frontmatter validation', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'forja-migration-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const skill = join(root, '.claude/skills/forja-security/SKILL.md');
  mkdirSync(join(root, '.claude/skills/forja-security'), { recursive: true });
  writeFileSync(skill, '---\r\nname: forja-security\r\ndescription: Checklist for external input: injection, traversal.\r\ndisable-model-invocation: true\r\n---\r\nBody\r\n');
  initCore(root);
  const repaired = readFileSync(skill, 'utf8');
  assert.equal(repaired, '---\r\nname: forja-security\r\ndescription: "Checklist for external input: injection, traversal."\r\ndisable-model-invocation: true\r\n---\r\nBody\r\n');
  initCore(root);
  assert.equal(readFileSync(skill, 'utf8'), repaired);
});

test('every bundled skill and agent header is valid YAML in the supported subset', () => {
  const here = join(import.meta.dirname, '..');
  for (const base of ['', 'examples/sample-project/'])
    for (const kind of ['skills', 'agents'])
      for (const entry of readdirSync(join(here, base, '.claude', kind))) {
        const file = join(here, base, '.claude', kind, entry, ...(kind === 'skills' ? ['SKILL.md'] : []));
        const header = readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/)[1];
        assert.deepEqual(frontmatterProblems(header), [], file);
      }
});

test('invalid YAML escapes, tab indentation and typed collections refuse repair', () => {
  for (const header of ['description: "bad\\q"', 'description: "bad\\Uffffffff"', 'tools:\n\t- Read', 'allowed-tools: [Read, Write]'])
    assert.throws(() => disableLegacySkill(`---\nname: forja-lead\n${header}\n---\nBody\n`, 'forja-lead'), /Invalid YAML/);
  const repaired = disableLegacySkill('---\nname: forja-lead\ndescription: a:\tb\n---\nBody\n', 'forja-lead');
  assert.match(repaired, /description: "a:\\tb"/);
});
