// 0.22.0 removed the legacy crew workflow. Reference proof for
// docs/LEGACY-REMOVAL.md ("Reference proof: patterns and allowlist"): no text
// file Git knows about (tracked or untracked, not ignored) still names a
// removed command, flag, agent, skill, module or doc outside the allowlist,
// and every relative Markdown link resolves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coreInstructions } from '../lib/core/instructions.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

export const PATTERNS = {
  P1: /\bforja(?:\.mjs)?["']?\s+(?:run|task|runner|forjalvl|models|autonomy|decide|decisions|technology|obsidian|ask|answers|fallback|progress|report|notify|status|context|resume)\b(?![-.\w])/,
  P2: /`(?:run (?:start|resume|checkpoint|finish|fail|block|driver)|task (?:add|show|start|review|done|fail|block)|runner|forjalvl|autonomy (?:show|set)|decisions reindex|technology split|obsidian sync)\b/,
  P3: /--(?:legacy|keep-legacy|forjalvl|visivel)\b(?![-\w])/,
  P4: /\.claude\/agents\b|\b(?:product-manager|product-designer|technology-scout|backend-dev|frontend-dev|security-reviewer)\b(?![-\w])/,
  P5: /\bforja-(?:lead|crew|qa|plan|review|implementer|product|design|scout|release|debug|performance|security|visual-check|decide)(?![-\w])/,
  P6: /(?:^|[/'"`(\s])(?:runner|driver|autonomy|models|run-cost|obsidian-sync|usage-counts)\.mjs\b|\btools\/(?:content|first|par3|perrun|subcontent|usage|medir-contexto|stats)\.mjs\b|mcp-forja\.json/,
  P7: /LEGACY-CLAUDE\.md|RUNBOOK-UNATTENDED\.md/,
};

const ALLOWED_FILES = new Set([
  'CHANGELOG.md',
  'docs/LEGACY-REMOVAL.md',
  'docs/RESEARCH.md',
  'docs/MODEL-BENCHMARK.md',
  'docs/ADAPTIVE-ORCHESTRATION.md',
  'examples/sample-project/AGENTS.md',
  'viewer/lib/state.mjs',
  'viewer/lib/feed.mjs',
  'viewer/index.html',
  'viewer/mobile.html',
  'viewer/assets/viewer.js',
  'viewer/assets/viewer.css',
  'test/state.test.mjs',
  'test/feed.test.mjs',
  'test/viewer-page.test.mjs',
  'test/server.test.mjs',
  'test/fixtures/build-fixtures.mjs',
  'test/legacy-references.test.mjs',
  'test/legacy-cli.test.mjs',
  'test/cli.test.mjs',
  'test/bootstrap.test.mjs',
  'test/core-migration.test.mjs',
  'test/init-rollback.test.mjs',
  'test/guard.test.mjs',
  'test/up.test.mjs',
  'test/supervise.test.mjs',
]);
const ALLOWED_PREFIXES = ['lib/core/'];
const ALLOWED_FIXTURE = /^test\/fixtures\/[^/]+\.jsonl$/;
// The managed block `core init` writes into a project's AGENTS.md/CLAUDE.md.
// Its source, lib/core/instructions.mjs, is allowlisted (a documented 0.22.0
// residual), so inside the block only lines identical to the current generator
// output are exempt; any other line there is scanned like the rest of the file.
const MANAGED_BEGIN = '<!-- forja-core:begin -->';
const MANAGED_END = '<!-- forja-core:end -->';
const MANAGED_LINES = new Set(coreInstructions().split('\n'));

// Only the refusal regions between these markers are allowed in these files.
const REGION_FILES = new Set(['bin/forja.mjs', 'lib/bootstrap.mjs']);
const BEGIN = 'legacy-references:' + 'allow-begin';
const END = 'legacy-references:' + 'allow-end';

export function allowedFile(path) {
  return ALLOWED_FILES.has(path) || ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix)) || ALLOWED_FIXTURE.test(path);
}

// Returns one entry per offending line: { path, line, id, text }.
export function scanText(path, text) {
  if (allowedFile(path)) return [];
  const found = [];
  let inRegion = false;
  let inManaged = false;
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === MANAGED_BEGIN) { inManaged = true; return; }
    if (line.trim() === MANAGED_END) { inManaged = false; return; }
    if (inManaged && MANAGED_LINES.has(line)) return;
    if (REGION_FILES.has(path)) {
      if (line.includes(BEGIN)) { inRegion = true; return; }
      if (line.includes(END)) { inRegion = false; return; }
      if (inRegion) return;
    }
    for (const [id, pattern] of Object.entries(PATTERNS)) {
      if (pattern.test(line)) found.push({ path, line: index + 1, id, text: line.trim().slice(0, 160) });
    }
  });
  return found;
}

function gitFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  // A tracked file deleted in the working tree is still listed until staged.
  return [...new Set(out.split('\0').filter(Boolean))].filter(path => existsSync(join(root, path)) && statSync(join(root, path)).isFile());
}

