// ntfy.sh client for Forja. Status-only messages: never code, diffs, file
// contents, full paths, tokens or secrets — not in the body and not in the
// Click link (the topic name is the only secret; see docs/ARCHITECTURE.md §10).
// Every Click URL goes through sanitizeClick, the single chokepoint that drops
// credential-looking query parameters, whatever the caller read from
// data/tunnel.json. Node core only; UTF-8 explicit so Portuguese accents never
// get re-encoded into an attachment.
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SERVER = 'https://ntfy.sh';
// Resolved per call, like the topic and server: callers (and tests) may set
// FORJA_DATA_DIR after this module is imported.
const dataDir = () => process.env.FORJA_DATA_DIR || join(repoRoot, 'data');
const logPath = () => join(dataDir(), 'notify.log');

export function topic() {
  if (process.env.FORJA_NTFY_TOPIC !== undefined) return process.env.FORJA_NTFY_TOPIC.trim();
  try {
    const config = JSON.parse(readFileSync(join(dataDir(), 'notify-config.json'), 'utf8'));
    return typeof config.topic === 'string' ? config.topic.trim() : '';
  } catch { return ''; }
}

// Same message inside DEDUP_MS is dropped (the watchdog and the tunnel manager
// both poll; without this a flapping state would spam the phone).
const DEDUP_MS = 10 * 60 * 1000;
function recentlySent(message) {
  try {
    const path = logPath();
    if (!existsSync(path)) return false;
    const lines = readFileSync(path, 'utf8').trim().split('\n').slice(-200);
    const now = Date.now();
    return lines.some(l => {
      try { const r = JSON.parse(l); return r.message === message && now - Date.parse(r.ts) < DEDUP_MS && r.ok; } catch { return false; }
    });
  } catch { return false; }
}

// The ntfy topic is public: a Click link that carries the viewer token would
// hand the topic's readers a session on the Sponsor's PC (POST /runs starts
// runs). Strip the credential parameters instead of trusting every caller;
// anything that is not a parseable http(s) URL is dropped outright.
// Allow-list, not a black-list of parameter names: a Click link is only ever a
// page of the viewer, so origin + path is everything it needs. Query string,
// fragment and userinfo are dropped whole — that way no future parameter name
// (and no `?K=` / `?Token=` spelling) can carry a credential onto a public
// topic, whatever a stale data/tunnel.json holds.
export function sanitizeClick(click) {
  if (!click) return undefined;
  let u;
  try { u = new URL(String(click)); } catch { return undefined; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  u.username = ''; u.password = '';
  u.search = ''; u.hash = '';
  return u.toString();
}

function logLine(rec) {
  try { const path = logPath(); mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(rec) + '\n'); } catch {}
}

/**
 * notify(message, { title, priority, tags, click, dedup })
 * priority: 'min' | 'low' | 'default' | 'high' | 'urgent'
 * Returns { ok, status, skipped } and never throws (a failed notification must
 * never break a run; it is logged to data/notify.log instead).
 */
export async function notify(message, opts = {}) {
  const { title = 'Forja', priority = 'default', tags = [], click, dedup = true, timeoutMs = 10000 } = opts;
  if (!message || !String(message).trim()) return { ok: false, skipped: 'empty' };
  const destination = topic();
  if (!destination) return { ok: false, skipped: 'not-configured' };
  if (dedup && recentlySent(message)) { logLine({ ts: new Date().toISOString(), message, ok: true, skipped: 'dedup' }); return { ok: true, skipped: 'dedup' }; }
  const url = `${process.env.FORJA_NTFY_SERVER || DEFAULT_SERVER}/${encodeURIComponent(destination)}`;
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: encodeHeader(title), Priority: priority };
  if (tags.length) headers.Tags = tags.join(',');
  const safeClick = sanitizeClick(click);
  if (safeClick) headers.Click = safeClick;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: Buffer.from(String(message), 'utf8'), signal: ctrl.signal });
    const ok = res.ok;
    logLine({ ts: new Date().toISOString(), message, title, priority, click: safeClick ? '(set)' : undefined, ok, status: res.status });
    return { ok, status: res.status };
  } catch (err) {
    logLine({ ts: new Date().toISOString(), message, title, priority, ok: false, error: String(err && err.message || err) });
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ntfy reads the Title header as-is; non-ASCII must be RFC 2047 encoded.
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// CLI: node lib/notify.mjs "message" [--title T] [--priority P] [--click URL] [--no-dedup]
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--title') opt.title = args[++i];
    else if (args[i] === '--priority') opt.priority = args[++i];
    else if (args[i] === '--click') opt.click = args[++i];
    else if (args[i] === '--tags') opt.tags = String(args[++i] || '').split(',').filter(Boolean);
    else if (args[i] === '--no-dedup') opt.dedup = false;
    else rest.push(args[i]);
  }
  notify(rest.join(' '), opt).then(r => { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); });
}
