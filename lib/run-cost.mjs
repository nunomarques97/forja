// Custo do run em tokens, lido das transcrições locais do Claude Code — S6 em
// docs/forja/TECHNOLOGY.md (docs/forja/technology/S6.md): o caminho garantido
// é o leitor de transcrições (`message.usage` dos `.jsonl` que o Claude Code
// já escreve em `~/.claude/projects/<slug>/`), nunca a telemetria OTLP/console
// (rejeitada porque escreve no stdout que `lib/runner.mjs` lê para
// LIMIT_RE/SUMMARY_RE). Só `node:fs`, `node:path`, `node:os` — zero pacotes de
// terceiros, o mesmo método de `tools/usage.mjs` (T1): percorrer as sessões,
// ler cada linha como JSON, somar `message.usage.{input_tokens,
// cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`.
//
// Reusa `walk` de tools/perrun.mjs (T1) para descer às sessões do Lead E às
// subpastas `subagents/` de cada uma. A soma por linha não chama
// `aggregateUsage`/`collectSessionUsage` de tools/ diretamente porque esta
// task precisa de balizas que essas duas funções não têm — saltar um ficheiro
// pelo `mtime` ANTES de o abrir, para nunca ler as centenas de MB de sessões
// antigas doutros runs deste projeto (medido nesta máquina: a pasta de sessões
// passa dos 400 MB), um prazo vigiado no meio da leitura, e um teto por linha.
//
// ENTRADA EXTERNA, NUNCA CONFIADA. Estes `.jsonl` não são escritos por este
// repositório e vivem fora dele: qualquer processo com escrita na pasta de
// sessões pode pôr lá o que quiser. O que sai desta função vai para
// `docs/forja/RUN.json` (versionado), para o evento `run.cost` (que o viewer
// serve ao browser) e para o stdout que o Lead lê — por isso:
//   1. cada campo de `message.usage` é coagido no ponto onde entra
//      (`tokenCount`): o que não for um número finito e não negativo conta 0;
//   2. no fim, a rede de segurança de `computeRunCost` recusa o resultado
//      (`ok: false`) se algum dos quatro totais não for um inteiro seguro e não
//      negativo — o campo cai para `null`, que é o comportamento prometido;
//   3. o `reason` de uma falha vem de uma LISTA FECHADA (`COST_REASON`), nunca
//      de `err.message` (que traz caminhos locais); a única coisa variável que
//      viaja é um `code` no formato de errno (`ENOENT`, …);
//   4. um valor anterior relido de `RUN.json` passa pelo mesmo crivo
//      (`keepLast`): números, booleanos, datas ISO e razões da lista, nada mais.
// Resultado: em `token_usage` e no evento só há `null`, inteiros finitos,
// booleanos, datas ISO e texto desta lista fechada.
//
// Passo acessório (docs/forja/PRODUCT-PROFILE.md, prioridade 5): nunca pode
// fazer falhar nem atrasar o run. Por isso as balizas abaixo estão escritas no
// código, não só em prosa, e um erro fica registado (`data/hook-errors.log` +
// evento `run.cost`) em vez de subir como exceção — `runTokenCostStep` nunca
// atira e `docs/forja/RUN.json.token_usage` fica ausente, `null`, ou a última
// medição boa marcada com a hora e o motivo da falha, nunca um número
// inventado.
import { createReadStream, readdirSync, statSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { walk } from '../tools/perrun.mjs';
import { dataDir, emit as emitEvent, nowIso } from './state-files.mjs';
import { usageAccumulator } from './usage-counts.mjs';

// ---------- balizas escritas no código (prioridade 5 do perfil de produto) ----------
// Um checkpoint não pode ficar à espera de disco: 8 s cobre com folga a leitura
// das sessões de um run normal (dezenas de ficheiros, poucos MB cada) e nunca
// se aproxima do tempo de uma fase do runner (minutos). É um PRAZO, vigiado
// entre ficheiros e a cada COST_DEADLINE_EVERY_LINES linhas: a leitura para
// sozinha e o passo devolve `ok: false` (motivo: tempo), nunca um número a
// meio.
export const COST_TIME_BUDGET_MS = 8000;
// Cinto, por cima do prazo: se uma única leitura ficar presa sem chegar ao
// próximo ponto de vigia, o `Promise.race` desiste. Nunca deve disparar.
export const COST_TIME_GRACE_MS = 2000;
// Soma de bytes de ficheiros .jsonl lidos nesta corrida — o resto fica de fora
// e o resultado sai marcado `truncated: true`, nunca falha por causa disso.
export const COST_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// Nº de ficheiros .jsonl considerados (depois do filtro por `mtime`) — defesa
// contra uma pasta de sessões com milhares de ficheiros.
export const COST_MAX_FILES = 4000;
// Teto por LINHA: um `.jsonl` de uma só linha enorme (não é um ficheiro nosso)
// não pode ser carregado inteiro para memória só para ser somado. Uma linha
// maior do que isto é descartada — e o resultado sai `truncated: true`, porque
// ficou algo de fora. 4 MB chega para qualquer linha real de transcrição.
export const COST_MAX_LINE_CHARS = 4 * 1024 * 1024;
// De quantas em quantas linhas se olha para o relógio (barato e frequente).
const COST_DEADLINE_EVERY_LINES = 2000;

// ---------- lista fechada de motivos (nada de `err.message`: traz caminhos) ----------
export const COST_REASON = {
  NO_START: 'o run não tem hora de início',
  NO_SESSIONS: 'sem transcrições deste projeto para ler',
  UNREADABLE: 'transcrições ilegíveis',
  TIMEOUT: 'a leitura das transcrições excedeu o tempo',
  INVALID: 'transcrições com contagens inválidas',
};
const REASONS = new Set(Object.values(COST_REASON));
const closedReason = r => (REASONS.has(r) ? r : COST_REASON.UNREADABLE);
// O único pedaço variável que pode viajar num evento: um código de erro do
// sistema (`ENOENT`, `EACCES`, `EPERM`, …). Nunca a mensagem, que leva o
// caminho da pasta do Sponsor.
const safeCode = err => {
  const c = err && err.code;
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(c) ? c : null;
};

export const TOKEN_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
// Coerção no ponto onde a entrada externa entra: string, objeto, array, null,
// `undefined`, `NaN`, `Infinity` (é o que `1e999` dá), um número negativo ou um
// número com casas decimais nunca produzem outra coisa que um inteiro >= 0.
const tokenCount = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
// O que um total tem de ser para poder ser escrito: inteiro seguro e >= 0 (uma
// soma que passasse de 2^53 deixaria de ser exata — melhor `null` do que um
// número que não é o número).
const isTokenTotal = v => Number.isSafeInteger(v) && v >= 0;
const zeros = () => ({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 });
// Datas: só o formato que `nowIso()` produz. Uma data vinda de um RUN.json
// editado à mão não passa a texto livre em `token_usage`.
const isoOrNull = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(v) ? v : null);

