#!/usr/bin/env node
// Serve a test fixture through the real viewer server with its timestamps
// re-based to "now", so every state looks live (instances working, timers
// ticking) instead of dead by clock. For screenshots and UI work only.
//
//   node tools/serve-fixture.mjs <fixture-name|path.jsonl> [port] [--tail-ago 20]
//
// Prints the tokenized local URL. Ctrl+C stops it. Never touches data/.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../viewer/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const args = process.argv.slice(2);
let tailAgo = 20;
const pos = [];
for (let i = 0; i < args.length; i++) { if (args[i] === '--tail-ago') tailAgo = Number(args[++i]); else pos.push(args[i]); }
const [name = 'all-states', portArg = '4390'] = pos;
const src = existsSync(name) ? resolve(name) : join(repoRoot, 'test', 'fixtures', `${name}.jsonl`);
if (!existsSync(src)) { console.error(`fixture not found: ${src}`); process.exit(1); }

const lines = readFileSync(src, 'utf8').split('\n');
const times = lines.map(l => { try { return Date.parse(JSON.parse(l).ts); } catch { return NaN; } }).filter(Number.isFinite);
const last = Math.max(...times);
const shift = Date.now() - tailAgo * 1000 - last;
const rebased = lines.map(l => {
  if (!l.trim()) return l;
  try { const r = JSON.parse(l); if (r.ts) r.ts = new Date(Date.parse(r.ts) + shift).toISOString(); return JSON.stringify(r); } catch { return l; }
}).join('\n');

const dataDir = mkdtempSync(join(tmpdir(), 'forja-fixture-'));
writeFileSync(join(dataDir, 'events.jsonl'), rebased);
process.env.FORJA_NO_WATCHDOG = '1';
process.env.FORJA_NTFY_SERVER = 'http://127.0.0.1:9';
const s = startServer({ port: Number(portArg), host: '127.0.0.1', dataDir });
console.log(`fixture ${name} re-based (last event ${tailAgo}s ago) → data dir ${dataDir}`);
console.log(`append more events to ${join(dataDir, 'events.jsonl')} to see live updates`);
