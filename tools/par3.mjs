#!/usr/bin/env node
// `node tools/par3.mjs --dir <pasta de sessões> [--from <ISO> --to <ISO>] [--exclude <ids>]`
// — média de ferramentas por jogada ("turno do modelo que chama pelo menos
// uma ferramenta"), separada em `lead` (ficheiros de topo de --dir) e
// `subagents` (ficheiros dentro de qualquer <sessão>/subagents/). Agrupa por
// `message.id` (nunca por linha do ficheiro: uma jogada com várias chamadas
// de ferramenta pode ficar escrita em várias linhas com o mesmo
// `message.id` — contar linhas dava sempre uma média perto de 1,00, e estava
// errado).
//
// Cópia parametrizada de C:/tools/forja-token-tools/par3.mjs
// (D31, decisão S6 em docs/forja/TECHNOLOGY.md — essa pasta é leitura
// apenas). Método de leitura inalterado — node:fs/node:readline, um JSON por
// linha, agrupar por message.id; o que mudou é que a pasta, a janela e a
// exclusão de sessões, antes fixas para o projeto sample-project, passam a
// argumentos.
//
// Argumentos:
//   --dir <pasta>       obrigatório — pasta de sessões (percorre-a por
//                       inteiro, topo e subagents/)
//   --from <ISO>        opcional — início da janela
//   --to <ISO>          opcional — fim da janela
//   --exclude <lista>   opcional — trechos de caminho (separados por
//                       vírgula) a ignorar só do grupo `lead`, ex.: uma
//                       sessão interativa que não é uma fase do run
//   -h, --help          mostra esta ajuda e sai a 0
//
// Sem argumento nenhum, sem --dir, ou com --help: mostra a ajuda e sai a 0.
// Sem --from e --to: conta tudo. Sem --exclude: nada é ignorado.
//
// Exemplo (medição de T1, referência do estudo: 1,12 no lead, 1,16 nos
// especialistas):
//   node tools/par3.mjs --dir "C:/fixtures/sessions" --from 2026-09-18T12:23 --to 2026-09-19T22:10 --exclude example1
import { readdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `uso: node tools/par3.mjs --dir <pasta de sessões> [--from <ISO> --to <ISO>] [--exclude <ids>]

Média de ferramentas por jogada (turno do modelo agrupado por message.id,
nunca por linha), separada em "lead" (ficheiros de topo) e "subagents"
(dentro de qualquer subagents/). Sem --from/--to conta tudo; --exclude
ignora caminhos (só no grupo "lead") que contenham um dos trechos dados.

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

export function walk(d) {
  let r = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) r = r.concat(walk(p));
    else if (e.name.endsWith('.jsonl')) r.push(p);
  }
  return r;
}

export async function turnsPerPlay(base, { from, to, exclude = [] } = {}) {
  const results = {};
  for (const kind of ['subagents', 'lead']) {
    const hist = {}; let groups = 0, calls = 0;
    for (const p of walk(base)) {
      const isSub = p.includes('subagents');
      if (kind === 'subagents' ? !isSub : isSub) continue;
      if (kind === 'lead' && exclude.some(id => p.includes(id))) continue;
      const rl = createInterface({ input: createReadStream(p, 'utf8'), crlfDelay: Infinity });
      let inWin = null; const g = {}; let n = 0;
      for await (const line of rl) {
        const s = line.trim(); if (!s) continue;
        let e; try { e = JSON.parse(s); } catch { continue; }
        if (inWin === null) {
          if (!from && !to) inWin = true;
          else if (e.timestamp) inWin = (!from || e.timestamp >= from) && (!to || e.timestamp <= to);
        }
        if (!inWin) continue;
        const m = e.message; if (!m || (m.role !== 'assistant' && e.type !== 'assistant')) continue;
        const c = m.content; if (!Array.isArray(c)) continue;
        const t = c.filter(b => b && b.type === 'tool_use').length; if (!t) continue;
        // Agrupar por message.id, nunca pela linha do ficheiro (ver cabeçalho).
        const k = m.id || e.requestId || ('x' + (n++));
        g[k] = (g[k] || 0) + t;
      }
      for (const v of Object.values(g)) { hist[v] = (hist[v] || 0) + 1; groups++; calls += v; }
    }
    results[kind] = { groups, calls, avg: groups ? calls / groups : 0, hist };
  }
  return results;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.length <= 2 || args.help || !args.dir) {
    console.log(HELP);
    process.exit(0);
  }
  const r = await turnsPerPlay(args.dir, { from: args.from, to: args.to, exclude: args.exclude || [] });
  for (const kind of ['subagents', 'lead']) {
    const k = r[kind];
    console.log(kind, '| model turns that call tools:', k.groups, '| tool calls:', k.calls, '| avg per turn:', k.avg.toFixed(2));
    console.log('   distribution:', JSON.stringify(k.hist));
  }
}
