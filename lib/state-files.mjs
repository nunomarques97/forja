// Forja run state on disk — docs/forja/ inside the PROJECT being worked on
// (docs/ARCHITECTURE.md §7) — plus the global event stream in <forja>/data.
// Used by bin/forja.mjs; no I/O outside the project's docs/forja/ and the
// Forja data dir. Node core only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { detailOf, labelOf, levelOf, readForjalvl } from './models.mjs';
import { autonomyLabelOf, autonomyRule, readAutonomy } from './autonomy.mjs';

export const forjaRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const dataDir = () => process.env.FORJA_DATA_DIR || join(forjaRoot, 'data');
export const eventsPath = () => join(dataDir(), 'events.jsonl');

export function projectKey(cwd) {
  return String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
export const pointerName = cwd => projectKey(cwd).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '.json';

export function projectRoot() {
  return process.env.FORJA_PROJECT_ROOT || process.cwd();
}
export const stateDir = () => join(projectRoot(), 'docs', 'forja');
export const runPath = () => join(stateDir(), 'RUN.json');
export const tasksPath = () => join(stateDir(), 'TASKS.json');
export const decisionsPath = () => join(stateDir(), 'DECISIONS.md');
export const queuePath = () => join(stateDir(), 'SPONSOR-QUEUE.md');
export const handoverPath = () => join(stateDir(), 'HANDOVER.md');
export const settingsPath = () => join(stateDir(), 'SETTINGS.json');
// Hand-backs and verdicts of the run, one file per task and attempt
// (`T<id>-a<n>-dev.md`, `T<id>-a<n>-review.md`): prompts carry the path, never
// the text (lib/runner.mjs `reportPath`).
export const reportsDir = () => join(stateDir(), 'reports');

export function nowIso() { return new Date().toISOString(); }
export function fmtLocal(iso) {
  const d = new Date(iso || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- session / run identity (§3) ----------
export function currentSessionId() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const p = join(dataDir(), 'sessions', pointerName(projectRoot()));
    // The pointer is the last session seen for this project, ended or not:
    // a CLI call right after SessionEnd still belongs to that session.
    if (existsSync(p)) { const j = JSON.parse(readFileSync(p, 'utf8')); if (j.session_id) return String(j.session_id); }
  } catch {}
  return 'cli-' + pointerName(projectRoot()).replace(/.json$/, ''); // per project, so two fresh projects never share a key
}

export function newRunId(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `R-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${randomBytes(2).toString('hex')}`;
}

// ---------- JSON files ----------
export function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
// tmp + rename (docs/ARCHITECTURE.md §3c): the guard, the viewer and the
// catalogue read RUN.json while a CLI call writes it, and a plain writeFileSync
// could hand them half a file. On Windows a rename over a file that another
// process has open for reading fails with EPERM/EBUSY for a few milliseconds:
// retried briefly, and as a last resort written in place (the old behaviour)
// rather than lost.
const RENAME_RETRIES = 20;
const pauseMs = ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify(value, null, 2) + '\n';
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, path); return; } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err && err.code) || i >= RENAME_RETRIES) {
        try { unlinkSync(tmp); } catch {}
        writeFileSync(path, body);
        return;
      }
      pauseMs(10);
    }
  }
}
export const readRun = () => readJson(runPath(), null);
export const writeRun = run => writeJson(runPath(), { ...run, updated_at: nowIso() });
export const readTasks = () => readJson(tasksPath(), []);
export const writeTasks = tasks => writeJson(tasksPath(), tasks);

// Per-project defaults (docs/forja/SETTINGS.json, committed): today `forjalvl`
// (docs/ARCHITECTURE.md §6) and `autonomy` (§6b). Written key by key so a file
// with other keys — or written by a later version — keeps them.
//
// No file = no defaults ({}). A file that exists but cannot be read or parsed
// is NOT the same thing and never reads as {}: a truncated or hand-edited
// SETTINGS.json would otherwise run the whole run on the wrong forjalvl without a
// word, and the next `models set` would overwrite it and drop its other keys.
// It throws instead, and every caller turns that into a refusal. A UTF-8 BOM
// (PowerShell's `>`/`Set-Content` default) is accepted: it is a readable file.
export class SettingsError extends Error {
  constructor(detail) { super(`${settingsPath()} ilegível: ${detail} — corrige-o à mão`); this.name = 'SettingsError'; }
}
export function readSettings() {
  let text;
  try { text = readFileSync(settingsPath(), 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new SettingsError(err && err.message ? err.message : String(err));
  }
  let value;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (err) { throw new SettingsError(err && err.message ? err.message : String(err)); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError('esperava um objeto JSON');
  return value;
}
export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }; // throws before writing: never overwrite a file we could not read
  // The rename of 17 set 2026 (`model_level` → `forjalvl`): writing the new key
  // retires the old one instead of leaving two names for the same setting in the
  // file. Reading never rewrites anything (lib/models.mjs `readForjalvl`).
  if (patch && patch.forjalvl !== undefined) delete next.model_level;
  writeJson(settingsPath(), next);
  return next;
}

