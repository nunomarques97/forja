#!/usr/bin/env node
// `node tools/efficiency-bench.mjs [--json] [--fixture <name>]`
// `node tools/efficiency-bench.mjs live <command>`: the live A/B through local
// Ollama models (tools/efficiency-live.mjs), the only part that calls a model.
//
// Offline, deterministic benchmark of the controller's deterministic parts.
// No model is called: every run uses the `custom` provider with a scripted
// provider function, inside throwaway Git projects in the OS temp directory.
//
//   packets    packet() for every task and phase at the worker limit and at
//              tighter limits: size per source, trimming order, mandatory
//              overflow, knowledge selection and task_scope size.
//   scenarios  whole drive() runs with scripted results (happy path, review
//              rejection, failing check, context rotation, output retry):
//              sessions per phase, submitted prompt characters, packet
//              characters and the context repeated across invocations,
//              measured with the same promptParts() as the real-run audit.
//   decisions  providerRetryDecision() and exhaustedRotations() over a fixed
//              matrix, as a guard that retry/rotation policy changes show up.
//
// Prompt text is normalized before measuring (temp root, run ID, timestamps
// and durations), so the numbers are the same on every run and machine for
// the same source. The final line is a SHA-256 of the metrics.
//
// Everything is exported for test/efficiency-bench.test.mjs; the script only
// runs itself when it is the entry point.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../lib/core/files.mjs';
import { createRun, drive, current } from '../lib/core/engine.mjs';
import { packet, planPacketProblems } from '../lib/core/context.mjs';
import { retrieveKnowledge } from '../lib/core/knowledge.mjs';
import { taskScope } from '../lib/core/task-scope.mjs';
import { PACKET_LIMIT, TASK_PACKET_BUDGET } from '../lib/core/plan-warnings.mjs';
import { providerRetryDecision, exhaustedRotations } from '../lib/core/recovery.mjs';
import { promptParts } from './efficiency-audit.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'efficiency');
export const LIMITS = [PACKET_LIMIT, TASK_PACKET_BUDGET, 24000, 12000];

// ---------- deterministic synthetic text ----------
const VOCABULARY = ('module registry value price cart total format round order queue cache index token check review packet '
  + 'scope task plan budget limit route session context source build parse render store fetch event handler worker file path '
  + 'record field option config default error retry state guard update result report stable shared public private').split(' ');
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function words(count, seed) {
  const next = random(seed), out = [];
  for (let i = 0; i < count; i++) out.push(VOCABULARY[Math.floor(next() * VOCABULARY.length)]);
  return out.join(' ');
}
const prose = (spec) => typeof spec === 'string' ? spec
  : `${spec.title ? `# ${spec.title}\n\n` : ''}${words(spec.words, spec.seed)}.${spec.extra ? ` ${spec.extra}` : ''}\n`;

