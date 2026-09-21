#!/usr/bin/env node
// `node tools/usage.mjs --dir <pasta de sessões>` — soma message.usage
// (tokens de entrada, de criação de cache, de leitura de cache e de saída)
// por ficheiro .jsonl de uma pasta de sessões do Claude Code
// (`~/.claude/projects/<slug>`), separado em "main" (thread principal,
// isSidechain ausente ou false) e "side" (isSidechain: true).
//
// Leitura parametrizada de transcrições nativas privadas.
// (D31, decisão S6 em docs/forja/TECHNOLOGY.md — essa pasta é leitura
// apenas, nunca se escreve lá). O método de leitura está inalterado —
// node:fs/node:readline, um JSON por linha, somar message.usage; o que
// mudou é que a pasta de sessões e a janela de tempo, antes fixas para o
// projeto de origem, passam a argumentos de linha de comandos.
//
// Argumentos:
//   --dir <pasta>   obrigatório — pasta com ficheiros .jsonl de sessão
//                   (só os de topo; não desce a <sessão>/subagents/)
//   --from <ISO>    opcional — ignora linhas com timestamp < --from
//   --to <ISO>      opcional — ignora linhas com timestamp > --to
//   -h, --help      mostra esta ajuda e sai a 0
//
// Sem argumento nenhum, sem --dir, ou com --help: mostra esta ajuda e sai a
// 0 (nunca rebenta com uma pilha de erros). Sem --from/--to: nenhuma linha é
// filtrada por tempo (o comportamento original, que não tinha janela).
//
// Escreve só em stdout, um array JSON, um objeto por ficheiro; nunca em
// disco e nunca fora deste repositório.
//
// Exemplo (medição de T1, docs/forja/TASKS.json — "tokens de entrada por
// run", referência do estudo 153,2 M):
//   node tools/usage.mjs --dir "C:/private/sessions" --from 2026-01-01T12:00 --to 2026-01-02T12:00
import { readdirSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { usageAccumulator } from '../lib/usage-counts.mjs';

const HELP = `uso: node tools/usage.mjs --dir <pasta de sessões> [--from <ISO>] [--to <ISO>]

Soma message.usage (input/cache_creation/cache_read/output) por ficheiro
.jsonl de --dir, separado em "main" e "side" (isSidechain: true).
Sem --from/--to conta tudo. Imprime um array JSON em stdout.

  --dir <pasta>   obrigatório
  --from <ISO>    opcional
  --to <ISO>      opcional
  -h, --help      esta ajuda`;

export function parseArgs(argv) {
  const out = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
  }
  return out;
}

export async function aggregateUsage(dir, { from, to } = {}) {
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  const out = [];
  for (const f of files) {
    const p = join(dir, f);
    const st = statSync(p);
    const rl = createInterface({ input: createReadStream(p, 'utf8'), crlfDelay: Infinity });
    const agg = { file: f, mtime: st.mtime.toISOString(), bytes: st.size, main: {}, side: {}, firstTs: null, lastTs: null, nReq: 0, nSide: 0 };
    const accumulate = usageAccumulator();
    const add = (bucket, model, u, fresh) => {
      const b = bucket[model] || (bucket[model] = { in: 0, cc: 0, cr: 0, out: 0, n: 0 });
      b.in += u.input_tokens || 0;
      b.cc += (u.cache_creation_input_tokens || 0);
      b.cr += (u.cache_read_input_tokens || 0);
      b.out += u.output_tokens || 0;
      if (fresh) b.n++;
    };
    for await (const line of rl) {
      const s = line.trim(); if (!s) continue;
      let e; try { e = JSON.parse(s); } catch { continue; }
      if (!e || typeof e !== 'object') continue;
      if (from && (!e.timestamp || e.timestamp < from)) continue;
      if (to && (!e.timestamp || e.timestamp > to)) continue;
      if (e.timestamp) { if (!agg.firstTs) agg.firstTs = e.timestamp; agg.lastTs = e.timestamp; }
      const msg = e.message;
      if (!msg || typeof msg !== 'object' || !msg.usage) continue;
      const model = String(msg.model || '?');
      const { delta, newMessage } = accumulate(msg);
      if (e.isSidechain === true) { add(agg.side, model, delta, newMessage); if (newMessage) agg.nSide++; }
      else { add(agg.main, model, delta, newMessage); if (newMessage) agg.nReq++; }
    }
    out.push(agg);
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.length <= 2 || args.help || !args.dir) {
    console.log(HELP);
    process.exit(0);
  }
  const out = await aggregateUsage(args.dir, { from: args.from, to: args.to });
  console.log(JSON.stringify(out));
}
