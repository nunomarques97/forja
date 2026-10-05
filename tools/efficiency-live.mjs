#!/usr/bin/env node
// Live paired A/B of the kept efficiency changes through local Ollama models
// (docs/EFFICIENCY.md, "Live A/B through Ollama"). Entry point:
//   node tools/efficiency-bench.mjs live <command> [--lab <dir>]
//   plan             print tasks, pairs, caps and profile; writes nothing
//   run [--detach]   run or resume; --detach starts it in the background and returns
//   status           progress and the per-arm summary
//   report           Markdown tables of the results (for docs/EFFICIENCY.md)
//   stop             ask a running harness to stop after the current run
// Arm "on" runs this worktree's bin/forja.mjs. Arm "off" runs a scratch copy
// of the same source in which only the kept packet change is undone. Each run
// is a fresh copy of a bake-off task (fixed plan) padded with generated
// modules, so the repository map is larger than both budgets.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO, TASKS_DIR, alive, gpuVerdict, kill, latestRun, loadTasks, nvidiaSample, ollama, readLedger, sleep, testCount } from './local-bakeoff.mjs';

const COMMANDS = ['plan', 'run', 'status', 'report', 'stop', 'help'];
const minutes = n => n * 60_000;

export const LIVE = {
  tasks: ['duration-fix', 'paginate-regression', 'coupon-feature'],
  // The first 2 repeats were the planned sample; the third was added within
  // the cap because the pass difference rested on two pairs (docs/EFFICIENCY.md).
  repeats: 3,
  wallClockMinutes: 90,
  runMinutes: 14,
  paddingFiles: 150,
  // Stricter than config/core-local.json: a fixed one-task plan needs at most
  // two develop and two review sessions.
  profileOverrides: { maxSessions: 4 },
  gpu: { busyUtilization: 40, foreignMemoryMiB: 6144, pollSeconds: 60, maxWaitMinutes: 30 },
};

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv, opt = { command };
  if (!COMMANDS.includes(command)) throw Error(`Unknown command ${JSON.stringify(command)}; use ${COMMANDS.join(', ')}.`);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--detach' && command === 'run') opt.detach = true;
    else if (rest[i] === '--lab' && rest[i + 1] && !rest[i + 1].startsWith('--')) opt.lab = rest[++i];
    else throw Error(`Unknown or incomplete argument ${JSON.stringify(rest[i])}; nothing was run or written.`);
  }
  return opt;
}

// ---------- the two arms ----------
// The kept eff-context change in packet(): task packets get a 3,000-character
// map with the task files pinned first. "Off" restores the call it replaced
// (the 6,000-character default, no pinned files).
export const MAP_CHANGE = {
  file: 'lib/core/context.mjs',
  on: [
    '  const map = task',
    "    ? repoMap(root, `${task.title} ${(task.files || []).join(' ')}`, TASK_MAP_CHARACTERS, task.files)",
    '    : repoMap(root, run.goal, PLAN_MAP_CHARACTERS);',
  ].join('\n'),
  off: "  const map = repoMap(root, task ? `${task.title} ${(task.files || []).join(' ')}` : run.goal);",
};

export function undoMapChange(source) {
  const text = source.replace(/\r\n/g, '\n');
  const at = text.indexOf(MAP_CHANGE.on);
  if (at < 0 || text.indexOf(MAP_CHANGE.on, at + 1) >= 0) throw Error(`${MAP_CHANGE.file} no longer holds the kept map call exactly once; update MAP_CHANGE before an A/B.`);
  return text.slice(0, at) + MAP_CHANGE.off + text.slice(at + MAP_CHANGE.on.length);
}

// Everything the controller loads at run time (the Core specialist methods
// live in .claude/skills); tests, examples and data stay out.
const RUNTIME = ['bin', 'lib', 'hooks', 'docs', 'config', 'viewer', 'tools', '.claude/skills', 'package.json', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'CHANGELOG.md', 'LICENSE'];

const sha = text => createHash('sha256').update(text).digest('hex');
function treeDigest(root, dir) {
  const hash = createHash('sha256');
  const walk = d => {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.isFile()) hash.update(`${relative(root, p).replace(/\\/g, '/')}\0`).update(readFileSync(p)).update('\0');
    }
  };
  walk(join(root, dir));
  return hash.digest('hex');
}