// A fixture file -> files, goal and plan with solutions.
export function expandFixture(fixture) {
  const files = Object.fromEntries(Object.entries(fixture.files || {}).map(([path, spec]) => [path, prose(spec)]));
  let plan = fixture.plan;
  const g = fixture.generate;
  if (g) {
    for (let i = 0; i < g.padFiles; i++)
      files[`lib/support/helper${String(i).padStart(2, '0')}.mjs`] = `export function helper${i}(value) {\n  return value;\n}\n`;
    for (let i = 0; i < g.notes; i++)
      files[`docs/notes/note${String(i).padStart(2, '0')}.md`] = prose({ title: `Note ${i}`, words: g.noteWords, seed: g.seed * 100 + i });
    const tasks = [];
    for (let i = 0; i < g.modules; i++) {
      const path = `lib/mod${String(i).padStart(2, '0')}.mjs`;
      files[path] = `export const done${i} = false;\n`;
      tasks.push({
        id: `M${i}`,
        title: `Mark module ${i} done and keep the registry consistent`,
        criteria: Array.from({ length: g.criteria }, (_, c) => words(g.criterionWords, g.seed * 1000 + i * 10 + c)),
        files: [path, 'lib/'],
        risks: [], complexity: 'easy', after: i ? [`M${i - 1}`] : [],
        checks: [{ command: 'node', args: ['--input-type=module', '-e', `import {done${i}} from './${path}'; if (done${i} !== true) process.exit(1)`] }],
        solution: { [path]: `export const done${i} = true;\n` },
      });
    }
    plan = { decisions: Array.from({ length: g.decisions }, (_, d) => words(g.decisionWords, g.seed * 7 + d)), tasks };
  }
  const solutions = Object.fromEntries(plan.tasks.map((t) => [t.id, t.solution || {}]));
  // Quality oracle: knowledge paths a task's packet must keep selecting.
  const expectKnowledge = Object.fromEntries(plan.tasks.filter((t) => t.expect_knowledge).map((t) => [t.id, t.expect_knowledge]));
  return {
    name: fixture.name,
    goal: prose(fixture.goal),
    files,
    plan: { decisions: plan.decisions || [], tasks: plan.tasks.map(({ solution, expect_knowledge, ...task }) => task) },
    solutions,
    expectKnowledge,
    scenarios: fixture.scenarios || ['happy'],
    packets: fixture.packets !== false,
  };
}

export function loadFixtures(dir = FIXTURE_DIR, only = null) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((f) => !only || f.name === only)
    .map(expandFixture);
}

// ---------- throwaway projects ----------
function tempProject(fixture) {
  const base = realpathSync(tmpdir());
  const root = mkdtempSync(join(base, 'forja-eff-bench-'));
  for (const [file, text] of Object.entries({ ...fixture.files, '.gitignore': '.forja/\n' })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git(root, ['init', '-q']);
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=FORJA bench', '-c', 'user.email=bench@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  return root;
}
function removeProject(root) {
  const rel = relative(realpathSync(tmpdir()), root);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Refusing to remove a directory outside the OS temp directory.');
  rmSync(root, { recursive: true, force: true });
}

// Variable text that is not a property of the controller: the temp root (in
// every spelling a prompt can carry), run IDs, timestamps and durations.
export function normalize(text, root) {
  let out = String(text);
  const spellings = [root, root.replace(/\\/g, '/'), JSON.stringify(root).slice(1, -1), JSON.stringify(root.replace(/\\/g, '/')).slice(1, -1)];
  for (const s of [...new Set(spellings)].sort((a, b) => b.length - a.length)) out = out.split(s).join('<root>');
  return out
    .replace(/F-\d{13}-[a-f0-9]{6}/g, 'F-0000000000000-000000')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '2000-01-01T00:00:00.000Z')
    .replace(/("duration_ms":)\d+/g, '$10');
}
const hash = (text) => createHash('sha256').update(text).digest('hex');

// ---------- packets ----------
// Sizes per top-level packet key, from the normalized text.
function sourceSizes(text) {
  return Object.fromEntries(Object.entries(JSON.parse(text)).map(([key, value]) => [key, JSON.stringify(value).length]));
}
function measurePacket(root, run, task, phase, limit) {
  try {
    const p = packet({ root, run, task, phase, limit });
    const text = normalize(p.text, root);
    return { characters: text.length, trimmed: p.sources.filter((s) => /^trimmed /.test(s.source)).map((s) => s.source.replace(/^trimmed /, '')) };
  } catch (error) {
    if (!Number.isSafeInteger(error.characters)) throw error;
    return { characters: error.characters, stopped: error.stopCode };
  }
}