// A pasta de sessões deste projeto em `~/.claude/projects/`: o nome varia de
// maiúsculas (comentário em lib/runner.mjs `findTranscript`), por isso
// comparamos sem distinguir caixa em vez de assumir uma só forma. O slug é
// normalizado dos dois lados (separador final, `-` finais) para um `cwd` com
// barra no fim não dar `null` em silêncio.
const slugOf = p => String(p || '').replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+$/, '').toLowerCase();

export function resolveSessionsDir(projectRoot, home = process.env.FORJA_VISIBLE_HOME || homedir()) {
  const base = join(home, '.claude', 'projects');
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return null; }
  const want = slugOf(projectRoot);
  if (!want) return null;
  // `hit.name` vem do readdirSync, nunca da string do projeto: o caminho lido
  // não pode sair de `<home>/.claude/projects`.
  const hit = entries.find(e => e.isDirectory() && slugOf(e.name) === want);
  return hit ? join(base, hit.name) : null;
}

// Linhas de um .jsonl, com teto por linha e sem readline: `createInterface`
// não tem limite de linha, e uma linha de dezenas de MB (ficheiro que não é
// nosso) seria materializada inteira em memória. Aqui a memória está limitada a
// `maxLineChars` + um pedaço: uma linha que passe o teto é descartada até ao
// próximo `\n` e contada em `stats.dropped` (o chamador marca `truncated`).
async function* jsonlLines(filePath, { maxLineChars = COST_MAX_LINE_CHARS, stats } = {}) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  try {
    let buf = '';
    let dropping = false;
    for await (const chunk of stream) {
      if (dropping) {
        const nl = chunk.indexOf('\n');
        if (nl < 0) continue; // ainda dentro da linha gigante
        dropping = false;
        buf = chunk.slice(nl + 1);
      } else {
        buf += chunk;
      }
      const parts = buf.split('\n');
      buf = parts.pop(); // o resto é uma linha por acabar
      for (const line of parts) yield line;
      if (buf.length > maxLineChars) { buf = ''; dropping = true; if (stats) stats.dropped++; }
    }
    if (!dropping && buf) yield buf; // última linha sem `\n` (transcrição a meio de uma escrita)
  } finally {
    stream.destroy(); // sair a meio (prazo, break do chamador) fecha o ficheiro
  }
}

