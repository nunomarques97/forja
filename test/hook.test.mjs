// hooks/log-event.mjs contract (docs/ARCHITECTURE.md §8): always exit 0,
// never write to stdout, cap big fields, keep object shapes, survive garbage
// and unwritable directories, write the session pointer, rotate at the cap.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'hooks', 'log-event.mjs');
const run = (input, env = {}) => spawnSync(process.execPath, [script], { input, env: { ...process.env, ...env }, encoding: 'utf8' });
const fresh = () => mkdtempSync(join(tmpdir(), 'forja-hook-'));

describe('hook contract', () => {
  test('a normal PostToolUse becomes one JSON line with ts and project; exit 0, silent', () => {
    const dir = fresh();
    const payload = { session_id: 's1', cwd: 'C:\\Fixtures\\User\\Desktop\\Repositorios\\forja', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: { ok: 1 }, tool_use_id: 't1', duration_ms: 5 };
    const r = run(JSON.stringify(payload), { FORJA_DATA_DIR: dir });
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.project, 'forja'); assert.ok(Date.parse(rec.ts)); assert.equal(rec.tool_name, 'Read'); assert.equal(rec.session_id, 's1');
    rmSync(dir, { recursive: true, force: true });
  });
  test('strings over the cap are cut, object shapes survive, _truncated lists what was cut', () => {
    const dir = fresh();
    const big = 'a'.repeat(40000);
    const payload = { session_id: 's1', cwd: 'C:\\p\\forja', hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { description: 'T1 · Fundidor: x', prompt: big, subagent_type: 'fundidor', model: 'fable' }, tool_response: { agentId: 'abc', resolvedModel: 'claude-fable-5-1', content: big } };
    run(JSON.stringify(payload), { FORJA_DATA_DIR: dir });
    const rec = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim());
    assert.equal(rec.tool_input.description, 'T1 · Fundidor: x');
    assert.equal(rec.tool_response.agentId, 'abc');
    assert.ok(rec.tool_input.prompt.length < 17000);
    assert.match(rec.tool_input.prompt, /truncated 23616 chars/);
    assert.deepEqual(rec._truncated.map(t => t.field).sort(), ['tool_input.prompt', 'tool_response.content']);
    rmSync(dir, { recursive: true, force: true });
  });
  test('payload ts/project cannot spoof the capture fields; non-string cwd gives project null', () => {
    const dir = fresh();
    run(JSON.stringify({ session_id: 's', cwd: 'C:\\p\\forja', hook_event_name: 'Stop', ts: '1999-01-01T00:00:00Z', project: 'spoofed' }), { FORJA_DATA_DIR: dir });
    run(JSON.stringify({ session_id: 's', cwd: { odd: 1 }, hook_event_name: 'Stop' }), { FORJA_DATA_DIR: dir });
    const [a, b] = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(a.project, 'forja'); assert.notEqual(a.ts, '1999-01-01T00:00:00Z'); assert.equal(a.payload_ts, '1999-01-01T00:00:00Z'); assert.equal(a.payload_project, 'spoofed');
    assert.equal(b.project, null);
    rmSync(dir, { recursive: true, force: true });
  });
  test('garbage and empty stdin never fail the hook', () => {
    const dir = fresh();
    for (const input of ['not json', '', '[1,2]', '{"a":']) assert.equal(run(input, { FORJA_DATA_DIR: dir }).status, 0);
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, 'empty stdin writes nothing; the three bad inputs are recorded as parse_error');
    for (const l of lines) assert.equal(JSON.parse(l).parse_error, true);
    rmSync(dir, { recursive: true, force: true });
  });
  test('an unwritable data dir still exits 0', () => {
    const r = run(JSON.stringify({ a: 1 }), { FORJA_DATA_DIR: process.platform === 'win32' ? 'C:\\Windows\\System32\\forja-nope-dir' : '/proc/forja-nope' });
    assert.equal(r.status, 0);
  });
  test('session pointer is written on session-level events with a case-insensitive key', () => {
    const dir = fresh();
    run(JSON.stringify({ session_id: 'sess-9', cwd: 'c:\\Fixtures\\User\\Desktop\\Repositorios\\forja', hook_event_name: 'UserPromptSubmit', prompt: 'go' }), { FORJA_DATA_DIR: dir });
    const files = readdirSync(join(dir, 'sessions'));
    assert.deepEqual(files, ['c-fixtures-user-desktop-repositorios-forja.json']);
    const p = JSON.parse(readFileSync(join(dir, 'sessions', files[0]), 'utf8'));
    assert.equal(p.session_id, 'sess-9'); assert.equal(p.ended, false);
    run(JSON.stringify({ session_id: 'sess-9', cwd: 'C:\\Fixtures\\User\\Desktop\\Repositorios\\forja', hook_event_name: 'SessionEnd', reason: 'other' }), { FORJA_DATA_DIR: dir });
    assert.equal(JSON.parse(readFileSync(join(dir, 'sessions', files[0]), 'utf8')).ended, true);
    run(JSON.stringify({ session_id: 'sess-9', cwd: 'C:\\x', hook_event_name: 'PreToolUse', tool_name: 'Read' }), { FORJA_DATA_DIR: dir });
    assert.equal(readdirSync(join(dir, 'sessions')).length, 1, 'tool events do not write pointers');
    rmSync(dir, { recursive: true, force: true });
  });
  test('rotation: when the file passes the cap it is renamed and a new one starts', () => {
    const dir = fresh();
    writeFileSync(join(dir, 'events.jsonl'), 'x'.repeat(2000) + '\n');
    run(JSON.stringify({ session_id: 's', cwd: 'C:\\p\\forja', hook_event_name: 'Stop' }), { FORJA_DATA_DIR: dir, FORJA_HOOK_ROTATE_AT: '1000' });
    const files = readdirSync(dir).filter(f => f.startsWith('events'));
    assert.equal(files.length, 2);
    assert.ok(files.some(f => /^events\..+\.jsonl$/.test(f)));
    const live = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(live.length, 1);
    assert.equal(JSON.parse(live[0]).hook_event_name, 'Stop');
    rmSync(dir, { recursive: true, force: true });
  });
});