export function packetSuite(fixture) {
  const root = tempProject(fixture);
  try {
    createRun(root, { goal: fixture.goal, provider: 'custom', plan: fixture.plan });
    const run = JSON.parse(readFileSync(current(root), 'utf8'));
    const tasks = {};
    for (const task of run.tasks) {
      const develop = normalize(packet({ root, run, task, phase: 'develop' }).text, root);
      const knowledge = retrieveKnowledge(root, `${task.title} ${(task.files || []).join(' ')} ${task.criteria.join(' ')}`);
      const scope = taskScope(run, task);
      tasks[task.id] = {
        develop_characters: develop.length,
        sources: sourceSizes(develop),
        limits: Object.fromEntries(LIMITS.map((limit) => [limit, measurePacket(root, run, task, 'develop', limit)])),
        review_characters: measurePacket(root, run, task, 'review', PACKET_LIMIT).characters,
        knowledge: {
          selected: knowledge.selected.length,
          characters: knowledge.selected.reduce((n, k) => n + k.text.length, 0),
          required: knowledge.selected.filter((k) => k.required).length,
          paths: [...new Set(knowledge.selected.map((k) => k.path))].sort(),
        },
        // Quality probes: the task's own files listed in the repository map,
        // and the fixture's expected knowledge paths still selected.
        quality: {
          map_task_files: (() => {
            const listed = new Set(JSON.parse(develop).repository_map.text.split('\n').map((l) => l.split(' :: ')[0]));
            const own = (task.files || []).filter((f) => f in fixture.files);
            return { listed: own.filter((f) => listed.has(f)).length, files: own.length };
          })(),
          knowledge_expected: (() => {
            const expected = fixture.expectKnowledge?.[task.id] || [];
            const selected = new Set(JSON.parse(develop).knowledge.selected.map((k) => k.path));
            return { selected: expected.filter((p) => selected.has(p)).length, expected: expected.length };
          })(),
        },
        task_scope: {
          characters: JSON.stringify(scope).length,
          remaining: scope.remaining_tasks.length,
          with_criteria: scope.remaining_tasks.filter((t) => 'criteria' in t).length,
          truncated: scope.remaining_tasks.filter((t) => t.criteria_truncated).length,
        },
      };
    }
    const planRun = { ...run, tasks: [], phase: 'plan' };
    const plan = measurePacket(root, planRun, null, 'plan', PACKET_LIMIT);
    const developSizes = Object.values(tasks).map((t) => t.develop_characters);
    const reviewSizes = Object.values(tasks).map((t) => t.review_characters);
    const quality = { map_task_files: { listed: 0, files: 0 }, knowledge_expected: { selected: 0, expected: 0 } };
    for (const t of Object.values(tasks))
      for (const [probe, counts] of Object.entries(t.quality))
        for (const [key, n] of Object.entries(counts)) quality[probe][key] += n;
    return {
      plan_characters: plan.characters,
      develop_characters: { total: developSizes.reduce((a, b) => a + b, 0), max: Math.max(...developSizes) },
      review_characters: { total: reviewSizes.reduce((a, b) => a + b, 0), max: Math.max(...reviewSizes) },
      quality,
      plan_budget_problems: planPacketProblems(root, run, run.tasks, run.decisions).map((p) => p.task),
      tasks,
    };
  } finally {
    removeProject(root);
  }
}

// ---------- scenarios ----------
const reply = (status, summary = 'Outcome') => ({ code: 0, result: { status, summary, findings: status === 'reject' ? ['Fix the reported defect.'] : [] }, duration_ms: 1000 });

// The scripted provider: develop writes the task's solution unless the
// scenario says otherwise on its first develop session; review approves unless
// told to reject once.
function scripted(fixture, scenario, root, seen) {
  const state = { develops: 0, reviews: 0 };
  return async (_, options) => {
    const ctx = JSON.parse(options.text);
    seen.push({ phase: ctx.phase, task: ctx.task?.id ?? null, input: normalize(options.input, root), packet: normalize(options.text, root) });
    const usage = { input_tokens: Math.ceil(options.input.length / 4), cache_creation_input_tokens: 0, cached_input_tokens: 0, output_tokens: 100 };
    if (ctx.phase === 'plan') return { ...reply('done'), result: fixture.plan, usage };
    if (ctx.phase === 'review') {
      state.reviews++;
      return { ...reply(scenario === 'review_reject_once' && state.reviews === 1 ? 'reject' : 'approve'), usage };
    }
    state.develops++;
    const first = state.develops === 1;
    if (first && scenario === 'context_rotation')
      return { code: 1, contextExceeded: true, lastContextTokens: 120001, progressNotes: 'Read the task files; the edit remains.' };
    if (first && scenario === 'output_retry')
      return { code: 1, overflow: true, progressNotes: 'Read the task files; the edit remains.' };
    if (!(first && scenario === 'check_fail_once'))
      for (const [file, text] of Object.entries(fixture.solutions[ctx.task.id] || {})) writeFileSync(join(root, file), text);
    return { ...reply('ready_for_validation'), usage };
  };
}

