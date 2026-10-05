#!/usr/bin/env node
// Local model bake-off (docs/research/local-models-2026-10-04.md).
//   plan                 print candidates, tasks and caps; writes nothing
//   run [--detach]       run or resume; --detach starts it in the background and returns
//   status               progress and per-role summary from the results file
//   report               Markdown tables of the results (for docs/research)
//   stop               ask a running harness to stop after the current step (resume with run)
//   cleanup [--confirm]  remove only models this harness pulled or created, except those in config/core-local.json
//   --lab <dir>          scratch root (default from test/bakeoff/config.json); results in <lab>/bakeoff/
// Each step runs this worktree's bin/forja.mjs with one local model in every
// phase, in a fresh scratch project; the hidden acceptance test never enters it.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TASKS_DIR = join(REPO, 'test', 'bakeoff', 'tasks');
export const OLLAMA = 'http://127.0.0.1:11434';
const COMMANDS = ['plan', 'run', 'status', 'report', 'stop', 'cleanup', 'help'];
const minutes = n => n * 60_000;

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv, opt = { command };
  if (!COMMANDS.includes(command)) throw Error(`Unknown command ${JSON.stringify(command)}; use ${COMMANDS.join(', ')}.`);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--detach' && command === 'run') opt.detach = true;
    else if (rest[i] === '--confirm' && command === 'cleanup') opt.confirm = true;
    else if (rest[i] === '--lab' && rest[i + 1] && !rest[i + 1].startsWith('--')) opt.lab = rest[++i];
    else throw Error(`Unknown or incomplete argument ${JSON.stringify(rest[i])}; nothing was run or written.`);
  }
  return opt;
}

