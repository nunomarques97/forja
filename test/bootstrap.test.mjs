// lib/bootstrap.mjs against temp dirs (never a real repo, never the sample
// project): `forja bootstrap <repo>` is the Core preparation of `core init`
// plus registration; --dry-run writes nothing; the removed legacy crew flags
// are refused before anything is written; refusals for missing dirs and the
// forja repo itself.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMOVED_FLAGS, removedFlagProblem, resolveTarget } from '../lib/bootstrap.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const forja = join(here, '..');
const cli = join(forja, 'bin', 'forja.mjs');
const root = mkdtempSync(join(tmpdir(), 'forja-bootstrap-'));
const dataDir = join(root, 'data');
const env = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
const runCore = (...args) => { const r = spawnSync(process.execPath, [cli, 'bootstrap', ...args], { env, encoding: 'utf8', cwd: root }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
after(() => rmSync(root, { recursive: true, force: true }));

// { relPath: sha256 } of every file under dir
function fingerprint(dir) {
  const out = {};
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p).replace(/\\/g, '/')] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
  walk(dir); return out;
}

const CUSTOM_CLAUDE = '# my-app — rules\n\n- Never touch the payments module without a ticket.\n- Tests: `npm test`.\n';
const CUSTOM_SETTINGS = {
  env: { MY_FLAG: 'yes' },
  permissions: { allow: ['Bash(npm test)'] },
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
};
function makeTarget(name) {
  const t = join(root, name); mkdirSync(join(t, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(t, 'CLAUDE.md'), CUSTOM_CLAUDE);
  writeFileSync(join(t, '.claude', 'settings.json'), JSON.stringify(CUSTOM_SETTINGS, null, 4));
  writeFileSync(join(t, '.claude', 'agents', 'mine.md'), '# mine\n');
  return t;
}

describe('default bootstrap prepares Core only', () => {
  test('no crew, skills or hooks are installed; legacy crew agents are archived; the project is registered', () => {
    const t = makeTarget('core-app');
    const crew = '---\nname: architect\ndescription: Architect of the Forja crew.\n---\n';
    writeFileSync(join(t, '.claude', 'agents', 'architect.md'), crew);
    const settings = readFileSync(join(t, '.claude', 'settings.json'), 'utf8');
    const r = runCore(t);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.mode, 'core');
    assert.equal(r.json.dryRun, false);
    assert.equal(r.json.registry.registered, true);
    assert.deepEqual(r.json.legacy_agents.archived, [{ from: ['.claude', 'agents', 'architect.md'].join('/'), to: 'docs/forja/legacy-agents/architect.md' }]);
    assert.equal(readFileSync(join(t, 'docs', 'forja', 'legacy-agents', 'architect.md'), 'utf8'), crew);
    assert.deepEqual(readdirSync(join(t, '.claude', 'agents')), ['mine.md']);
    assert.ok(!existsSync(join(t, '.claude', 'skills')), 'no skills copied');
    assert.equal(readFileSync(join(t, '.claude', 'settings.json'), 'utf8'), settings, 'no hooks merged');
    assert.ok(!existsSync(join(t, 'docs', 'forja', 'TASKS.json')), 'no legacy run state');
    const claude = readFileSync(join(t, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith(CUSTOM_CLAUDE));
    assert.match(claude, /<!-- forja-core:begin -->\n## FORJA core/);
    assert.match(readFileSync(join(t, '.gitignore'), 'utf8'), /^\.forja\/$/m);
    const again = runCore(t);
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(again.json.legacy_agents.archived, []);
  });
  test('--dry-run reports the Core changes and writes nothing', () => {
    const t = makeTarget('core-dry'); const before = fingerprint(t);
    const r = runCore(t, '--dry-run');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.json.mode, 'core'); assert.equal(r.json.dryRun, true);
    assert.deepEqual(r.json.changes, ['AGENTS.md', 'CLAUDE.md', '.gitignore', '.forja']);
    assert.equal(r.json.registry, undefined);
    assert.deepEqual(fingerprint(t), before);
  });
});

describe('the removed legacy crew flags are refused and write nothing', () => {
  test('removedFlagProblem names each flag used and points to forja core init', () => {
    assert.deepEqual(REMOVED_FLAGS, ['legacy', 'keep-legacy']);
    assert.equal(removedFlagProblem({}), null);
    assert.equal(removedFlagProblem({ 'dry-run': true }), null);
    const both = removedFlagProblem({ legacy: true, 'keep-legacy': true });
    assert.match(both, /^bootstrap --legacy --keep-legacy was removed in 0\.22\.0/);
    assert.match(both, /`forja core init`/);
    assert.match(both, /Nothing was written\.$/);
    // `bootstrap --legacy <repo>` parses the repo as the flag's value: still refused.
    assert.match(removedFlagProblem({ legacy: 'some-repo' }), /^bootstrap --legacy was removed/);
    assert.match(removedFlagProblem({ 'keep-legacy': true }), /^bootstrap --keep-legacy was removed/);
  });
  for (const args of [['--legacy'], ['--keep-legacy'], ['--legacy', '--keep-legacy'], ['--legacy', '--dry-run'], ['--dry-run', '--keep-legacy']]) {
    test(`bootstrap <repo> ${args.join(' ')} exits non-zero with an English pointer to forja core init`, () => {
      const t = makeTarget(`refused${args.join('')}`);
      const crew = '---\nname: qa\ndescription: QA of the Forja crew.\n---\n';
      writeFileSync(join(t, '.claude', 'agents', 'qa.md'), crew);
      const registry = join(dataDir, 'projects.json');
      const registryBefore = existsSync(registry) ? readFileSync(registry, 'utf8') : null;
      const before = fingerprint(t);
      const r = runCore(t, ...args);
      assert.notEqual(r.code, 0, r.out);
      assert.equal(r.out, '', 'no summary is printed');
      assert.match(r.err, /^forja: bootstrap --(?:keep-)?legacy.* was removed in 0\.22\.0: the legacy crew install no longer exists\. Run `forja core init` in the repository/);
      assert.deepEqual(fingerprint(t), before, 'the target is untouched (no Core init, no archiving)');
      assert.equal(existsSync(registry) ? readFileSync(registry, 'utf8') : null, registryBefore, 'the registry is untouched');
    });
  }
  test('the flag before the repo (`bootstrap --legacy <repo>`) is refused too and writes nothing', () => {
    const t = makeTarget('refused-before'); const before = fingerprint(t);
    const r = spawnSync(process.execPath, [cli, 'bootstrap', '--legacy', t], { env, encoding: 'utf8', cwd: root });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /bootstrap --legacy was removed in 0\.22\.0.*`forja core init`/);
    assert.deepEqual(fingerprint(t), before);
  });
  test('a missing target with a removed flag gets the removal message, not a path error', () => {
    const r = runCore(join(root, 'nope'), '--legacy');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /was removed in 0\.22\.0/);
    assert.ok(!existsSync(join(root, 'nope')));
  });
});

