// lib/bootstrap.mjs against temp dirs (never a real repo, never the sample
// project): a target that already has a CLAUDE.md with its own text and a
// settings.json with its own hook and env keeps all of it; our nine agents, the
// forja-* skills, the 17 hooks, docs/forja/ and the managed block arrive; the
// second run is byte-identical and reports everything unchanged; --dry-run
// writes nothing; refusals for missing dirs and the forja repo itself.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS, AGENTS, MARK_BEGIN, MARK_END, hookCommand, mergeSettings, upsertManagedBlock, managedBlock, planBootstrap, detectEol } from '../lib/bootstrap.mjs';
import { DECISIONS_HEADER, QUEUE_HEADER } from '../lib/state-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const forja = join(here, '..');
const cli = join(forja, 'bin', 'forja.mjs');
const root = mkdtempSync(join(tmpdir(), 'forja-bootstrap-'));
const env = { ...process.env, FORJA_DATA_DIR: join(root, 'data'), FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
const run = (...args) => { const r = spawnSync(process.execPath, [cli, 'bootstrap', ...args], { env, encoding: 'utf8', cwd: root }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
after(() => rmSync(root, { recursive: true, force: true }));

// { relPath: sha256 } of every file under dir
function fingerprint(dir) {
  const out = {};
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p).replace(/\\/g, '/')] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
  walk(dir); return out;
}

const CUSTOM_CLAUDE = '# my-app — rules\n\n- Never touch the payments module without a ticket.\n- Tests: `npm test`.\n';
const CUSTOM_SETTINGS = {
  env: { MY_FLAG: 'yes', CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '3' },
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node lint.mjs', timeout: 3 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
  },
};
function makeTarget(name) {
  const t = join(root, name); mkdirSync(join(t, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(t, 'CLAUDE.md'), CUSTOM_CLAUDE);
  writeFileSync(join(t, '.claude', 'settings.json'), JSON.stringify(CUSTOM_SETTINGS, null, 4));
  writeFileSync(join(t, '.claude', 'agents', 'mine.md'), '# mine\n');
  return t;
}

describe('pure merge helpers', () => {
  test('hookCommand uses the forja path with forward slashes', () => {
    assert.equal(hookCommand('C:\\Fixtures\\x\\forja'), 'node "C:/Fixtures/x/forja/hooks/log-event.mjs"');
  });
  test('mergeSettings keeps custom env/hooks/keys, forces the two Forja env values, adds fallbackModel only when absent, adds 17 hooks once', () => {
    const { settings: s, warnings } = mergeSettings(CUSTOM_SETTINGS, 'C:\\f');
    assert.deepEqual(warnings, []);
    assert.equal(s.env.MY_FLAG, 'yes'); assert.equal(s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '0'); assert.equal(s.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1');
    assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
    assert.deepEqual(s.fallbackModel, ['opus']);
    assert.deepEqual(mergeSettings({ fallbackModel: ['sonnet'] }, 'C:\\f').settings.fallbackModel, ['sonnet']);
    for (const ev of HOOK_EVENTS) {
      const ours = s.hooks[ev].flatMap(g => g.hooks).filter(h => h.command === 'node "C:/f/hooks/log-event.mjs"');
      assert.equal(ours.length, 1, ev); assert.equal(ours[0].type, 'command'); assert.equal(ours[0].timeout, ev === 'SessionEnd' ? 5 : 10);
    }
    assert.deepEqual(s.hooks.PreToolUse[0], CUSTOM_SETTINGS.hooks.PreToolUse[0]);
    assert.deepEqual(s.hooks.Stop[0], CUSTOM_SETTINGS.hooks.Stop[0]);
    assert.equal(Object.keys(s.hooks).length, 17);
    // idempotent: merging the result again changes nothing
    assert.deepEqual(mergeSettings(s, 'C:\\f').settings, s);
    // input not mutated
    assert.equal(CUSTOM_SETTINGS.hooks.PreToolUse.length, 1); assert.equal(CUSTOM_SETTINGS.fallbackModel, undefined);
  });
  test('upsertManagedBlock: append when absent, replace in place when present, collapse duplicates, never touch other text', () => {
    const block = managedBlock('C:\\f');
    assert.ok(block.startsWith(MARK_BEGIN) && block.endsWith(MARK_END));
    assert.ok(block.includes('## Forja') && block.includes('`C:\\f`') && block.includes('RUNBOOK-UNATTENDED.md') && block.includes('Lead') && block.includes('Reviewer') && block.includes('All Forja runs keep state in docs/forja/.'));
    const once = upsertManagedBlock(CUSTOM_CLAUDE, block);
    assert.ok(once.startsWith(CUSTOM_CLAUDE)); assert.equal(once, CUSTOM_CLAUDE + '\n' + block + '\n');
    assert.equal(upsertManagedBlock(once, block), once);
    const stale = once.replace(block, `${MARK_BEGIN}\n## Forja\n- old\n${MARK_END}`) + 'tail text\n';
    const fixed = upsertManagedBlock(stale, block);
    assert.equal(fixed, once + 'tail text\n');
    const dup = once + '\n' + block + '\n';
    assert.equal((upsertManagedBlock(dup, block).match(/forja:begin/g) || []).length, 1);
    assert.equal(upsertManagedBlock('', block), block + '\n');
    assert.equal(upsertManagedBlock('no newline at end', block), 'no newline at end\n\n' + block + '\n');
  });
  test('the block separates preparing the project from choosing who drives a run (§3c): both ways, as equals', () => {
    const block = managedBlock('C:\\f');
    assert.match(block, /prepared for Forja; that does not start anything/);
    assert.match(block, /ONE driver, recorded in `docs\/forja\/RUN.json` \(`driver`\)/);
    assert.match(block, /In a conversation .*run start --goal "<goal>".*`interactive`, and the guard never launches a runner on it/);
    assert.match(block, /Unattended: .*runner --goal "<goal>".*the run is `runner`, and the guard recovers it/);
    assert.match(block, /run driver show\|set interactive\|runner/);
    assert.doesNotMatch(block, /Start an unattended run from this folder/, 'the old block sent every run to the runner');
  });
  test('a CRLF CLAUDE.md gets the block in CRLF (no bare LF), is idempotent, and a replaced block keeps CRLF', () => {
    const block = managedBlock('C:\\f');
    const crlf = CUSTOM_CLAUDE.replace(/\n/g, '\r\n');
    assert.equal(detectEol(crlf), '\r\n'); assert.equal(detectEol(CUSTOM_CLAUDE), '\n');
    const once = upsertManagedBlock(crlf, block);
    assert.ok(once.startsWith(crlf));
    assert.equal((once.match(/\n/g) || []).length, (once.match(/\r\n/g) || []).length, 'every LF is part of a CRLF');
    assert.equal(once, crlf + '\r\n' + block.replace(/\n/g, '\r\n') + '\r\n');
    assert.equal(upsertManagedBlock(once, block), once, 'idempotent');
    const stale = once.replace(block.replace(/\n/g, '\r\n'), `${MARK_BEGIN}\r\n- old\r\n${MARK_END}`);
    assert.equal(upsertManagedBlock(stale, block), once);
  });
  test('a non-array hooks.<event> in the target is kept as is with a warning; the other events still get our hook', () => {
    const { settings: s, warnings } = mergeSettings({ hooks: { Stop: 'not-a-list', PreToolUse: { hooks: [] } } }, 'C:\\f');
    assert.equal(s.hooks.Stop, 'not-a-list'); assert.deepEqual(s.hooks.PreToolUse, { hooks: [] });
    assert.equal(warnings.length, 2); assert.match(warnings[0], /hooks\.PreToolUse não é uma lista/); assert.match(warnings[1], /hooks\.Stop não é uma lista/);
    const ok = HOOK_EVENTS.filter(ev => Array.isArray(s.hooks[ev]) && s.hooks[ev].some(g => g.hooks.some(h => h.command === 'node "C:/f/hooks/log-event.mjs"')));
    assert.equal(ok.length, 15);
  });
});

describe('bootstrap into a temp target with its own CLAUDE.md, settings.json and agent', () => {
  const t = makeTarget('my-app');
  test('first run: custom text and hook intact, ours added, docs/forja created, summary lists create/update', () => {
    const r = run(t);
    assert.equal(r.code, 0, r.err); assert.equal(r.json.ok, true); assert.equal(r.json.dryRun, false);
    assert.equal(r.json.target, t);
    const claude = readFileSync(join(t, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith(CUSTOM_CLAUDE), 'custom text intact at the top');
    assert.equal((claude.match(/forja:begin/g) || []).length, 1);
    assert.ok(claude.includes(`- Forja repo: \`${forja}\``) || claude.includes('- Forja repo: `'));
    const s = JSON.parse(readFileSync(join(t, '.claude', 'settings.json'), 'utf8'));
    assert.equal(s.env.MY_FLAG, 'yes'); assert.equal(s.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '0'); assert.equal(s.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, '1');
    assert.deepEqual(s.permissions, CUSTOM_SETTINGS.permissions); assert.deepEqual(s.fallbackModel, ['opus']);
    assert.deepEqual(s.hooks.PreToolUse[0], CUSTOM_SETTINGS.hooks.PreToolUse[0], 'custom hook intact');
    const cmd = hookCommand(forja);
    assert.ok(/^node "[A-Za-z]:\/[^"\\]+\/hooks\/log-event\.mjs"$/.test(cmd), cmd);
    assert.ok(existsSync(cmd.slice(6, -1)), 'the hook command points at a real file');
    for (const ev of HOOK_EVENTS) assert.equal(s.hooks[ev].flatMap(g => g.hooks).filter(h => h.command === cmd).length, 1, ev);
    for (const a of AGENTS) assert.equal(readFileSync(join(t, '.claude', 'agents', `${a}.md`), 'utf8'), readFileSync(join(forja, '.claude', 'agents', `${a}.md`), 'utf8'));
    assert.equal(readFileSync(join(t, '.claude', 'agents', 'mine.md'), 'utf8'), '# mine\n', 'foreign agent kept');
    for (const sk of readdirSync(join(forja, '.claude', 'skills')).filter(n => n.startsWith('forja-'))) assert.equal(readFileSync(join(t, '.claude', 'skills', sk, 'SKILL.md'), 'utf8'), readFileSync(join(forja, '.claude', 'skills', sk, 'SKILL.md'), 'utf8'));
    assert.equal(readFileSync(join(t, 'docs', 'forja', 'TASKS.json'), 'utf8'), '[]\n');
    assert.equal(readFileSync(join(t, 'docs', 'forja', 'DECISIONS.md'), 'utf8'), DECISIONS_HEADER);
    assert.equal(readFileSync(join(t, 'docs', 'forja', 'SPONSOR-QUEUE.md'), 'utf8'), QUEUE_HEADER);
    assert.ok(!existsSync(join(t, 'docs', 'forja', 'RUN.json')));
    assert.deepEqual(r.json.updated.sort(), ['.claude/settings.json', 'CLAUDE.md']);
    assert.ok(r.json.created.includes('.claude/agents/product-manager.md') && r.json.created.includes('docs/forja/TASKS.json') && r.json.created.includes('.claude/skills/forja-crew/SKILL.md'));
    assert.deepEqual(r.json.unchanged, []);
  });
  test('second run: byte-identical tree, everything unchanged', () => {
    const before = fingerprint(t);
    const r = run(t);
    assert.equal(r.code, 0); assert.deepEqual(r.json.created, []); assert.deepEqual(r.json.updated, []);
    assert.equal(r.json.unchanged.length, AGENTS.length + readdirSync(join(forja, '.claude', 'skills')).filter(n => n.startsWith('forja-')).length + 1 + 3 + 1);
    assert.deepEqual(fingerprint(t), before);
  });
  test('run state and the Sponsor text survive a third run after someone wrote in them', () => {
    writeFileSync(join(t, 'docs', 'forja', 'TASKS.json'), '[{"id":"T1"}]\n');
    writeFileSync(join(t, 'CLAUDE.md'), readFileSync(join(t, 'CLAUDE.md'), 'utf8') + '\n## Extra\nkeep me\n');
    const r = run(t);
    assert.equal(r.code, 0); assert.deepEqual(r.json.updated, []);
    assert.equal(readFileSync(join(t, 'docs', 'forja', 'TASKS.json'), 'utf8'), '[{"id":"T1"}]\n');
    assert.ok(readFileSync(join(t, 'CLAUDE.md'), 'utf8').endsWith('\n## Extra\nkeep me\n'));
  });
});

describe('dry-run and refusals', () => {
  test('--dry-run prints the same plan and writes nothing', () => {
    const t = makeTarget('dry'); const before = fingerprint(t);
    const r = run(t, '--dry-run');
    assert.equal(r.code, 0, r.err); assert.equal(r.json.dryRun, true);
    assert.ok(r.json.created.includes('docs/forja/TASKS.json') && r.json.updated.includes('CLAUDE.md'));
    assert.deepEqual(fingerprint(t), before);
    assert.ok(!existsSync(join(t, 'docs')));
  });
  test('missing dir, a file, the forja repo itself, and a parent of the forja repo are refused', () => {
    assert.throws(() => planBootstrap(join(root, 'nope')), /não existe/);
    const f = join(root, 'a-file.txt'); writeFileSync(f, 'x');
    assert.throws(() => planBootstrap(f), /não é uma pasta/);
    assert.throws(() => planBootstrap(forja), /próprio repo/);
    assert.throws(() => planBootstrap(join(forja, '..')), /contém o repo do Forja/);
    assert.throws(() => planBootstrap(undefined), /uso:/);
    const r = run(join(root, 'nope')); assert.notEqual(r.code, 0); assert.match(r.err, /não existe/);
  });
  test('a target without CLAUDE.md or .claude gets a minimal CLAUDE.md and a fresh settings.json', () => {
    const t = join(root, 'bare'); mkdirSync(t);
    const r = run(t); assert.equal(r.code, 0, r.err);
    const claude = readFileSync(join(t, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith('# bare — project rules\n\n' + MARK_BEGIN)); assert.ok(claude.trimEnd().endsWith(MARK_END));
    const s = JSON.parse(readFileSync(join(t, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(s).sort(), ['env', 'fallbackModel', 'hooks']); assert.equal(Object.keys(s.hooks).length, 17);
    assert.ok(r.json.created.includes('CLAUDE.md') && r.json.created.includes('.claude/settings.json'));
  });
  test('invalid settings.json is refused, not overwritten', () => {
    const t = join(root, 'badjson'); mkdirSync(join(t, '.claude'), { recursive: true }); writeFileSync(join(t, '.claude', 'settings.json'), '{ not json');
    const r = run(t); assert.notEqual(r.code, 0); assert.match(r.err, /não é JSON válido/);
    assert.equal(readFileSync(join(t, '.claude', 'settings.json'), 'utf8'), '{ not json');
  });
});

describe('legacy forge-named files', () => {
  test('a second bootstrap removes the agent files and skill folders an earlier Forja installed under the old names', () => {
    const root = mkdtempSync(join(tmpdir(), 'forja-boot-legacy-'));
    try {
      mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
      mkdirSync(join(root, '.claude', 'skills', 'forja-decide'), { recursive: true });
      writeFileSync(join(root, '.claude', 'agents', 'bigorna.md'), '# old\nskills:\n  - forja-crew');
      writeFileSync(join(root, '.claude', 'agents', 'mine.md'), '# not ours');
      writeFileSync(join(root, '.claude', 'skills', 'forja-decide', 'SKILL.md'), '# old skill (forja)');
      const r = spawnSync(process.execPath, [join(here, '..', 'bin', 'forja.mjs'), 'bootstrap', root], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const s = JSON.parse(r.stdout);
      assert.ok(s.removed.includes('.claude/agents/bigorna.md') && s.removed.includes('.claude/skills/forja-decide'), JSON.stringify(s.removed));
      assert.equal(existsSync(join(root, '.claude', 'agents', 'bigorna.md')), false);
      assert.equal(existsSync(join(root, '.claude', 'skills', 'forja-decide')), false);
      assert.equal(existsSync(join(root, '.claude', 'agents', 'mine.md')), true, 'files that are not ours are kept');
      assert.equal(existsSync(join(root, '.claude', 'agents', 'product-manager.md')), true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('legacy names that are not ours', () => {
  test('a user file with a legacy name that does not mention Forja is kept and reported', () => {
    const root = mkdtempSync(join(tmpdir(), 'forja-boot-keep-'));
    try {
      mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
      mkdirSync(join(root, '.claude', 'skills', 'forja-decide'), { recursive: true });
      writeFileSync(join(root, '.claude', 'agents', 'contraste.md'), '# my own contraste agent');
      writeFileSync(join(root, '.claude', 'skills', 'forja-decide', 'SKILL.md'), '# my own decide skill');
      const r = spawnSync(process.execPath, [join(here, '..', 'bin', 'forja.mjs'), 'bootstrap', root], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      const s = JSON.parse(r.stdout);
      assert.deepEqual(s.removed, []);
      assert.ok(existsSync(join(root, '.claude', 'agents', 'contraste.md')));
      assert.ok(existsSync(join(root, '.claude', 'skills', 'forja-decide', 'SKILL.md')));
      assert.ok((s.warnings || []).some(w => /contraste\.md/.test(w)) && (s.warnings || []).some(w => /forja-decide/.test(w)), JSON.stringify(s.warnings));
    } finally { rmSync(root, { recursive: true, force: true }); }
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
