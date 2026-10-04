#!/usr/bin/env node
// FORJA CLI. Run from the PROJECT root: node "<forja>/bin/forja.mjs" <command> [...]
// FORJA Core (`start`, `core ...`, lib/core/engine.mjs) is the only workflow.
// The other commands run the monitoring around it: the viewer, the tunnel, the
// guard, autostart and the project registry.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { forjaRoot } from '../lib/state-files.mjs';

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
function fail(msg, code = 2) { console.error(`forja: ${msg}`); process.exit(code); }

// legacy-references:allow-begin
// The legacy crew workflow was removed in 0.22.0 (docs/LEGACY-REMOVAL.md). Its
// commands are refused before any other module is loaded or any file is
// touched, and each refusal names the Core command to use instead.
const PROFILE = 'a Core profile: `forja start --config <profile.json>`, checked with `forja core doctor --config <profile.json>`';
const SPONSOR = '`forja core status` and the viewer /core panel, which show a pending Sponsor decision; answer it with `forja core decide`';
const OBSERVE = '`forja core status`, `forja core usage`, `forja core evidence` or the viewer /core panel';
const REMOVED_COMMANDS = {
  run: '`forja start --goal "..." --provider claude|codex|kilo` for a new run; `forja core resume`, `forja core status`, `forja core abandon --why "..."` or `forja core stop` for the current one',
  task: 'the Core planner and controller own the tasks: `forja core status` to inspect them, `forja core retry --task T1 --why "..."` (add `--reopen` for an approved task) to retry one',
  runner: '`forja start --goal "..." --provider claude|codex|kilo` for a new run, `forja core resume` to continue one',
  forjalvl: PROFILE,
  models: PROFILE,
  autonomy: 'Core budgets and the profile (`forja start --config <profile.json>`); paid choices always reach the Sponsor as a pending decision in `forja core status`',
  decide: '`forja core decide --run <id> --decision <D> --option <id> --why "..."` for a Sponsor technology choice; other decisions belong in the project\'s own docs',
  decisions: '`forja core status` for the run; the decisions log is a plain project file with nothing to run',
  technology: '`forja core decide`, which records Core technology choices in the run state',
  obsidian: '`forja core status` for the run; Obsidian is an optional human interface, not a FORJA step',
  ask: SPONSOR,
  answers: SPONSOR,
  fallback: 'the provider and model per phase in the Core profile (`--config`), and `forja core retry` after a provider failure',
  progress: OBSERVE,
  report: OBSERVE,
  notify: '`forja core status`; Core sends its notifications (ntfy) by itself',
  status: '`forja core status`',
  context: '`forja core context --query "..."`',
  resume: '`forja core resume`',
};
const removedCommandMessage = cmd =>
  `\`${cmd}\` was removed in 0.22.0 with the legacy crew workflow. Use instead: ${REMOVED_COMMANDS[cmd]}. See \`forja core --help\` for every Core command.`;
// legacy-references:allow-end

// ---------- delegated commands ----------
async function delegate(mod, fn, args) {
  const path = join(forjaRoot, 'lib', mod);
  if (!existsSync(path)) fail(`${fn}: module ${mod} is missing`);
  const m = await import(`file://${path.replace(/\\/g, '/')}`);
  return m[fn](args);
}

