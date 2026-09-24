// Operator stop requests. The CLI runs in another process than the controller,
// which owns current.json under the single-writer lock. A request is therefore
// a separate file that only the controller consumes, between invocations.
import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inside } from './files.mjs';

const MODES = ['invocation', 'task'];
const TASK_ID = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
export const stopRequestPath = root => inside(root, '.forja/stop-request.json');

// Returns a well-formed request for runId, or null. Malformed or foreign
// requests are ignored rather than trusted.
export function readStopRequest(root, runId) {
  try {
    const path = stopRequestPath(root);
    if (!existsSync(path)) return null;
    const r = JSON.parse(readFileSync(path, 'utf8'));
    if (!r || r.version !== 1 || r.run_id !== runId || !MODES.includes(r.mode) ||
        (r.task !== null && !TASK_ID.test(r.task)) || typeof r.requested_at !== 'string' ||
        Number.isNaN(Date.parse(r.requested_at)))
      return null;
    return { version: 1, run_id: r.run_id, mode: r.mode, task: r.task, requested_at: r.requested_at };
  } catch {
    return null;
  }
}

export function clearStopRequest(root) {
  try { unlinkSync(stopRequestPath(root)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// The task the controller is working on, or will select next: the pending
// invocation's task, else the first unfinished task whose dependencies are done.
export function currentTaskId(run) {
  if (run.pending?.task) return run.pending.task;
  const done = id => run.tasks.find(t => t.id === id)?.status === 'done';
  return run.tasks.find(t => t.status !== 'done' && t.after.every(done))?.id ?? null;
}

// A default request is due at any invocation boundary. An after-task request
// is due only before an invocation for a different task than the one it names.
export const stopDue = (request, nextTaskId) =>
  !!request && (request.mode === 'invocation' || request.task !== (nextTaskId ?? null));

// controllerAlive reports whether a live controller holds the project lock.
export function requestStop(root, { afterTask = false, controllerAlive } = {}) {
  const file = inside(root, '.forja/current.json');
  if (!existsSync(file)) throw new Error('No Core run to stop.');
  const run = JSON.parse(readFileSync(file, 'utf8'));
  if (run.status !== 'running' || !controllerAlive())
    throw new Error(`No active Core run to stop: run ${run.run_id} is ${run.status === 'running' ? 'not attached to a live controller' : run.status}. A stop request applies only to a running controller.`);
  const mode = afterTask ? 'task' : 'invocation';
  const existing = readStopRequest(root, run.run_id);
  // Repeated requests are idempotent; never loosen an earlier, stricter boundary.
  if (existing && (existing.mode === mode || existing.mode === 'invocation'))
    return { run, request: existing, changed: false };
  const request = { version: 1, run_id: run.run_id, mode, task: afterTask ? currentTaskId(run) : null, requested_at: new Date().toISOString() };
  const path = stopRequestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
  renameSync(tmp, path);
  return { run, request, changed: true };
}
