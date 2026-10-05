#!/usr/bin/env node
// Stress suite runner (test/stress/manifest.json).
//   plan                 print scenarios, caps and the derived profile; writes nothing
//   run [--detach]       run or resume, one scenario at a time; --detach returns at once
//   status               progress and totals from the results file
//   stop                 ask a running harness to stop after the current scenario (resume with run)
//   export               write test/stress/results/<label>.json from the results, keeping its judgements
//   --profile <json>     local profile (default config/core-local.json); every route must be local
//   --label <name>       results set (default baseline): <lab>/stress/<label>/results.json
//   --only <id,id>       subset of scenarios; --lab <dir> scratch root (default from the manifest)
// Each scenario is rebuilt fresh, run with this worktree's bin/forja.mjs under
// a wall-clock cap that kills the whole process tree, then judged by its hidden
// acceptance check from outside the project. maxCloudSessions is always 0.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alive, gpuVerdict, kill, latestRun, nvidiaSample, ollama, sleep, testCount } from './local-bakeoff.mjs';
import { REPO, acceptanceFile, loadManifest, materialize, scenarioBudgets, selectScenarios, validManifest } from '../test/stress/build-scenarios.mjs';
import { resultsFile, summarizeRecords } from '../test/stress/verify-results.mjs';

const COMMANDS = ['plan', 'run', 'status', 'stop', 'export', 'help'];
const DEFAULT_PROFILE = join(REPO, 'config', 'core-local.json');
const DEFAULT_GPU = { busyUtilization: 40, foreignMemoryMiB: 6144, pollSeconds: 60, maxWaitMinutes: 60 };
// Provider credentials never reach a nested run: it is local only.
const CLOUD_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'KILO_API_KEY'];
const minutes = n => n * 60_000;
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv, opt = { command };
  if (!COMMANDS.includes(command)) throw Error(`Unknown command ${JSON.stringify(command)}; use ${COMMANDS.join(', ')}.`);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i], value = rest[i + 1];
    if (flag === '--detach' && command === 'run') opt.detach = true;
    else if (['--profile', '--label', '--only', '--lab'].includes(flag) && value && !value.startsWith('--')) { opt[flag.slice(2)] = value; i++; }
    else throw Error(`Unknown or incomplete argument ${JSON.stringify(flag)}; nothing was run or written.`);
  }
  if (opt.label !== undefined && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(opt.label)) throw Error('--label must be lower-case letters, digits and dashes.');
  return opt;
}

// The Core profile of one scenario: the given local profile with the
// scenario's budgets as upper bounds and no cloud session at all.
export function stressProfile(profile, budgets) {
  const fail = message => { throw Error(`Stress profile: ${message}`); };
  if (!profile || typeof profile !== 'object') fail('not a JSON object.');
  if (profile.escalation) fail('escalation reaches the Claude route; nested stress runs use local models only.');
  const routes = profile.routes ?? {};
  for (const phase of ['plan', 'develop', 'review']) if (!routes[phase]) fail(`routes.${phase} is missing.`);
  for (const [selector, route] of Object.entries(routes))
    if (route?.localProvider !== 'ollama' || !['kilo', 'codex'].includes(route.provider) || !route.model) fail(`route ${selector} is not a local Ollama route.`);
  const cap = (value, limit) => Math.min(Number.isInteger(value) ? value : limit, limit);
  return {
    ...profile,
    maxSessions: cap(profile.maxSessions, budgets.maxSessions),
    maxAttempts: cap(profile.maxAttempts, budgets.maxAttempts),
    maxCloudSessions: 0,
  };
}
export const profileModels = profile => [...new Set(Object.values(profile.routes).map(route => route.model))];

// Deduplicated ledger rows of a run (the last row of each invocation wins).
export function ledgerTotals(runDir) {
  const rows = new Map();
  const path = runDir && join(runDir, 'usage.jsonl');
  if (path && existsSync(path))
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (Number.isInteger(row?.id)) rows.set(row.id, row);
    }
  const list = [...rows.values()];
  const sum = pick => list.reduce((n, row) => n + (pick(row) ?? 0), 0);
  const known = list.filter(row => row.usage);
  return {
    sessions: list.length,
    cloud_sessions: list.filter(row => row.local === false).length,
    phases: Object.fromEntries(['plan', 'develop', 'review'].map(phase => [phase, list.filter(row => row.phase === phase).length])),
    tokens: {
      input: known.length ? sum(row => row.usage && (row.usage.input_tokens ?? 0) + (row.usage.cached_input_tokens ?? 0) + (row.usage.cache_creation_input_tokens ?? 0)) : null,
      output: known.length ? sum(row => row.usage?.output_tokens) : null,
      coverage: list.length ? known.length / list.length : null,
    },
  };
}