// ---------- configuration ----------
export const variantName = (base, ctx) => `forja-bk-${base.replace(/:latest$/, '').replace(/[^a-z0-9.]+/gi, '-').toLowerCase()}:${Math.round(ctx / 1024)}k`;
export const slug = text => String(text).replace(/[^a-z0-9.]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

export function validateConfig(config) {
  const fail = message => { throw Error(`Bake-off config: ${message}`); };
  if (config?.version !== 1) fail('version must be 1.');
  if (!Number.isInteger(config.wallClockMinutes) || config.wallClockMinutes < 1 || config.wallClockMinutes > 180) fail('wallClockMinutes must be in 1..180.');
  for (const stage of ['screening', 'full']) if (!Number.isInteger(config.runMinutes?.[stage]) || config.runMinutes[stage] < 1 || config.runMinutes[stage] > 60) fail(`runMinutes.${stage} must be in 1..60.`);
  if (config.profile?.maxCloudSessions !== 0) fail('profile.maxCloudSessions must be 0: the bake-off is local only.');
  if (!Number.isInteger(config.contextTokens) || config.contextTokens < 16384) fail('contextTokens must be at least 16384 (Kilo preflight).');
  const names = new Set();
  for (const c of config.candidates || []) {
    if (!!c.model === !!c.base) fail('each candidate names either model (installed as is) or base (a 32k variant is created).');
    if (c.model && c.pull) fail(`${c.model}: only a base can be pulled.`);
    if (/cloud/i.test(c.model || c.base)) fail(`${c.model || c.base}: cloud models are not local.`);
    if (c.pull && !(c.sizeGB > 0 && c.sizeGB <= config.maxModelGB)) fail(`${c.base}: a pulled model must declare sizeGB within maxModelGB (${config.maxModelGB}).`);
    if (c.pull && !c.license) fail(`${c.base}: a pulled model must declare its (free) license.`);
    const name = candidateModel(c, config);
    if (names.has(name)) fail(`duplicate candidate ${name}.`);
    names.add(name);
  }
  if (!names.size) fail('no candidates.');
  if (config.keep !== undefined && !(Array.isArray(config.keep) && config.keep.every(name => typeof name === 'string' && name))) fail('keep must be a list of model names.');
  return config;
}
export const candidateModel = (c, config) => c.model || variantName(c.base, config.contextTokens);

export function loadTasks(dir = TASKS_DIR) {
  return readdirSync(dir).sort().map(id => {
    const task = JSON.parse(readFileSync(join(dir, id, 'task.json'), 'utf8'));
    if (task.id !== id || !['screening', 'full'].includes(task.stage) || !task.goal || !task.plan?.tasks?.length) throw Error(`Invalid bake-off task ${id}.`);
    for (const part of ['project', 'acceptance.test.mjs']) if (!existsSync(join(dir, id, part))) throw Error(`Bake-off task ${id} lacks ${part}.`);
    return { ...task, dir: join(dir, id) };
  });
}

// The Core profile of one model: every phase on that local model, no cloud.
export function profileFor(model, config) {
  const { routeMinutes, ...budgets } = config.profile;
  const route = phase => ({ provider: 'kilo', localProvider: 'ollama', model, maxMinutes: routeMinutes[phase] });
  return { ...budgets, routes: { plan: route('plan'), develop: route('develop'), review: route('review') } };
}

// ---------- GPU and Ollama ----------
// Windows reports no per-process GPU memory, so another process's load is the
// total in use minus what Ollama reports for its loaded models.
export function gpuVerdict({ utilization, memoryUsedMiB, ollamaMiB = 0, foreignModels = [] }, limits) {
  if (foreignModels.length) return { busy: true, reason: `another Ollama model is loaded: ${foreignModels.join(', ')}` };
  if (utilization === null) return { busy: false, reason: 'nvidia-smi unavailable' };
  const foreign = Math.max(0, memoryUsedMiB - ollamaMiB);
  if (utilization >= limits.busyUtilization) return { busy: true, reason: `GPU utilization ${utilization}%` };
  if (foreign >= limits.foreignMemoryMiB) return { busy: true, reason: `${foreign} MiB of GPU memory used by other processes` };
  return { busy: false, reason: `utilization ${utilization}%, ${foreign} MiB used by other processes` };
}

export function nvidiaSample() {
  const out = spawnSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (out.status !== 0) return { utilization: null, memoryUsedMiB: null };
  const [utilization, memoryUsedMiB] = out.stdout.trim().split('\n')[0].split(',').map(v => Number(v.trim()));
  return { utilization, memoryUsedMiB };
}

export async function ollama(path, body, timeoutMs = 30_000) {
  const response = await fetch(OLLAMA + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw Error(`Ollama ${path} answered ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
const installed = async () => new Set((await ollama('/api/tags')).models.map(m => m.name));
const loaded = async () => (await ollama('/api/ps')).models || [];

// ---------- run measurement ----------
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

export function latestRun(project) {
  const runs = join(project, '.forja', 'runs');
  if (!existsSync(runs)) return null;
  const ids = readdirSync(runs).filter(id => existsSync(join(runs, id, 'state.json')));
  ids.sort((a, b) => statSync(join(runs, a, 'state.json')).mtimeMs - statSync(join(runs, b, 'state.json')).mtimeMs);
  return ids.length ? join(runs, ids.at(-1)) : null;
}

export function readLedger(runDir) {
  const path = join(runDir, 'usage.jsonl');
  if (!existsSync(path)) return [];
  const rows = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (Number.isInteger(row?.id)) rows.set(row.id, row);
  }
  return [...rows.values()].sort((a, b) => a.id - b.id).map(row => ({
    id: row.id, phase: row.phase, attempt: row.attempt, result: row.result, timed_out: !!row.timed_out,
    duration_ms: row.duration_ms ?? null, calls: row.calls ?? null,
    input_tokens: row.usage ? (row.usage.input_tokens ?? 0) + (row.usage.cached_input_tokens ?? 0) + (row.usage.cache_creation_input_tokens ?? 0) : null,
    output_tokens: row.usage?.output_tokens ?? null, follow_up: !!row.result_follow_up,
    status: readJson(join(runDir, `call-${row.id}-result.json`))?.status ?? null,
  }));
}

const sum = values => values.reduce((n, v) => n + (v ?? 0), 0);
const rate = (tokens, ms) => (tokens && ms ? Math.round((tokens / (ms / 1000)) * 10) / 10 : null);

// Per-role outcome of one run; `truth` is the hidden acceptance result.
export function roleOutcomes({ rows, state, fixedPlan, acceptance }) {
  const of = phase => rows.filter(r => r.phase === phase);
  const phase = list => ({ sessions: list.length, duration_ms: sum(list.map(r => r.duration_ms)), output_tokens: sum(list.map(r => r.output_tokens)),
    input_tokens: sum(list.map(r => r.input_tokens)), tokens_per_s: rate(sum(list.map(r => r.output_tokens)), sum(list.map(r => r.duration_ms))),
    timeouts: list.filter(r => r.timed_out).length, follow_ups: list.filter(r => r.follow_up).length, results: list.map(r => r.status ?? r.result) });
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const planRows = of('plan');
  const plan = fixedPlan ? { fixed: true } : { ...phase(planRows), ok: planRows.length > 0 && planRows.at(-1).result === 'returned' && tasks.length > 0, tasks: tasks.length,
    checks: tasks.reduce((n, t) => n + (t.checks?.length ?? 0), 0) };
  const develop = { ...phase(of('develop')), acceptance: acceptance.passed, own_tests: acceptance.ownTests };
  const reviewRows = of('review'), verdicts = reviewRows.map(r => r.status);
  const last = verdicts.at(-1) ?? null;
  const review = { ...phase(reviewRows), verdicts, valid: reviewRows.length ? verdicts.every(v => v === 'approve' || v === 'reject') : null,
    correct: last === 'approve' ? acceptance.passed : last === 'reject' ? !acceptance.passed : null };
  return { plan, develop, review };
}

// ---------- selection and summary ----------
export function screeningScore(steps, model) {
  const runs = steps.filter(s => s.kind === 'run' && s.stage === 'screening' && s.model === model && s.status === 'done');
  if (!runs.length) return null;
  const roles = runs.map(s => s.roles);
  const accepted = runs.some(s => s.acceptance?.passed);
  const score = 3 * accepted + (roles.some(r => r.plan?.ok) ? 1 : 0) + (roles.some(r => r.review?.correct === true) ? 1 : 0);
  return { score, duration_ms: sum(runs.map(s => s.duration_ms)) };
}

export function pickFinalists(steps, models, count) {
  return models.map(model => ({ model, ...screeningScore(steps, model) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.duration_ms - b.duration_ms)
    .slice(0, count).map(s => s.model);
}

export function summarize(state) {
  const models = {};
  for (const step of state.steps.filter(s => s.kind === 'run' && s.status === 'done')) {
    const m = models[step.model] ??= { runs: 0, plan: { runs: 0, ok: 0, ms: 0, tok: 0 }, develop: { runs: 0, accepted: 0, own_tests: 0, ms: 0, tok: 0 }, review: { runs: 0, valid: 0, correct: 0, ms: 0, tok: 0 }, failures: [] };
    m.runs++;
    const { plan, develop, review } = step.roles;
    if (!plan.fixed && plan.sessions) { m.plan.runs++; m.plan.ok += plan.ok ? 1 : 0; m.plan.ms += plan.duration_ms; m.plan.tok += plan.output_tokens; }
    if (develop.sessions) { m.develop.runs++; m.develop.accepted += develop.acceptance ? 1 : 0; m.develop.own_tests += develop.own_tests ? 1 : 0; m.develop.ms += develop.duration_ms; m.develop.tok += develop.output_tokens; }
    if (review.sessions) { m.review.runs++; m.review.valid += review.valid ? 1 : 0; m.review.correct += review.correct ? 1 : 0; m.review.ms += review.duration_ms; m.review.tok += review.output_tokens; }
    if (step.failure) m.failures.push(`${step.task}${step.fixedPlan ? ' (fixed plan)' : ''}: ${step.failure}`);
  }
  for (const [model, m] of Object.entries(models)) {
    for (const role of ['plan', 'develop', 'review']) { const r = m[role]; r.tokens_per_s = rate(r.tok, r.ms); r.mean_s = r.runs ? Math.round(r.ms / r.runs / 1000) : null; }
    m.probe = state.steps.find(s => s.kind === 'probe' && s.model === model && s.status === 'done')?.probe ?? null;
  }
  // Rates in key order, then mean time: a fast model never outranks a correct one.
  const ranking = (role, keys) => Object.entries(models).filter(([, m]) => m[role].runs)
    .sort(([, a], [, b]) => keys.reduce((d, key) => d || b[role][key] / b[role].runs - a[role][key] / a[role].runs, 0) || a[role].mean_s - b[role].mean_s).map(([model]) => model);
  return { models, ranking: { plan: ranking('plan', ['ok']), develop: ranking('develop', ['accepted', 'own_tests']), review: ranking('review', ['correct', 'valid']) } };
}

// ---------- the harness ----------
class Harness {
  constructor(config, lab) {
    this.config = config;
    this.root = join(lab, 'bakeoff');
    this.paths = { state: join(this.root, 'results.json'), pid: join(this.root, 'harness.pid'), stop: join(this.root, 'STOP'), log: join(this.root, 'bakeoff.log'),
      projects: join(this.root, 'projects'), runs: join(this.root, 'runs'), profiles: join(this.root, 'profiles'), data: join(this.root, 'data'), tmp: join(this.root, 'tmp') };
  }
  log(line) { console.log(`${new Date().toISOString()} ${line}`); }
  load() {
    this.state = readJson(this.paths.state) ?? { version: 1, created_at: new Date().toISOString(), active_ms: 0, status: 'new', steps: [], models: {} };
  }
  save() {
    this.state.active_ms = this.activeBefore + (Date.now() - this.sessionStart);
    this.state.updated_at = new Date().toISOString();
    writeFileSync(this.paths.state + '.tmp', JSON.stringify(this.state, null, 2) + '\n');
    renameSync(this.paths.state + '.tmp', this.paths.state);
  }
  left() { return minutes(this.config.wallClockMinutes) - (this.activeBefore + (Date.now() - this.sessionStart)); }
  step(id) { return this.state.steps.find(s => s.id === id); }
  stopRequested() { return existsSync(this.paths.stop); }

  async run() {
    for (const dir of ['projects', 'runs', 'profiles', 'data', 'tmp']) mkdirSync(this.paths[dir], { recursive: true });
    const other = readJson(this.paths.pid);
    if (other && other.pid !== process.pid && alive(other.pid)) throw Error(`Another bake-off harness is running (pid ${other.pid}).`);
    writeFileSync(this.paths.pid, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    rmSync(this.paths.stop, { force: true });
    this.load();
    if (this.state.status === 'done') { this.log('Bake-off already finished; see status.'); return; }
    this.activeBefore = this.state.active_ms; this.sessionStart = Date.now();
    this.state.status = 'running'; this.state.config = this.config; this.save();
    try {
      this.tasks = loadTasks();
      this.state.tasks = this.tasks.map(({ id, kind, stage }) => ({ id, kind, stage }));
      const pulls = this.pullAll().catch(error => this.log(`pulls stopped: ${error.message}`));
      const screening = this.tasks.filter(t => t.stage === 'screening');
      const deferred = [];
      for (const c of this.config.candidates) {
        if (c.pull && !this.pullDone(c)) { deferred.push(c); continue; }
        if (!await this.screen(c, screening)) return;
      }
      await pulls;
      for (const c of deferred) if (!await this.screen(c, screening)) return;
      const models = this.config.candidates.map(c => candidateModel(c, this.config));
      const finalists = pickFinalists(this.state.steps, models, this.config.fullCandidates);
      this.state.finalists = finalists; this.save();
      // Fastest screening first, so the wall-clock cap cuts the slowest finalist, not every finalist.
      const order = [...finalists].sort((a, b) => screeningScore(this.state.steps, a).duration_ms - screeningScore(this.state.steps, b).duration_ms);
      for (const model of order)
        for (const task of this.tasks.filter(t => t.stage === 'full'))
          if (!await this.runTask(model, task, 'full')) return;
      await this.unloadOurs(null);
      this.state.status = 'done'; this.state.finished_at = new Date().toISOString();
      this.state.summary = summarize(this.state);
      this.log('Bake-off finished.');
    } finally {
      if (this.state.status === 'running') this.state.status = 'stopped';
      this.save();
      rmSync(this.paths.pid, { force: true });
    }
  }

  // Returns false when the harness must stop (cap, stop request or GPU wait limit).
  async halt(reason) { this.state.status = reason; this.state.stop_reason = reason; this.save(); this.log(`Stopping: ${reason}.`); return false; }

  async screen(candidate, tasks) {
    const model = await this.prepare(candidate);
    if (!model) return true;
    if (!await this.probe(model)) return false;
    for (const task of tasks) if (!await this.runTask(model, task, 'screening')) return false;
    return true;
  }

  // Pulls run in the background (network, not GPU) while installed models are screened.
  async pullAll() {
    const before = await installed();
    for (const c of this.config.candidates.filter(c => c.pull)) {
      const id = `pull:${c.base}`;
      let step = this.step(id);
      if (step?.status === 'done' || step?.status === 'failed') continue;
      if (before.has(c.base)) { this.state.steps.push(step ?? { id, kind: 'pull', model: c.base, status: 'done', pulled: false, note: 'already installed; never removed' }); this.save(); continue; }
      step ??= { id, kind: 'pull', model: c.base }; if (!this.state.steps.includes(step)) this.state.steps.push(step);
      step.status = 'running'; step.started_at = new Date().toISOString(); this.save();
      this.log(`pull ${c.base} (${c.sizeGB} GB, ${c.license})`);
      const started = Date.now();
      const code = await new Promise(done => {
        const child = spawn('ollama', ['pull', c.base], { stdio: 'ignore', windowsHide: true });
        const timer = setTimeout(() => kill(child.pid), minutes(40));
        child.on('exit', code => { clearTimeout(timer); done(code); }); child.on('error', () => { clearTimeout(timer); done(-1); });
      });
      step.duration_ms = Date.now() - started;
      const tags = (await ollama('/api/tags')).models;
      const tag = tags.find(m => m.name === c.base);
      if (code === 0 && tag) {
        Object.assign(step, { status: 'done', pulled: true, bytes: tag.size });
        if (tag.size > this.config.maxModelGB * 1e9) { step.note = `larger than ${this.config.maxModelGB} GB; not used`; step.status = 'failed'; }
      } else Object.assign(step, { status: 'failed', pulled: !!tag, error: `ollama pull exited ${code}` });
      this.save();
    }
  }
  pullDone(c) { const s = this.step(`pull:${c.base}`); return s?.status === 'done' || s?.status === 'failed'; }

  // Resolves the candidate to an installed local model with tools and a 32k context.
  async prepare(c) {
    const model = candidateModel(c, this.config);
    if (c.pull && this.step(`pull:${c.base}`)?.status !== 'done') { this.record({ id: `prepare:${model}`, kind: 'prepare', model, status: 'failed', error: 'pull failed' }); return null; }
    const tags = await installed();
    if (c.base) {
      if (!tags.has(c.base)) { this.record({ id: `prepare:${model}`, kind: 'prepare', model, status: 'failed', error: `${c.base} is not installed` }); return null; }
      if (!tags.has(model)) {
        await ollama('/api/create', { model, from: c.base, parameters: { num_ctx: this.config.contextTokens }, stream: false }, minutes(5));
        this.state.models[model] = { created: true, from: c.base }; this.save();
      }
    } else if (!tags.has(model)) { this.record({ id: `prepare:${model}`, kind: 'prepare', model, status: 'failed', error: 'not installed' }); return null; }
    const show = await ollama('/api/show', { model });
    const capabilities = show.capabilities || [];
    const license = String(show.license || '').split('\n').find(l => l.trim())?.trim().slice(0, 80) ?? null;
    this.state.models[model] = { ...this.state.models[model], capabilities, license, parameters: show.details?.parameter_size ?? null, quantization: show.details?.quantization_level ?? null, family: show.details?.family ?? null };
    this.save();
    if (!capabilities.includes('tools')) { this.record({ id: `prepare:${model}`, kind: 'prepare', model, status: 'failed', error: 'model has no tool support' }); return null; }
    return model;
  }
  record(step) { if (!this.step(step.id)) { this.state.steps.push(step); this.save(); } }

  async waitForGpu(model) {
    const started = Date.now();
    for (;;) {
      await this.unloadOurs(model);
      const ps = await loaded();
      const ours = new Set(this.config.candidates.map(c => candidateModel(c, this.config)));
      const samples = [];
      for (let i = 0; i < 3; i++) { samples.push(nvidiaSample()); if (i < 2) await sleep(2000); }
      const utilization = samples[0].utilization === null ? null : samples.map(s => s.utilization).sort((a, b) => a - b)[1];
      const verdict = gpuVerdict({ utilization, memoryUsedMiB: Math.max(...samples.map(s => s.memoryUsedMiB ?? 0)), ollamaMiB: sum(ps.map(m => m.size_vram)) / 2 ** 20,
        foreignModels: ps.map(m => m.name).filter(name => !ours.has(name)) }, this.config.gpu);
      if (!verdict.busy) return { waited_ms: Date.now() - started, gpu: verdict.reason };
      if (Date.now() - started > minutes(this.config.gpu.maxWaitMinutes) || this.left() < minutes(5) || this.stopRequested()) return null;
      this.log(`GPU busy (${verdict.reason}); waiting.`);
      await sleep(this.config.gpu.pollSeconds * 1000);
      this.save();
    }
  }

  // One model at a time: unload every candidate model except the current one.
  async unloadOurs(keep) {
    const ours = new Set(this.config.candidates.map(c => candidateModel(c, this.config)));
    for (const m of (await loaded()).filter(m => ours.has(m.name) && m.name !== keep)) await ollama('/api/generate', { model: m.name, keep_alive: 0 }, minutes(1));
    for (let i = 0; i < 30 && (await loaded()).some(m => ours.has(m.name) && m.name !== keep); i++) await sleep(2000);
  }

  async probe(model) {
    const id = `probe:${model}`;
    if (this.step(id)?.status === 'done') return true;
    if (this.stopRequested()) return this.halt('stop requested');
    if (this.left() < minutes(5)) return this.halt('wall-clock cap reached');
    const gpu = await this.waitForGpu(model);
    if (!gpu) return this.halt(this.stopRequested() ? 'stop requested' : 'GPU busy too long');
    const step = this.step(id) ?? { id, kind: 'probe', model }; if (!this.state.steps.includes(step)) this.state.steps.push(step);
    const code = readFileSync(join(TASKS_DIR, 'safe-path', 'acceptance.test.mjs'), 'utf8');
    try {
      const r = await ollama('/api/generate', { model, prompt: `${code}\n\nIn one sentence, what does this test check?`, stream: false, keep_alive: '15m', options: { temperature: 0, num_predict: 128 } }, minutes(4));
      const ns = n => (n ? n / 1e9 : null);
      step.probe = { load_s: ns(r.load_duration), prompt_tokens: r.prompt_eval_count ?? null, prompt_tokens_per_s: r.prompt_eval_duration ? Math.round(r.prompt_eval_count / ns(r.prompt_eval_duration)) : null,
        output_tokens: r.eval_count ?? null, tokens_per_s: r.eval_duration ? Math.round((r.eval_count / ns(r.eval_duration)) * 10) / 10 : null };
      const ps = (await loaded()).find(m => m.name === model);
      if (ps) step.probe.vram_gb = Math.round((ps.size_vram / 1e9) * 10) / 10, step.probe.size_gb = Math.round((ps.size / 1e9) * 10) / 10;
      step.status = 'done'; Object.assign(step, gpu);
    } catch (error) { step.status = 'failed'; step.error = error.message.slice(0, 300); }
    this.save();
    this.log(`probe ${model}: ${JSON.stringify(step.probe ?? step.error)}`);
    return true;
  }

  async runTask(model, task, stage) {
    for (const fixedPlan of [false, true]) {
      const id = `run:${stage}:${model}:${task.id}${fixedPlan ? ':fixed-plan' : ''}`;
      let step = this.step(id);
      if (fixedPlan) {
        // A fixed plan is only used when the model's own plan failed, so the
        // developer and reviewer of a weak planner are still measured.
        const own = this.step(`run:${stage}:${model}:${task.id}`);
        if (!own || own.status !== 'done' || own.roles.plan.ok) return true;
      }
      // A step whose Core run was never created (start refused it) is retried on resume, within its tries.
      if (step?.status === 'done' && (step.run_id || step.tries >= 2)) continue;
      if (this.stopRequested()) return this.halt('stop requested');
      if (this.left() < minutes(5)) return this.halt('wall-clock cap reached');
      const gpu = await this.waitForGpu(model);
      if (!gpu) return this.halt(this.stopRequested() ? 'stop requested' : 'GPU busy too long');
      step ??= { id, kind: 'run', stage, model, task: task.id, fixedPlan, tries: 0 };
      if (!this.state.steps.includes(step)) this.state.steps.push(step);
      // A step interrupted by a crash restarts once on a fresh copy.
      if (++step.tries > 2) { Object.assign(step, { status: 'failed', error: 'interrupted twice' }); this.save(); continue; }
      step.status = 'running'; Object.assign(step, gpu); this.save();
      Object.assign(step, await this.execute(model, task, stage, fixedPlan, `${slug(model)}-${task.id}${fixedPlan ? '-fixed' : ''}-${step.tries}`));
      step.status = 'done'; this.save();
      this.log(`${id}: acceptance ${step.acceptance.passed ? 'pass' : 'fail'}, run ${step.run_status}${step.failure ? ` (${step.failure})` : ''}, ${Math.round(step.duration_ms / 1000)} s`);
    }
    return true;
  }

  async execute(model, task, stage, fixedPlan, name) {
    const project = join(this.paths.projects, name), evidence = join(this.paths.runs, name);
    rmSync(project, { recursive: true, force: true });
    cpSync(join(task.dir, 'project'), project, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    const git = (...args) => spawnSync('git', ['-c', 'user.name=bakeoff', '-c', 'user.email=bakeoff@localhost', '-c', 'core.autocrlf=false', ...args], { cwd: project, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'initial');
    const profile = join(this.paths.profiles, `${slug(model)}.json`);
    writeFileSync(profile, JSON.stringify(profileFor(model, this.config), null, 2) + '\n');
    const args = [join(REPO, 'bin', 'forja.mjs'), 'start', '--provider', 'kilo', '--project', project, '--config', profile, '--goal', task.goal];
    if (fixedPlan) { const planPath = join(evidence, 'plan.json'); writeFileSync(planPath, JSON.stringify(task.plan, null, 2)); args.push('--plan', planPath); }
    const capMs = Math.min(minutes(this.config.runMinutes[stage]), this.left() - minutes(2));
    const out = openSync(join(evidence, 'forja.log'), 'w');
    const started = Date.now();
    const result = await new Promise(done => {
      const child = spawn(process.execPath, args, { cwd: project, stdio: ['ignore', out, out], windowsHide: true,
        env: { ...process.env, FORJA_DATA_DIR: this.paths.data, FORJA_NTFY_TOPIC: '', TEMP: this.paths.tmp, TMP: this.paths.tmp, TMPDIR: this.paths.tmp } });
      let capped = false;
      const timer = setTimeout(() => { capped = true; kill(child.pid); }, capMs);
      child.on('exit', code => { clearTimeout(timer); done({ code, capped }); });
      child.on('error', error => { clearTimeout(timer); done({ code: -1, capped, error: error.message }); });
    });
    const duration_ms = Date.now() - started;
    const runDir = latestRun(project), state = runDir ? readJson(join(runDir, 'state.json')) : null, rows = runDir ? readLedger(runDir) : [];
    const acceptance = this.judge(task, project, evidence);
    git('add', '-A');
    const diff = git('diff', '--cached', 'HEAD', '--', '.', ':(exclude).forja').stdout ?? '';
    writeFileSync(join(evidence, 'change.diff'), diff.slice(0, 256 * 1024));
    const stat = git('diff', '--cached', '--numstat', 'HEAD', '--', '.', ':(exclude).forja').stdout?.trim().split('\n').filter(Boolean) ?? [];
    const tail = readFileSync(join(evidence, 'forja.log'), 'utf8').trim().split('\n').slice(-3).join(' | ');
    const failure = result.capped ? `harness cap of ${Math.round(capMs / 60000)} min reached` : state?.status === 'done' ? null
      : (tail.match(/FORJA (blocked|failed)[^|]*/)?.[0] ?? state?.stopCode ?? `exit ${result.code}`).slice(0, 300);
    return { project, evidence, run_id: state?.run_id ?? null, run_status: state?.status ?? null, stop_code: state?.stopCode ?? null, exit_code: result.code, capped: result.capped,
      duration_ms, sessions: rows.length, failure, files_changed: stat.length, lines_changed: stat.reduce((n, l) => n + l.split('\t').slice(0, 2).reduce((m, v) => m + (Number(v) || 0), 0), 0),
      acceptance, roles: roleOutcomes({ rows, state, fixedPlan, acceptance: { passed: acceptance.passed, ownTests: acceptance.own_tests } }), calls: rows };
  }

  // The hidden acceptance test runs from the template folder against the project.
  judge(task, project, evidence) {
    const { NODE_TEST_CONTEXT, ...inherited } = process.env;
    const env = { ...inherited, BAKEOFF_PROJECT: project, TEMP: this.paths.tmp, TMP: this.paths.tmp };
    const hidden = spawnSync(process.execPath, ['--test', join(task.dir, 'acceptance.test.mjs')], { cwd: this.paths.tmp, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const own = spawnSync(process.execPath, ['--test'], { cwd: project, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    writeFileSync(join(evidence, 'acceptance.log'), `${hidden.stdout ?? ''}${hidden.stderr ?? ''}\n---- own tests ----\n${own.stdout ?? ''}${own.stderr ?? ''}`);
    return { passed: hidden.status === 0, pass: testCount(hidden.stdout, 'pass'), fail: testCount(hidden.stdout, 'fail'), own_tests: own.status === 0, own_pass: testCount(own.stdout, 'pass'), own_fail: testCount(own.stdout, 'fail') };
  }
}

// Summary line of node --test in the TAP ("# pass 3") or spec ("ℹ pass 3", maybe coloured) reporter.
export const testCount = (text, key) => Number(String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').match(new RegExp(`^(?:# |ℹ )${key} (\\d+)`, 'm'))?.[1] ?? 0);
// Hidden-test counts of a finished step; older results are re-read from the saved log.
function acceptanceCounts(step) {
  if (step.acceptance.pass + step.acceptance.fail > 0 || !step.evidence) return step.acceptance;
  const log = existsSync(join(step.evidence, 'acceptance.log')) ? readFileSync(join(step.evidence, 'acceptance.log'), 'utf8').split('---- own tests ----')[0] : '';
  return { ...step.acceptance, pass: testCount(log, 'pass'), fail: testCount(log, 'fail') };
}

export const sleep = ms => new Promise(done => setTimeout(done, ms));
export function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
// The controller's provider children (Kilo) must die with it.
export function kill(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

const secs = ms => (ms ? Math.round(ms / 1000) : '–');
const cell = text => String(text).replace(/\|/g, '/');
// Markdown tables from the results file; every number comes from the ledger,
// the probe or the hidden acceptance test.
export function report(state) {
  const { models, ranking } = summarize(state);
  const lines = ['| Model | Parameters, quantization | Generation tok/s | Prompt tok/s | Load s | Loaded GB (on GPU) |', '|---|---|---|---|---|---|'];
  for (const step of state.steps.filter(s => s.kind === 'probe')) {
    const m = state.models?.[step.model] ?? {}, p = step.probe ?? {};
    lines.push(`| \`${step.model}\` | ${m.parameters ?? '?'} ${m.quantization ?? ''} | ${p.tokens_per_s ?? '–'} | ${p.prompt_tokens_per_s ?? '–'} | ${p.load_s ? p.load_s.toFixed(1) : '–'} | ${p.size_gb ?? '–'} (${p.vram_gb ?? '–'}) |`);
  }
  lines.push('', '| Stage | Model | Task | Plan | Develop: hidden acceptance / own tests | Review verdicts | Run end | Time s | Sessions | Effective output tok/s plan / develop / review |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const s of state.steps.filter(s => s.kind === 'run' && s.status === 'done')) {
    const { plan, develop, review } = s.roles;
    const planCell = plan.fixed ? 'fixed plan' : `${plan.ok ? 'ok' : 'failed'} (${secs(plan.duration_ms)} s)`;
    const a = acceptanceCounts(s);
    const devCell = develop.sessions
      ? `${a.passed ? 'pass' : 'fail'} (${a.pass}/${a.pass + a.fail}) / ${a.own_tests ? 'pass' : 'fail'}, ${develop.sessions}× ${secs(develop.duration_ms)} s`
      : 'not reached';
    const end = s.run_status === 'done' ? 'done' : cell(s.failure ?? s.run_status ?? '?').replace(/^FORJA blocked: ([^:]*: )?/, '');
    lines.push(`| ${s.stage} | \`${s.model}\` | ${s.task}${s.fixedPlan ? ' (fixed plan)' : ''} | ${planCell} | ${devCell} | ${review.verdicts?.length ? review.verdicts.map(v => v ?? 'none').join(', ') : '–'} | ${end} | ${secs(s.duration_ms)} | ${s.sessions} | ${plan.tokens_per_s ?? '–'} / ${develop.tokens_per_s ?? '–'} / ${review.tokens_per_s ?? '–'} |`);
  }
  lines.push('', '| Model | Plan usable | Develop accepted | Review valid verdict / correct | Mean s plan / develop / review |', '|---|---|---|---|---|');
  for (const [model, m] of Object.entries(models))
    lines.push(`| \`${model}\` | ${m.plan.ok}/${m.plan.runs} | ${m.develop.accepted}/${m.develop.runs} | ${m.review.valid}/${m.review.runs} / ${m.review.correct}/${m.review.runs} | ${m.plan.mean_s ?? '–'} / ${m.develop.mean_s ?? '–'} / ${m.review.mean_s ?? '–'} |`);
  lines.push('', `Measured order (rate, then mean time): plan ${ranking.plan.join(' > ')}; develop ${ranking.develop.join(' > ')}; review ${ranking.review.join(' > ')}.`);
  return lines.join('\n');
}

// Only models this harness pulled or created are ever removed; the recommended
// profile's models and the config's `keep` list (documented alternatives) stay.
export function cleanupPlan(state, keepNames) {
  const keep = new Set(keepNames);
  const ours = [...state.steps.filter(s => s.kind === 'pull' && s.pulled).map(s => s.model),
    ...Object.entries(state.models ?? {}).filter(([, m]) => m.created).map(([name]) => name)];
  return { remove: ours.filter(name => !keep.has(name)), keep: ours.filter(name => keep.has(name)) };
}

async function cleanup(harness, confirm) {
  harness.load();
  const local = Object.values(readJson(join(REPO, 'config', 'core-local.json'))?.routes ?? {}).map(r => r.model);
  const { remove, keep } = cleanupPlan(harness.state, [...local, ...(harness.config.keep ?? [])]);
  console.log(JSON.stringify({ remove, keep, confirm: !!confirm }, null, 2));
  if (!confirm) { console.log('Dry run: add --confirm to remove these models.'); return; }
  for (const model of remove) await fetch(`${OLLAMA}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) });
}

async function main(argv) {
  const opt = parseArgs(argv);
  if (opt.command === 'help') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const config = validateConfig(JSON.parse(readFileSync(join(REPO, 'test', 'bakeoff', 'config.json'), 'utf8')));
  const harness = new Harness(config, resolve(opt.lab ?? config.lab));
  if (opt.command === 'plan') {
    const tasks = loadTasks();
    console.log(JSON.stringify({ results: harness.paths.state, wall_clock_minutes: config.wallClockMinutes, run_minutes: config.runMinutes, finalists: config.fullCandidates,
      candidates: config.candidates.map(c => ({ model: candidateModel(c, config), ...c })), tasks: tasks.map(({ id, kind, stage }) => ({ id, kind, stage })),
      profile: profileFor('<model>', config) }, null, 2));
  } else if (opt.command === 'status') {
    harness.load();
    const s = harness.state, running = readJson(harness.paths.pid);
    console.log(JSON.stringify({ status: s.status, alive: !!running && alive(running.pid), active_minutes: Math.round(s.active_ms / 60000), finalists: s.finalists ?? null,
      steps: s.steps.map(step => `${step.id} ${step.status}${step.acceptance ? ` acceptance=${step.acceptance.passed}` : ''}${step.failure ? ` (${step.failure})` : step.error ? ` (${step.error})` : ''}`),
      summary: summarize(s) }, null, 2));
  } else if (opt.command === 'report') {
    harness.load();
    console.log(report(harness.state));
  } else if (opt.command === 'stop') {
    mkdirSync(harness.root, { recursive: true }); writeFileSync(harness.paths.stop, new Date().toISOString());
    console.log('Stop requested: the harness stops after the current step; run resumes it.');
  } else if (opt.command === 'cleanup') await cleanup(harness, opt.confirm);
  else if (opt.detach) {
    mkdirSync(harness.root, { recursive: true });
    const log = openSync(harness.paths.log, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', ...(opt.lab ? ['--lab', opt.lab] : [])], { cwd: REPO, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
    console.log(JSON.stringify({ pid: child.pid, log: harness.paths.log, results: harness.paths.state }));
  } else await harness.run();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2)).catch(error => {
  console.error(`local-bakeoff: ${error.message}`);
  process.exitCode = 2;
});
