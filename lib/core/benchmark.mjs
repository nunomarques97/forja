import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { git } from './files.mjs';
import { readMetadata } from './diagnose.mjs';
import { isolatedCheck, preflightCheckIsolation, validateCheckIsolation } from './check-isolation.mjs';
import { benchmarkAccess, benchmarkCall } from './benchmark-provider.mjs';
import { normalizedUsage } from './metrics.mjs';
import { tasks, oracle, reviewCases, creativeRubric } from './benchmark-fixtures.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 4096) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const known = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const invalid = () => Error('Invalid benchmark configuration.');
export function benchmarkConfig(value) {
  if (!known(value, ['version', 'baseline', 'candidate', 'tasks', 'repetitions', 'maxCalls', 'maxDurationMs', 'timeoutMs', 'checkIsolation']) || value.version !== 1) throw invalid();
  for (const profile of [value.baseline, value.candidate]) {
    if (!known(profile, ['model', 'effort']) || !text(profile.model, 80) || profile.model !== profile.model.trim() || !/^claude-[a-z0-9-]+$/.test(profile.model) ||
        !['low', 'medium', 'high', 'max'].includes(profile.effort)) throw invalid();
  }
  if (value.baseline.model === value.candidate.model && value.baseline.effort === value.candidate.effort) throw invalid();
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > 3 ||
      Array.from(value.tasks).some(t => !Object.hasOwn(tasks, t)) || new Set(value.tasks).size !== value.tasks.length ||
      !integer(value.repetitions, 3, 5) || !integer(value.timeoutMs, 1000, 180000) ||
      !integer(value.maxCalls, 6, 30) || value.maxCalls < value.tasks.length * value.repetitions * 2 ||
      !integer(value.maxDurationMs, value.timeoutMs, 1800000)) throw invalid();
  try { if (!validateCheckIsolation(value)) throw invalid(); } catch { throw invalid(); }
  return JSON.parse(JSON.stringify(value));
}
export function loadBenchmarkConfig(path) {
  if (!text(path, 4096)) throw invalid();
  const absolute = resolve(path), value = readMetadata(dirname(absolute), basename(absolute), { left: 65536 }, 65536);
  try { return benchmarkConfig(JSON.parse(value.text)); } catch { throw invalid(); }
}
export function benchmarkSchedule(config) {
  const calls = [];
  for (let repeat = 1; repeat <= config.repetitions; repeat++) {
    for (const task of config.tasks) {
      for (const profile of repeat % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline'])
        calls.push({ id: calls.length + 1, repeat, task, profile });
    }
  }
  return calls;
}
const sources = ['benchmark.mjs', 'benchmark-fixtures.mjs', 'benchmark-provider.mjs', 'providers.mjs', 'worker-access.mjs', 'provider-trace.mjs', 'metrics.mjs', 'files.mjs', 'check-isolation.mjs', 'check-runner.py'];
function sourceHashes() {
  return Object.fromEntries(sources.map(name => [name, hash(readFileSync(fileURLToPath(new URL(name, import.meta.url))))]));
}
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

// Generated source only runs in the existing OS-isolated check backend. No
// eval, VM, host execution or silent fallback. Each check gets a new checkout.
export async function benchmarkOracle(source, directory, config, check = isolatedCheck) {
  mkdirSync(directory);
  git(directory, ['init', '-q']);
  writeFileSync(join(directory, 'candidate.py'), source, { flag: 'wx' });
  writeFileSync(join(directory, 'oracle.py'), oracle, { flag: 'wx' });
  const r = await check('/usr/bin/python3', ['-I', '-B', '-c', "import sys; sys.path.insert(0, '.'); import oracle"],
    { cwd: directory, config, timeoutMs: 5000 });
  return { passed: r.code === 0 && !r.timedOut && !r.overflow && r.stdout?.trim() === 'FORJA_ORACLE_PASS_V1',
    code: r.code, timed_out: r.timedOut, overflow: r.overflow };
}
async function grade(task, value, directory, config, check) {
  if (task === 'implement') {
    if (!known(value, ['source', 'explanation']) || !text(value.source, 32768) || !text(value.explanation)) return { status: 'fail', reason: 'invalid_response' };
    const result = await benchmarkOracle(value.source, directory, config, check);
    return { status: result.passed ? 'pass' : 'fail', reason: 'independent_oracle', ...result };
  }
  if (task === 'review') {
    if (!known(value, ['verdicts']) || !Array.isArray(value.verdicts) || value.verdicts.length !== reviewCases.length ||
        Array.from(value.verdicts).some(v => !known(v, ['id', 'approve', 'reason']) || !reviewCases.some(c => c.id === v.id) || typeof v.approve !== 'boolean' || !text(v.reason)) ||
        new Set(value.verdicts.map(v => v.id)).size !== reviewCases.length) return { status: 'fail', reason: 'invalid_response' };
    const falseApprovals = reviewCases.filter(c => !c.valid && value.verdicts.find(v => v.id === c.id).approve).length;
    const falseRejections = reviewCases.filter(c => c.valid && !value.verdicts.find(v => v.id === c.id).approve).length;
    return { status: falseApprovals || falseRejections ? 'fail' : 'pass', false_approvals: falseApprovals, false_rejections: falseRejections };
  }
  const directionKeys = Object.keys(tasks.plan.schema.properties.directions.items.properties);
  const decisionKeys = Object.keys(tasks.plan.schema.properties.decision.properties);
  if (!known(value, ['directions', 'decision']) || !Array.isArray(value.directions) || value.directions.length !== 3 ||
      Array.from(value.directions).some(d => !known(d, directionKeys) || directionKeys.some(k => !text(d[k]))) ||
      !known(value.decision, decisionKeys) || decisionKeys.some(k => !text(value.decision[k]))) return { status: 'fail', reason: 'invalid_response' };
  return { status: 'manual_review_required', reason: 'structure_complete_not_creative_quality' };
}

export function benchmarkDecision(config, attempts, { complete, mode }) {
  const scope = [...config.tasks];
  const insufficient = reason => ({ recommendation: 'insufficient_evidence', reason, scope });
  const schedule = benchmarkSchedule(config);
  if (!complete || attempts.length !== schedule.length || schedule.some((slot, i) => Object.keys(slot).some(k => slot[k] !== attempts[i]?.[k]))) return insufficient('incomplete_schedule');
  if (mode !== 'native') return insufficient('simulated_execution');
  if (attempts.some(a => a.execution !== 'returned' || !a.identity_confirmed || a.duration_ms === null || a.input_tokens === null || a.output_tokens === null)) return insufficient('execution_identity_or_measurement_gap');
  if (config.tasks.includes('plan')) return insufficient('creative_assessment_required');
  if (attempts.some(a => !['pass', 'fail'].includes(a.grade?.status))) return insufficient('ungraded_result');
  const baselinePass = attempts.filter(a => a.profile === 'baseline').every(a => a.grade.status === 'pass');
  const candidatePass = attempts.filter(a => a.profile === 'candidate').every(a => a.grade.status === 'pass');
  if (baselinePass) return { recommendation: 'retain_baseline', reason: candidatePass ? 'no_observed_correctness_advantage' : 'candidate_failed_checks', scope };
  if (candidatePass) return { recommendation: 'propose_profile_change', reason: 'candidate_passed_all_selected_checks_baseline_did_not', scope };
  return insufficient('both_profiles_failed_checks');
}

export async function runBenchmark(raw, {
  providerCall = benchmarkCall, accessCheck = benchmarkAccess, check = isolatedCheck,
  isolationCheck = preflightCheckIsolation, onProgress = () => {},
} = {}) {
  const config = benchmarkConfig(raw), schedule = benchmarkSchedule(config);
  const mode = providerCall === benchmarkCall && accessCheck === benchmarkAccess && check === isolatedCheck && isolationCheck === preflightCheckIsolation ? 'native' : 'simulated';
  // Preflight has no model calls and no project state access.
  await isolationCheck(config);
  const access = await accessCheck();
  const directory = mkdtempSync(join(tmpdir(), 'forja-benchmark-'));
  const frozen = { version: 1, suite: 'bounded-model-comparison-v1', mode, config, schedule,
    node: process.version, provider: access, source_hashes: sourceHashes(),
    tasks: Object.fromEntries(config.tasks.map(t => [t, tasks[t]])), oracle, review_cases: reviewCases, creative_rubric: creativeRubric,
    stopping: 'No retries. Stop on execution/access/quota/tool/identity failure or elapsed budget. Keep incorrect responses and continue the frozen schedule.',
    decision: 'Quality first. All selected checks must pass for a candidate proposal; creative work requires blind assessment. Ties retain baseline. No automatic profile changes.',
  };
  const serialized = JSON.stringify(frozen, null, 2) + '\n', digest = hash(serialized);
  writeFileSync(join(directory, 'protocol.json'), serialized, { flag: 'wx', mode: 0o600 });
  const attempts = [], controls = [];
  let stop = null;
  const started = performance.now();
  const intact = () => hash(readFileSync(join(directory, 'protocol.json'))) === digest && JSON.stringify(sourceHashes()) === JSON.stringify(frozen.source_hashes);
  const report = complete => ({ version: 1, directory, protocol_sha256: digest, mode,
    status: complete ? 'complete' : 'incomplete', stop_reason: stop, scheduled: schedule.length, attempts, controls,
    decision: benchmarkDecision(config, attempts, { complete, mode }),
    limitations: 'Small fixed synthetic suite, not a general model ranking or statistical proof. Review controls contain related variants. Creative grading remains pending. Time/tokens are observations, not subscription charges. No profile or project state changed. Evidence is private and retained in the returned temporary directory.',
  });
  const persist = complete => writeFileSync(join(directory, 'report.json'), JSON.stringify(report(complete), null, 2) + '\n', { mode: 0o600 });
  persist(false);
  try {
    for (const c of reviewCases) {
      const result = await benchmarkOracle(c.source, join(directory, 'control-' + c.id), config, check);
      controls.push({ id: c.id, expected_pass: c.valid, ...result });
      if (result.passed !== c.valid || result.timed_out || result.overflow) { stop = 'oracle_controls_failed'; break; }
    }
    for (const slot of stop ? [] : schedule) {
      if (performance.now() - started + config.timeoutMs > config.maxDurationMs) { stop = 'elapsed_budget'; break; }
      if (!intact()) { stop = 'frozen_input_changed'; break; }
      const folder = join(directory, 'call-' + slot.id); mkdirSync(folder);
      const cwd = join(folder, 'workspace'); mkdirSync(cwd);
      const task = tasks[slot.task], profile = config[slot.profile];
      save(join(folder, 'schema.json'), task.schema);
      save(join(folder, 'mcp.json'), { mcpServers: {} });
      writeFileSync(join(folder, 'prompt.txt'), task.prompt, { flag: 'wx' });
      save(join(folder, 'started.json'), { ...slot, protocol_sha256: digest, at: new Date().toISOString() });
      onProgress({ event: 'started', ...slot });
      let value;
      try {
        value = await providerCall({ cwd, input: task.prompt, ...profile, schemaPath: join(folder, 'schema.json'), mcpPath: join(folder, 'mcp.json'),
          resultPath: join(folder, 'provider-result.json'), logPath: join(folder, 'native.json'), tracePath: join(folder, 'events.jsonl'), timeoutMs: config.timeoutMs }, access);
      } catch { value = { code: -1, error: true }; }
      save(join(folder, 'response.json'), value.result ?? null);
      const usage = normalizedUsage({ provider: 'claude', usage: value.usage });
      const execution = value.benchmark?.unauthorized_tools ? 'unauthorized_tools' : value.rate_limited ? 'provider_limit' : value.contextExceeded ? 'context_limit' :
        value.timedOut ? 'timeout' : value.overflow ? 'output_limit' : value.code !== 0 || value.error ? 'provider_error' : 'returned';
      const attempt = { ...slot, execution, identity_confirmed: value.reported_model === profile.model,
        duration_ms: integer(value.duration_ms, 0, Number.MAX_SAFE_INTEGER) ? value.duration_ms : null, input_tokens: usage.input, output_tokens: usage.output,
        quota_observed: value.benchmark?.quota_observed === true,
        grade: null };
      attempts.push(attempt);
      try {
        if (execution === 'returned') attempt.grade = await grade(slot.task, value.result, join(folder, 'grade'), config, check);
      } catch { attempt.grade = { status: 'unavailable', reason: 'check_infrastructure_failure' }; stop = 'check_infrastructure_failure'; }
      save(join(folder, 'assessment.json'), attempt);
      appendFileSync(join(directory, 'attempts.jsonl'), JSON.stringify(attempt) + '\n');
      if (execution !== 'returned') stop = execution;
      else if (!attempt.identity_confirmed) stop = 'unconfirmed_model_identity';
      else if (value.benchmark?.stop_for_quota) stop = 'quota_guard';
      if (!intact()) stop = 'frozen_input_changed';
      else if (performance.now() - started > config.maxDurationMs) stop = 'elapsed_budget';
      persist(false);
      onProgress({ event: 'completed', ...attempt });
      if (stop) break;
    }
  } catch { stop = 'controller_or_check_failure'; }
  const complete = !stop && attempts.length === schedule.length;
  persist(complete);
  return report(complete);
}
