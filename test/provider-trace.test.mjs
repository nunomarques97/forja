import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { providerTrace } from '../lib/core/provider-trace.mjs';
import { runProvider, execute } from '../lib/core/providers.mjs';

const root = mkdtempSync(join(tmpdir(), 'forja-trace-'));
after(() => rmSync(root, { recursive: true, force: true }));
const rows = path => readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);

test('trace persists bounded metadata before completion without copying tool content', () => {
  const path = join(root, 'bounded.jsonl');
  const trace = providerTrace(path, 'codex', 2);
  trace.observe('{broken', 1);
  trace.observe('null', 2);
  trace.observe(JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', status: 'in_progress', command: 'PRIVATE_COMMAND', aggregated_output: 'PRIVATE_OUTPUT' } }), 3);
  // The journal must already exist on disk while the provider is still active.
  assert.equal(rows(path).length, 2);
  trace.observe(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', status: 'failed', exit_code: 1 } }), 10);
  trace.observe(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 123 } }), 11);
  const summary = trace.finish();
  assert.equal(summary.events, 3);
  assert.equal(summary.recorded_events, 2);
  assert.equal(summary.dropped_events, 1);
  assert.equal(summary.unparsed_lines, 2);
  assert.equal(summary.first_event_ms, 3);
  assert.equal(summary.last_event_ms, 11);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /PRIVATE_|input_tokens/);
  assert.deepEqual(trace.finish(), summary);
});

test('timeout retains completed events on disk while usage stays unknown', async () => {
  const script = join(root, 'timeout.mjs');
  writeFileSync(script, `process.stdout.write('{"type":"thread.');
setTimeout(() => { console.log('started","thread_id":"fixture"}'); console.log('{"type":"item.started","item":{"id":"item_0","type":"command_execution","status":"in_progress","command":"PRIVATE"}}'); }, 20);
setTimeout(() => {}, 30000);`);
  const tracePath = join(root, 'timeout.jsonl');
  const out = await runProvider('codex', {
    config: { command: process.execPath, args: [script] },
    cwd: root, timeoutMs: 1500, schemaPath: join(root, 'unused-schema.json'),
    resultPath: join(root, 'absent-result.json'), logPath: join(root, 'timeout-stream.json'), tracePath,
  });
  assert.equal(out.timedOut, true);
  assert.equal(out.usage, null);
  assert.equal(out.calls, null);
  assert.equal(out.observations.events, 2);
  const events = rows(tracePath).filter(r => r.kind === 'event');
  assert.deepEqual(events.map(e => e.type), ['thread.started', 'item.started']);
  assert.ok(events.every((e, i) => Number.isSafeInteger(e.elapsed_ms) && e.elapsed_ms >= 0 && (!i || e.elapsed_ms >= events[i - 1].elapsed_ms)));
  assert.match(JSON.parse(readFileSync(join(root, 'timeout-stream.json'))).stdout, /PRIVATE/);
  assert.doesNotMatch(readFileSync(tracePath, 'utf8'), /PRIVATE/);
});

test('line observation handles trailing JSON and cannot swallow sink failures', async () => {
  const observed = [];
  const trailing = await execute(process.execPath, ['-e', `process.stdout.write('noise\\n{"type":"turn.completed"}')`], {
    cwd: root, onStdoutLine: line => observed.push(line),
  });
  assert.equal(trailing.code, 0);
  assert.deepEqual(observed, ['noise', '{"type":"turn.completed"}']);
  const failed = await execute(process.execPath, ['-e', `console.log('{}');setTimeout(()=>{},30000)`], {
    cwd: root, timeoutMs: 5000, onStdoutLine: () => { throw Error('fixture disk error'); },
  });
  assert.match(failed.observationError, /fixture disk error/);
  assert.notEqual(failed.code, 0);
  assert.equal(failed.timedOut, false);
});

test('trace refuses existing files and symlinks before modifying their target', () => {
  const destination = join(root, 'protected.txt');
  writeFileSync(destination, 'preserve');
  assert.throws(() => providerTrace(destination, 'codex'), /EEXIST/);
  const link = join(root, 'trace-link.jsonl');
  try { symlinkSync(destination, link, 'file'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; return; }
  assert.throws(() => providerTrace(link, 'codex'), /EEXIST/);
  assert.equal(readFileSync(destination, 'utf8'), 'preserve');
});