const usage = `FORJA core (docs/CORE-RUNBOOK.md)
  start --goal "..." | --goal-file <path> --provider claude|codex|kilo [--project <repo>] [--allow-dirty] [--config <json>] [--plan <json>]
    (--goal-file reads the goal as UTF-8 from a path relative to the current folder; use it for long goals or goals with double quotes, which Windows PowerShell 5.1 cuts)
  core init | core doctor [--provider claude|codex|kilo] [--config file] | core resume | core status | core usage [--details]
  core deliver [--retry | --approve-production <reviewed-commit-sha>]
  core diagnose [--invocation ID] [--phase plan|develop|review]  (read-only execution metadata; no provider calls; ID 1..200; filters combine with AND)
  core evidence [--run ID]  (read-only model/effort evidence for the current or an archived run; no model ranking or automatic changes)
  core evaluation-plan --runs ID,ID  (read-only triage of 1..10 explicit archived runs; prepares a comparison protocol, never executes it)
  core benchmark --config file  (executes a bounded comparison through Claude; explicit profiles/budgets and bubblewrap required; private artifacts outside project)
  core context --query "..."  (selected project knowledge with source references)
  core decide --run ID --decision D --option ID --why "..."  (records an explicit Sponsor technology choice for a pending decision)
  core retry --task T1 --why "..." [--max-attempts 3] [--max-sessions 40]
  core retry --task T1 --reopen --why "..."   (reopen an approved task after a defect is found)
  core retry --task T1 --checks-file <json> --why "..." [--validate-only]
    (replace the checks of an unfinished task, for example one that writes project files, with read-only checks: a UTF-8 JSON array of {"command","args"}; validated like a new plan; final checks stay; old and new checks go to recovery.jsonl)
  core abandon --why "..."
  core stop [--after-task]  (asks the running controller to stop at the next invocation boundary, or after the current task; never kills a live worker; core resume continues)
  Budgets: --max-sessions 30 --max-cloud-sessions N --max-attempts 2 --max-minutes 30 --max-rotations 2 --max-context-tokens 120000 --provider-retries 1 --check-timeout-minutes N
    (--provider-retries 0|1: automatic fresh develop sessions per implementation attempt after a provider output-budget failure; 0 blocks at once)
    (--check-timeout-minutes 1..180: per-check timeout; default the smaller of --max-minutes and 10; a check killed by it blocks with check_timeout, spends no attempt, and core resume --check-timeout-minutes N runs the checks again)
  --help or -h on start and any core command prints this text and changes nothing. start, resume, retry, abandon, stop, deliver, decide and init refuse unknown flags and extra arguments before any effect.

Monitoring:
  serve | up [--port N] [--no-tunnel] | down | token rotate | autostart install|remove
    (serve runs the viewer; open /core for Core runs. up runs the viewer behind a free tunnel and supervises both; autostart starts up and the guard at logon)
  guard [run] [--poll-ms 60000] | guard stop | guard status
    (relaunches a Core controller that died while its run was running: 3 tries, 15 min apart; \`forja guard\` alone is \`guard run\` and keeps running; status only simulates)
  projects list | projects prune   (registered projects with their folder and Core run; prune drops the ones whose folder is gone)
  bootstrap <repo> [--dry-run]   (prepares a repository for Core, as \`forja core init\` does there, and registers it)`;

async function main() {
  const { pos, opt } = parse(process.argv.slice(2));
  const [cmd, sub, ...rest] = pos;
  // `Object.hasOwn`, never a truthiness test on the lookup: `toString` and the
  // rest of Object.prototype are unknown commands, not removed ones.
  if (cmd !== undefined && Object.hasOwn(REMOVED_COMMANDS, cmd)) fail(removedCommandMessage(cmd));
  try {
    switch (cmd) {
      // Every positional goes through, so `--help`, `-h` and stray words
      // (a goal split by shell quoting) reach the engine's checks.
      case 'start': return await delegate('core/engine.mjs', 'core', { pos, opt, usage });
      case 'core': return await delegate('core/engine.mjs', 'core', { pos: pos.slice(1), opt, usage });
      case 'serve': return await delegate('serve.mjs', 'serve', { opt });
      case 'up': return await delegate('up.mjs', 'up', { opt });
      case 'down': return await delegate('up.mjs', 'down', { opt });
      case 'token': return await delegate('serve.mjs', 'token', { pos: [sub, ...rest], opt });
      case 'autostart': return await delegate('up.mjs', 'autostart', { pos: [sub, ...rest], opt });
      case 'guard': return await delegate('guard.mjs', 'guard', { pos: [sub, ...rest], opt });
      case 'bootstrap': return await delegate('bootstrap.mjs', 'bootstrap', { pos: [sub, ...rest], opt });
      case 'projects': return await delegate('projects.mjs', 'projects', { pos: [sub, ...rest], opt });
      default: console.log(usage); process.exit(cmd ? 2 : 0);
    }
  } catch (err) {
    // A known refusal (Error with a message) is shown as one sentence; only
    // an unexpected failure gets the stack, so the Sponsor never sees frames
    // for a plain "not valid JSON".
    const known = err instanceof Error && err.message && !/^(TypeError|ReferenceError|RangeError|SyntaxError)/.test(String(err.name));
    fail(known ? err.message : String(err && err.stack || err), 1);
  }
}
main();
