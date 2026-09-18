#!/usr/bin/env node
// `node tools/stats.mjs [--run R-…|--session <id>] [--json]` — statistics per role
// for the runs in data/events.jsonl (or FORJA_DATA_DIR): time switched on, number
// of sessions (instances) and the model(s) each role actually ran on, computed by
// the same reducer the viewer uses (docs/ARCHITECTURE.md §8). Statistics only.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createState, applyLine, snapshot } from '../viewer/lib/state.mjs';
import { dataDir } from '../lib/state-files.mjs';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) { const v = args[i + 1]; if (v && !v.startsWith('--')) { opt[args[i].slice(2)] = v; i++; } else opt[args[i].slice(2)] = true; }

const path = opt.events || join(dataDir(), 'events.jsonl');
if (!existsSync(path)) { console.error(`stats: ${path} não existe`); process.exit(2); }
const st = createState();
let n = 0;
for (const line of readFileSync(path, 'utf8').split('\n')) if (line.trim()) applyLine(st, line, ++n);
const snap = snapshot(st, Date.now());

function fmtMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
const shortModel = m => m === 'desconhecido' ? 'sem modelo registado' : /fable/i.test(m) ? 'fable' : /opus/i.test(m) ? 'opus' : /sonnet/i.test(m) ? 'sonnet' : /haiku/i.test(m) ? 'haiku' : m;

let runs = snap.runs;
if (opt.run) runs = runs.filter(r => r.id === opt.run || (r.forja && r.forja.runId === opt.run));
if (opt.session) runs = runs.filter(r => (r.sessions || []).some(s => String(s).startsWith(opt.session)));
if (!runs.length) { console.error('stats: nenhum run corresponde'); process.exit(1); }

const rows = runs.map(r => ({
  run: r.forja && r.forja.runId ? r.forja.runId : r.id,
  project: r.project, status: r.status, started: r.startedAt, ended: r.endedAt,
  roles: r.roster.map(c => ({
    role: c.name, core: !!c.core, sessions: c.sessions || 0, activeMs: c.activeMs || 0,
    models: Object.fromEntries(Object.entries(c.models || {}).map(([k, v]) => [shortModel(k), v])),
  })),
  native: (r.native || []).length,
}));

if (opt.json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
for (const r of rows) {
  console.log(`\n${r.run} · ${r.project} · ${r.status} · ${new Date(r.started).toISOString().slice(0, 16).replace('T', ' ')}${r.ended ? ' → ' + new Date(r.ended).toISOString().slice(11, 16) : ''}`);
  console.log('| Papel | Modelo(s) | Tempo ligado | Sessões |');
  console.log('|---|---|---|---|');
  for (const c of r.roles) {
    const models = Object.entries(c.models).sort((a, b) => b[1] - a[1]).map(([m, ms]) => Object.keys(c.models).length > 1 ? `${m} ${fmtMs(ms)}` : m).join(', ') || "—";
    console.log(`| ${c.role}${c.core ? '' : ' (a pedido)'} | ${models} | ${c.activeMs ? fmtMs(c.activeMs) : '—'} | ${c.sessions || '—'} |`);
  }
  if (r.native) console.log(`| ferramentas nativas | sonnet | — | ${r.native} |`);
}
