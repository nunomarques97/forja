#!/usr/bin/env node
// Forja CLI — the crew's only way to change run state (docs/ARCHITECTURE.md §7b).
// Run from the PROJECT root: node "<forja>/bin/forja.mjs" <command> [...]
// State lives in <project>/docs/forja/; every command also emits a `Forja`
// event into <forja>/data/events.jsonl for the viewer, and regenerates
// docs/forja/HANDOVER.md so a crash never loses more than the step in progress.
import { existsSync, appendFileSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  forjaRoot, dataDir, projectRoot, stateDir, runPath, decisionsPath, queuePath, handoverPath,
  readRun, writeRun, readTasks, writeTasks, readQueue, markAnswered, emit, writeHandover, nextId, appendMd,
  DECISIONS_HEADER, QUEUE_HEADER, nowIso, fmtLocal, newRunId, currentSessionId, listAnswerFiles,
  settingsPath, readSettings, writeSettings, reportsDir,
} from '../lib/state-files.mjs';
import { normalizeLevel, levelOf, labelOf, detailOf, readForjalvl } from '../lib/models.mjs';
import { normalizeAutonomy, autonomyOf, autonomyLabelOf, autonomyRule, readAutonomy, queueAlwaysLine, roadmapRule } from '../lib/autonomy.mjs';
// One reading of a switch flag for the whole CLI and the runner (`--visivel`).
import { flagOn } from '../lib/runner.mjs';
import { notify } from '../lib/notify.mjs';
import { DRIVER_LABEL, describeDriver, liveRunner, normalizeDriver, resolveDriver, withClaimMutex } from '../lib/driver.mjs';

const MAX_ATTEMPTS = 3;

// ---------- arg parsing: positionals + --flags (value or boolean) ----------
function parse(argv) {
  const pos = []; const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v !== undefined && !v.startsWith('--')) { opt[k] = v; i++; } else opt[k] = true; }
    else pos.push(a);
  }
  return { pos, opt };
}
const need = (v, what) => { if (v === undefined || v === true || v === '') fail(`falta ${what}`); return v; };
function fail(msg, code = 2) { console.error(`forja: ${msg}`); process.exit(code); }
function out(obj) { console.log(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)); }
const phoneUrl = () => { try { const t = JSON.parse(readFileSync(join(dataDir(), 'tunnel.json'), 'utf8')); return t.mobileUrl || t.url || undefined; } catch { return undefined; } };
async function ping(message, opts = {}) { const r = await notify(message, { click: phoneUrl(), ...opts }); if (!r.ok && !r.skipped) console.error(`forja: notificação falhou (${r.error || r.status})`); return r; }
const requireRun = () => { const run = readRun(); if (!run) fail('sem run neste projeto — corre `forja run start --goal "…"` primeiro'); return run; };
// A forjalvl typed by a person (flag or SETTINGS.json) is refused loudly (exit 2);
// a forjalvl already stored in RUN.json is read tolerantly (lib/models.mjs).
function checkedLevel(value, where, flag = '--forjalvl') {
  if (value === true) fail(`${flag} precisa de um nível: max|high|eco (ou máximo|alto|económico)`);
  try { return normalizeLevel(value); } catch (err) { fail(`${err.message}${where ? ` (${where})` : ''}`); }
}
// The forjalvl asked for on the command line: `--forjalvl <x>`, with `--models <x>`
// as a silent alias (the name before the Sponsor's rename of 17 set 2026).
// `null` = no flag at all, so the caller falls back to the project's default.
function flagLevel(opt) {
  const flag = opt.forjalvl !== undefined ? '--forjalvl' : opt.models !== undefined ? '--models' : null;
  return flag === null ? null : { flag, value: flag === '--forjalvl' ? opt.forjalvl : opt.models };
}
// An unreadable SETTINGS.json is a refusal, never "no settings": the run would
// otherwise start on the wrong forjalvl (lib/state-files.mjs).
const projectSettings = () => { try { return readSettings(); } catch (err) { fail(err.message); } };
const projectLevel = () => checkedLevel(readForjalvl(projectSettings()), `em ${settingsPath()}`);
// The autonomy of a run (docs/ARCHITECTURE.md §6b), by the same rules as the
// forjalvl: a value typed by a person is refused loudly (exit 2), a value
// already on disk is read tolerantly (lib/autonomy.mjs).
function checkedAutonomy(value, where, flag = '--autonomy') {
  if (value === true) fail(`${flag} precisa de um valor: normal|total`);
  try { return normalizeAutonomy(value); } catch (err) { fail(`${err.message}${where ? ` (${where})` : ''}`); }
}
const projectAutonomy = () => checkedAutonomy(readAutonomy(projectSettings()), `em ${settingsPath()}`);
// A switch flag (`--visivel`): present with no value = on, an explicit sim|não
// accepted, anything else refused loudly (lib/runner.mjs `flagOn`).
function checkedSwitch(value, flag) {
  const v = flagOn(value);
  if (v === null) fail(`${flag} é um interruptor (sem valor, ou sim|não) — recebi "${value}"`);
  return v;
}
// ---------- who drives the run (docs/ARCHITECTURE.md §3c, lib/driver.mjs) ----------
// FORJA_RUNNER=1 is set by `forja runner` for itself and for its sessions.
const callerIsRunner = () => process.env.FORJA_RUNNER === '1';
const driverNow = run => resolveDriver(run, projectRoot(), dataDir());
// The two entry points a Lead uses to work on a run (`run resume`, `task start`)
// refuse to put a second executor on it. A runner session on a run a
// conversation drives is refused; a conversation on a runner-driven run is
// refused and told how to take it over explicitly. One exception, stated in
// §3c: a VISIBLE runner's session (`claude --bg`) runs in the Claude daemon and
// may not carry FORJA_RUNNER, so it is recognised by its session id instead —
// the runner writes the short id of the session in progress into its lock the
// moment `claude --bg` announces it, and only a caller whose session id starts
// with it passes (never the session that asked for the hand-over).
function assertDriver(run, what) {
  if (!run || !['running', 'blocked'].includes(run.status)) return;
  const d = driverNow(run);
  if (callerIsRunner()) {
    if (d.driver !== 'runner') fail(`${what}: o run ${run.run_id} não é conduzido pelo runner (responsável: ${describeDriver(d)}) — o runner não lhe toca`, 4);
    return;
  }
  if (d.driver === 'interactive') return;
  if (d.driver === 'runner') {
    const live = liveRunner(projectRoot(), dataDir());
    // Only the id Claude Code puts in the session's own environment: the
    // fallback pointer (last session seen in this project) could be the
    // runner's session and would let a conversation pass as it.
    const sid = String(process.env.CLAUDE_CODE_SESSION_ID || '').toLowerCase();
    const req = run.driver_request && typeof run.driver_request === 'object' ? run.driver_request : null;
    const isRequester = req && typeof req.by === 'string' && req.by.toLowerCase() === sid;
    if (live && live.visible === true && typeof live.session === 'string' && /^[0-9a-f]{6,8}$/.test(live.session) && sid.startsWith(live.session) && !isRequester) return;
    fail(`${what}: o run ${run.run_id} é conduzido pelo runner${live ? ` (vivo, pid ${live.pid})` : ' (neste momento sem processo vivo; a guarda pode relançá-lo)'} — para o conduzir nesta conversa, primeiro \`forja run driver set interactive\``, 4);
  }
  fail(`${what}: o responsável do run ${run.run_id} é desconhecido (${d.source}) — confirma quem o conduz: \`forja run driver set interactive\` (esta conversa) ou \`forja run driver set runner\``, 4);
}
// Errors thrown inside the claim mutex (never `fail`, which exits without
// running the `finally` that removes the mutex file).
const refuse = msg => { const e = new Error(msg); e.name = 'ForjaRefusal'; throw e; };