// Builds the off copy from the current worktree; returns the evidence that
// only the map call differs.
export function buildOffCopy(target, source = REPO) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  for (const part of RUNTIME) if (existsSync(join(source, part))) cpSync(join(source, part), join(target, part), { recursive: true });
  const on = readFileSync(join(source, MAP_CHANGE.file), 'utf8');
  const off = undoMapChange(on);
  writeFileSync(join(target, MAP_CHANGE.file), off);
  return { root: target, context_on_sha256: sha(on), context_off_sha256: sha(off), lib_sha256: treeDigest(source, 'lib') };
}

// ---------- scratch projects ----------
const AREAS = ['billing', 'shipping', 'accounts', 'reports', 'alerts', 'inventory', 'pricing', 'sessions', 'exports', 'webhooks'];
const NOUNS = ['ledger', 'parcel', 'invoice', 'profile', 'badge', 'route', 'queue', 'ticket', 'batch', 'metric', 'record', 'channel', 'bucket', 'slot', 'label'];
const VERBS = ['load', 'store', 'merge', 'shape', 'render', 'sync', 'index', 'archive', 'resolve', 'encode'];
const cap = word => word[0].toUpperCase() + word.slice(1);

// Deterministic neighbouring modules: no test file names, no word of a task
// query, so they only make the repository map larger than both budgets.
export function paddingFiles(count = LIVE.paddingFiles) {
  const files = {};
  for (let i = 0; i < count; i++) {
    const area = AREAS[i % AREAS.length], noun = NOUNS[Math.floor(i / AREAS.length) % NOUNS.length], verb = VERBS[(i * 7) % VERBS.length];
    files[`packages/${area}/${noun}-${verb}.mjs`] = [
      `// ${cap(area)}: ${noun} helpers.`,
      `export function ${verb}${cap(noun)}(value) {`,
      `  return { area: '${area}', kind: '${noun}', value };`,
      '}',
      `export function is${cap(noun)}(value) {`,
      `  return value?.kind === '${noun}';`,
      '}',
      `export function ${noun}Label(value) {`,
      `  return \`${noun}:\${String(value?.value ?? '')}\`;`,
      '}',
      '',
    ].join('\n');
  }
  return files;
}

