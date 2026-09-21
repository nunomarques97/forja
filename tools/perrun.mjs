#!/usr/bin/env node
// `node tools/perrun.mjs --dir <pasta de sessões> --archive-dir <pasta de runs arquivados> [--exclude <ids>]`
// — soma cache_creation/cache_read/output de todas as sessões (topo e
// subagents/) de --dir, agrupa-as por run usando os ficheiros
// `docs/forja/archive/R-*.json` de --archive-dir (started_at/finished_at de
// cada run), e imprime tokens e pedidos por run mais a média entre runs.
//
// Leitura parametrizada de transcrições nativas: node:fs/node:readline,
// um JSON por linha. Diretórios e exclusões são argumentos explícitos;
// transcrições privadas nunca são incluídas no repositório.
//
// Argumentos:
//   --dir <pasta>          obrigatório — pasta de sessões do projeto
//                          (percorre-a por inteiro, topo e subagents/)
//   --archive-dir <pasta>  obrigatório — docs/forja/archive do projeto
//                          (ficheiros R-*.json com started_at/finished_at)
//   --exclude <lista>      opcional — trechos de caminho (separados por
//                          vírgula) a ignorar, ex.: uma sessão interativa
//   -h, --help             mostra esta ajuda e sai a 0
//
// Sem argumento nenhum, sem --dir/--archive-dir, ou com --help: mostra a
// ajuda e sai a 0. Sem --exclude: nenhuma sessão é ignorada.
//
// Exemplo:
//   node tools/perrun.mjs --dir "C:/private/sessions" --archive-dir "C:/projects/example/docs/forja/archive"
import { readdirSync, createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageAccumulator } from '../lib/usage-counts.mjs';

const HELP = `uso: node tools/perrun.mjs --dir <pasta de sessões> --archive-dir <pasta de runs arquivados> [--exclude <ids>]

Soma tokens de todas as sessões de --dir (topo e subagents/) e agrupa-as por
run usando os ficheiros R-*.json de --archive-dir. --exclude ignora
caminhos que contenham um dos trechos dados.

  --dir <pasta>          obrigatório
  --archive-dir <pasta>  obrigatório
  --exclude <lista>      opcional
  -h, --help             esta ajuda`;

export function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--archive-dir') out.archiveDir = argv[++i];
    else if (a === '--exclude') out.exclude = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

export function walk(d) {
  let r = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) r = r.concat(walk(p));
    else if (e.name.endsWith('.jsonl')) r.push(p);
  }
  return r;
}

export async function collectSessionUsage(base, { exclude = [] } = {}) {
  const sess = [];
  for (const p of walk(base)) {
    if (exclude.some(id => p.includes(id))) continue;
    const rl = createInterface({ input: createReadStream(p, 'utf8'), crlfDelay: Infinity });
    let ts = null, v = { cc: 0, cr: 0, out: 0, n: 0 };
    const accumulate = usageAccumulator();
    for await (const line of rl) {
      const s = line.trim(); if (!s) continue;
      let e; try { e = JSON.parse(s); } catch { continue; }
      if (e.timestamp && !ts) ts = e.timestamp;
      const m = e.message; if (!m || !m.usage) continue;
      const { delta, newMessage } = accumulate(m);
      v.cc += delta.cache_creation_input_tokens; v.cr += delta.cache_read_input_tokens; v.out += delta.output_tokens; if (newMessage) v.n++;
    }
    if (v.n) sess.push({ ts, ...v });
  }
  return sess;
}

export function loadRuns(archiveDir) {
  return readdirSync(archiveDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const j = JSON.parse(readFileSync(join(archiveDir, f), 'utf8'));
      const r = j.run || j;
      return { id: r.run_id, start: r.started_at, end: r.finished_at || r.ended_at || r.updated_at, tasks: (j.tasks || []).length };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

export function aggregateByRun(sess, runs) {
  let T = { s: 0, n: 0, cc: 0, cr: 0, out: 0, t: 0 };
  const rows = [];
  for (const r of runs) {
    const a = { s: 0, n: 0, cc: 0, cr: 0, out: 0 };
    for (const x of sess) if (x.ts >= r.start && x.ts <= (r.end || '9999')) { a.s++; a.n += x.n; a.cc += x.cc; a.cr += x.cr; a.out += x.out; }
    rows.push({ ...r, ...a });
    T.s += a.s; T.n += a.n; T.cc += a.cc; T.cr += a.cr; T.out += a.out; T.t += r.tasks;
  }
  const k = runs.length || 1;
  return {
    rows, totals: T, k,
    avgTasks: T.t / k, avgSess: T.s / k, avgReqs: T.n / k, avgCc: T.cc / k, avgCr: T.cr / k, avgOut: T.out / k,
    avgInputTotal: T.cc / k + T.cr / k,
    weightedCost: (T.cc / k) * 2 + (T.cr / k) * 0.1 + (T.out / k) * 5,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.length <= 2 || args.help || !args.dir || !args.archiveDir) {
    console.log(HELP);
    process.exit(0);
  }
  const f = n => Math.round(n).toLocaleString('en-US');
  const sess = await collectSessionUsage(args.dir, { exclude: args.exclude || [] });
  const runs = loadRuns(args.archiveDir);
  const agg = aggregateByRun(sess, runs);
  for (const r of agg.rows) console.log(r.id, 'tasks', String(r.tasks).padStart(2), 'sess', String(r.s).padStart(3), 'reqs', String(r.n).padStart(5), 'cc', f(r.cc).padStart(11), 'cr', f(r.cr).padStart(13), 'out', f(r.out).padStart(9));
  console.log('\nMEDIA por run: tasks', agg.avgTasks.toFixed(1), 'sess', agg.avgSess.toFixed(1), 'reqs', f(agg.avgReqs), 'cc', f(agg.avgCc), 'cr', f(agg.avgCr), 'out', f(agg.avgOut));
  console.log('entrada total/run', f(agg.avgInputTotal));
  console.log('custo ponderado/run', f(agg.weightedCost));
}