function readText(path) {
  const bytes = readFileSync(join(root, path));
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

export function scanRepository(files = gitFiles()) {
  const found = [];
  for (const path of files) {
    const text = readText(path);
    if (text !== null) found.push(...scanText(path, text));
  }
  return found;
}

// Relative targets of inline links/images and reference definitions, outside
// fenced code blocks and inline code spans.
export function markdownTargets(text) {
  const targets = [];
  let fence = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const marker = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const line = raw.replace(/`+[^`]*`+/g, '');
    const add = target => {
      let value = target.trim();
      if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
      value = value.split(/\s+/)[0];
      if (!value || value.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return;
      targets.push({ line: index + 1, target: value });
    };
    for (const match of line.matchAll(/\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*(?:\s+"[^"]*")?)\)/g)) add(match[1]);
    const definition = line.match(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/);
    if (definition) add(definition[1]);
  });
  return targets;
}

export function brokenLinks(files = gitFiles(), { read = readText, exists = existsSync } = {}) {
  const broken = [];
  for (const path of files.filter(file => file.toLowerCase().endsWith('.md'))) {
    const text = read(path);
    if (text === null) continue;
    for (const { line, target } of markdownTargets(text)) {
      let clean = target.split('#')[0].split('?')[0];
      try { clean = decodeURIComponent(clean); } catch { /* keep the raw target */ }
      if (!clean) continue;
      const resolved = clean.startsWith('/') ? join(root, clean) : join(root, dirname(path), clean);
      if (!exists(resolved)) broken.push({ path, line, target });
    }
  }
  return broken;
}

test('no removed command, flag, agent, skill, module or doc is referenced outside the allowlist', () => {
  const found = scanRepository();
  assert.deepEqual(found.map(v => `${v.path}:${v.line} ${v.id} ${v.text}`), []);
});

test('the scan fails on a seeded violation for every pattern', () => {
  const seeds = {
    P1: 'Run `node bin/forja.mjs runner` to continue.',
    P2: 'Use `run start --goal x` first.',
    P3: 'forja bootstrap ~/project --legacy',
    P4: 'See .claude/agents/qa.md and the product-manager role.',
    P5: 'Load the forja-lead skill.',
    P6: "import { x } from './runner.mjs';",
    P7: 'Read docs/LEGACY-CLAUDE.md.',
  };
  for (const [id, line] of Object.entries(seeds)) {
    const found = scanText('docs/SEEDED.md', `# Seed\n\n${line}\n`);
    assert.ok(found.some(v => v.id === id && v.line === 3), `${id} not detected in: ${line}`);
  }
  // Allowlisted history stays allowed; a refusal region allows only its inside.
  assert.deepEqual(scanText('CHANGELOG.md', seeds.P1), []);
  const region = ['// ' + BEGIN, "const removed = ['runner'];", '// ' + END, "console.log('forja runner');"].join('\n');
  assert.deepEqual(scanText('bin/forja.mjs', region).map(v => [v.line, v.id]), [[4, 'P1']]);
  assert.equal(scanText('lib/guard.mjs', region).length, 1);
});

test('inside the managed forja-core block only exact generator lines are exempt', () => {
  const block = ['# Project', MANAGED_BEGIN, coreInstructions(), MANAGED_END, ''].join('\n');
  assert.deepEqual(scanText('AGENTS.md', block), []);
  assert.deepEqual(scanText('CLAUDE.md', block.split('\n').join('\r\n')), []);
  // An edited line inside the block, or a generator line outside it, is still reported.
  const edited = block.replace('Legacy `runner` and `run start` are compatibility', 'Use `run start` and `runner`; they are compatibility');
  assert.deepEqual(scanText('AGENTS.md', edited).map(v => v.id), ['P2']);
  const outside = ['# Project', coreInstructions()].join('\n');
  assert.ok(scanText('AGENTS.md', outside).length >= 2);
});

test('Core names and temporary prefixes are not legacy references', () => {
  const lines = [
    'forja core status --run F-1',
    'node bin/forja.mjs start --goal "x"',
    'Read .claude/skills/forja-core-planner/SKILL.md',
    'mkdtemp(join(tmpdir(), "forja-plan-packet-"))',
    "import { launchCore } from '../lib/spawn-runner.mjs';",
    'python check-runner.py',
    'forja bootstrap ~/project --dry-run',
  ];
  assert.deepEqual(scanText('docs/SEEDED.md', lines.join('\n')), []);
});

test('every relative Markdown link resolves', () => {
  assert.deepEqual(brokenLinks().map(v => `${v.path}:${v.line} ${v.target}`), []);
});

test('the link check fails on a seeded broken link and ignores code and external links', () => {
  const text = [
    '[ok](docs/CORE.md) [gone](docs/GONE.md#part) ![img](assets/x.png "title")',
    '[web](https://example.com) [anchor](#top) [mail](mailto:a@example.com)',
    '`[code](docs/NOT-A-LINK.md)`',
    '```',
    '[fenced](docs/ALSO-NOT.md)',
    '```',
    '[ref]: ./docs/REF.md',
  ].join('\n');
  assert.deepEqual(markdownTargets(text).map(v => v.target), ['docs/CORE.md', 'docs/GONE.md#part', 'assets/x.png', './docs/REF.md']);
  const broken = brokenLinks(['guide/SEED.md'], { read: () => text, exists: path => !path.includes('GONE') });
  assert.deepEqual(broken.map(v => [v.line, v.target]), [[1, 'docs/GONE.md#part']]);
  const resolved = [];
  brokenLinks(['guide/SEED.md'], { read: () => '[up](../README.md)', exists: path => { resolved.push(path); return true; } });
  assert.deepEqual(resolved, [join(root, 'README.md')]);
});
