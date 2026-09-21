// Forja → a Central de Projetos do Sponsor (Obsidian): ao fechar um run,
// invocar o programa DELE (`_obsidian-sync/sync.py --projetos <id>`) para a
// ficha do projeto ficar em dia. O Forja nunca escreve no vault: chama o
// script do Sponsor e mais nada (D12/D13 em docs/forja/DECISIONS.md, decisão
// S3 em docs/forja/TECHNOLOGY.md). Só núcleo do Node 24 — `node:fs`,
// `node:path`, `node:os` e `node:child_process.spawnSync` com `timeout`, o
// mesmo padrão que `claudeSync` em lib/runner.mjs usa há meses para correr um
// processo externo sem deixar uma falha subir.
//
// Duas metades, de propósito:
//  - `planObsidianSync()` é pura: decide, não corre nada, não escreve nada.
//    Devolve ou o motivo do salto ou a linha de comandos exata.
//  - `runObsidianSync()` é a única que lança um processo. NUNCA atira exceção,
//    nunca muda o código de saída de quem a chama e nunca envia ntfy: uma
//    falha, um timeout ou uma exceção voltam como valor e ficam num evento
//    `obsidian.sync` no stream (docs/ARCHITECTURE.md §8).
//
// Um passo acessório nunca pode matar o trabalho principal
// (docs/forja/PRODUCT-PROFILE.md, prioridade 4): é essa a regra inteira deste
// ficheiro.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emit as emitEvent } from './state-files.mjs';

// 60 s cobre a corrida incremental normal do `sync.py`; o script tem o seu
// próprio bloqueio contra execuções simultâneas (PROCEDIMENTO.md §3), por isso
// dois fechos ao mesmo tempo não se atropelam — o segundo sai sozinho.
export const SYNC_TIMEOUT_MS = 60_000;
// O interruptor por projeto (D13) e a pasta da Central, em docs/forja/SETTINGS.json,
// ao lado de `forjalvl` e `autonomy` (docs/ARCHITECTURE.md §7).
export const SETTINGS_KEY = 'obsidian_sync';
export const SETTINGS_DIR_KEY = 'obsidian_sync_dir';
// Balizas do D12 escritas em código, não só em prosa: marcar como revisto é a
// revisão curada, que o PROCEDIMENTO.md §4 reserva a uma sessão Claude, e
// `--forcar` reescreveria fichas que não mudaram. Um plano que traga qualquer
// destes argumentos — ou que não traga `--projetos` — é recusado antes de
// chegar ao `spawnSync`.
export const FORBIDDEN_ARGS = ['--forcar', '--forçar', '--marcar-revisto', '--por-rever'];
export const REQUIRED_ARG = '--projetos';

