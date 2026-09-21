#!/usr/bin/env node
// `node tools/content.mjs --dir <pasta de sessões> [--from <ISO> --to <ISO>] [--exclude <ids>]`
// — sobre as sessões de topo (thread principal, não desce a
// <sessão>/subagents/) de --dir: caracteres de texto do assistente, de
// prompts e de resultados de ferramenta do utilizador, por ferramenta, por
// comando Bash/PowerShell e por ficheiro lido, mais os resultados de
// ferramenta com mais de 60 000 caracteres.
//
// Cópia parametrizada de C:/tools/forja-token-tools/content.mjs
// (D31, decisão S6 em docs/forja/TECHNOLOGY.md — essa pasta é leitura
// apenas). Método de leitura inalterado — node:fs/node:readline, um JSON por
// linha, somar caracteres de texto/tool_use/tool_result; o que mudou é que a
// pasta, a janela e a exclusão de sessões, antes fixas para o projeto
// sample-project, passam a argumentos.
//
// Argumentos:
//   --dir <pasta>       obrigatório — pasta com ficheiros .jsonl de sessão
//   --from <ISO>        opcional — início da janela
//   --to <ISO>          opcional — fim da janela
//   --exclude <lista>   opcional — nomes de ficheiro (prefixo, separados por
//                       vírgula) a ignorar por inteiro, ex.: uma sessão
//                       interativa que não é uma fase do run
//   -h, --help          mostra esta ajuda e sai a 0
//
// Sem argumento nenhum, sem --dir, ou com --help: mostra a ajuda e sai a 0.
// Sem --from e --to: conta todas as sessões (sem filtro de tempo — a versão
// original só contava a janela fixa; sem janela nenhuma, o valor razoável é
// "tudo", nunca "nada"). Sem --exclude: nenhuma sessão é ignorada.
//
// Exemplo:
//   node tools/content.mjs --dir "C:/fixtures/sessions" --from 2026-09-18T12:23 --to 2026-09-19T22:07 --exclude example1
import { readdirSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `uso: node tools/content.mjs --dir <pasta de sessões> [--from <ISO> --to <ISO>] [--exclude <ids>]

Caracteres de texto do assistente e de resultados de ferramenta das sessões
de topo de --dir, por ferramenta / comando / ficheiro lido. Sem --from/--to
conta tudo; --exclude ignora ficheiros cujo nome comece por um dos prefixos.

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

export async function computeMainContent(dir, { from, to, exclude = [] } = {}) {
  const files = readdirSync(dir).filter(f => f.endsWith('.jsonl') && !exclude.some(id => f.startsWith(id)));
  const byTool = {}, byCmd = {}, byReadFile = {};
  let assistantChars = 0, userChars = 0, nSessions = 0, nToolRes = 0;
  const bigResults = [];
  for (const f of files) {
    const p = join(dir, f);
    const rl = createInterface({ input: createReadStream(p, 'utf8'), crlfDelay: Infinity });
    let inWindow = null;
    const pendingTool = new Map();
    for await (const line of rl) {
      const s = line.trim(); if (!s) continue;
      let e; try { e = JSON.parse(s); } catch { continue; }
      if (!e || typeof e !== 'object') continue;
      if (inWindow === null) {
        if (!from && !to) inWindow = true;
        else if (e.timestamp) inWindow = (!from || e.timestamp >= from) && (!to || e.timestamp <= to);
        if (inWindow) nSessions++;
      }
      if (!inWindow) continue;
      const msg = e.message && typeof e.message === 'object' ? e.message : null;
      if (!msg) continue;
      const c = msg.content;
      if (msg.role === 'assistant' || e.type === 'assistant') {
        if (Array.isArray(c)) for (const b of c) {
          if (b.type === 'text') assistantChars += (b.text || '').length;
          else if (b.type === 'thinking') assistantChars += (b.thinking || '').length;
          else if (b.type === 'tool_use') { pendingTool.set(b.id, { name: b.name, input: b.input }); assistantChars += JSON.stringify(b.input || {}).length; }
        }
      } else if (msg.role === 'user' || e.type === 'user') {
        if (typeof c === 'string') userChars += c.length;
        else if (Array.isArray(c)) for (const b of c) {
          if (b.type === 'text') userChars += (b.text || '').length;
          else if (b.type === 'tool_result') {
            const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
            const len = t.length; nToolRes++;
            const meta = pendingTool.get(b.tool_use_id) || { name: 'unknown', input: {} };
            byTool[meta.name] = (byTool[meta.name] || 0) + len;
            if (meta.name === 'Bash' || meta.name === 'PowerShell') {
              const cmd = String(meta.input && meta.input.command || '').trim().split('\n')[0].slice(0, 60);
              const key = cmd.split(/\s+/).slice(0, 3).join(' ');
              byCmd[key] = (byCmd[key] || 0) + len;
            }
            if (meta.name === 'Read') {
              const fp = String(meta.input && meta.input.file_path || '').split(String.fromCharCode(92)).join('/').split('/').slice(-2).join('/');
              byReadFile[fp] = (byReadFile[fp] || 0) + len;
            }
            if (len > 60000) bigResults.push({ f: f.slice(0, 8), tool: meta.name, len, hint: JSON.stringify(meta.input || {}).slice(0, 120) });
          }
        }
      }
    }
  }
  return { nSessions, nToolRes, assistantChars, userChars, byTool, byCmd, byReadFile, bigResults };
}

function top(o, n = 15) { return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n); }

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.length <= 2 || args.help || !args.dir) {
    console.log(HELP);
    process.exit(0);
  }
  const r = await computeMainContent(args.dir, { from: args.from, to: args.to, exclude: args.exclude || [] });
  console.log('sessions in window:', r.nSessions, 'tool results:', r.nToolRes);
  console.log('assistant chars (text+thinking+tool inputs):', r.assistantChars.toLocaleString());
  console.log('user chars (prompts + tool results):', r.userChars.toLocaleString());
  console.log('\n--- chars of tool_result by tool ---');
  for (const [k, v] of top(r.byTool)) console.log(String(k).padEnd(28), v.toLocaleString(), (v / r.userChars * 100).toFixed(1) + '%');
  console.log('\n--- chars by bash command head ---');
  for (const [k, v] of top(r.byCmd, 20)) console.log(String(k).padEnd(40), v.toLocaleString());
  console.log('\n--- chars by file Read ---');
  for (const [k, v] of top(r.byReadFile, 20)) console.log(String(k).padEnd(48), v.toLocaleString());
  console.log('\n--- single tool results > 60k chars ---');
  for (const b of r.bigResults.sort((a, b) => b.len - a.len).slice(0, 20)) console.log(b.f, b.tool, b.len.toLocaleString(), b.hint);
}
