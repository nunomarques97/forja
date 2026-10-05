#!/usr/bin/env node
// A/B measurement of auto-learning (docs/AUTO-LEARNING.md, Measurement).
//   --dry-run                     print the schedule and the maximum session count; writes nothing
//   --simulate                    whole harness with a scripted provider; no provider calls
//   --confirm-sessions <n>        live mode: real Core runs, n must equal the computed maximum
//   --config <profile.json>       live/dry-run: Core run config (routing, models), without delivery
//   --provider <name>             default claude
//   --out <file>                  results JSON; default in the OS temp directory, never a tracked file
//   --keep                        keep the temp projects for inspection
// Every run happens in its own OS temp directory.
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LESSONS_AB, armConfig, configHash, lessonsAbSchedule, resultsPathProblem, runLessonsAb } from '../lib/core/lessons-eval.mjs';

const VALUE_FLAGS = ['confirm-sessions', 'config', 'provider', 'out'], SWITCHES = ['dry-run', 'simulate', 'keep', 'help'];

export function parseArgs(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (SWITCHES.includes(flag)) opt[flag] = true;
    else if (VALUE_FLAGS.includes(flag) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[flag] = argv[++i];
    else throw Error(`Unknown or incomplete argument ${JSON.stringify(argv[i])}; nothing was run or written.`);
  }
  if (opt['dry-run'] && opt.simulate) throw Error('Use either --dry-run or --simulate.');
  return opt;
}

function profileOf(opt) {
  if (!opt.config) return {};
  try { return JSON.parse(readFileSync(resolve(opt.config), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw Error(`Cannot read the profile ${JSON.stringify(opt.config)}: ${error.message}`); }
}

export function plan(config = LESSONS_AB) {
  return {
    config: config.id,
    config_sha256: configHash(config),
    fixtures: config.fixtures.map(f => ({ id: f.id, pattern: f.pattern, task: f.task.title, prior_runs: f.history.length })),
    arms: config.arms,
    repetitions: config.repetitions,
    session_cap_per_run: config.sessionCapPerRun,
    max_sessions: config.maxTotalSessions,
    verdict_thresholds: config.verdict,
    schedule: lessonsAbSchedule(config),
    live_command: `node tools/lessons-ab.mjs --confirm-sessions ${config.maxTotalSessions} --config <profile.json>`,
  };
}

async function main(argv) {
  const opt = parseArgs(argv);
  if (opt.help) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const provider = opt.provider ?? 'claude', profile = profileOf(opt);
  for (const arm of LESSONS_AB.arms) armConfig(profile, arm);
  if (opt['dry-run']) {
    console.log(JSON.stringify({ mode: 'dry-run', provider, ...plan(), writes: 'nothing' }, null, 2));
    console.log(`Maximum provider sessions: ${LESSONS_AB.maxTotalSessions}.`);
    return;
  }
  const mode = opt.simulate ? 'simulated' : 'live';
  if (mode === 'live' && Number(opt['confirm-sessions']) !== LESSONS_AB.maxTotalSessions)
    throw Error(`Live mode starts up to ${LESSONS_AB.maxTotalSessions} provider sessions. Confirm with --confirm-sessions ${LESSONS_AB.maxTotalSessions} (see --dry-run). Nothing was run or written.`);
  const out = resolve(opt.out ?? join(tmpdir(), `forja-lessons-ab-${mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const problem = resultsPathProblem(out);
  if (problem) throw Error(`${problem} Nothing was run or written.`);
  let first = true;
  const save = value => { writeFileSync(out, JSON.stringify(value, null, 2) + '\n', first ? { flag: 'wx' } : {}); first = false; };
  const result = await runLessonsAb({ mode, provider, profile, keep: !!opt.keep, log: line => console.error(line), onRun: save });
  save(result);
  console.log(JSON.stringify({ mode, results: out, sessions_used: result.sessions_used, max_sessions: result.max_sessions, verdict: result.verdict.verdict, reasons: result.verdict.reasons }, null, 2));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) main(process.argv.slice(2)).catch(error => {
  console.error(`lessons-ab: ${error.message}`);
  process.exitCode = 2;
});