function writeJsonArchive(run) {
  const path = join(stateDir(), `RUN-${run.run_id}.json`);
  writeFileSync(path, JSON.stringify({ ...run, status: 'abandoned', abandoned_at: nowIso() }, null, 2) + '\n');
}

// Writes the files of a new run (called by `run start` inside the claim mutex).
// `existing` is the RUN.json being replaced (finished, failed, or forced over).
function startRunFiles(run, existing) {
  mkdirSync(stateDir(), { recursive: true });
  // Reports of the run live on disk, not in prompts: each session writes the
  // Dev's hand-back and the Reviewer's verdict here and the next prompt carries
  // the path (lib/runner.mjs `reportPath`, forja-lead §1/§9).
  mkdirSync(reportsDir(), { recursive: true });
  // A previous run's tasks belong to that run: archive {run, tasks} next to RUN.json
  // (docs/forja/archive/<run_id>.json) BEFORE anything is overwritten, so a failed
  // archive write leaves the previous run intact.
  const prevTasks = readTasks();
  if (prevTasks.length) {
    const archDir = join(stateDir(), 'archive'); mkdirSync(archDir, { recursive: true });
    const key = existing && existing.run_id ? existing.run_id : `orphan-${Date.now()}`;
    let archPath = join(archDir, `${key}.json`);
    if (existsSync(archPath)) archPath = join(archDir, `${key}-${Date.now()}.json`); // never overwrite an archive
    writeFileSync(archPath, JSON.stringify({ run: existing || null, tasks: prevTasks, archived_at: run.started_at }, null, 2) + '\n');
  }
  writeRun(run);
  writeTasks([]);
  if (!existsSync(decisionsPath())) appendMd(decisionsPath(), DECISIONS_HEADER, '');
  if (!existsSync(queuePath())) appendMd(queuePath(), QUEUE_HEADER, '');
}