// ---------- markdown logs (append-only) ----------
export function nextId(path, prefix) {
  if (!existsSync(path)) return `${prefix}1`;
  const text = readFileSync(path, 'utf8');
  const ids = [...text.matchAll(new RegExp(`\\b${prefix}(\\d+)\\b`, 'g'))].map(m => Number(m[1]));
  return `${prefix}${(ids.length ? Math.max(...ids) : 0) + 1}`;
}
export function appendMd(path, header, text) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, header);
  appendFileSync(path, text);
}

export const DECISIONS_HEADER = `# Decisões — registo append-only\n\nUma linha por decisão tomada dentro de um run do Forja (quem, quando, o quê, porquê, reversível?). Nunca se apaga; uma decisão revertida ganha uma linha nova "substituída por".\n\n`;
export const QUEUE_HEADER = `# Fila para o Sponsor\n\nPerguntas que só o Sponsor pode responder. Cada uma tem o default que o Forja aplicou para não parar. Para responder: pelo viewer (telemóvel ou desktop), ou escreve a resposta na secção da pergunta abaixo (linha "Resposta:") e o Lead recolhe-a com \`forja answers\`.\n\n`;

// Parse SPONSOR-QUEUE.md into entries: [{ id, question, default, why, status, answer, ts }]
export function readQueue() {
  if (!existsSync(queuePath())) return [];
  const text = readFileSync(queuePath(), 'utf8');
  const out = [];
  const parts = text.split(/^## /m).slice(1);
  for (const part of parts) {
    const [head, ...rest] = part.split('\n');
    const m = head.match(/^(Q\d+)\s*[—-]\s*(.*)$/);
    if (!m) continue;
    const body = rest.join('\n');
    const get = k => (body.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1]?.trim() ?? null;
    out.push({ id: m[1], question: m[2].trim(), status: (get('Estado') || 'aberta').toLowerCase(), default: get('Default aplicado'), why: get('Porquê só o Sponsor'), answer: get('Resposta') || null, ts: get('Aberta em') });
  }
  return out;
}

export function markAnswered(id, answer, when = nowIso()) {
  if (!existsSync(queuePath())) return false;
  let text = readFileSync(queuePath(), 'utf8');
  const re = new RegExp(`(^## ${id}\\s*[—-][^\\n]*\\n)([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  const m = text.match(re);
  if (!m) return false;
  let body = m[2];
  body = body.replace(/^Estado:.*$/m, `Estado: respondida (${fmtLocal(when)})`);
  if (/^Resposta:/m.test(body)) body = body.replace(/^Resposta:.*$/m, `Resposta: ${answer}`); else body += `Resposta: ${answer}\n`;
  text = text.replace(re, m[1] + body);
  writeFileSync(queuePath(), text);
  return true;
}

// ---------- events into the global stream ----------
export function emit(kind, fields, { run, session } = {}) {
  const cwd = projectRoot();
  const rec = {
    ts: nowIso(),
    project: basename(cwd),
    session_id: session || currentSessionId(),
    cwd,
    hook_event_name: 'Forja',
    forja: { kind, run_id: run ? run.run_id : (readRun() || {}).run_id || null, ...fields },
  };
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(eventsPath(), JSON.stringify(rec) + '\n');
  } catch (err) {
    try { appendFileSync(join(dataDir(), 'hook-errors.log'), `${nowIso()} cli-emit: ${err && err.message}\n`); } catch {}
  }
  return rec;
}

// ---------- handover ----------
export function writeHandover(note = null) {
  const run = readRun();
  const tasks = readTasks();
  const queue = readQueue();
  const open = queue.filter(q => q.status.startsWith('aberta'));
  const decisions = existsSync(decisionsPath()) ? readFileSync(decisionsPath(), 'utf8').split('\n').filter(l => l.startsWith('- ')).slice(-10) : [];
  const doing = tasks.find(t => t.status === 'doing') || tasks.find(t => t.status === 'review');
  const next = tasks.find(t => t.status === 'todo' && (!t.after || tasks.find(x => x.id === t.after)?.status === 'done'));
  const lines = [];
  lines.push(`# Handover — ${run ? run.project : basename(projectRoot())}`);
  lines.push('');
  lines.push(`Gerado automaticamente em ${fmtLocal()} por \`forja\`. Uma sessão nova lê isto e continua de onde a anterior ficou. Não editar à mão: é regenerado por cada comando \`forja run *\` / \`forja task *\`.`);
  lines.push('');
  if (!run) { lines.push('Sem run ativo neste projeto. Arrancar com `forja run start --goal "…"`.'); writeFileSync(handoverPath(), lines.join('\n') + '\n'); return; }
  lines.push(`## Run ${run.run_id} — ${run.status}`);
  lines.push(`- Objetivo: ${run.goal}`);
  lines.push(`- Começou: ${fmtLocal(run.started_at)} · checkpoints: ${(run.checkpoints || []).length} · piso de modelo: **${run.model_floor}**${run.fallbacks && run.fallbacks.length ? ` (fallbacks: ${run.fallbacks.map(f => f.id).join(', ')})` : ''}`);
  lines.push(`- forjalvl (nível de modelos): **${labelOf(readForjalvl(run))}** (\`${levelOf(readForjalvl(run))}\`) — ${detailOf(readForjalvl(run))}`);
  lines.push(`- Autonomia: **${autonomyLabelOf(readAutonomy(run))}** — ${autonomyRule(readAutonomy(run))}`);
  // Who drives the run (docs/ARCHITECTURE.md §3c). Written raw here: the
  // resolution with runner evidence lives in lib/driver.mjs, and `forja run
  // driver show` prints it.
  lines.push(`- Responsável: **${run.driver === 'interactive' ? 'conversa interativa' : run.driver === 'runner' ? 'runner autónomo' : 'não registado (run anterior ao campo — `forja run driver show`)'}**${run.driver_request && run.driver_request.to ? ` · transferência pedida para ${run.driver_request.to === 'interactive' ? 'uma conversa interativa' : 'o runner'}` : ''}`);
  lines.push(`- Sessões: ${(run.sessions || []).join(', ')}`);
  if (note) lines.push(`- Nota do último checkpoint: ${note}`);
  lines.push('');
  lines.push('## Tasks');
  if (!tasks.length) lines.push('(nenhuma — o Architect ainda não planeou)');
  for (const t of tasks) lines.push(`- ${t.id} [${t.status}] ${t.title} — dono: ${t.owner || '?'}, tentativas: ${t.attempts || 0}${t.why ? `, último motivo: ${t.why}` : ''}${t.after ? `, depende de ${t.after}` : ''}`);
  lines.push('');
  lines.push('## Próxima ação exata');
  if (run.status === 'finished') lines.push('Run terminado. Nada a fazer; ler `REPORT-*.md`.');
  else if (run.status === 'failed') lines.push(`Run falhou: ${run.why || '?'}. Decidir com o Sponsor se se reabre.`);
  else if (run.status === 'blocked') lines.push(`Run bloqueado: ${run.why || '?'}. Só o Sponsor desbloqueia; depois \`forja run resume\`.`);
  else if (doing) lines.push(`Continuar ${doing.id} (${doing.status === 'review' ? 'à espera do veredicto do Reviewer' : `em curso, tentativa ${doing.attempts}`}): ${doing.title}. Se a sessão anterior morreu a meio, verificar \`git status\` e repetir \`forja task start ${doing.id}\` com o mesmo especialista.`);
  else if (next) lines.push(`Arrancar ${next.id}: \`forja task start ${next.id}\` e delegar a ${next.owner || 'um especialista'}.`);
  else if (tasks.length && tasks.every(t => ['done', 'failed', 'blocked'].includes(t.status))) lines.push('Todas as tasks fechadas: pedir o relatório ao Product Manager (`R · Product Manager: relatório do run`) e correr `forja run finish`.');
  else lines.push('Sem tasks por fazer: pedir plano ao Architect (`P · Architect: plano do run`).');
  lines.push('');
  lines.push(`## Fila do Sponsor (${open.length} aberta${open.length === 1 ? '' : 's'})`);
  for (const q of open) lines.push(`- ${q.id}: ${q.question} — default aplicado: ${q.default || '?'}`);
  if (!open.length) lines.push('(nenhuma pergunta aberta)');
  lines.push('');
  lines.push('## Últimas decisões');
  lines.push(...(decisions.length ? decisions : ['(nenhuma)']));
  lines.push('');
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(handoverPath(), lines.join('\n') + '\n');
}

export function listAnswerFiles() {
  const dir = join(dataDir(), 'answers');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f));
}