// done: FORJA finished; blocked/failed: FORJA stopped; capped: the harness
// killed it at the wall-clock cap; error: no run was created.
export function outcomeOf({ capped, state }) {
  if (capped) return 'capped';
  if (!state) return 'error';
  return ['done', 'blocked', 'failed'].includes(state.status) ? state.status : `unfinished:${state.status}`;
}

export function summarize(results, scenarios) {
  const records = scenarios.map(s => results.scenarios[s.id]).filter(r => r?.status === 'done');
  const by = key => Object.fromEntries([...new Set(records.map(r => r[key]))].map(v => [v, records.filter(r => r[key] === v).length]));
  return {
    scenarios: scenarios.length,
    judged: records.length,
    accepted: records.filter(r => r.acceptance?.passed).length,
    completion_rate: records.length ? Math.round((records.filter(r => r.acceptance?.passed).length / scenarios.length) * 1000) / 10 : 0,
    outcomes: by('outcome'),
    tokens: { input: records.reduce((n, r) => n + (r.tokens?.input ?? 0), 0), output: records.reduce((n, r) => n + (r.tokens?.output ?? 0), 0) },
    sessions: records.reduce((n, r) => n + (r.sessions ?? 0), 0),
    cloud_sessions: records.reduce((n, r) => n + (r.cloud_sessions ?? 0), 0),
    minutes: Math.round(records.reduce((n, r) => n + (r.duration_ms ?? 0), 0) / 60000),
  };
}