// ---------- run ----------
const runCmds = {
  async start({ opt }) {
    const goal = need(opt.goal, '--goal "…"');
    const existing = readRun();
    if (existing && existing.status === 'running' && !opt.force) fail(`já existe o run ${existing.run_id} a correr — usa \`forja run resume\` para continuar, ou \`forja run finish\`/\`run fail\` para o fechar`);
    // forjalvl of this run: the flag wins, else the project's default
    // (docs/forja/SETTINGS.json), else `max` (docs/ARCHITECTURE.md §6).
    // Resolved before anything is written or archived: a bad flag or an
    // unreadable SETTINGS.json leaves the project exactly as it was.
    const asked = flagLevel(opt);
    const forjalvl = asked === null ? projectLevel() : checkedLevel(asked.value, '', asked.flag);
    // Autonomy of this run, resolved in the same breath and by the same rules
    // (flag > project default > `normal`), before anything is written.
    const autonomy = opt.autonomy === undefined ? projectAutonomy() : checkedAutonomy(opt.autonomy);
    // Visible sessions (`runner --visivel`, Technology Scout decision S2): a
    // record of how this run was started, so RUN.json, the handover and a future
    // `POST /runs` all say it. It is not a policy the sessions read: the runner
    // process that launches them decides, one invocation at a time.
    const visibleFlag = opt.visivel !== undefined ? opt.visivel : opt.visible;
    const visible = checkedSwitch(visibleFlag, '--visivel');
    // Who drives this run (docs/ARCHITECTURE.md §3c): `--driver` when given (the
    // runner always passes `--driver runner`), else the runner's own env, else a
    // conversation — `run start` typed in a Claude Code session is the
    // interactive Lead of forja-lead. Refused loudly when typed wrong.
    let driver;
    if (opt.driver === true) fail('--driver precisa de um valor: interactive|runner');
    try { driver = opt.driver === undefined ? (callerIsRunner() ? 'runner' : 'interactive') : normalizeDriver(opt.driver); } catch (err) { fail(err.message); }
    const run = { run_id: newRunId(), project: basename(projectRoot()), goal, status: 'running', model_floor: 'fable', forjalvl, autonomy, visible, driver, driver_since: nowIso(), driver_session: driver === 'interactive' ? currentSessionId() : null, started_at: nowIso(), sessions: [currentSessionId()], checkpoints: [], fallbacks: [], answers_applied: [], current_task: null };
    // Check-and-write inside the claim mutex: two `run start` at once (a
    // conversation and a runner, a double tap) must not both see "no run".
    // A live runner on this project refuses any new run, even with --force.
    withClaimMutex(projectRoot(), () => {
      const cur = readRun();
      const live = liveRunner(projectRoot(), dataDir());
      if (live && !callerIsRunner()) refuse(`há um runner vivo neste projeto (pid ${live.pid}) — não arranco outro run por cima dele`);
      if (cur && cur.status === 'running' && !opt.force) refuse(`já existe o run ${cur.run_id} a correr — usa \`forja run resume\` para continuar, ou \`forja run finish\`/\`run fail\` para o fechar`);
      if (cur && cur.status === 'running' && opt.force) {
        // Never lose a run silently: the forced-over run is archived next to RUN.json and recorded as abandoned.
        writeJsonArchive(cur);
        emit('run.fail', { why: 'abandonado por `run start --force`' }, { run: cur });
      }
      startRunFiles(run, cur);
    });
    emit('run.start', { goal, model_floor: run.model_floor, forjalvl: run.forjalvl, model_level: run.forjalvl, autonomy: run.autonomy, visible: run.visible, driver: run.driver }, { run });
    writeHandover();
    await ping(`Forja: run começou em ${run.project} — ${goal.slice(0, 120)}`, { tags: ['rocket'] });
    out({ ok: true, run_id: run.run_id, forjalvl: run.forjalvl, autonomy: run.autonomy, visible: run.visible, driver: run.driver, state: stateDir() });
  },
  // `run driver show|set <interactive|runner>` — who drives this run (§3c).
  async driver({ pos, opt }) {
    const sub = pos[0] || 'show';
    if (sub === 'show') {
      const run = requireRun();
      const d = driverNow(run);
      const live = liveRunner(projectRoot(), dataDir());
      out({ ok: true, run_id: run.run_id, status: run.status, driver: d.driver, label: DRIVER_LABEL[d.driver], source: d.source, since: run.driver_since || null, request: d.request, runner: live ? { pid: live.pid, run_id: live.run_id || null, visible: live.visible === true } : null });
      return;
    }
    if (sub !== 'set') fail('uso: forja run driver show | forja run driver set interactive|runner');
    let to;
    try { to = normalizeDriver(need(pos[1], 'o responsável: interactive|runner')); } catch (err) { fail(err.message); }
    const result = withClaimMutex(projectRoot(), () => {
      const run = readRun();
      if (!run) refuse('sem run neste projeto');
      if (!['running', 'blocked'].includes(run.status)) refuse(`o run ${run.run_id} está ${run.status} — não há nada para conduzir`);
      const d = driverNow(run);
      const live = liveRunner(projectRoot(), dataDir());
      const liveHere = live && (!live.run_id || live.run_id === run.run_id) ? live : null;
      const sid = currentSessionId();
      if (to === 'interactive') {
        if (liveHere) {
          // The runner is mid-session: it cannot be taken over under its feet.
          // The request is written down and the runner honours it between two
          // sessions, writing the checkpoint and the new driver itself.
          if (callerIsRunner()) refuse('um runner não pede para si próprio a passagem a conversa');
          writeRun({ ...run, driver_request: { to: 'interactive', at: nowIso(), by: sid } });
          emit('run.driver', { from: d.driver, to: 'interactive', pending: true }, { run });
          writeHandover();
          return { pending: true, run_id: run.run_id, runner_pid: liveHere.pid };
        }
        const note = `responsável: ${DRIVER_LABEL[d.driver]} → conversa interativa`;
        const { driver_request: _r, ...rest } = run;
        writeRun({ ...rest, driver: 'interactive', driver_since: nowIso(), driver_session: sid, checkpoints: [...(run.checkpoints || []), { ts: nowIso(), note }], sessions: run.sessions && !run.sessions.includes(sid) ? [...run.sessions, sid] : run.sessions });
        emit('run.driver', { from: d.driver, to: 'interactive', note }, { run });
        writeHandover(note);
        return { pending: false, run_id: run.run_id, from: d.driver };
      }
      // to runner
      if (liveHere) {
        if (d.driver === 'runner') return { pending: false, run_id: run.run_id, from: 'runner', unchanged: true };
        refuse(`há um runner vivo neste projeto (pid ${liveHere.pid}) com o run a outro responsável — estado inconsistente; espera que ele saia`);
      }
      const open = readTasks().filter(t => ['doing', 'review'].includes(t.status));
      if (open.length) refuse(`a task ${open.map(t => t.id).join(', ')} está em curso nesta conversa — fecha-a (task done/fail/block) ou devolve-a à fila (\`task fail ${open[0].id} --no-attempt --why "passada ao runner"\`) antes de passar o run ao runner`);
      const note = `responsável: ${DRIVER_LABEL[d.driver]} → runner autónomo`;
      const { driver_request: _r, ...rest } = run;
      writeRun({ ...rest, driver: 'runner', driver_since: nowIso(), driver_session: null, checkpoints: [...(run.checkpoints || []), { ts: nowIso(), note }] });
      emit('run.driver', { from: d.driver, to: 'runner', note }, { run });
      writeHandover(note);
      return { pending: false, run_id: run.run_id, from: d.driver };
    });
    if (result.pending) out({ ok: true, run_id: result.run_id, driver: 'runner', pending: 'interactive', note: `pedido registado: o runner (pid ${result.runner_pid}) liberta o run no fim da sessão em curso e escreve um checkpoint; confirma com \`forja run driver show\` antes de continuar nesta conversa` });
    else if (to === 'runner') out({ ok: true, run_id: result.run_id, driver: 'runner', from: result.from, note: result.unchanged ? 'já era do runner, e o runner está vivo' : 'o run é agora do runner. Nada foi lançado: arranca-o com `forja runner` nesta pasta (ou pelo catálogo). Com a guarda ligada, ela lança-o sozinha ~2 min depois de o ver sem runner.' });
    else out({ ok: true, run_id: result.run_id, driver: 'interactive', from: result.from, note: 'o run é agora desta conversa: a guarda nunca lança um runner sobre ele. Continua com `forja run resume`.' });
  },
  async resume() {
    const run = requireRun();
    assertDriver(run, 'run resume');
    const sid = currentSessionId();
    if (!run.sessions.includes(sid)) run.sessions.push(sid);
    // A conversation that resumes an interactive run is its Lead from now on
    // (a restart or a new chat window gets a new session id).
    if (run.driver === 'interactive' && !callerIsRunner()) run.driver_session = sid;
    if (run.status === 'blocked') run.status = 'running';
    writeRun(run);
    emit('run.resume', { note: `sessão ${sid.slice(0, 8)}` }, { run });
    writeHandover();
    out({ ok: true, run_id: run.run_id, status: run.status, sessions: run.sessions });
  },
  async checkpoint({ opt }) {
    const run = requireRun();
    const note = typeof opt.note === 'string' ? opt.note : null;
    run.checkpoints.push({ ts: nowIso(), note });
    writeRun(run);
    emit('run.checkpoint', { note, n: run.checkpoints.length }, { run });
    writeHandover(note);
    out({ ok: true, checkpoints: run.checkpoints.length, handover: handoverPath() });
  },
  async finish({ opt }) {
    const run = requireRun();
    const tasks = readTasks();
    const openTasks = tasks.filter(t => ['todo', 'doing', 'review'].includes(t.status));
    if (openTasks.length && !opt.force) fail(`ainda há tasks abertas: ${openTasks.map(t => t.id).join(', ')} — fecha-as (done/fail/block) ou usa --force`);
    run.status = 'finished'; run.finished_at = nowIso();
    writeRun(run);
    emit('run.finish', { note: opt.note || null }, { run });
    writeHandover();
    const done = tasks.filter(t => t.status === 'done').length;
    await ping(`Forja: run terminou em ${run.project} — ${done}/${tasks.length} tasks aprovadas${readQueue().filter(q => q.status.startsWith('aberta')).length ? ', há perguntas na fila' : ''}`, { tags: ['white_check_mark'], priority: 'high' });
    out({ ok: true, run_id: run.run_id, done, total: tasks.length });
  },
  async fail({ opt }) {
    const run = requireRun();
    run.status = 'failed'; run.why = need(opt.why, '--why "…"'); run.finished_at = nowIso();
    writeRun(run);
    emit('run.fail', { why: run.why }, { run });
    writeHandover();
    await ping(`Forja: run FALHOU em ${run.project} — ${run.why.slice(0, 140)}`, { tags: ['x'], priority: 'high' });
    out({ ok: true, run_id: run.run_id, status: 'failed' });
  },
  async block({ opt }) {
    const run = requireRun();
    run.status = 'blocked'; run.why = need(opt.why, '--why "…"');
    writeRun(run);
    emit('run.block', { why: run.why }, { run });
    writeHandover();
    await ping(`Forja: run BLOQUEADO em ${run.project} — precisa de ti: ${run.why.slice(0, 120)}`, { tags: ['no_entry'], priority: 'urgent' });
    out({ ok: true, run_id: run.run_id, status: 'blocked' });
  },
};

