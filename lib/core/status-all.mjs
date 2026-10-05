// `forja core status --all`: one line per registered project (the FORJA data
// dir registry, lib/projects.mjs) that has a Core run, for an operator who
// checks several overnight projects at once. Strictly read-only: no lock is
// taken and nothing in the registry or in any project's .forja is written, so
// it is safe beside live controllers and works from any folder. Projects
// without a Core run (legacy-only, never started, or a folder that is gone)
// are only counted. One unreadable project never hides the others.
//
// JSON (--json) is a stable script contract:
// { ok, projects: [{ project, status, tasks_done, tasks_total,
//   current: { task, phase, attempt } | null, updated_at, block_reason,
//   usage_limit_wait, queue_length }], without_core_run }
// status is running | interrupted (running without a live controller) |
// waiting (usage-limit wait) | blocked | done | failed | unreadable.
import { existsSync, readFileSync } from 'node:fs';
import { inside } from './context.mjs';
import { coreAlive } from './observe.mjs';
import { recoveryInfo, usageLimitWaitStatus } from './recovery.mjs';
import { readStopRequest } from './stop.mjs';
import { queueLength } from './queue.mjs';
import { pendingTechnology } from './technology.mjs';
import { loadProjects } from '../projects.mjs';
import { dataDir as defaultDataDir } from '../state-files.mjs';

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const UNREADABLE = 'Core state is unreadable; check it locally.';

// The current Core run of one project: null without one, or a status row.
function projectRow(name, root, alive) {
  let file;
  try {
    file = inside(root, '.forja/current.json');
    if (!existsSync(file)) return null;
  } catch {
    return unreadable(name, root);
  }
  let r;
  try {
    r = JSON.parse(readFileSync(file, 'utf8'));
    if (!r || r.version !== 1 || !/^F-[A-Za-z0-9-]+$/.test(r.run_id) ||
        !['running', 'blocked', 'done', 'failed'].includes(r.status) || !Array.isArray(r.tasks))
      throw new Error('Invalid state');
    const live = coreAlive(root, alive);
    const stopRequested = !!readStopRequest(root, r.run_id);
    const wait = usageLimitWaitStatus(r, { stopRequested });
    const status = r.status === 'running' ? (live ? 'running' : 'interrupted') : wait ? 'waiting' : r.status;
    const p = r.pending && typeof r.pending === 'object' ? r.pending : null;
    const technology = ['running', 'blocked'].includes(r.status) && pendingTechnology(r).length > 0;
    return {
      project: name,
      status,
      tasks_done: r.tasks.filter((t) => t?.status === 'done').length,
      tasks_total: r.tasks.length,
      current: p ? { task: str(p.task, 64), phase: str(p.phase, 32), attempt: count(p.attempt) } : null,
      updated_at: str(r.updated_at, 40),
      block_reason: technology ? 'Sponsor technology choice pending' : recoveryInfo(r, { alive: live, stopRequested })?.title ?? null,
      usage_limit_wait: wait,
      queue_length: queueLength(root).length,
    };
  } catch {
    return unreadable(name, root);
  }
}

function unreadable(name, root) {
  let queue = null;
  try { queue = queueLength(root).length; } catch {}
  return { project: name, status: 'unreadable', tasks_done: null, tasks_total: null, current: null,
    updated_at: null, block_reason: UNREADABLE, usage_limit_wait: null, queue_length: queue };
}

// The report object; a corrupt registry throws (nothing is read or written).
export function statusAll({ dataDir = defaultDataDir(), alive } = {}) {
  const registry = loadProjects(dataDir);
  if (registry.corrupt)
    throw new Error('The FORJA project registry (projects.json in the FORJA data folder) is unreadable; fix or remove it by hand. Nothing was read from the projects and nothing was changed.');
  const projects = [];
  let withoutCoreRun = 0;
  for (const p of [...registry.projects].sort((a, b) => a.name.localeCompare(b.name))) {
    let row = null;
    try {
      row = existsSync(p.path) ? projectRow(p.name, p.path, alive) : null;
    } catch {
      row = unreadable(p.name, p.path);
    }
    if (row) projects.push(row);
    else withoutCoreRun++;
  }
  return { ok: true, projects, without_core_run: withoutCoreRun };
}

function statusText(row) {
  if (row.status !== 'waiting') return row.status;
  const w = row.usage_limit_wait;
  return `waiting for usage limit until ${w.reset_at}${w.auto_resume ? '' : ' (no automatic resume; core resume after that time)'}`;
}

// One human-readable line per project plus the count line.
export function statusAllLines(report) {
  const lines = report.projects.map((row) => {
    const parts = [row.project, statusText(row)];
    if (row.status !== 'unreadable') {
      parts.push(`tasks ${row.tasks_done}/${row.tasks_total}`);
      if (row.current) parts.push(`current ${row.current.task || 'plan'} ${row.current.phase || 'call'} attempt ${row.current.attempt}`);
      parts.push(`updated ${row.updated_at || 'unknown'}`);
    }
    if (row.block_reason) parts.push(`reason: ${row.block_reason}`);
    parts.push(row.queue_length === null ? 'queue unreadable' : `queue ${row.queue_length}`);
    return parts.join(' | ');
  });
  if (!report.projects.length) lines.push('No registered project has a Core run.');
  lines.push(`${report.without_core_run} registered project${report.without_core_run === 1 ? '' : 's'} without a Core run.`);
  return lines;
}

// CLI: `core status --all [--json]`. Refuses other flags before reading.
export function statusAllCommand(pos = [], opt = {}) {
  const unknown = Object.keys(opt).filter((k) => !['all', 'json'].includes(k));
  if (unknown.length || opt.all !== true || ![undefined, true].includes(opt.json))
    throw new Error(`core status --all takes only --json${unknown.length ? `; unknown flag ${unknown.map((k) => `--${k}`).join(', ')}` : ''}. Nothing was read or changed.`);
  if (pos.length > 1)
    throw new Error(`Unexpected argument ${pos.slice(1).map((a) => JSON.stringify(String(a))).join(', ')} for core status --all. Nothing was read or changed.`);
  let report;
  try {
    report = statusAll();
  } catch (error) {
    if (!opt.json) throw error;
    console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exitCode = 1;
    return null;
  }
  console.log(opt.json ? JSON.stringify(report, null, 2) : statusAllLines(report).join('\n'));
  return report;
}