describe('refusals', () => {
  test('missing dir, a file, the forja repo itself, and a parent of the forja repo are refused', () => {
    assert.throws(() => resolveTarget(join(root, 'nope')), /não existe/);
    const f = join(root, 'a-file.txt'); writeFileSync(f, 'x');
    assert.throws(() => resolveTarget(f), /não é uma pasta/);
    assert.throws(() => resolveTarget(forja), /próprio repo/);
    assert.throws(() => resolveTarget(join(forja, '..')), /contém o repo do Forja/);
    assert.throws(() => resolveTarget(undefined), /uso:/);
    const r = runCore(join(root, 'nope')); assert.notEqual(r.code, 0); assert.match(r.err, /não existe/);
  });
});

// Rede de segurança (17 set 2026): dois testes deste ficheiro corriam o CLI sem
// FORJA_DATA_DIR e registaram 86 pastas temporárias no registo REAL do Sponsor —
// apareceram todas no menu «Novo run» do telemóvel. O ficheiro real é lido
// quando este ficheiro é importado e comparado no fim.
const realRegistry = join(forja, 'data', 'projects.json');
const realRegistryBefore = existsSync(realRegistry) ? readFileSync(realRegistry, 'utf8') : null;
describe('o registo real do Sponsor nunca é tocado pelos testes', () => {
  test('data/projects.json ficou como estava (ou continua a não existir)', () => {
    const now = existsSync(realRegistry) ? readFileSync(realRegistry, 'utf8') : null;
    assert.equal(now, realRegistryBefore, 'um teste escreveu no registo real — falta-lhe FORJA_DATA_DIR no env do spawn');
  });
});