// ---------- task ----------
const taskCmds = {
  async add({ opt }) {
    const run = requireRun();
    const tasks = readTasks();
    const id = typeof opt.id === 'string' ? opt.id : `T${tasks.length + 1}`;
    if (tasks.some(t => t.id === id)) fail(`task ${id} já existe`);
    const task = { id, title: need(opt.title, '--title "…"'), owner: opt.owner || null, complexity: ['easy', 'medium', 'hard'].includes(String(opt.complexity || '').toLowerCase()) ? String(opt.complexity).toLowerCase() : 'medium', criteria: opt.criteria || null, after: opt.after || null, status: 'todo', attempts: 0, created_at: nowIso(), updated_at: nowIso(), why: null, verdicts: [], evidence: null };
    tasks.push(task); writeTasks(tasks);
    emit('task.add', { id, title: task.title, owner: task.owner, complexity: task.complexity, criteria: task.criteria, after: task.after }, { run });
    writeHandover();
    out({ ok: true, id });
  },
  // `task show T<n>` — everything a session needs about one task, so a Lead
  // never has to read (and re-read into its context) the whole TASKS.json:
  // id, title, state, owner, complexity, criteria, attempts, every verdict in
  // full, and the dependency. Read-only: it changes nothing and emits nothing.
  show({ pos }) {
    requireRun();
    const id = need(pos[0], 'o id da task (ex.: task show T1)');
    const tasks = readTasks(); const task = tasks.find(t => t.id === id); if (!task) fail(`task ${id} não existe`);
    const dep = task.after ? tasks.find(t => t.id === task.after) : null;
    const lines = [
      `${task.id} — ${task.title}`,
      `Estado: ${task.status} · tentativas: ${task.attempts || 0}/${MAX_ATTEMPTS} · owner: ${task.owner || '(sem owner)'} · complexidade: ${task.complexity || 'medium'}`,
      `Depende de: ${task.after ? `${task.after}${dep ? ` (${dep.status})` : ' (não existe neste plano)'}` : 'nada'}`,
      '',
      'Critérios de aceitação (definição de done):',
      task.criteria ? String(task.criteria) : '(nenhum registado — o título é o critério)',
    ];
    if (task.why) lines.push('', `Último motivo registado: ${task.why}`);
    if (task.evidence) lines.push('', `Evidência: ${task.evidence}`);
    // A task written by an older Forja (or by hand) may have no `verdicts` at all:
    // reading it must print "none", never crash the session that is reading it.
    const verdicts = Array.isArray(task.verdicts) ? task.verdicts : [];
    lines.push('', `Veredictos (${verdicts.length}):`);
    if (!verdicts.length) lines.push('(nenhum ainda)');
    // Verdicts in full, never clipped: on a retry they are the specification.
    for (const [i, v] of verdicts.entries()) lines.push(`${i + 1}. ${fmtLocal(v.ts)} · ${v.verdict}${v.model_floor ? ` · piso ${v.model_floor}` : ''}${v.fallback_review ? ' · revisto em modelo de fallback' : ''}\n${v.text || '(sem texto)'}`);
    out(lines.join('\n'));
  },
  async start({ pos }) {
    const run = requireRun();
    assertDriver(run, 'task start');
    const tasks = readTasks(); const task = tasks.find(t => t.id === pos[0]); if (!task) fail(`task ${pos[0]} não existe`);
    if (task.status === 'done') fail(`task ${task.id} já está fechada (done)`);
    if (task.status === 'failed') fail(`task ${task.id} falhou ${task.attempts} vezes e está fechada neste run — não se reabre (regra dos 3 strikes)`);
    if (task.attempts >= MAX_ATTEMPTS) fail(`task ${task.id} já tem ${task.attempts} tentativas`);
    task.status = 'doing'; task.attempts += 1; task.updated_at = nowIso(); task.started_at = task.started_at || task.updated_at;
    run.current_task = task.id; writeRun(run); writeTasks(tasks);
    emit('task.start', { id: task.id, attempts: task.attempts, title: task.title, owner: task.owner }, { run });
    writeHandover();
    out({ ok: true, id: task.id, attempts: task.attempts, owner: task.owner, title: task.title, criteria: task.criteria, previous_verdicts: task.verdicts });
  },
  async review({ pos }) {
    const run = requireRun();
    const tasks = readTasks(); const task = tasks.find(t => t.id === pos[0]); if (!task) fail(`task ${pos[0]} não existe`);
    if (task.status !== 'doing') fail(`task ${task.id} está "${task.status}", não "doing" — só uma task em curso vai para review`);
    task.status = 'review'; task.updated_at = nowIso(); writeTasks(tasks);
    emit('task.review', { id: task.id, attempts: task.attempts }, { run });
    writeHandover();
    out({ ok: true, id: task.id, status: 'review' });
  },
  async done({ pos, opt }) {
    const run = requireRun();
    const tasks = readTasks(); const task = tasks.find(t => t.id === pos[0]); if (!task) fail(`task ${pos[0]} não existe`);
    if (!['doing', 'review'].includes(task.status)) fail(`task ${task.id} está "${task.status}" — só uma task em curso ou em review pode ser fechada como done`);
    task.status = 'done'; task.updated_at = nowIso(); task.verdicts.push({ ts: nowIso(), verdict: 'APPROVE', text: opt.verdict || null, model_floor: run.model_floor, fallback_review: run.model_floor !== 'fable' && run.fallbacks?.length ? true : false });
    if (typeof opt.evidence === 'string') task.evidence = opt.evidence;
    if (run.current_task === task.id) run.current_task = null; writeRun(run); writeTasks(tasks);
    emit('task.done', { id: task.id, verdict: opt.verdict || null, evidence: task.evidence, fallback_review: task.verdicts.at(-1).fallback_review }, { run });
    writeHandover();
    out({ ok: true, id: task.id, status: 'done' });
  },
  async fail({ pos, opt }) {
    const run = requireRun();
    const tasks = readTasks(); const task = tasks.find(t => t.id === pos[0]); if (!task) fail(`task ${pos[0]} não existe`);
    if (!['doing', 'review'].includes(task.status)) fail(`task ${task.id} está "${task.status}" — só uma task em curso ou em review pode falhar`);
    const why = need(opt.why, '--why "…"');
    if (opt['no-attempt'] === true || String(opt['no-attempt']).toLowerCase() === 'true') {
      // Runner recovery after a usage-limit pause: the attempt never really happened —
      // back to todo, attempt count restored, no verdict recorded.
      task.status = 'todo'; task.attempts = Math.max(0, task.attempts - 1); task.why = why; task.updated_at = nowIso();
      if (run.current_task === task.id) run.current_task = null; writeRun(run); writeTasks(tasks);
      emit('task.fail', { id: task.id, attempts: task.attempts, why, final: false, no_attempt: true }, { run });
      writeHandover();
      out({ ok: true, id: task.id, status: task.status, attempts: task.attempts, no_attempt: true });
      return;
    }
    task.verdicts.push({ ts: nowIso(), verdict: 'REJECT', text: why });
    task.why = why; task.updated_at = nowIso();
    const final = task.attempts >= MAX_ATTEMPTS;
    task.status = final ? 'failed' : 'todo';
    if (run.current_task === task.id) run.current_task = null; writeRun(run); writeTasks(tasks);
    emit('task.fail', { id: task.id, attempts: task.attempts, why, final }, { run });
    writeHandover();
    if (final) await ping(`Forja: task ${task.id} falhou 3 vezes em ${run.project} e foi fechada — ${why.slice(0, 100)}`, { tags: ['warning'], priority: 'high' });
    out({ ok: true, id: task.id, status: task.status, attempts: task.attempts, final });
  },
  async block({ pos, opt }) {
    const run = requireRun();
    const tasks = readTasks(); const task = tasks.find(t => t.id === pos[0]); if (!task) fail(`task ${pos[0]} não existe`);
    task.status = 'blocked'; task.why = need(opt.why, '--why "…"'); task.updated_at = nowIso();
    if (run.current_task === task.id) run.current_task = null; writeRun(run); writeTasks(tasks);
    emit('task.block', { id: task.id, why: task.why }, { run });
    writeHandover();
    await ping(`Forja: task ${task.id} bloqueada em ${run.project} — precisa de ti: ${task.why.slice(0, 110)}`, { tags: ['no_entry'], priority: 'high' });
    out({ ok: true, id: task.id, status: 'blocked' });
  },
};