// Soma message.usage de UM ficheiro .jsonl dentro de [from, to] — a mesma
// leitura que `tools/usage.mjs` faz por ficheiro (um JSON por linha, tolera uma
// última linha meio escrita), com coerção numérica por campo e o prazo vigiado
// a cada COST_DEADLINE_EVERY_LINES linhas.
async function sumFileUsage(filePath, { from, to, maxLineChars = COST_MAX_LINE_CHARS, deadline = Infinity } = {}) {
  const totals = zeros();
  const accumulate = usageAccumulator();
  const stats = { dropped: 0 };
  let timedOut = false;
  let seen = 0;
  for await (const line of jsonlLines(filePath, { maxLineChars, stats })) {
    if (++seen % COST_DEADLINE_EVERY_LINES === 0 && Date.now() > deadline) { timedOut = true; break; }
    const s = line.trim();
    if (!s) continue;
    let e;
    try { e = JSON.parse(s); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    // Janela por linha: sem timestamp em texto não há como situar a linha, e
    // uma linha que não se situa fica fora (nunca dentro por omissão).
    if (from || to) {
      if (typeof e.timestamp !== 'string') continue;
      if (from && e.timestamp < from) continue;
      if (to && e.timestamp > to) continue;
    }
    const msg = e.message;
    if (!msg || typeof msg !== 'object') continue;
    const u = msg.usage;
    if (!u || typeof u !== 'object') continue;
    const { delta } = accumulate(msg);
    for (const key of TOKEN_FIELDS) totals[key] += delta[key];
  }
  return { ...totals, dropped: stats.dropped, timedOut };
}

// Soma message.usage de todas as sessões (Lead + `subagents/`) de
// `sessionsDir` dentro de [from, to]. `walk` (tools/perrun.mjs, T1) desce às
// subpastas; o `mtime` de cada ficheiro descarta, sem o abrir, tudo o que só
// pode ter linhas anteriores a `from` (as transcrições são append-only: se a
// última escrita foi antes de `from`, nenhuma linha lá dentro pode estar na
// janela) — é essa a baliza de TAMANHO escrita no código, aplicada antes de
// qualquer leitura.
export async function sumSessionsUsage(sessionsDir, {
  from, to,
  maxTotalBytes = COST_MAX_TOTAL_BYTES,
  maxFiles = COST_MAX_FILES,
  maxLineChars = COST_MAX_LINE_CHARS,
  deadline = Infinity,
} = {}) {
  const files = walk(sessionsDir); // atira se sessionsDir não existir/não for legível — o chamador apanha
  const stated = [];
  for (const f of files) {
    let st;
    try { st = statSync(f); } catch { continue; } // um ficheiro que desapareceu entre o walk e o stat não pára a soma
    const mtimeIso = st.mtime.toISOString();
    if (from && mtimeIso < from) continue; // só pode ter linhas mais antigas que a janela
    stated.push({ file: f, size: st.size, mtime: mtimeIso });
  }
  // Mais recente primeiro: se o orçamento de bytes não chegar para tudo, o que
  // fica de fora é o mais antigo dentro da janela, nunca as sessões de agora.
  stated.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
  const capped = stated.slice(0, maxFiles);
  let truncated = stated.length > capped.length;
  const included = [];
  let usedBytes = 0;
  for (const s of capped) {
    if (usedBytes + s.size > maxTotalBytes) { truncated = true; continue; }
    usedBytes += s.size;
    included.push(s.file);
  }
  const totals = zeros();
  let timedOut = false;
  let filesRead = 0;
  for (const file of included) {
    if (Date.now() > deadline) { timedOut = true; break; } // prazo vigiado ENTRE ficheiros
    let u;
    try { u = await sumFileUsage(file, { from, to, maxLineChars, deadline }); } catch { continue; } // um ficheiro ilegível não pára a soma
    filesRead++;
    if (u.dropped) truncated = true; // uma linha acima do teto ficou de fora
    if (u.timedOut) { timedOut = true; break; }
    for (const k of TOKEN_FIELDS) totals[k] += u[k];
  }
  return { ...totals, truncated, timedOut, filesRead, filesSeen: files.length };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('tempo excedido'), { forjaCostTimeout: true })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// O passo inteiro, puro-ish (não escreve nada, não emite nada): dado o run e a
// pasta do projeto, devolve `{ ok: true, ... }` com as parcelas e a hora do
// cálculo, ou `{ ok: false, reason, code }` (motivo da lista fechada) quando não
// há transcrições legíveis — nunca atira.
// `sumUsage` existe para o teste poder provar a rede de segurança e o mapa de
// motivos sem precisar de um disco doente; em produção é sempre
// `sumSessionsUsage`.
export async function computeRunCost(run, {
  projectRoot,
  home = process.env.FORJA_VISIBLE_HOME || homedir(),
  now = nowIso(),
  timeBudgetMs = COST_TIME_BUDGET_MS,
  graceMs = COST_TIME_GRACE_MS,
  maxTotalBytes = COST_MAX_TOTAL_BYTES,
  maxFiles = COST_MAX_FILES,
  maxLineChars = COST_MAX_LINE_CHARS,
  sumUsage = sumSessionsUsage,
} = {}) {
  const calculated_at = nowIso();
  const no = (reason, code = null) => ({ ok: false, reason: closedReason(reason), code, calculated_at });
  try {
    const from = isoOrNull(run && run.started_at);
    if (!from) return no(COST_REASON.NO_START);
    const to = isoOrNull(now);
    if (!to) return no(COST_REASON.NO_START);
    const dir = resolveSessionsDir(projectRoot, home);
    if (!dir) return no(COST_REASON.NO_SESSIONS);
    const deadline = Date.now() + timeBudgetMs;
    const result = await withTimeout(
      sumUsage(dir, { from, to, maxTotalBytes, maxFiles, maxLineChars, deadline }),
      timeBudgetMs + graceMs,
    );
    if (!result || typeof result !== 'object') return no(COST_REASON.UNREADABLE);
    // Prazo esgotado: uma soma a meio não é uma medição. Melhor `null` (ou a
    // última medição boa) do que um número mais pequeno do que a verdade.
    if (result.timedOut) return no(COST_REASON.TIMEOUT);
    // Rede de segurança, o último ponto antes de isto virar ficheiro versionado,
    // evento e stdout: quatro inteiros seguros e não negativos, ou nada.
    if (!TOKEN_FIELDS.every(k => isTokenTotal(result[k]))) return no(COST_REASON.INVALID);
    return {
      ok: true,
      calculated_at,
      from,
      to,
      input_tokens: result.input_tokens,
      cache_creation_input_tokens: result.cache_creation_input_tokens,
      cache_read_input_tokens: result.cache_read_input_tokens,
      output_tokens: result.output_tokens,
      truncated: result.truncated === true,
    };
  } catch (err) {
    if (err && err.forjaCostTimeout) return no(COST_REASON.TIMEOUT);
    return no(COST_REASON.UNREADABLE, safeCode(err));
  }
}

function logError(message) {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(join(dataDir(), 'hook-errors.log'), `${nowIso()} run-cost: ${message}\n`);
  } catch { /* registar o erro a falhar nunca é motivo para falhar o passo */ }
}

