// bin/forja.mjs dispatch since 0.22.0: Core (`start`, `core ...`) plus the
// monitoring commands, with a Core-only usage text. The removed legacy commands
// are covered by test/legacy-cli.test.mjs. ntfy is pointed at a dead port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/forja.mjs', import.meta.url));

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function forja(cwd, data, args) {
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9', FORJA_NTFY_TOPIC: 'fixture-cli' };
  delete env.FORJA_PROJECT_ROOT;
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const KEPT = ['start', 'core', 'serve', 'up', 'down', 'token', 'autostart', 'guard', 'projects', 'bootstrap'];

test('the dispatch handles exactly the kept commands', () => {
  const source = readFileSync(cli, 'utf8');
  const cases = [...source.matchAll(/^\s+case '([a-z-]+)':/gm)].map(m => m[1]);
  assert.deepEqual(cases.sort(), [...KEPT].sort());
  assert.doesNotMatch(source, /lib\/(?:runner|driver|autonomy|models|run-cost|obsidian-sync)\b|from '\.\.\/lib\/(?!state-files\.mjs')/, 'no legacy module is imported');
});

test('without a command the usage is printed with exit 0, and it is Core-only', t => {
  const dir = tempDir(t, 'forja-cli-');
  const r = forja(dir, join(dir, 'data'), []);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^FORJA core \(docs\/CORE-RUNBOOK\.md\)\n/);
  assert.match(r.out, /\n {2}core decide --run ID --decision D --option ID --why "\.\.\."/);
  assert.match(r.out, /\nMonitoring:\n {2}serve \| up \[--port N\] \[--no-tunnel\] \| down \| token rotate \| autostart install\|remove\n/);
  for (const line of ['  guard [run] [--poll-ms 60000] | guard stop | guard status', '  projects list | projects prune', '  bootstrap <repo> [--dry-run]'])
    assert.ok(r.out.includes(line), line);
  assert.doesNotMatch(r.out, /\bLegacy\b|legacy runs|--legacy|forjalvl|autonomy|run start|task add|runner \[|\banswers\b|fallback|obsidian|\bdecisions reindex\b/);
  // Every command line of the usage starts with a kept command.
  const commands = r.out.split('\n').filter(l => /^ {2}[a-z]/.test(l)).map(l => l.trim().split(/\s/)[0]);
  for (const cmd of commands) assert.ok(KEPT.includes(cmd), `usage line for ${cmd}`);
  assert.equal(readdirSync(dir).length, 0, 'printing the usage writes nothing, not even the data dir');
});

test('core --help prints the same Core-only usage', t => {
  const dir = tempDir(t, 'forja-cli-');
  const data = join(dir, 'data');
  assert.equal(forja(dir, data, ['core', '--help']).out, forja(dir, data, []).out);
});

test('an unknown command, or an Object.prototype name, prints the usage with exit 2', t => {
  const dir = tempDir(t, 'forja-cli-');
  const usage = forja(dir, join(dir, 'data'), []).out;
  for (const cmd of ['nope', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    const r = forja(dir, join(dir, 'data'), [cmd]);
    assert.equal(r.code, 2, cmd);
    assert.equal(r.out, usage, cmd);
    assert.doesNotMatch(r.err, /was removed/, `${cmd} is unknown, not removed`);
  }
  assert.equal(readdirSync(dir).length, 0);
});

test('projects list runs through the dispatch', t => {
  const dir = tempDir(t, 'forja-cli-');
  const data = join(dir, 'data'); mkdirSync(data);
  const r = forja(dir, data, ['projects', 'list']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out), { ok: true, projects: [], missing: 0 });
});

test('a delegated command that throws is one sentence, not a stack (the dispatch awaits it)', t => {
  // `projects prune` throws on an unreadable registry (lib/projects.mjs). If the
  // dispatch in main() returned the promise without `await`, the rejection would
  // escape its try/catch and print a stack instead of a refusal.
  const dir = tempDir(t, 'forja-delegate-');
  const data = join(dir, 'data'); mkdirSync(data, { recursive: true });
  const registry = join(data, 'projects.json');
  const truncated = '{ "version": 1, "projects": [ ';
  writeFileSync(registry, truncated);
  const r = forja(dir, data, ['projects', 'prune']);
  const output = `${r.out}${r.err}`.trim();
  assert.equal(r.code, 1, output);
  assert.equal(output.split('\n').length, 1, `one line, no stack:\n${output}`);
  assert.match(output, /^forja: o registo de projetos existe mas está ilegível .*corrige-o ou apaga-o à mão$/);
  assert.equal(/\n\s+at |\.mjs:\d+/.test(output), false, 'no stack frames');
  assert.equal(readFileSync(registry, 'utf8'), truncated, 'the unreadable registry was not rewritten');
});