// ---------- decisions & Sponsor queue ----------
async function decide({ pos, opt }) {
  const run = requireRun();
  const text = need(pos[0], 'o texto da decisão');
  const why = need(opt.why, '--why "…"');
  const reversible = opt.reversible === undefined ? null : /^(yes|sim|true|y)$/i.test(String(opt.reversible));
  const id = nextId(decisionsPath(), 'D');
  const by = opt.by || 'Product Manager';
  appendMd(decisionsPath(), DECISIONS_HEADER, `- **${id}** · ${fmtLocal()} · ${by} · run ${run.run_id} — ${text} Porquê: ${why} Reversível: ${reversible === null ? 'não indicado' : reversible ? 'sim' : 'não'}.${opt.supersedes ? ` Substitui ${opt.supersedes}.` : ''}\n`);
  emit('decision', { id, text, why, reversible, by, supersedes: opt.supersedes || null }, { run });
  writeHandover();
  out({ ok: true, id });
}
async function ask({ pos, opt }) {
  const run = requireRun();
  const question = need(pos[0], 'a pergunta');
  const def = need(opt.default, '--default "…" (o default aplicado)');
  const why = need(opt.why, '--why "…" (porquê só o Sponsor)');
  const id = nextId(queuePath(), 'Q');
  appendMd(queuePath(), QUEUE_HEADER, `## ${id} — ${question}\nEstado: aberta\nAberta em: ${fmtLocal()}\nRun: ${run.run_id}\nDefault aplicado: ${def}\nPorquê só o Sponsor: ${why}\nResposta:\n\n`);
  emit('ask', { id, text: question, default: def, why }, { run });
  writeHandover();
  await ping(`Forja precisa de ti (${run.project}) ${id}: ${question.slice(0, 100)} — entretanto: ${def.slice(0, 60)}`, { tags: ['question'], priority: 'high' });
  out({ ok: true, id });
}
async function answers() {
  const run = requireRun();
  const applied = new Set(run.answers_applied || []);
  const project = basename(projectRoot());
  let n = 0;
  for (const file of listAnswerFiles()) {
    if (basename(file, '.jsonl') !== project) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let a; try { a = JSON.parse(line); } catch { continue; }
      const key = `${a.id}@${a.ts}`;
      if (!a.id || !a.answer || applied.has(key)) continue;
      if (markAnswered(a.id, a.answer, a.ts)) { applied.add(key); n += 1; emit('answer', { id: a.id, text: a.answer, via: 'viewer' }, { run }); }
    }
  }
  // Answers typed straight into SPONSOR-QUEUE.md (Resposta: …) are events too.
  for (const q of readQueue()) {
    if (q.answer && q.status.startsWith('aberta')) { markAnswered(q.id, q.answer); applied.add(`${q.id}@file`); n += 1; emit('answer', { id: q.id, text: q.answer, via: 'file' }, { run }); }
  }
  run.answers_applied = [...applied]; writeRun(run);
  writeHandover();
  out({ ok: true, applied: n, open: readQueue().filter(q => q.status.startsWith('aberta')).map(q => q.id) });
}
async function fallback({ pos, opt }) {
  const run = requireRun();
  const [role, from, to] = pos;
  if (!role || !from || !to) fail('uso: forja fallback <papel> <de> <para> --why "…"');
  const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
  const ROLES = ['lead', 'architect', 'product-manager', 'product-designer', 'technology-scout', 'frontend-dev', 'backend-dev', 'reviewer', 'qa', 'security-reviewer', 'nativa', 'ferreiro', 'bigorna', 'tracador', 'fundidor', 'lapidador', 'contraste'];
  if (!ROLES.includes(role)) fail(`papéis válidos: ${ROLES.join(', ')}`);
  if (!MODELS.includes(from) || !MODELS.includes(to)) fail(`modelos válidos: ${MODELS.join(', ')}`);
  const why = need(opt.why, '--why "…"');
  const id = `F${(run.fallbacks || []).length + 1}`;
  const rec = { id, ts: nowIso(), role, from, to, why, run_id: run.run_id, project: run.project };
  run.fallbacks = [...(run.fallbacks || []), rec];
  const order = { sonnet: 0, haiku: 0, opus: 1, fable: 2 };
  if ((order[to] ?? 0) < (order[run.model_floor] ?? 2)) run.model_floor = to;
  writeRun(run);
  try { mkdirSync(dataDir(), { recursive: true }); appendFileSync(join(dataDir(), 'fallbacks.jsonl'), JSON.stringify(rec) + '\n'); } catch {}
  emit('fallback', { id, role, from, to, why }, { run });
  writeHandover();
  await ping(`Forja: fallback de modelo em ${run.project} — ${role}: ${from} → ${to} (${why.slice(0, 80)}). Piso do run: ${run.model_floor}`, { tags: ['arrow_down'] });
  out({ ok: true, id, model_floor: run.model_floor });
}
async function progress({ pos, opt }) {
  const run = readRun();
  const text = need(pos[0], 'o texto');
  emit('progress', { text, role: opt.as || null }, run ? { run } : {});
  out({ ok: true });
}
// A hands-on session (no `forja run start`) delivers its final report to the
// Sponsor in the chat; this is the one line that tells the viewer's feed it
// happened (event 8, «relatório entregue»). Inside a run, `run finish` does it.
async function report({ pos }) {
  const run = readRun();
  if (run && run.status === 'running') fail(`há um run a correr (${run.run_id}): fecha-o com \`forja run finish --note "…"\`, que já regista o fim`);
  const text = need(pos.join(' ').trim(), 'a frase do relatório (uma linha, sem código, caminhos nem segredos)');
  emit('report', { text: text.slice(0, 600) }, run ? { run } : {});
  out({ ok: true });
}
async function notifyCmd({ pos, opt }) {
  const run = readRun();
  const text = need(pos.join(' '), 'a mensagem');
  const r = await ping(text, { priority: opt.priority || 'default', dedup: !opt['no-dedup'] });
  emit('notify', { text }, run ? { run } : {});
  out({ ok: r.ok, status: r.status, skipped: r.skipped });
}