export async function scenarioRun(fixture, scenario) {
  const root = tempProject(fixture);
  const seen = [];
  try {
    createRun(root, { goal: fixture.goal, provider: 'custom', config: { maxAttempts: 3, maxRotations: 2, maxSessions: 80 } });
    const run = await drive(root, { log: () => {}, providerCall: scripted(fixture, scenario, root, seen) });
    const sessions = {}, prompt = {}, packetChars = {};
    for (const s of seen) {
      sessions[s.phase] = (sessions[s.phase] || 0) + 1;
      prompt[s.phase] = (prompt[s.phase] || 0) + s.input.length;
      packetChars[s.phase] = (packetChars[s.phase] || 0) + s.packet.length;
    }
    // Same measure as the audit: packet keys and instruction lines already
    // sent earlier in this run.
    const seenParts = new Set();
    let characters = 0, repeated = 0;
    for (const s of seen) {
      const { instructions, packet: data } = promptParts(s.input);
      for (const [key, text] of [...instructions.map((l) => ['instructions', l]), ...Object.entries(data || {}).map(([k, v]) => [k, JSON.stringify(v)])]) {
        const digest = hash(`${key}\0${text}`);
        characters += text.length;
        if (seenParts.has(digest)) repeated += text.length;
        seenParts.add(digest);
      }
    }
    return {
      status: run.status,
      stop_code: run.stopCode ?? null,
      sessions,
      invocations: seen.length,
      prompt_characters: prompt,
      prompt_total: Object.values(prompt).reduce((a, b) => a + b, 0),
      packet_characters: packetChars,
      estimated_tokens: Math.ceil(Object.values(prompt).reduce((a, b) => a + b, 0) / 4),
      repeated_characters: repeated,
      repeated_percent: characters ? Math.round((1000 * repeated) / characters) / 10 : null,
      attempts: Object.fromEntries(run.tasks.map((t) => [t.id, t.attempts])),
      rotations: run.tasks.reduce((n, t) => n + (t.rotations || 0), 0),
      provider_retries: run.tasks.reduce((n, t) => n + (t.provider_retries?.total || 0), 0),
      // Check executions: each task's last validation pass, the final
      // regression, and final entries recorded without running the command
      // (by reason). Earlier failed validation passes are not kept in state.
      checks: {
        task_last_pass: run.tasks.reduce((n, t) => n + (t.validation?.length || 0), 0),
        final: run.tasks.reduce((n, t) => n + (t.finalValidation || []).filter((v) => !v.skipped).length, 0),
        skipped: run.tasks.flatMap((t) => (t.finalValidation || []).filter((v) => v.skipped).map((v) => v.skipped))
          .reduce((m, reason) => ({ ...m, [reason]: (m[reason] || 0) + 1 }), {}),
      },
    };
  } finally {
    removeProject(root);
  }
}

// ---------- retry / rotation decisions ----------
export function decisionMatrix() {
  const rows = [];
  for (const phase of ['plan', 'develop', 'review'])
    for (const code of ['output', 'timeout', 'context', 'error'])
      for (const limit of [0, 1])
        for (const used of [0, 1]) {
          const task = { id: 'T1', attempts: 1, provider_retries: used ? { attempt: 1, used, total: used } : undefined };
          rows.push(`${phase}/${code}/limit${limit}/used${used}:${providerRetryDecision({ limits: { providerRetries: limit } }, task, phase, code).retry ? 'retry' : 'stop'}`);
        }
  const rotations = [[2, 1], [2, 2], [2, 3], [0, 1]].map(([limit, used]) => `rotations${limit}/used${used}:${exhaustedRotations({ limits: { rotations: limit } }, { id: 'T1', rotations: used }) ? 'exhausted' : 'ok'}`);
  return { retries: rows.filter((r) => r.endsWith(':retry')).length, cases: rows.length, rotation_cases: rotations };
}

