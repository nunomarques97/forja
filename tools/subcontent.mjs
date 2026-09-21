#!/usr/bin/env node
// `node tools/subcontent.mjs --dir <pasta de sessões> [--from <ISO> --to <ISO>] [--exclude <ids>]`
// — igual a content.mjs, mas só sobre ficheiros dentro de qualquer pasta
// <sessão>/subagents/ (os especialistas nativos que uma sessão lança pelo
// `Agent`/`Task` tool), incluindo os resultados de ferramenta no total de
// caracteres do utilizador (é a diferença estrutural real entre este script
// e content.mjs, preservada da fonte).
//
// Cópia parametrizada de
// C:/tools/forja-token-tools/subcontent.mjs (D31, decisão S6 em
// docs/forja/TECHNOLOGY.md — essa pasta é leitura apenas). Método de leitura
// inalterado — node:fs/node:readline, um JSON por linha; o que mudou é que a
// pasta, a janela e a exclusão de sessões, antes fixas para o projeto
// sample-project, passam a argumentos.
//
// Argumentos:
//   --dir <pasta>       obrigatório — pasta com sessões (percorre-a por
//                       inteiro, à procura de qualquer subagents/**/*.jsonl)
//   --from <ISO>        opcional — início da janela
//   --to <ISO>          opcional — fim da janela
//   --exclude <lista>   opcional — trechos de caminho (separados por
//                       vírgula) a ignorar, ex.: o id de uma sessão
//                       interativa que não é uma fase do run
//   -h, --help          mostra esta ajuda e sai a 0
//
// Sem argumento nenhum, sem --dir, ou com --help: mostra a ajuda e sai a 0.
// Sem --from e --to: conta tudo. Sem --exclude: nada é ignorado.
//
// Uso desta medição (D31, critério de aceitação 5): caracteres de
// docs/forja/* lidos por especialistas — corre com --dir apontado à pasta de
// sessões do projeto e procura, na secção "by file read" da saída, a linha
// do ficheiro que interessa (ex. TASKS.json).
//
// Exemplo:
//   node tools/subcontent.mjs --dir "C:/fixtures/sessions" --from 2026-09-18T12:23 --to 2026-09-19T22:10
import { readdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `uso: node tools/subcontent.mjs --dir <pasta de sessões> [--from <ISO> --to <ISO>] [--exclude <ids>]

Igual a content.mjs, mas só sobre ficheiros dentro de <sessão>/subagents/.
Sem --from/--to conta tudo; --exclude ignora caminhos que contenham um dos
trechos dados.

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

export async function computeSubagentContent(base, { from, to, exclude = [] } = {}) {
  const byTool = {}, byCmd = {}, byRead = {}, big = [];
  let nS = 0, userChars = 0, asstChars = 0, nRes = 0;
  const BS = String.fromCharCode(92);
  for (const p of walk(base)) {
    if (!p.includes('subagents')) continue;
    if (exclude.some(id => p.includes(id))) continue;
    const rl = createInterface({ input: createReadStream(p, 'utf8'), crlfDelay: Infinity });
    const pend = new Map(); let inWin = null;
    for await (const line of rl) {
      const s = line.trim(); if (!s) continue;
      let e; try { e = JSON.parse(s); } catch { continue; }
      if (inWin === null) {
        if (!from && !to) inWin = true;
        else if (e.timestamp) inWin = (!from || e.timestamp >= from) && (!to || e.timestamp <= to);
        if (inWin) nS++;
      }
      if (!inWin) continue;
      const m = e.message && typeof e.message === 'object' ? e.message : null; if (!m) continue;
      const c = m.content;
      if (m.role === 'assistant' || e.type === 'assistant') {
        if (Array.isArray(c)) for (const b of c) {
          if (b.type === 'text') asstChars += (b.text || '').length;
          else if (b.type === 'thinking') asstChars += (b.thinking || '').length;
          else if (b.type === 'tool_use') { pend.set(b.id, { name: b.name, input: b.input }); asstChars += JSON.stringify(b.input || {}).length; }
        }
      } else if (m.role === 'user' || e.type === 'user') {
        if (typeof c === 'string') userChars += c.length;
        else if (Array.isArray(c)) for (const b of c) {
          if (b.type === 'text') userChars += (b.text || '').length;
          else if (b.type === 'tool_result') {
            const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''); const len = t.length; nRes++; userChars += len;
            const meta = pend.get(b.tool_use_id) || { name: 'unknown', input: {} };
            byTool[meta.name] = (byTool[meta.name] || 0) + len;
            if (meta.name === 'Bash' || meta.name === 'PowerShell') { const cmd = String(meta.input && meta.input.command || '').trim().split('\n')[0]; const key = cmd.split(/\s+/).slice(0, 3).join(' ').slice(0, 50); byCmd[key] = (byCmd[key] || 0) + len; }
            if (meta.name === 'Read') { const fp = String(meta.input && meta.input.file_path || '').split(BS).join('/').split('/').slice(-2).join('/'); byRead[fp] = (byRead[fp] || 0) + len; }
            if (len > 40000) big.push({ tool: meta.name, len, hint: JSON.stringify(meta.input || {}).slice(0, 140) });
          }
        }
      }
    }
  }
  return { nS, nRes, asstChars, userChars, byTool, byCmd, byRead, big };
}

function top(o, n) { return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n); }

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.length <= 2 || args.help || !args.dir) {
    console.log(HELP);
    process.exit(0);
  }
  const r = await computeSubagentContent(args.dir, { from: args.from, to: args.to, exclude: args.exclude || [] });
  console.log('subagent sessions:', r.nS, 'tool results:', r.nRes);
  console.log('assistant chars:', r.asstChars.toLocaleString(), ' user chars:', r.userChars.toLocaleString());
  console.log('\n-- by tool --'); for (const [k, v] of top(r.byTool, 14)) console.log(String(k).padEnd(26), v.toLocaleString(), (v / r.userChars * 100).toFixed(1) + '%');
  console.log('\n-- by command head --'); for (const [k, v] of top(r.byCmd, 25)) console.log(String(k).padEnd(52), v.toLocaleString());
  console.log('\n-- by file read --'); for (const [k, v] of top(r.byRead, 20)) console.log(String(k).padEnd(46), v.toLocaleString());
  console.log('\n-- single results > 40k chars --'); for (const b of r.big.sort((a, b) => b.len - a.len).slice(0, 15)) console.log(b.tool, b.len.toLocaleString(), b.hint);
}