// ---------- forjalvl (nível de modelos, docs/ARCHITECTURE.md §6) ----------
const forjalvlCmds = {
  // `forjalvl show` — the project's default and, if there is one, the run in progress.
  show() {
    const settings = projectSettings();
    const def = projectLevel();
    const run = readRun();
    const lines = [];
    // Where the forjalvl came from, told exactly: no file at all, a file that
    // does not set the key, or the file's value. (An unreadable file never gets
    // here.) A file written before the rename says `model_level`: it still
    // counts as "set", and nothing rewrites it.
    const from = readForjalvl(settings) !== undefined ? ` — de ${settingsPath()}`
      : existsSync(settingsPath()) ? ` — por omissão do Forja; ${settingsPath()} existe mas não define forjalvl`
        : ' — por omissão do Forja, sem SETTINGS.json';
    lines.push(`Projeto ${basename(projectRoot())} — forjalvl por omissão: ${labelOf(def)} (${def})${from}`);
    lines.push(`  ${detailOf(def)}`);
    if (!run) lines.push('Sem run neste projeto: o próximo `forja run start` usa este forjalvl (ou o de `--forjalvl <nível>`).');
    else {
      const lvl = levelOf(readForjalvl(run));
      lines.push(`Run ${run.run_id} (${run.status}) — forjalvl: ${labelOf(lvl)} (${lvl})${lvl === def ? '' : ' — diferente do forjalvl por omissão do projeto'}`);
      lines.push(`  ${detailOf(lvl)}`);
      lines.push('O forjalvl de um run escolhe-se ao arrancá-lo; `forjalvl set` só muda o forjalvl por omissão dos próximos runs.');
    }
    out(lines.join('\n'));
  },
  // `forjalvl set <nível>` — the project's default, with or without a run open.
  set({ pos }) {
    const level = checkedLevel(need(pos[0], 'o nível: max|high|eco (ou máximo|alto|económico)'));
    // Refuses before writing when the file is there but unreadable: overwriting
    // it would silently drop whatever else the Sponsor had in it.
    try { writeSettings({ forjalvl: level }); } catch (err) { fail(err.message); }
    out({ ok: true, forjalvl: level, label: labelOf(level), settings: settingsPath(), note: 'vale para os próximos runs deste projeto; um run já a correr mantém o forjalvl com que arrancou' });
  },
};