export function materialize(task, project, padding = paddingFiles()) {
  rmSync(project, { recursive: true, force: true });
  cpSync(join(task.dir, 'project'), project, { recursive: true });
  for (const [path, text] of Object.entries(padding)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  const git = (...args) => spawnSync('git', ['-c', 'user.name=live-ab', '-c', 'user.email=live-ab@localhost', '-c', 'core.autocrlf=false', ...args], { cwd: project, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'initial');
  return git;
}

// The local profile: config/core-local.json with stricter run budgets; every
// route must stay local.
export function liveProfile(base = JSON.parse(readFileSync(join(REPO, 'config', 'core-local.json'), 'utf8'))) {
  const profile = { ...base, ...LIVE.profileOverrides };
  if (profile.maxCloudSessions !== 0 || profile.escalation) throw Error('The live A/B runs local models only: the profile needs maxCloudSessions 0 and no escalation.');
  for (const [phase, route] of Object.entries(profile.routes || {}))
    if (route.localProvider !== 'ollama') throw Error(`The live A/B runs local models only: route ${phase} is not an Ollama route.`);
  return profile;
}

// Paired order: the arms alternate which goes first, so a warm model or cache
// does not always favour the same arm.
export function schedule(tasks = LIVE.tasks, repeats = LIVE.repeats) {
  const runs = [];
  let pair = 0;
  for (let r = 1; r <= repeats; r++)
    for (const task of tasks) {
      const arms = pair % 2 === 0 ? ['on', 'off'] : ['off', 'on'];
      for (const arm of arms) runs.push({ id: `${task}:r${r}:${arm}`, pair: `${task}:r${r}`, task, repeat: r, arm });
      pair++;
    }
  return runs;
}

// ---------- measurement ----------
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const sum = values => values.reduce((n, v) => n + (v ?? 0), 0);
export function median(values) {
  const v = values.filter(x => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

// Repository map and prompt characters as the ledger records them per invocation.
export function packetStats(runDir) {
  const rows = new Map();
  const path = join(runDir, 'usage.jsonl');
  if (existsSync(path))
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (Number.isInteger(row?.id)) rows.set(row.id, row);
    }
  const list = [...rows.values()];
  const map = list.map(r => r.context_sources?.find(s => s.source === 'repository_map')?.characters ?? 0);
  return { prompt_characters: sum(list.map(r => r.prompt_characters)), map_characters: sum(map), map_characters_max: map.length ? Math.max(...map) : 0 };
}

// Size of the first model request of each session (input plus cache), from
// Kilo's step_finish events: the fixed context (system prompt, tools, FORJA
// prompt and packet) that every later call of the session sends again.
export function sessionBaselines(runDir) {
  const out = [];
  if (!runDir || !existsSync(join(runDir, 'usage.jsonl'))) return out;
  const phases = new Map();
  for (const line of readFileSync(join(runDir, 'usage.jsonl'), 'utf8').split('\n')) {
    try { const row = JSON.parse(line); if (Number.isInteger(row?.id)) phases.set(row.id, row.phase); } catch {}
  }
  for (const [id, phase] of [...phases].sort((a, b) => a[0] - b[0])) {
    const raw = readJson(join(runDir, `call-${id}-stream.json`));
    const text = typeof raw?.stdout === 'string' ? raw.stdout : '';
    for (const line of text.split(/\r?\n/)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const tokens = event?.type === 'step_finish' ? event.part?.tokens : null;
      if (!tokens) continue;
      out.push({ id, phase, tokens: (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) });
      break;
    }
  }
  return out;
}

export function runMetrics(rows, packets) {
  return {
    sessions: rows.length, calls: sum(rows.map(r => r.calls)), input_tokens: sum(rows.map(r => r.input_tokens)), output_tokens: sum(rows.map(r => r.output_tokens)),
    provider_ms: sum(rows.map(r => r.duration_ms)), develop_sessions: rows.filter(r => r.phase === 'develop').length,
    review_verdicts: rows.filter(r => r.phase === 'review').map(r => r.status ?? r.result), follow_ups: rows.filter(r => r.follow_up).length, timeouts: rows.filter(r => r.timed_out).length,
    ...packets,
  };
}

// Per-arm totals, paired differences (on minus off) over complete pairs, and
// the verdict against the offline gain. Rules fixed before the run:
// contradicts when "on" passes fewer hidden tests in complete pairs or its
// median paired input is higher; confirms when it passes at least as many and
// both its median paired input and input per call are lower; otherwise, or
// with fewer than 2 complete pairs, inconclusive.
export function summarizeLive(steps) {
  const done = steps.filter(s => s.kind === 'run' && s.status === 'done' && s.metrics);
  const arm = name => {
    const list = done.filter(s => s.arm === name), m = list.map(s => s.metrics);
    return {
      runs: list.length, passed: list.filter(s => s.acceptance?.passed).length, own_tests: list.filter(s => s.acceptance?.own_tests).length,
      sessions: sum(m.map(x => x.sessions)), calls: sum(m.map(x => x.calls)), input_tokens: sum(m.map(x => x.input_tokens)), output_tokens: sum(m.map(x => x.output_tokens)),
      wall_ms: sum(list.map(s => s.duration_ms)), provider_ms: sum(m.map(x => x.provider_ms)),
      input_per_call: sum(m.map(x => x.calls)) ? Math.round(sum(m.map(x => x.input_tokens)) / sum(m.map(x => x.calls))) : null,
      median_input_tokens: median(m.map(x => x.input_tokens)), median_map_characters_max: median(m.map(x => x.map_characters_max)),
      median_develop_baseline: median(list.flatMap(s => (s.baselines || []).filter(b => b.phase === 'develop').map(b => b.tokens))),
      median_review_baseline: median(list.flatMap(s => (s.baselines || []).filter(b => b.phase === 'review').map(b => b.tokens))),
    };
  };
  const pairs = [];
  for (const id of [...new Set(done.map(s => s.pair))]) {
    const on = done.find(s => s.pair === id && s.arm === 'on'), off = done.find(s => s.pair === id && s.arm === 'off');
    if (!on || !off) continue;
    const perCall = s => (s.metrics.calls ? s.metrics.input_tokens / s.metrics.calls : null);
    const firstDevelop = s => (s.baselines || []).find(b => b.phase === 'develop')?.tokens ?? null;
    pairs.push({
      pair: id, input_tokens: on.metrics.input_tokens - off.metrics.input_tokens, calls: on.metrics.calls - off.metrics.calls,
      wall_ms: on.duration_ms - off.duration_ms, input_per_call: perCall(on) !== null && perCall(off) !== null ? Math.round(perCall(on) - perCall(off)) : null,
      develop_baseline: firstDevelop(on) !== null && firstDevelop(off) !== null ? firstDevelop(on) - firstDevelop(off) : null,
      passed: { on: !!on.acceptance?.passed, off: !!off.acceptance?.passed },
    });
  }
  const paired = {
    pairs: pairs.length, passed_on: pairs.filter(p => p.passed.on).length, passed_off: pairs.filter(p => p.passed.off).length,
    median_input_tokens: median(pairs.map(p => p.input_tokens)), median_calls: median(pairs.map(p => p.calls)),
    median_wall_ms: median(pairs.map(p => p.wall_ms)), median_input_per_call: median(pairs.map(p => p.input_per_call)),
    median_develop_baseline: median(pairs.map(p => p.develop_baseline)),
    on_lower_input: pairs.filter(p => p.input_tokens < 0).length,
  };
  let verdict = 'inconclusive', reason = `${pairs.length} complete pair(s); at least 2 are needed`;
  if (pairs.length >= 2) {
    if (paired.passed_on < paired.passed_off) [verdict, reason] = ['contradicts', `on passed ${paired.passed_on} of ${pairs.length} pairs, off ${paired.passed_off}`];
    else if (paired.median_input_tokens > 0) [verdict, reason] = ['contradicts', `median paired input +${paired.median_input_tokens} tokens with the change`];
    else if (paired.median_input_tokens < 0 && paired.median_input_per_call < 0) [verdict, reason] = ['confirms', `median paired input ${paired.median_input_tokens} tokens, input per call ${paired.median_input_per_call}, passes ${paired.passed_on} vs ${paired.passed_off}`];
    else reason = `median paired input ${paired.median_input_tokens}, input per call ${paired.median_input_per_call}`;
  }
  return { arms: { off: arm('off'), on: arm('on') }, pairs, paired, verdict, reason };
}

// ---------- the harness ----------
class LiveAb {
  constructor(lab) {
    this.root = join(lab, 'live-ab');
    this.paths = Object.fromEntries(['projects', 'runs', 'data', 'tmp'].map(d => [d, join(this.root, d)]));
    Object.assign(this.paths, { state: join(this.root, 'results.json'), pid: join(this.root, 'harness.pid'), stop: join(this.root, 'STOP'), log: join(this.root, 'live-ab.log'),
      off: join(this.root, 'forja-off'), profile: join(this.root, 'profile.json') });
  }
  log(line) { console.log(`${new Date().toISOString()} ${line}`); }
  load() { this.state = readJson(this.paths.state) ?? { version: 1, created_at: new Date().toISOString(), active_ms: 0, status: 'new', steps: [] }; }
  save() {
    if (this.sessionStart) this.state.active_ms = this.activeBefore + (Date.now() - this.sessionStart);
    this.state.updated_at = new Date().toISOString();
    writeFileSync(this.paths.state + '.tmp', JSON.stringify(this.state, null, 2) + '\n');
    renameSync(this.paths.state + '.tmp', this.paths.state);
  }
  left() { return minutes(LIVE.wallClockMinutes) - (this.activeBefore + (Date.now() - this.sessionStart)); }
  halt(reason) { this.state.status = reason; this.state.stop_reason = reason; this.save(); this.log(`Stopping: ${reason}.`); return false; }

  async run() {
    for (const dir of ['projects', 'runs', 'data', 'tmp']) mkdirSync(this.paths[dir], { recursive: true });
    const other = readJson(this.paths.pid);
    if (other && other.pid !== process.pid && alive(other.pid)) throw Error(`Another live A/B harness is running (pid ${other.pid}).`);
    writeFileSync(this.paths.pid, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    rmSync(this.paths.stop, { force: true });
    this.load();
    const finished = schedule().every(r => this.state.steps.some(s => s.id === r.id && (s.status === 'done' || s.status === 'failed')));
    if (this.state.status === 'done' && finished) { this.log('Live A/B already finished; see status.'); rmSync(this.paths.pid, { force: true }); return; }
    this.activeBefore = this.state.active_ms; this.sessionStart = Date.now();
    try {
      this.state.status = 'running';
      this.profile = liveProfile();
      writeFileSync(this.paths.profile, JSON.stringify(this.profile, null, 2) + '\n');
      this.models = new Set(Object.values(this.profile.routes).map(r => r.model));
      // Rebuilt on every start, so the off arm always matches the current source.
      const copy = buildOffCopy(this.paths.off);
      this.state.code = copy; this.state.profile = this.profile; this.state.live = LIVE;
      if (!this.state.code_history?.includes(copy.lib_sha256)) (this.state.code_history ??= []).push(copy.lib_sha256);
      this.save();
      const tasks = Object.fromEntries(loadTasks(TASKS_DIR).map(t => [t.id, t]));
      for (const id of LIVE.tasks) if (!tasks[id]) throw Error(`Bake-off task ${id} is missing.`);
      for (const planned of schedule()) {
        let step = this.state.steps.find(s => s.id === planned.id);
        if (step?.status === 'done' || step?.status === 'failed') continue;
        if (existsSync(this.paths.stop)) return this.halt('stop requested');
        if (this.left() < minutes(5)) return this.halt('wall-clock cap reached');
        const gpu = await this.waitForGpu();
        if (!gpu) return this.halt(existsSync(this.paths.stop) ? 'stop requested' : 'GPU busy too long');
        step ??= { ...planned, kind: 'run', tries: 0 };
        if (!this.state.steps.includes(step)) this.state.steps.push(step);
        // A run interrupted by a crash restarts once on a fresh copy.
        if (++step.tries > 2) { Object.assign(step, { status: 'failed', error: 'interrupted twice' }); this.save(); continue; }
        Object.assign(step, { status: 'running', lib_sha256: copy.lib_sha256 }, gpu); this.save();
        Object.assign(step, await this.execute(tasks[planned.task], planned, `${planned.task}-r${planned.repeat}-${planned.arm}`));
        // No Core run means the controller refused to start: a harness or
        // setup fault, not a measurement, so stop instead of using up the pairs.
        if (!step.run_id) { step.status = 'error'; return this.halt(`no Core run was created for ${step.id}: ${step.failure}`); }
        step.status = 'done'; this.save();
        this.log(`${step.id}: acceptance ${step.acceptance.passed ? 'pass' : 'fail'}, run ${step.run_status ?? '?'}${step.failure ? ` (${step.failure})` : ''}, ${Math.round(step.duration_ms / 1000)} s, ${step.metrics.input_tokens} input tokens, ${step.metrics.calls} calls`);
      }
      for (const m of (await ollama('/api/ps')).models || []) if (this.models.has(m.name)) await ollama('/api/generate', { model: m.name, keep_alive: 0 }, minutes(1));
      this.state.status = 'done'; this.state.finished_at = new Date().toISOString();
      this.state.summary = summarizeLive(withBaselines(this.state.steps));
      this.log(`Live A/B finished: ${this.state.summary.verdict} (${this.state.summary.reason}).`);
    } finally {
      if (this.state.status === 'running') this.state.status = 'stopped';
      this.save();
      rmSync(this.paths.pid, { force: true });
    }
  }

  // Waits while another process uses the GPU heavily or another model is loaded.
  async waitForGpu() {
    const started = Date.now();
    for (;;) {
      const ps = (await ollama('/api/ps')).models || [];
      const samples = [];
      for (let i = 0; i < 3; i++) { samples.push(nvidiaSample()); if (i < 2) await sleep(2000); }
      const utilization = samples[0].utilization === null ? null : samples.map(s => s.utilization).sort((a, b) => a - b)[1];
      const verdict = gpuVerdict({ utilization, memoryUsedMiB: Math.max(...samples.map(s => s.memoryUsedMiB ?? 0)), ollamaMiB: sum(ps.map(m => m.size_vram)) / 2 ** 20,
        foreignModels: ps.map(m => m.name).filter(name => !this.models.has(name)) }, LIVE.gpu);
      if (!verdict.busy) return { waited_ms: Date.now() - started, gpu: verdict.reason };
      if (Date.now() - started > minutes(LIVE.gpu.maxWaitMinutes) || this.left() < minutes(5) || existsSync(this.paths.stop)) return null;
      this.log(`GPU busy (${verdict.reason}); waiting.`);
      await sleep(LIVE.gpu.pollSeconds * 1000);
      this.save();
    }
  }

  async execute(task, planned, name) {
    const project = join(this.paths.projects, name), evidence = join(this.paths.runs, name);
    const git = materialize(task, project);
    mkdirSync(evidence, { recursive: true });
    const planPath = join(evidence, 'plan.json');
    writeFileSync(planPath, JSON.stringify(task.plan, null, 2));
    const forja = planned.arm === 'on' ? REPO : this.paths.off;
    const args = [join(forja, 'bin', 'forja.mjs'), 'start', '--provider', 'kilo', '--project', project, '--config', this.paths.profile, '--goal', task.goal, '--plan', planPath];
    const capMs = Math.min(minutes(LIVE.runMinutes), this.left() - minutes(1));
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
    const runDir = latestRun(project), state = runDir ? readJson(join(runDir, 'state.json')) : null;
    const metrics = runMetrics(runDir ? readLedger(runDir) : [], runDir ? packetStats(runDir) : { prompt_characters: 0, map_characters: 0, map_characters_max: 0 });
    const acceptance = this.judge(task, project, evidence);
    git('add', '-A');
    writeFileSync(join(evidence, 'change.diff'), (git('diff', '--cached', 'HEAD', '--', '.', ':(exclude).forja').stdout ?? '').slice(0, 256 * 1024));
    const tail = readFileSync(join(evidence, 'forja.log'), 'utf8').trim().split('\n').slice(-3).join(' | ');
    const failure = result.capped ? `harness cap of ${Math.round(capMs / 60000)} min reached` : state?.status === 'done' ? null
      : (tail.match(/FORJA (blocked|failed)[^|]*/)?.[0] ?? state?.stopCode ?? `exit ${result.code}`).slice(0, 300);
    return { forja: planned.arm === 'on' ? 'worktree' : 'off copy', project, evidence, run_id: state?.run_id ?? null, run_status: state?.status ?? null, stop_code: state?.stopCode ?? null,
      exit_code: result.code, capped: result.capped, duration_ms, failure, acceptance, metrics };
  }

  // The hidden acceptance test runs from the template folder against the project.
  judge(task, project, evidence) {
    const { NODE_TEST_CONTEXT, ...inherited } = process.env;
    const env = { ...inherited, BAKEOFF_PROJECT: project, TEMP: this.paths.tmp, TMP: this.paths.tmp };
    const hidden = spawnSync(process.execPath, ['--test', join(task.dir, 'acceptance.test.mjs')], { cwd: this.paths.tmp, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    const own = spawnSync(process.execPath, ['--test'], { cwd: project, env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    writeFileSync(join(evidence, 'acceptance.log'), `${hidden.stdout ?? ''}${hidden.stderr ?? ''}\n---- own tests ----\n${own.stdout ?? ''}${own.stderr ?? ''}`);
    return { passed: hidden.status === 0, pass: testCount(hidden.stdout, 'pass'), fail: testCount(hidden.stdout, 'fail'), own_tests: own.status === 0 };
  }
}

const secs = ms => (ms == null ? '–' : Math.round(ms / 1000));
const signed = n => (n == null ? '–' : n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US'));
// Baselines are read from the saved run folders, so older results gain them too.
export const withBaselines = steps => steps.map(s => (s.kind === 'run' && s.project && !s.baselines ? { ...s, baselines: sessionBaselines(latestRun(s.project)) } : s));

export function report(state) {
  const steps = withBaselines(state.steps);
  const s = summarizeLive(steps);
  const lines = ['| Run | Arm | Hidden test | Own tests | Run end | Sessions | Calls | Input tokens | Output tokens | Input/call | Map chars (max per packet) | First request per session | Wall s |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const step of steps.filter(x => x.kind === 'run' && x.status === 'done')) {
    const m = step.metrics, a = step.acceptance;
    const end = step.capped ? 'harness cap' : step.run_status === 'done' ? 'done' : `${step.run_status ?? '?'}${step.stop_code ? ` (${step.stop_code})` : ''}`;
    lines.push(`| ${step.pair} | ${step.arm} | ${a.passed ? 'pass' : 'fail'} (${a.pass}/${a.pass + a.fail}) | ${a.own_tests ? 'pass' : 'fail'} | ${end} | ${m.sessions} | ${m.calls} | ${m.input_tokens.toLocaleString('en-US')} | ${m.output_tokens.toLocaleString('en-US')} | ${m.calls ? Math.round(m.input_tokens / m.calls).toLocaleString('en-US') : '–'} | ${m.map_characters_max.toLocaleString('en-US')} | ${(step.baselines || []).map(b => `${b.phase[0]} ${b.tokens.toLocaleString('en-US')}`).join(', ') || '–'} | ${secs(step.duration_ms)} |`);
  }
  lines.push('', '| Arm | Runs | Hidden pass | Own tests pass | Sessions | Calls | Input tokens | Output tokens | Input/call | Median map chars | Median first request develop / review | Wall s |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [name, a] of Object.entries(s.arms))
    lines.push(`| ${name} | ${a.runs} | ${a.passed} | ${a.own_tests} | ${a.sessions} | ${a.calls} | ${a.input_tokens.toLocaleString('en-US')} | ${a.output_tokens.toLocaleString('en-US')} | ${a.input_per_call?.toLocaleString('en-US') ?? '–'} | ${a.median_map_characters_max ?? '–'} | ${a.median_develop_baseline ?? '–'} / ${a.median_review_baseline ?? '–'} | ${secs(a.wall_ms)} |`);
  const p = s.paired;
  lines.push('', `Paired (on minus off, ${p.pairs} complete pairs): median input ${signed(p.median_input_tokens)} tokens, median calls ${signed(p.median_calls)}, median input per call ${signed(p.median_input_per_call)}, median first develop request ${signed(p.median_develop_baseline)}, median wall ${signed(p.median_wall_ms == null ? null : Math.round(p.median_wall_ms / 1000))} s; on lower input in ${p.on_lower_input} of ${p.pairs}; hidden passes on ${p.passed_on}, off ${p.passed_off}.`);
  lines.push('', `Verdict: ${s.verdict} (${s.reason}).`);
  return lines.join('\n');
}

const defaultLab = () => JSON.parse(readFileSync(join(REPO, 'test', 'bakeoff', 'config.json'), 'utf8')).lab;

export async function main(argv) {
  const opt = parseArgs(argv);
  if (opt.command === 'help') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const harness = new LiveAb(resolve(opt.lab ?? defaultLab()));
  if (opt.command === 'plan') {
    console.log(JSON.stringify({ results: harness.paths.state, live: LIVE, change: MAP_CHANGE, runs: schedule().map(r => r.id), profile: liveProfile(), padding_files: Object.keys(paddingFiles()).length }, null, 2));
  } else if (opt.command === 'status') {
    harness.load();
    const s = harness.state, running = readJson(harness.paths.pid);
    console.log(JSON.stringify({ status: s.status, alive: !!running && alive(running.pid), active_minutes: Math.round(s.active_ms / 60000),
      steps: s.steps.map(step => `${step.id} ${step.status}${step.acceptance ? ` acceptance=${step.acceptance.passed}` : ''}${step.failure ? ` (${step.failure})` : step.error ? ` (${step.error})` : ''}`),
      summary: summarizeLive(withBaselines(s.steps)) }, null, 2));
  } else if (opt.command === 'report') {
    harness.load();
    console.log(report(harness.state));
  } else if (opt.command === 'stop') {
    mkdirSync(harness.root, { recursive: true }); writeFileSync(harness.paths.stop, new Date().toISOString());
    console.log('Stop requested: the harness stops after the current run; run resumes it.');
  } else if (opt.detach) {
    mkdirSync(harness.root, { recursive: true });
    const log = openSync(harness.paths.log, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', ...(opt.lab ? ['--lab', opt.lab] : [])], { cwd: REPO, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
    console.log(JSON.stringify({ pid: child.pid, log: harness.paths.log, results: harness.paths.state }));
  } else await harness.run();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2)).catch(error => {
  console.error(`efficiency-live: ${error.message}`);
  process.exitCode = 2;
});