// The committed form of a results set: measured fields from the harness, the
// judgement fields (verdict, change, judgement, failure) kept from the committed file,
// local paths replaced by <lab>. verdict starts as the acceptance result; a
// missing judgement or failure class fails test/stress/verify-results.mjs.
export function exportResults(results, manifest, previous = null, lab = manifest.lab) {
  const anonymize = text => text == null ? null : String(text).split(lab).join('<lab>').replace(/[A-Za-z]:[\\/][^\s|"']*/g, '<path>');
  const kept = new Map((previous?.scenarios ?? []).map(r => [r.id, r]));
  const records = manifest.scenarios.map(s => {
    const r = results.scenarios[s.id], old = kept.get(s.id) ?? {};
    if (r?.status !== 'done') return { id: s.id, category: s.category, kind: s.kind, outcome: 'error', acceptance: 'fail', verdict: old.verdict ?? 'fail', tokens: { input: null, output: null }, sessions: 0, duration_s: 0,
      evidence: null, forja_failure: anonymize(r?.error ?? 'not run'), change: old.change, judgement: old.judgement, failure: old.failure };
    const acceptance = r.acceptance?.passed ? 'pass' : 'fail';
    const record = {
      id: s.id, category: s.category, kind: s.kind, outcome: r.outcome.startsWith('unfinished') ? 'error' : r.outcome, stop_code: r.stop_code, acceptance,
      acceptance_tests: { pass: r.acceptance?.pass ?? null, fail: r.acceptance?.fail ?? null }, verdict: old.verdict ?? acceptance,
      tokens: { input: r.tokens?.input ?? null, output: r.tokens?.output ?? null }, sessions: r.sessions ?? 0, phases: r.phases, cloud_sessions: r.cloud_sessions ?? 0,
      duration_s: Math.round((r.duration_ms ?? 0) / 1000), tasks: r.tasks, files_changed: r.files_changed,
      evidence: `<lab>/stress/${results.label}/runs/${s.id}-${r.tries}/`, forja_failure: anonymize(r.failure), change: old.change, judgement: old.judgement, failure: old.failure,
    };
    if (record.outcome === 'done' && record.verdict === 'pass') delete record.failure;
    return record;
  });
  return {
    version: 1, label: results.label, run_started_at: results.created_at, run_finished_at: results.finished_at ?? null, active_minutes: Math.round((results.active_ms ?? 0) / 60000),
    profile: 'config/core-local.json', profile_sha256: results.profile_sha256 ?? null,
    summary: summarizeRecords(records), scenarios: records,
  };
}

export class Harness {
  constructor(manifest, { lab, label = 'baseline', profilePath = DEFAULT_PROFILE, only, forjaBin = join(REPO, 'bin', 'forja.mjs'), gpu = true, capMs = null, log = line => console.log(`${new Date().toISOString()} ${line}`) } = {}) {
    this.manifest = manifest;
    this.scenarios = selectScenarios(manifest, only);
    this.label = label;
    this.profilePath = resolve(profilePath);
    this.forjaBin = forjaBin;
    this.gpu = gpu ? { ...DEFAULT_GPU, ...manifest.gpu } : null;
    this.capMs = capMs;
    this.log = log;
    const base = join(resolve(lab ?? manifest.lab), 'stress');
    this.root = join(base, label);
    this.paths = { results: join(this.root, 'results.json'), stop: join(this.root, 'STOP'), log: join(this.root, 'stress.log'), pid: join(base, 'harness.pid'),
      projects: join(this.root, 'projects'), runs: join(this.root, 'runs'), data: join(base, 'data'), tmp: join(base, 'tmp') };
  }

  load() {
    this.results = readJson(this.paths.results) ?? { version: 1, label: this.label, created_at: new Date().toISOString(), active_ms: 0, status: 'new', scenarios: {} };
    return this.results;
  }
  save() {
    if (this.sessionStart) this.results.active_ms = this.activeBefore + (Date.now() - this.sessionStart);
    this.results.updated_at = new Date().toISOString();
    writeFileSync(this.paths.results + '.tmp', JSON.stringify(this.results, null, 2) + '\n');
    renameSync(this.paths.results + '.tmp', this.paths.results);
  }
  left() { return minutes(this.manifest.wallClockMinutes) - (this.activeBefore + (Date.now() - this.sessionStart)); }
  stopRequested() { return existsSync(this.paths.stop); }
  halt(reason) { this.results.status = 'stopped'; this.results.stop_reason = reason; this.log(`Stopping: ${reason}.`); return false; }

  profileFor(scenario) {
    return stressProfile(JSON.parse(readFileSync(this.profilePath, 'utf8')), scenarioBudgets(this.manifest, scenario));
  }

  async run() {
    for (const dir of ['projects', 'runs', 'data', 'tmp']) mkdirSync(this.paths[dir], { recursive: true });
    const other = readJson(this.paths.pid);
    if (other && other.pid !== process.pid && alive(other.pid)) throw Error(`Another stress harness is running (pid ${other.pid}, label ${other.label}).`);
    // Refuse a bad profile before any scenario starts.
    for (const scenario of this.scenarios) this.profileFor(scenario);
    writeFileSync(this.paths.pid, JSON.stringify({ pid: process.pid, label: this.label, started_at: new Date().toISOString() }));
    rmSync(this.paths.stop, { force: true });
    this.load();
    this.activeBefore = this.results.active_ms; this.sessionStart = Date.now();
    const profileText = readFileSync(this.profilePath);
    Object.assign(this.results, { status: 'running', stop_reason: null, profile: this.profilePath, profile_sha256: createHash('sha256').update(profileText).digest('hex'), forja: this.forjaBin });
    this.save();
    try {
      for (const scenario of this.scenarios) if (!await this.runScenario(scenario)) return;
      if (this.scenarios.every(s => this.results.scenarios[s.id]?.status === 'done' || this.results.scenarios[s.id]?.status === 'failed')) {
        this.results.status = 'done'; this.results.finished_at = new Date().toISOString();
      }
      this.results.summary = summarize(this.results, this.manifest.scenarios);
      this.log(`Stress run ${this.label}: ${JSON.stringify(this.results.summary)}`);
    } finally {
      if (this.results.status === 'running') this.results.status = 'stopped';
      this.save();
      if (readJson(this.paths.pid)?.pid === process.pid) rmSync(this.paths.pid, { force: true });
    }
  }

  // Returns false when the harness must stop (cap, stop request or GPU wait limit).
  async runScenario(scenario) {
    let record = this.results.scenarios[scenario.id];
    if (record?.status === 'done' || record?.status === 'failed') return true;
    if (this.stopRequested()) return this.halt('stop requested');
    if (this.left() < minutes(5)) return this.halt('wall-clock cap reached');
    const profile = this.profileFor(scenario);
    const gpu = await this.waitForGpu(profileModels(profile));
    if (!gpu) return this.halt(this.stopRequested() ? 'stop requested' : 'GPU busy too long');
    record ??= { id: scenario.id, category: scenario.category, kind: scenario.kind, tries: 0 };
    this.results.scenarios[scenario.id] = record;
    // A scenario interrupted by a crash restarts on a fresh copy, once.
    if (++record.tries > 2) { Object.assign(record, { status: 'failed', error: 'interrupted twice' }); this.save(); return true; }
    record.status = 'running'; record.started_at = new Date().toISOString(); record.gpu = gpu; this.save();
    try {
      Object.assign(record, await this.execute(scenario, profile, record.tries));
      record.status = 'done';
    } catch (error) {
      Object.assign(record, { status: 'failed', error: error.message.slice(0, 300) });
    }
    record.finished_at = new Date().toISOString();
    this.save();
    this.log(`${scenario.id}: ${record.outcome ?? record.status}, acceptance ${record.acceptance?.passed ? 'pass' : 'fail'}, ${Math.round((record.duration_ms ?? 0) / 1000)} s, ${record.sessions ?? 0} sessions`);
    return true;
  }

  async execute(scenario, profile, tries) {
    const project = join(this.paths.projects, scenario.id), evidence = join(this.paths.runs, `${scenario.id}-${tries}`);
    materialize(scenario, project);
    rmSync(evidence, { recursive: true, force: true });
    mkdirSync(evidence, { recursive: true });
    const profilePath = join(evidence, 'profile.json'), goalPath = join(evidence, 'goal.txt');
    writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n');
    writeFileSync(goalPath, scenario.goal);
    const capMs = this.capMs ?? Math.max(60_000, Math.min(minutes(scenarioBudgets(this.manifest, scenario).runMinutes), this.left() - minutes(2)));
    const env = { ...process.env, FORJA_DATA_DIR: this.paths.data, FORJA_NTFY_TOPIC: '', TEMP: this.paths.tmp, TMP: this.paths.tmp, TMPDIR: this.paths.tmp };
    for (const name of CLOUD_ENV) delete env[name];
    delete env.NODE_TEST_CONTEXT;
    const args = [this.forjaBin, 'start', '--provider', profile.routes.develop.provider, '--project', project, '--config', profilePath, '--goal-file', goalPath];
    const out = openSync(join(evidence, 'forja.log'), 'w');
    const started = Date.now();
    const result = await new Promise(done => {
      const child = spawn(process.execPath, args, { cwd: project, stdio: ['ignore', out, out], windowsHide: true, env });
      let capped = false;
      const timer = setTimeout(() => { capped = true; kill(child.pid); }, capMs);
      child.on('exit', code => { clearTimeout(timer); done({ code, capped }); });
      child.on('error', error => { clearTimeout(timer); done({ code: -1, capped, error: error.message }); });
    });
    const duration_ms = Date.now() - started;
    const runDir = latestRun(project), state = runDir ? readJson(join(runDir, 'state.json')) : null;
    const totals = ledgerTotals(runDir);
    const acceptance = this.judge(scenario, project, evidence);
    const git = (...a) => spawnSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: project, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
    git('add', '-A', '--', '.', ':(exclude).forja');
    writeFileSync(join(evidence, 'change.diff'), (git('diff', '--cached', 'HEAD').stdout ?? '').slice(0, 256 * 1024));
    const stat = git('diff', '--cached', '--numstat', 'HEAD').stdout?.trim().split('\n').filter(Boolean) ?? [];
    const tail = readFileSync(join(evidence, 'forja.log'), 'utf8').trim().split('\n').slice(-3).join(' | ');
    const outcome = outcomeOf({ capped: result.capped, state });
    return {
      outcome, project, evidence, run_id: state?.run_id ?? null, run_status: state?.status ?? null, stop_code: state?.stopCode ?? null, exit_code: result.code, capped: result.capped, cap_minutes: Math.round(capMs / 60000),
      duration_ms, ...totals, acceptance, files_changed: stat.length, tasks: Array.isArray(state?.tasks) ? state.tasks.length : null,
      failure: outcome === 'done' ? null : result.capped ? `harness cap of ${Math.round(capMs / 60000)} min reached` : (tail.match(/FORJA (blocked|failed)[^|]*/)?.[0] ?? state?.stopCode ?? result.error ?? `exit ${result.code}`).slice(0, 300),
    };
  }

  // The hidden acceptance check runs from this repository against the project.
  judge(scenario, project, evidence) {
    const { NODE_TEST_CONTEXT, ...inherited } = process.env;
    const out = spawnSync(process.execPath, ['--test', acceptanceFile(scenario)], { cwd: REPO, env: { ...inherited, STRESS_PROJECT: project, TEMP: this.paths.tmp, TMP: this.paths.tmp, TMPDIR: this.paths.tmp }, encoding: 'utf8', windowsHide: true, timeout: 180_000 });
    const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
    writeFileSync(join(evidence, 'acceptance.log'), text);
    return { passed: out.status === 0, pass: testCount(text, 'pass'), fail: testCount(text, 'fail') };
  }

  // Waits while another process uses the GPU heavily or another Ollama model is loaded.
  async waitForGpu(models) {
    if (!this.gpu) return { waited_ms: 0, gpu: 'not checked' };
    const started = Date.now(), ours = new Set(models);
    for (;;) {
      let ps = [];
      try { ps = (await ollama('/api/ps')).models ?? []; } catch (error) { this.log(`Ollama /api/ps failed: ${error.message}`); }
      const samples = [];
      for (let i = 0; i < 3; i++) { samples.push(nvidiaSample()); if (i < 2) await sleep(2000); }
      const utilization = samples[0].utilization === null ? null : samples.map(s => s.utilization).sort((a, b) => a - b)[1];
      const verdict = gpuVerdict({ utilization, memoryUsedMiB: Math.max(...samples.map(s => s.memoryUsedMiB ?? 0)), ollamaMiB: ps.reduce((n, m) => n + (m.size_vram ?? 0), 0) / 2 ** 20,
        foreignModels: ps.map(m => m.name).filter(name => !ours.has(name)) }, this.gpu);
      if (!verdict.busy) return { waited_ms: Date.now() - started, gpu: verdict.reason };
      if (Date.now() - started > minutes(this.gpu.maxWaitMinutes) || this.left() < minutes(5) || this.stopRequested()) return null;
      this.log(`GPU busy (${verdict.reason}); waiting.`);
      await sleep(this.gpu.pollSeconds * 1000);
      this.save();
    }
  }
}

async function main(argv) {
  const opt = parseArgs(argv);
  if (opt.command === 'help') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const manifest = validManifest(loadManifest());
  const harness = new Harness(manifest, { lab: opt.lab, label: opt.label, profilePath: opt.profile, only: opt.only });
  if (opt.command === 'plan') {
    console.log(JSON.stringify({ results: harness.paths.results, wall_clock_minutes: manifest.wallClockMinutes, profile: harness.profilePath,
      scenarios: harness.scenarios.map(s => ({ id: s.id, category: s.category, kind: s.kind, budgets: scenarioBudgets(manifest, s) })),
      derived_profile: harness.profileFor(harness.scenarios[0]) }, null, 2));
  } else if (opt.command === 'status') {
    const results = harness.load(), running = readJson(harness.paths.pid);
    console.log(JSON.stringify({ status: results.status, stop_reason: results.stop_reason ?? null, alive: !!running && running.label === harness.label && alive(running.pid), active_minutes: Math.round(results.active_ms / 60000),
      scenarios: harness.scenarios.map(s => { const r = results.scenarios[s.id]; return `${s.id} ${r?.status ?? 'pending'}${r?.outcome ? ` ${r.outcome}` : ''}${r?.acceptance ? ` acceptance=${r.acceptance.passed}` : ''}${r?.failure ? ` (${r.failure})` : r?.error ? ` (${r.error})` : ''}`; }),
      summary: summarize(results, manifest.scenarios) }, null, 2));
  } else if (opt.command === 'export') {
    const out = resultsFile(harness.label);
    const exported = exportResults(harness.load(), manifest, readJson(out), resolve(opt.lab ?? manifest.lab));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(exported, null, 2) + '\n');
    console.log(JSON.stringify({ written: relative(REPO, out).replace(/\\/g, '/'), summary: exported.summary, unjudged: exported.scenarios.filter(r => !r.judgement).map(r => r.id) }));
  } else if (opt.command === 'stop') {
    mkdirSync(harness.root, { recursive: true }); writeFileSync(harness.paths.stop, new Date().toISOString());
    console.log('Stop requested: the harness stops after the current scenario; run resumes it.');
  } else if (opt.detach) {
    mkdirSync(harness.root, { recursive: true });
    const log = openSync(harness.paths.log, 'a');
    const rest = argv.slice(1).filter(a => a !== '--detach');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', ...rest], { cwd: REPO, detached: true, stdio: ['ignore', log, log], windowsHide: true });
    child.unref();
    console.log(JSON.stringify({ pid: child.pid, log: harness.paths.log, results: harness.paths.results }));
  } else await harness.run();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2)).catch(error => {
  console.error(`stress-run: ${error.message}`);
  process.exitCode = 2;
});