// Falhou o recálculo, mas já houve uma medição boa: «nunca foi medido» e
// «falhou desta vez» não são a mesma coisa, e quem lê o RUN.json tem de as
// distinguir. Mantém-se o valor anterior com a hora e o motivo da falha — e o
// valor anterior é re-validado campo a campo (o ficheiro pode ter sido editado
// à mão, ou escrito por uma versão antiga deste módulo, sem coerção).
function keepLast(previous, { failed_at, failed_reason }) {
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return null;
  if (!TOKEN_FIELDS.every(k => isTokenTotal(previous[k]))) return null;
  const kept = {
    calculated_at: isoOrNull(previous.calculated_at),
    from: isoOrNull(previous.from),
    to: isoOrNull(previous.to),
    truncated: previous.truncated === true,
    failed_at: isoOrNull(failed_at),
    failed_reason: closedReason(failed_reason),
  };
  for (const k of TOKEN_FIELDS) kept[k] = previous[k];
  return kept;
}

// O que `run checkpoint`/`run finish` chamam: nunca atira, nunca faz o
// comando falhar nem esperar mais do que `timeBudgetMs` + a margem. Devolve o
// valor para `RUN.json.token_usage` — a medição nova, ou (em falha) a anterior
// marcada com `failed_at`/`failed_reason`, ou `null` quando nunca houve
// nenhuma; nunca um número inventado. Regista evidência: o erro em
// `data/hook-errors.log` e sempre um evento `run.cost` (nunca um campo `kind`
// dentro do payload — invariante do CLAUDE.md; `kind` aqui é só o argumento do
// envelope) com números, booleanos e um motivo da lista fechada, sem caminhos
// nem identificadores.
export async function runTokenCostStep({ run, projectRoot, home, now, emit = emitEvent, previous, ...budgets } = {}) {
  let result;
  try {
    result = await computeRunCost(run, { projectRoot, home, now, ...budgets });
  } catch (err) {
    result = { ok: false, reason: COST_REASON.UNREADABLE, code: safeCode(err), calculated_at: nowIso() };
  }
  if (!result.ok) {
    const reason = closedReason(result.reason);
    const code = safeCode(result); // `safeCode` olha para `.code`: aqui é o do resultado, já filtrado
    logError(code ? `${reason} (${code})` : reason);
    try { emit('run.cost', { ok: false, reason, code }, run ? { run } : {}); } catch { /* evidência a falhar nunca falha o passo */ }
    return keepLast(previous, { failed_at: result.calculated_at, failed_reason: reason });
  }
  const cost = {
    calculated_at: result.calculated_at,
    from: result.from,
    to: result.to,
    input_tokens: result.input_tokens,
    cache_creation_input_tokens: result.cache_creation_input_tokens,
    cache_read_input_tokens: result.cache_read_input_tokens,
    output_tokens: result.output_tokens,
    truncated: result.truncated,
  };
  try {
    emit('run.cost', {
      ok: true,
      input_tokens: cost.input_tokens,
      cache_creation_input_tokens: cost.cache_creation_input_tokens,
      cache_read_input_tokens: cost.cache_read_input_tokens,
      output_tokens: cost.output_tokens,
      truncated: cost.truncated,
    }, run ? { run } : {});
  } catch { /* evidência a falhar nunca falha o passo */ }
  return cost;
}
