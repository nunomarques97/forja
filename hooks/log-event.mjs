#!/usr/bin/env node
// Claude Code hook command for every Forja event. Reads the hook payload as JSON
// on stdin (how Claude Code delivers hook data — confirmed empirically, see
// docs/ARCHITECTURE.md §8) and appends one JSON line to data/events.jsonl.
//
// Contract (docs/ARCHITECTURE.md §8):
// - never blocks or slows Claude Code: exit code is always 0, nothing on stdout,
//   every failure of this script goes to data/hook-errors.log instead;
// - one line per event: { ts, project, ...payload } — ts is the capture time
//   (the payload carries none), project = basename(cwd);
// - big string fields are capped at CAP characters (≈ CAP bytes for ASCII, at
//   most 4× for multibyte text; the transcript keeps the original); the record
//   lists what was cut under `_truncated`;
// - the file is rotated at ROTATE_AT bytes (renamed to events.<stamp>.jsonl);
// - a single appendFileSync per event: NTFS serialises append writes, so two
//   concurrent hooks (main session + subagent) never interleave half lines;
// - writes data/sessions/<projectKey>.json on session-level events so the
//   forja CLI can find the current session for a project without the
//   undocumented CLAUDE_CODE_SESSION_ID env var.
//
// Usage in settings.json (any hook event):
//   { "type": "command", "command": "node \"${CLAUDE_PROJECT_DIR}/hooks/log-event.mjs\"", "timeout": 10 }
// Env: FORJA_DATA_DIR overrides the data directory (tests).

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.FORJA_DATA_DIR || join(repoRoot, 'data');
const eventsPath = join(dataDir, 'events.jsonl');
const errorsPath = join(dataDir, 'hook-errors.log');
const CAP = Number(process.env.FORJA_HOOK_CAP || 16 * 1024);
const ROTATE_AT = Number(process.env.FORJA_HOOK_ROTATE_AT || 64 * 1024 * 1024);
const SESSION_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd', 'StopFailure']);

function logError(where, err) {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(errorsPath, `${new Date().toISOString()} ${where}: ${err && err.stack ? err.stack : err}\n`);
  } catch {
    // Nothing else we can do; the hook must still exit 0.
  }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    logError('stdin', err);
    return '';
  }
}

// Case- and separator-insensitive key for a Windows path: the same repo shows
// up as C:\Users\... in one session and c:\Users\... in another.
export function projectKey(cwd) {
  return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Caps every string inside the payload at CAP characters (recursively), keeps
// object shapes intact so consumers can still read tool_input.description,
// tool_response.agentId, etc. Arrays longer than 200 items are cut too.
export function capPayload(value, path, truncated, depth = 0) {
  if (typeof value === 'string') {
    if (value.length <= CAP) return value;
    truncated.push({ field: path, original_length: value.length });
    return value.slice(0, CAP) + `…[truncated ${value.length - CAP} chars]`;
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, 200).map((v, i) => capPayload(v, `${path}[${i}]`, truncated, depth + 1));
    if (value.length > 200) truncated.push({ field: path, original_length: value.length, kept: 200 });
    return out;
  }
  if (value && typeof value === 'object') {
    if (depth > 12) { truncated.push({ field: path, reason: 'depth' }); return '[nested too deep]'; }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = capPayload(v, path ? `${path}.${k}` : k, truncated, depth + 1);
    return out;
  }
  return value;
}

export function buildRecord(raw, now = new Date()) {
  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = { parse_error: true, raw: String(raw) };
    } catch {
      payload = { parse_error: true, raw };
    }
  }
  const truncated = [];
  const capped = capPayload(payload, '', truncated);
  // Our own fields win: a payload carrying `ts`/`project` (never seen from
  // Claude Code, but nothing forbids it) must not spoof the capture time or
  // the project name. Keep the originals under payload_* for the record.
  if ('ts' in capped) { capped.payload_ts = capped.ts; delete capped.ts; }
  if ('project' in capped) { capped.payload_project = capped.project; delete capped.project; }
  const record = {
    ts: now.toISOString(),
    project: typeof capped.cwd === 'string' && capped.cwd ? basename(capped.cwd.replace(/[\\/]+$/, '')) : null,
    ...capped,
  };
  if (truncated.length) record._truncated = truncated;
  return record;
}

function rotateIfNeeded() {
  let size = 0;
  try { size = statSync(eventsPath).size; } catch { return; }
  if (size < ROTATE_AT) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    renameSync(eventsPath, join(dataDir, `events.${stamp}.jsonl`));
  } catch (err) {
    // The viewer may hold the file open on Windows; try again on a later event.
    logError('rotate', err);
  }
}

function writeSessionPointer(record) {
  if (!SESSION_EVENTS.has(record.hook_event_name) || !record.session_id || !record.cwd) return;
  try {
    const dir = join(dataDir, 'sessions');
    mkdirSync(dir, { recursive: true });
    const key = projectKey(record.cwd).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const pointer = {
      session_id: record.session_id,
      cwd: record.cwd,
      project: record.project,
      last_event: record.hook_event_name,
      ended: record.hook_event_name === 'SessionEnd',
      ts: record.ts,
    };
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(pointer, null, 2));
  } catch (err) {
    logError('session-pointer', err);
  }
}

function main() {
  try {
    const raw = readStdin();
    if (!raw.trim()) { logError('stdin', 'empty payload (nothing written)'); return; }
    const record = buildRecord(raw);
    mkdirSync(dataDir, { recursive: true });
    rotateIfNeeded();
    appendFileSync(eventsPath, JSON.stringify(record) + '\n');
    writeSessionPointer(record);
  } catch (err) {
    logError('main', err);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main();
  process.exitCode = 0;
}