// ---------- autonomia (docs/ARCHITECTURE.md §6b) ----------
const autonomyCmds = {
  // `autonomy show` — the project's default and, if there is one, the run in progress.
  show() {
    const settings = projectSettings();
    const def = projectAutonomy();
    const run = readRun();
    const lines = [];
    // Where the value came from, told exactly: no file, a file that does not set
    // the key, or the file's value (same three cases as `forjalvl show`).
    const from = readAutonomy(settings) !== undefined ? ` — de ${settingsPath()}`
      : existsSync(settingsPath()) ? ` — por omissão do Forja; ${settingsPath()} existe mas não define autonomy`
        : ' — por omissão do Forja, sem SETTINGS.json';
    lines.push(`Projeto ${basename(projectRoot())} — autonomia por omissão: ${autonomyLabelOf(def)}${from}`);
    lines.push(`  ${autonomyRule(def)}`);
    if (!run) lines.push('Sem run neste projeto: o próximo `forja run start` usa esta autonomia (ou a de `--autonomy <normal|total>`).');
    else {
      const a = autonomyOf(readAutonomy(run));
      lines.push(`Run ${run.run_id} (${run.status}) — autonomia: ${autonomyLabelOf(a)}${a === def ? '' : ' — diferente da autonomia por omissão do projeto'}`);
      lines.push(`  ${autonomyRule(a)}`);
      lines.push('A autonomia de um run escolhe-se ao arrancá-lo; `autonomy set` só muda a autonomia por omissão dos próximos runs.');
    }
    out(lines.join('\n'));
  },
  // `autonomy set <normal|total>` — the project's default, with or without a run open.
  // Setting `total` always prints, on one line, what still goes to the queue:
  // the Sponsor is giving freedom, and he sees exactly what he is not giving.
  set({ pos }) {
    const autonomy = checkedAutonomy(need(pos[0], 'o valor: normal|total'));
    // Refuses before writing when the file is there but unreadable: overwriting
    // it would silently drop whatever else the Sponsor had in it.
    try { writeSettings({ autonomy }); } catch (err) { fail(err.message); }
    out({
      ok: true, autonomy, settings: settingsPath(),
      note: 'vale para os próximos runs deste projeto; um run já a correr mantém a autonomia com que arrancou',
      ...(autonomy === 'total' ? { ainda_na_fila: queueAlwaysLine(), perguntas_de_dinheiro: roadmapRule() } : {}),
    });
  },
};

// ---------- status & resume ----------
function status() {
  const run = readRun();
  if (!run) { out('Sem run neste projeto. `forja run start --goal "…"` para começar.'); return; }
  const tasks = readTasks();
  const queue = readQueue();
  const lines = [`Run ${run.run_id} · ${run.project} · ${run.status} · forjalvl: ${labelOf(readForjalvl(run))} (${levelOf(readForjalvl(run))}) · autonomia: ${autonomyLabelOf(readAutonomy(run))} · piso ${run.model_floor} · sessões ${run.sessions.length} · checkpoints ${run.checkpoints.length}`, `Objetivo: ${run.goal}`, ''];
  for (const t of tasks) lines.push(`${t.id.padEnd(4)} ${t.status.padEnd(8)} ${String(t.attempts).padStart(1)}/${MAX_ATTEMPTS}  ${t.owner || '?'}  ${t.title}${t.why ? `  ← ${t.why.slice(0, 80)}` : ''}`);
  if (!tasks.length) lines.push('(sem tasks)');
  lines.push('');
  const open = queue.filter(q => q.status.startsWith('aberta'));
  lines.push(`Fila do Sponsor: ${open.length} aberta${open.length === 1 ? '' : 's'}${open.length ? ' — ' + open.map(q => `${q.id}: ${q.question} (default: ${q.default})`).join(' | ') : ''}`);
  if (run.fallbacks && run.fallbacks.length) lines.push(`Fallbacks: ${run.fallbacks.map(f => `${f.id} ${f.role} ${f.from}→${f.to} ${fmtLocal(f.ts)}`).join(' | ')}`);
  // Live instances, from the viewer's reducer over the global stream (best effort, same rules as the UI).
  try {
    const events = readFileSync(join(dataDir(), 'events.jsonl'), 'utf8').split('\n');
    return import('../viewer/lib/state.mjs').then(({ reduceLines, STATES }) => {
      const snap = reduceLines(events, Date.now());
      const r = snap.runs.find(x => x.runId === run.run_id || x.id === run.run_id) || snap.runs.find(x => x.sessions.includes(currentSessionId()));
      if (r) {
        lines.push('');
        lines.push(`Elenco (viewer): ${r.roster.map(c => `${c.name}=${c.state}${c.detail ? ` (${String(c.detail).slice(0, 40)})` : ''}`).join(' · ')}`);
        const live = r.roster.flatMap(c => c.instances).filter(i => ![STATES.TERMINADO, STATES.FALHOU].includes(i.state));
        for (const i of live) lines.push(`  ${i.role} ${i.agentId} ${i.state} ${i.task || ''} ${i.resolvedModel || ''}`);
      }
      out(lines.join('\n'));
    }).catch(() => out(lines.join('\n')));
  } catch { out(lines.join('\n')); }
}
function resume() {
  const run = readRun();
  const forja = forjaRoot;
  if (!run) { out(`Sem run neste projeto. Prompt de arranque: ver ${join(forja, 'docs', 'RUNBOOK-UNATTENDED.md')}.`); return; }
  const prompt = [
    `Continue the Forja run ${run.run_id} on this project (${run.project}).`,
    `Load the skill forja-lead and follow it. Read CLAUDE.md, then docs/forja/HANDOVER.md, docs/forja/RUN.json, docs/forja/TASKS.json, docs/forja/SPONSOR-QUEUE.md.`,
    `Run: node "${join(forja, 'bin', 'forja.mjs')}" run resume — then node "${join(forja, 'bin', 'forja.mjs')}" status — then continue from the exact next action in HANDOVER.md.`,
    `Goal of the run: ${run.goal}`,
    `forjalvl (nível de modelos) for this run: ${levelOf(readForjalvl(run))} (${labelOf(readForjalvl(run))}) — ${detailOf(readForjalvl(run))}. It decides every role's model (forja-lead §1); it is in RUN.json.forjalvl and never in the agent files.`,
    `Autonomy of this run: ${autonomyOf(readAutonomy(run))} — ${autonomyRule(readAutonomy(run), 'en')} It is the Sponsor's, in RUN.json.autonomy (docs/ARCHITECTURE.md §6b); never change it, never argue with it.`,
    `Model floor for this run: ${run.model_floor} (the Architect's model at level max). Never ask me anything in the terminal: product questions go to Product Manager, Sponsor-only questions to the queue with a default applied. Do not end your turn while the run is running and work is possible.`,
  ].join('\n');
  out(prompt);
}

