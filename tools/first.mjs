#!/usr/bin/env node
// `node tools/first.mjs --dir <pasta de sessões> [--from <ISO> --to <ISO>] [--exclude <ids>]`
// — para cada ficheiro .jsonl de --dir: a primeira mensagem do utilizador
// (em caracteres) e o primeiro message.usage da sessão (tokens de entrada,
// de criação de cache, de leitura de cache), para medir o custo do primeiro
// pedido de uma sessão nova. Imprime uma linha por sessão, ordenada por
// timestamp; se --from e --to forem dados, imprime também a média sobre as
// sessões dessa janela.
//
// Cópia parametrizada de C:/tools/forja-token-tools/first.mjs
// (D31, decisão S6 em docs/forja/TECHNOLOGY.md — essa pasta é leitura
// apenas). Método de leitura inalterado — node:fs/node:readline, primeira
// linha `user`, primeira linha com `message.usage`; o que mudou é que a
// pasta e a janela, antes fixas para o projeto sample-project, passam a
// argumentos.
//
// Argumentos:
//   --dir <pasta>       obrigatório
//   --from <ISO>        opcional — início da janela usada para a média
//   --to <ISO>          opcional — fim da janela usada para a média
//   --exclude <lista>   opcional — ids de sessão (8 carateres do nome do
//                       ficheiro, separados por vírgula) fora só da média,
//                       ex.: uma sessão interativa que não é uma fase do run
//   -h, --help          mostra esta ajuda e sai a 0
//
// Sem argumento nenhum, sem --dir, ou com --help: mostra a ajuda e sai a 0.
// Sem --from e --to: só imprime a linha por sessão, sem bloco de média (sem
// janela não há "sessões desta janela" a promediar). Sem --exclude: nenhuma
// sessão fica de fora da média.
//
// Exemplo:
//   node tools/first.mjs --dir "C:/fixtures/sessions" --from 2026-09-18T12:23 --to 2026-09-19T22:10 --exclude example1
import { readdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `uso: node tools/first.mjs --dir <pasta de sessões> [--from <ISO> --to <ISO>] [--exclude <ids>]

Primeira mensagem do utilizador e primeiro message.usage por sessão de
--dir, ordenados por timestamp. Com --from e --to, imprime também a média
sobre essa janela; --exclude tira ids (8 carateres, separados por vírgula)
só da média.

  --dir <pasta>       obrigatório
  --from <ISO>        opcional
  --to <ISO>          opcional
  --exclude <lista>   opcional
  -h, --help          esta ajuda`;

export function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--exclude') out.exclude = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
  }
  return out;
}

export async function collectFirstRequests(dir) {
  const rows = [];
  for (const f of readdirSync(dir).filter(x => x.endsWith('.jsonl'))) {
    const rl = createInterface({ input: createReadStream(join(dir, f), 'utf8'), crlfDelay: Infinity });
    let first = null, firstTs = null, firstUserChars = null, nUser = 0, model = null;
    for await (const line of rl) {
      const s = line.trim(); if (!s) continue;
      let e; try { e = JSON.parse(s); } catch { continue; }
      const msg = e && e.message;
      if (msg && (msg.role === 'user' || e.type === 'user') && nUser === 0) {
        const c = msg.content;
        firstUserChars = typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((a, b) => a + ((b.text || '').length), 0) : 0;
        nUser++;
      }
      if (msg && msg.usage && !first) {
        first = msg.usage; firstTs = e.timestamp; model = msg.model;
      }
      if (first) break;
    }
    if (first) rows.push({ id: f.slice(0, 8), ts: firstTs, model, in: first.input_tokens || 0, cc: first.cache_creation_input_tokens || 0, cr: first.cache_read_input_tokens || 0, uchars: firstUserChars });
  }
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return rows;
}

export function windowStats(rows, { from, to, exclude = [] } = {}) {
  if (!from || !to) return null;
  const win = rows.filter(r => r.ts >= from && r.ts <= to && !exclude.includes(r.id));
  const avg = k => Math.round(win.reduce((a, r) => a + r[k], 0) / win.length);
  return {
    win,
    avgCc: win.length ? avg('cc') : null,
    avgCr: win.length ? avg('cr') : null,
    avgIn: win.length ? avg('in') : null,
    avgUchars: win.length ? avg('uchars') : null,
    minCc: win.length ? Math.min(...win.map(r => r.cc)) : null,
    maxCc: win.length ? Math.max(...win.map(r => r.cc)) : null,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.length <= 2 || args.help || !args.dir) {
    console.log(HELP);
    process.exit(0);
  }
  const rows = await collectFirstRequests(args.dir);
  for (const r of rows) console.log(r.id, String(r.ts).slice(0, 16), String(r.model).padEnd(16), 'in', String(r.in).padStart(6), 'cc', String(r.cc).padStart(7), 'cr', String(r.cr).padStart(7), 'promptChars', String(r.uchars).padStart(7));
  const stats = windowStats(rows, { from: args.from, to: args.to, exclude: args.exclude || [] });
  if (stats) {
    console.log(`\n--- janela ${args.from} .. ${args.to} sessions:`, stats.win.length);
    if (stats.win.length) {
      console.log('avg first-request cache_creation:', stats.avgCc, ' avg cache_read:', stats.avgCr, ' avg in:', stats.avgIn, ' avg prompt chars:', stats.avgUchars);
      console.log('min cc', stats.minCc, 'max cc', stats.maxCc);
    }
  }
}