// ---------- runner ----------
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value;

export async function runBench({ only = null } = {}) {
  const fixtures = loadFixtures(FIXTURE_DIR, only);
  const report = { version: 1, limits: LIMITS, fixtures: {}, decisions: decisionMatrix() };
  for (const fixture of fixtures) {
    const scenarios = {};
    for (const scenario of fixture.scenarios) scenarios[scenario] = await scenarioRun(fixture, scenario);
    report.fixtures[fixture.name] = { ...(fixture.packets ? { packets: packetSuite(fixture) } : {}), scenarios };
  }
  const totals = { prompt_characters: 0, invocations: 0, repeated_characters: 0, packet_characters: 0, final_check_runs: 0 };
  for (const f of Object.values(report.fixtures)) {
    if (f.packets) totals.packet_characters += f.packets.plan_characters + f.packets.develop_characters.total + f.packets.review_characters.total;
    for (const s of Object.values(f.scenarios)) {
      totals.prompt_characters += s.prompt_total;
      totals.invocations += s.invocations;
      totals.repeated_characters += s.repeated_characters;
      totals.final_check_runs += s.checks.final;
    }
  }
  report.totals = totals;
  const metrics = stable(report);
  return { metrics, hash: hash(JSON.stringify(metrics)) };
}

function summary({ metrics, hash: digest }) {
  const k = (n) => (n == null ? 'n/a' : n.toLocaleString('en-US'));
  const lines = [];
  for (const [name, f] of Object.entries(metrics.fixtures)) {
    const q = f.packets?.quality;
    if (!q) lines.push(`${name}: scenarios only`);
    else lines.push(`${name}: plan packet ${k(f.packets.plan_characters)} chars, develop packets total ${k(f.packets.develop_characters.total)} (max ${k(f.packets.develop_characters.max)}), review packets total ${k(f.packets.review_characters.total)}; quality: task files in map ${q.map_task_files.listed}/${q.map_task_files.files}, expected knowledge ${q.knowledge_expected.selected}/${q.knowledge_expected.expected}`);
    for (const [scenario, s] of Object.entries(f.scenarios))
      lines.push(`  ${scenario}: ${s.status}, ${k(s.invocations)} sessions (${Object.entries(s.sessions).map(([p, n]) => `${p} ${n}`).join(', ')}), prompt ${k(s.prompt_total)} chars, repeated ${s.repeated_percent}%, checks ${k(s.checks.task_last_pass)} task + ${k(s.checks.final)} final${Object.keys(s.checks.skipped).length ? ` (skipped ${Object.entries(s.checks.skipped).map(([r, n]) => `${r} ${n}`).join(', ')})` : ''}`);
  }
  lines.push(`decisions: ${metrics.decisions.retries}/${metrics.decisions.cases} retry`);
  lines.push(`totals: ${k(metrics.totals.invocations)} sessions, ${k(metrics.totals.prompt_characters)} prompt chars, ${k(metrics.totals.repeated_characters)} repeated, ${k(metrics.totals.packet_characters)} packet-suite chars, ${k(metrics.totals.final_check_runs)} final check runs`);
  lines.push(`metrics sha256 ${digest}`);
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === 'live') {
    import('./efficiency-live.mjs')
      .then((live) => live.main(args.slice(1)))
      .catch((error) => { console.error(`efficiency-live: ${error.message}`); process.exit(2); });
  } else {
    const only = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
    runBench({ only })
      .then((result) => console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : summary(result)))
      .catch((error) => { console.error(`efficiency-bench: ${error.message}`); process.exit(1); });
  }
}