// ---------- delegated commands (modules written in later phases) ----------
async function delegate(mod, fn, args) {
  const path = join(forjaRoot, 'lib', mod);
  if (!existsSync(path)) fail(`${fn}: módulo ${mod} ainda não existe (fase posterior)`);
  const m = await import(`file://${path.replace(/\\/g, '/')}`);
  return m[fn](args);
}

const usage = `forja — comandos (docs/ARCHITECTURE.md §7b)
  run start --goal "…" [--forjalvl max|high|eco] [--autonomy normal|total] [--visivel] [--driver interactive|runner] | run resume | run checkpoint [--note "…"] | run finish [--note "…"] | run fail --why "…" | run block --why "…"
  run driver show | run driver set interactive|runner   (quem conduz o run: esta conversa ou o runner autónomo — a guarda só relança runs do runner; docs/ARCHITECTURE.md §3c)
  task add --id T1 --owner backend-dev|frontend-dev --title "…" [--complexity easy|medium|hard] [--criteria "…"] [--after T0]
  task show T1   (id, estado, owner, complexidade, critérios, tentativas, veredictos completos, dependência)
  task start T1 | task review T1 | task done T1 --verdict "…" [--evidence "…"] | task fail T1 --why "…" [--no-attempt] | task block T1 --why "…"
  runner [--goal "…"] [--forjalvl max|high|eco] [--autonomy normal|total] [--visivel] [--max-task-minutes 45] [--max-plan-minutes 90] [--max-sessions 60]   (uma sessão nova do Claude Code por fase; sem --goal retoma o run em curso; --visivel corre cada fase como sessão de fundo \`claude --bg\`, que aparece na app do Claude)
  forjalvl show | forjalvl set max|high|eco   (forjalvl, o nível de modelos: máximo · alto · económico — por run, com omissão por projeto em docs/forja/SETTINGS.json; \`models\` e \`--models\` continuam a funcionar como alias)
  autonomy show | autonomy set normal|total   (autonomia do run: \`total\` decide dentro do run dependências gratuitas e escolhas de produto/design em vez de as pôr na fila — dinheiro, contas, envios, apagar dados e publicar continuam sempre na fila)
  decide "…" --why "…" [--reversible yes|no] [--supersedes D1] [--by "Product Manager"]
  ask "…" --default "…" --why "…" | answers
  fallback <papel> <de> <para> --why "…" | progress "…" [--as papel] | notify "…" [--priority high] | status | resume
  report "…"   (sessão à mão, sem run: regista o fim e o relatório entregue ao Sponsor numa linha — o viewer mostra-o no feed; dentro de um run usa-se \`run finish\`)
  serve | up [--port N] [--no-tunnel] | down | token rotate | autostart install|remove | bootstrap <repo> [--dry-run] [--keep-legacy]
  guard [run] [--poll-ms 60000] | guard stop | guard status   (guarda dos runners: processo à parte que relança um runner morto a meio de um run — 3 tentativas, 15 min entre elas; \`forja guard\` sem subcomando é o mesmo que \`guard run\` e fica a correr; "status" só simula e não lança nada)
  projects list | projects prune   (registo de projetos preparados: lista com pasta e run; prune tira os que já não têm pasta)`;

async function main() {
  const { pos, opt } = parse(process.argv.slice(2));
  const [cmd, sub, ...rest] = pos;
  const args = { pos: rest, opt };
  try {
    switch (cmd) {
      // `Object.hasOwn`, never a truthiness test on the lookup: `toString`,
      // `constructor` and the rest of Object.prototype are unknown subcommands,
      // not functions to call with the run's state (same rule as lib/models.mjs).
      case 'run': if (!Object.hasOwn(runCmds, sub)) fail(usage); return await runCmds[sub](args);
      case 'task': if (!Object.hasOwn(taskCmds, sub)) fail(usage); return await taskCmds[sub](args);
      // `models` is the name this command had before the Sponsor's rename of
      // 17 set 2026: it still works, and says so once on stderr.
      case 'models':
      case 'forjalvl': {
        if (cmd === 'models') console.error(`forja: \`models\` (alias de forjalvl) — usa \`forja forjalvl ${sub || 'show'}\``);
        if (!Object.hasOwn(forjalvlCmds, sub)) fail(usage);
        return await forjalvlCmds[sub](args);
      }
      case 'autonomy': if (!Object.hasOwn(autonomyCmds, sub)) fail(usage); return await autonomyCmds[sub](args);
      case 'decide': return await decide({ pos: [sub, ...rest], opt });
      case 'ask': return await ask({ pos: [sub, ...rest], opt });
      case 'answers': return await answers();
      case 'fallback': return await fallback({ pos: [sub, ...rest], opt });
      case 'progress': return await progress({ pos: [sub, ...rest], opt });
      case 'report': return await report({ pos: [sub, ...rest].filter(Boolean), opt });
      case 'notify': return await notifyCmd({ pos: [sub, ...rest].filter(Boolean), opt });
      case 'status': return await status();
      case 'resume': return resume();
      case 'runner': return await delegate('runner.mjs', 'runner', { opt });
      case 'serve': return await delegate('serve.mjs', 'serve', { opt });
      case 'up': return await delegate('up.mjs', 'up', { opt });
      case 'down': return await delegate('up.mjs', 'down', { opt });
      case 'token': return await delegate('serve.mjs', 'token', { pos: [sub, ...rest], opt });
      case 'autostart': return await delegate('up.mjs', 'autostart', { pos: [sub, ...rest], opt });
      case 'guard': return await delegate('guard.mjs', 'guard', { pos: [sub, ...rest], opt });
      case 'bootstrap': return await delegate('bootstrap.mjs', 'bootstrap', { pos: [sub, ...rest], opt });
      case 'projects': return await delegate('projects.mjs', 'projects', { pos: [sub, ...rest], opt });
      default: out(usage); process.exit(cmd ? 2 : 0);
    }
  } catch (err) {
    // A known refusal (Error with a message) is shown as one sentence; only
    // an unexpected failure gets the stack, so the Sponsor never sees frames
    // for a plain "não é JSON válido".
    const known = err instanceof Error && err.message && !/^(TypeError|ReferenceError|RangeError|SyntaxError)/.test(String(err.name));
    fail(known ? err.message : String(err && err.stack || err), 1);
  }
}
main();