// Quanto de stdout/stderr entra no evento: o suficiente para perceber a falha,
// nunca um despejo (o contrato do hook corta campos aos 16 KB; aqui fica muito
// abaixo disso de propósito).
const TAIL = 400;
const tail = text => { const s = String(text || '').replace(/\s+$/, ''); return s.length <= TAIL ? s : `…${s.slice(-TAIL)}`; };
const fmtMs = ms => (ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`);
const msgOf = err => (err && err.message ? err.message : String(err));

// ---------- onde estão as coisas ----------
// A pasta da Central é do Sponsor e vive fora de qualquer repositório. Ordem:
// variável de ambiente (usada pelos testes e por quem a tenha noutro sítio),
// chave do SETTINGS.json do projeto, e por fim o sítio onde ela está nesta
// máquina — derivado de `homedir()`, nunca com o nome de utilizador escrito à
// mão. Numa máquina onde não exista, o passo salta com motivo e nada acontece.
export function defaultSyncDir() {
  return join(homedir(), 'Desktop', 'Central de Projetos', '_obsidian-sync');
}
export function resolveSyncDir(settings) {
  const env = process.env.FORJA_OBSIDIAN_SYNC_DIR;
  if (typeof env === 'string' && env.trim()) return env.trim();
  const v = plainSettings(settings)[SETTINGS_DIR_KEY];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return defaultSyncDir();
}
// O interpretador: `python`, como o PROCEDIMENTO.md §3 manda correr o script.
// Injetável para os testes o poderem trocar por `process.execPath` sem exigir
// Python instalado.
export function defaultPython() {
  const env = process.env.FORJA_OBSIDIAN_PYTHON;
  return typeof env === 'string' && env.trim() ? env.trim() : 'python';
}

// ---------- comparação de caminhos (PROCEDIMENTO.md §6.1) ----------
// «sem distinguir maiúsculas de minúsculas nem `/` de `\`». O mesmo espírito do
// `projectKey` de lib/state-files.mjs, aqui sem o cortar para chave de ficheiro.
export function normalizePath(p) {
  return String(p == null ? '' : p).trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}
export function samePath(a, b) {
  const x = normalizePath(a);
  return x !== '' && x === normalizePath(b);
}

// ---------- o interruptor (D13: ligado por omissão) ----------
// Um `settings` que seja um Error (SETTINGS.json ilegível, `SettingsError` de
// lib/state-files.mjs) não é «sem definições»: quem chama trata-o como salto
// com motivo, e esta função nunca lê nada de lá.
function plainSettings(settings) {
  return settings && typeof settings === 'object' && !(settings instanceof Error) && !Array.isArray(settings) ? settings : {};
}
const OFF = new Set(['false', '0', 'no', 'nao', 'não', 'off', 'desligado', 'desligada', 'nunca']);
export function syncOn(settings) {
  const v = plainSettings(settings)[SETTINGS_KEY];
  if (v === undefined || v === null || v === '') return true; // ficheiro ausente, ou chave ausente = ligado
  if (typeof v === 'boolean') return v;
  return !OFF.has(String(v).trim().toLowerCase());
}
// Açúcar para quem tem uma função que pode atirar (`readSettings`): devolve o
// objeto ou o próprio Error, para o plano o transformar em motivo de salto.
export function settingsOrError(read) {
  try { return read(); } catch (err) { return err instanceof Error ? err : new Error(String(err)); }
}

// ---------- a metade pura: decidir sem correr nada ----------
// Devolve `{ run: false, skipped: true, reason }` — e só isso — quando o passo
// não deve correr, ou `{ run: true, id, command, args, cwd, timeoutMs }` com a
// linha de comandos exata. Não escreve nada, não lança nada, não emite nada.
export function planObsidianSync({
  projectRoot = null,
  syncDir = null,
  settings = {},
  python = undefined,
  timeoutMs = SYNC_TIMEOUT_MS,
} = {}) {
  const skip = reason => ({ run: false, skipped: true, reason, id: null });
  try {
    if (!projectRoot || !String(projectRoot).trim()) return skip('sem pasta de projeto para identificar');
    if (settings instanceof Error) return skip(`não consegui ler as definições do projeto (${msgOf(settings)})`);
    if (!syncOn(settings)) return skip(`desligado neste projeto (${SETTINGS_KEY} em docs/forja/SETTINGS.json)`);
    const dir = syncDir && String(syncDir).trim() ? String(syncDir).trim() : null;
    if (!dir) return skip('sem pasta da Central de Projetos configurada');
    const syncPy = join(dir, 'sync.py');
    if (!existsSync(syncPy)) return skip(`não encontrei o programa da Central em ${syncPy}`);
    const configPath = join(dir, 'config.json');
    if (!existsSync(configPath)) return skip(`não encontrei ${configPath}`);
    let config;
    try { config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); }
    catch (err) { return skip(`${configPath} não é JSON válido (${msgOf(err)})`); }
    const entries = config && Array.isArray(config.projetos) ? config.projetos : [];
    const entry = entries.find(e => e && typeof e === 'object' && samePath(e.caminho, projectRoot));
    if (!entry) return skip(`este projeto não está na Central (nenhuma entrada de ${configPath} com o caminho ${projectRoot})`);
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!id) return skip(`a entrada da Central para ${projectRoot} não tem "id"`);
    const cmd = python && String(python).trim() ? String(python).trim() : defaultPython();
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : SYNC_TIMEOUT_MS;
    // Sempre `--projetos <id>`, nunca sem filtro, nunca `--forcar`, nunca
    // `--marcar-revisto` (D12). A lista é literal: não há caminho no código
    // que acrescente outro argumento.
    return { run: true, skipped: false, id, command: cmd, args: [syncPy, REQUIRED_ARG, id], cwd: dir, timeoutMs: ms, syncPy, configPath };
  } catch (err) {
    // Nem a decisão pode rebentar o fecho de um run: um erro inesperado de
    // leitura vira salto com motivo, como tudo o resto aqui.
    return skip(`erro ao decidir o sync (${msgOf(err)})`);
  }
}

// ---------- a metade que corre: nunca lança, nunca muda o código de saída ----------
// `spawn` e `emit` são injetáveis para os testes correrem um interpretador
// qualquer (`process.execPath`) e recolherem o evento sem tocar no stream real.
export function runObsidianSync(plan, { spawn = spawnSync, emit = emitEvent, run = null, clock = Date.now } = {}) {
  const started = clock();
  let result;
  try {
    if (!plan || plan.run !== true) {
      result = { ok: false, skipped: true, reason: (plan && plan.reason) || 'sem plano de sync', id: null, status: null, ms: 0 };
    } else if (!Array.isArray(plan.args) || !plan.args.includes(REQUIRED_ARG)
      || plan.args.some(a => FORBIDDEN_ARGS.includes(String(a).trim().toLowerCase()))) {
      // Baliza do D12 imposta aqui, no último sítio antes do processo nascer.
      result = { ok: false, skipped: true, reason: `plano recusado: o sync só corre com ${REQUIRED_ARG} <id> e nunca com ${FORBIDDEN_ARGS.join(', ')}`, id: plan.id || null, status: null, ms: 0 };
    } else {
      const r = spawn(plan.command, plan.args, { cwd: plan.cwd, encoding: 'utf8', timeout: plan.timeoutMs, windowsHide: true });
      const ms = clock() - started;
      const err = r && r.error;
      const code = err && err.code;
      const base = { skipped: false, id: plan.id, ms, status: r && typeof r.status === 'number' ? r.status : null, stderr: tail(r && r.stderr), stdout: tail(r && r.stdout) };
      if (code === 'ETIMEDOUT') result = { ...base, ok: false, timedOut: true, reason: `o sync excedeu ${fmtMs(plan.timeoutMs)} e foi terminado` };
      else if (code === 'ENOENT') result = { ...base, ok: false, reason: `não encontrei o interpretador de Python (${plan.command})` };
      else if (err) result = { ...base, ok: false, reason: `o sync não arrancou (${msgOf(err)})` };
      else if (base.status === 0) result = { ...base, ok: true, reason: null };
      else result = { ...base, ok: false, reason: `o sync saiu com código ${base.status === null ? '?' : base.status}${base.stderr ? `: ${base.stderr}` : ''}` };
    }
  } catch (err) {
    // Inclui o caso de o próprio `spawnSync` atirar (argumentos inválidos,
    // cwd inexistente em alguns sistemas): erro é valor, nunca exceção.
    result = { ok: false, skipped: false, reason: `exceção ao correr o sync (${msgOf(err)})`, id: (plan && plan.id) || null, status: null, ms: clock() - started };
  }
  // Evidência em disco. Campos: ok · salto · motivo · duração (ms) · id do
  // projeto na Central · código de saída. Nunca um campo chamado `kind` no
  // payload (invariante do CLAUDE.md) — `obsidian.sync` é o kind do envelope.
  try {
    emit('obsidian.sync', {
      ok: result.ok === true,
      skipped: result.skipped === true,
      reason: result.reason || null,
      ms: result.ms,
      project_id: result.id || null,
      status: result.status ?? null,
    }, run ? { run } : {});
  } catch { /* escrever evidência a falhar nunca é motivo para falhar o passo */ }
  return result;
}

// ---------- o passo inteiro, como o fecho do run o usa ----------
// Resolve pasta e interpretador, planeia, corre, devolve o resultado. Nunca
// lança: é isto que `forja run finish` e `forja obsidian sync` chamam.
export function obsidianSync({ projectRoot = null, settings = {}, run = null, syncDir = undefined, python = undefined, timeoutMs = SYNC_TIMEOUT_MS, spawn = spawnSync, emit = emitEvent, clock = Date.now } = {}) {
  try {
    const plan = planObsidianSync({ projectRoot, syncDir: syncDir === undefined ? resolveSyncDir(settings) : syncDir, settings, python, timeoutMs });
    return runObsidianSync(plan, { spawn, emit, run, clock });
  } catch (err) {
    return { ok: false, skipped: true, reason: `erro no passo do sync (${msgOf(err)})`, id: null, status: null, ms: 0 };
  }
}

// Uma linha em português simples para o CLI imprimir: o que fez, ou porque
// saltou. Uma falha di-lo e diz também que o run não é afetado, porque é essa
// a dúvida de quem lê.
export function describeObsidianSync(result) {
  if (!result) return 'Sync do Obsidian: saltado — sem resultado.';
  const took = Number.isFinite(result.ms) ? fmtMs(result.ms) : 'tempo desconhecido';
  if (result.skipped) return `Sync do Obsidian: saltado — ${result.reason}.`;
  if (result.ok) return `Sync do Obsidian: a ficha de «${result.id}» foi atualizada pelo programa da Central em ${took}.`;
  return `Sync do Obsidian: falhou — ${result.reason}. O run não é afetado.`;
}
