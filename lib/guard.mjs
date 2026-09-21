// `forja guard [run]|stop|status` — a guarda dos runners (docs/ARCHITECTURE.md §12).
// `forja guard` with no subcommand is `forja guard run`: it starts the long-lived
// process and stays in the foreground until `forja guard stop` or a signal.
//
// Why it exists (incident of 17 set 2026): the runner of the job-hunter project
// died mid-task (pid 3888) and its task stayed `doing` for 52 minutes, because
// nothing relaunches a dead runner. The viewer already notices this (watchdog in
// viewer/server.mjs, `main-dead`) but only notifies — and that day the viewer
// itself had died (SIGHUP at 18:54:21Z), so not even the notification went out.
//
// The guard is a SEPARATE, long-lived process with its own autostart entry: it
// wakes every GUARD_POLL_MS, reads the project registry (data/projects.json) and
// each project's RUN.json, and relaunches `forja runner` where a run is
// `running` and its runner has been dead for longer than the grace period. It
// never touches the viewer, never kills anything, and never writes to
// data/events.jsonl: its evidence is data/guard/guard.log and the `via=guard`
// line the launch leaves in data/runner/spawn.log.
//
// Four rules keep it from making things worse:
//   - a hard cap of GUARD_MAX_ATTEMPTS tries per run, GUARD_RETRY_MS apart. A
//     try that produced a process counts in `attempts`, a spawn that produced no
//     pid counts in `failed_spawns`, and the cap is on the SUM: a launch that
//     never happened never costs a real attempt (that was always the intent),
//     but it is still a try — it waits its 15 min like the others and the third
//     one gives up out loud instead of hammering the machine once a minute;
//   - `blocked` runs are never relaunched (the runner would exit at once — a
//     person has to act);
//   - the counter survives a restart of the guard (it lives in
//     data/guard/state.json) and only resets on evidence: a run_id CONFIRMED
//     different, a status CONFIRMED not `running`, or a runner that stayed alive
//     for GUARD_HEALTHY_MS. A RUN.json that cannot be read this tick (written
//     by tmp+rename since §3c, but still editable by hand) is not evidence of
//     anything and never erases a counter;
//   - only a run whose driver is `runner` (docs/ARCHITECTURE.md §3c) is ever
//     relaunched: a run a conversation conducts, or one whose driver cannot be
//     proven, never gets a runner from the guard.
//
// The decision is a pure function (`guardPlan`) with the clock injected, so
// every rule above is verifiable line by line in test/guard.test.mjs; the action
// layer (`runGuardOnce`) has every side effect injectable (list, spawn, notify,
// log, now) and is tested without spawning a process or touching the network.
//
// Node core only.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, forjaRoot, nowIso } from './state-files.mjs';
import { listProjectsWithStatus, resetAliveCache, safeName } from './projects.mjs';
import { LOCK_STALE_MS, acquireLock, beatLock, readLock, releaseLock } from './runner.mjs';
import { launchRunner, launchForja, launchCore } from './spawn-runner.mjs';
import { notify as defaultNotify } from './notify.mjs';
// Supervisão mútua (docs/ARCHITECTURE.md §12): desde que a guarda também vigia o
// viewer, as regras, as constantes e os predicados de vida são os mesmos dos
// dois lados e vivem uma vez só, em lib/supervise.mjs. O que era daqui
// (GUARD_CMD_RE, guardAlive, guardPaths, phoneUrl) está lá e é reexportado aqui,
// para nada que já importava desta porta ter de mudar.
import {
  PEER_MAX_ATTEMPTS, appendPeerLog, controlPaths, guardAlive, guardPaths, peerPlan, phoneUrl,
  runPeerCheckOnce, safeNotify, upAlive, withClick,
} from './supervise.mjs';
export { GUARD_CMD_RE, guardAlive, guardPaths, phoneUrl } from './supervise.mjs';

// ---------- constants ----------
export const GUARD_POLL_MS = 60_000;        // one pass a minute
export const GUARD_DEAD_GRACE_MS = 120_000; // a runner counts as dead only after this long without a live lock
export const GUARD_RETRY_MS = 900_000;      // minimum spacing between two tries on the same run (= LOCK_STALE_MS)
export const GUARD_MAX_ATTEMPTS = 3;        // tries (relaunches + failed spawns); then the guard gives up and says so, once
export const GUARD_HEALTHY_MS = 1_800_000;  // a runner alive this long without a break clears the counter
export const GUARD_WRAPPER_RETRY_S = 30;    // the autostart wrapper waits this long before restarting the guard after an error
export const GUARD_MIN_POLL_MS = 1000;      // a poll below this is a spin, not a poll: refused on the command line

// ---------- paths ----------
// `guardPaths` (everything the guard owns, under data/guard/) is re-exported
// from lib/supervise.mjs above: the viewer needs the guard's lock and stop file
// to watch it, and one definition of that layout is the whole point.
export const guardConsoleLog = (dir = dataDir()) => join(dir, 'guard', 'guard.console.log');

// ---------- state file ----------
// The project map is keyed by a name from data/projects.json, and `safeName`
// allows `__proto__` (underscores are legal in a folder name). On a plain `{}`,
// `projects['__proto__'] = entry` hits Object.prototype's setter: no own
// property is created, JSON.stringify writes nothing, and that one project
// would silently never have its counter persisted — watched for ever, capped
// never. A prototype-less map has no setter to hit, so every name is just a key.
export const emptyProjects = () => Object.create(null);
// `up` is the viewer's entry, a SIBLING of `projects` and never a key inside it:
// a project may legitimately be called "up", and its counter and the viewer's
// must never be the same slot.
export const EMPTY_STATE = () => ({ version: 1, projects: emptyProjects(), up: {} });
const upEntryOf = raw => (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});

// An unreadable or corrupt state file is an empty state, never a throw: the
// guard must keep going (it would otherwise die on the one tick that matters).
// A file written before the viewer was watched (no `up` key) reads as an empty
// entry — and the next write puts the key there.
export function readGuardState(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch { return EMPTY_STATE(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_STATE();
  const ok = raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects);
  // Object.assign onto a prototype-less target: JSON.parse already puts a
  // "__proto__" key on the parsed object as a normal own property, and this
  // keeps it one.
  return { version: 1, projects: ok ? Object.assign(emptyProjects(), raw.projects) : emptyProjects(), up: upEntryOf(raw.up) };
}

// tmp+rename, same atomicity as writeProjects (lib/projects.mjs): a crash never
// leaves half a state file, and half a state file is a lost attempt counter.
export function writeGuardState(path, state) {
  mkdirSync(join(path, '..'), { recursive: true });
  const body = JSON.stringify({ version: 1, projects: (state && state.projects) || emptyProjects(), up: upEntryOf(state && state.up) }, null, 2) + '\n';
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
  return state;
}

export const appendGuardLog = appendPeerLog;

// ---------- notification texts (status only) ----------
// §10: never a path, never a token — and here also never the run_id and never
// the goal text. The project name goes through safeName, which leaves nothing
// that could read as a path (no slash, no backslash), and the attempt count is
// written "2 de 3" for the same reason.
export const relaunchMessage = (project, n, max = GUARD_MAX_ATTEMPTS) =>
  `Forja: o runner de ${safeName(project)} morreu a meio do run — relancei-o (tentativa ${n} de ${max})`;
export const gaveUpMessage = (project, max = GUARD_MAX_ATTEMPTS) =>
  `Forja: desisti de relançar o runner de ${safeName(project)} — ${max} tentativas seguidas não pegaram; o run está parado e precisa de ti`;

// ---------- pure decision ----------
const msOf = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : null;
};
const isoOf = ms => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  try { return new Date(ms).toISOString(); } catch { return null; }
};
const blank = (runId = null) => ({ run_id: runId, attempts: 0, failed_spawns: 0, dead_since: null, last_attempt_at: null, alive_since: null, gave_up_at: null });
const counter = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, GUARD_MAX_ATTEMPTS) : 0; };

function readEntry(raw) {
  const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    run_id: typeof e.run_id === 'string' ? e.run_id.slice(0, 64) : null,
    attempts: counter(e.attempts),
    // Tries that never became a process (no pid, spawn threw, folder gone).
    // They do not cost an `attempt` — but they are still tries, and they count
    // towards the same cap, or a permanently broken spawn would be retried for
    // ever without anyone ever being told.
    failed_spawns: counter(e.failed_spawns),
    dead_since: msOf(e.dead_since),
    last_attempt_at: msOf(e.last_attempt_at),
    alive_since: msOf(e.alive_since),
    gave_up_at: msOf(e.gave_up_at),
  };
}
const writeEntry = e => ({
  run_id: e.run_id, attempts: e.attempts, failed_spawns: e.failed_spawns || 0, dead_since: isoOf(e.dead_since),
  last_attempt_at: isoOf(e.last_attempt_at), alive_since: isoOf(e.alive_since), gave_up_at: isoOf(e.gave_up_at),
});
// How many tries this dead run has already had: real relaunches plus spawns that
// never produced one. The cap, the "tentativa N de 3" in the notification and
// the give-up all count this, never `attempts` alone.
export const triesOf = e => (e ? counter(e.attempts) + counter(e.failed_spawns) : 0);

const minutes = ms => Math.max(0, Math.round(ms / 60_000));
const seconds = ms => Math.max(0, Math.round(ms / 1000));

// The shape `newRunId` produces (lib/state-files.mjs: `R-20260917-ab12`), as a
// whitelist. The guard is the only thing in Forja that starts a process with
// NOBODY looking: everything else that relaunches a run needs a tap on the phone
// first, and that tap was the last human check on a `run_id` that came off disk.
// A bootstrapped project could carry a committed RUN.json whose run_id holds a
// quote, a space or a control character; downstream that id becomes the session
// `--name` of a `shell: true` command line on Windows (lib/runner.mjs), whose
// quoting does not escape `"`. So the id is validated HERE, at the gate, before
// anything is launched — and a project whose id does not match is simply never
// acted upon (it is not a crash, not a reset, not a notification: just no).
export const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const validRunId = id => typeof id === 'string' && RUN_ID_RE.test(id);

/**
 * Pure: what the guard would do right now. No clock, no I/O.
 *
 * `list` is what `listProjectsWithStatus()` returns:
 *   { name, path, run: { run_id, status, visible, driver } | null, runnerAlive }[]
 * (`driver` already resolved by lib/driver.mjs; only 'runner' is ever relaunched)
 * `state` is the object read from data/guard/state.json.
 *
 * Returns { actions, giveUps, skips, state } where `state` is the next state to
 * write. Neither counter is advanced here: `runGuardOnce` advances `attempts`
 * after a spawn that produced a pid and `failed_spawns` after one that did not,
 * so a launch that never happened never costs a real attempt — but both stamp
 * `last_attempt_at`, which is what keeps the GUARD_RETRY_MS spacing honest for
 * a spawn path that is simply broken. `gave_up_at` IS stamped here, because a
 * give-up is a decision, not a side effect, and it must be announced exactly once.
 */
export function guardPlan(list, state, now) {
  const actions = []; const giveUps = []; const skips = [];
  // Both maps prototype-less: see `emptyProjects`. `prev` too, because a state
  // that came straight from a JSON.parse elsewhere would answer `prev['toString']`
  // with a function instead of undefined.
  const prev = Object.assign(emptyProjects(), (state && state.projects) || undefined);
  const next = { version: 1, projects: emptyProjects() };
  const clock = Number.isFinite(now) ? now : 0;
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || !p.name) continue;
    const name = p.name;
    const run = p.run && typeof p.run === 'object' && !Array.isArray(p.run) ? p.run : null;
    // An id that is not exactly the shape Forja writes is treated as no id at all.
    const runId = run && validRunId(run.run_id) ? run.run_id : null;
    const status = run && typeof run.status === 'string' ? run.status : null;
    const skip = why => skips.push({ name, why });

    let e = readEntry(prev[name]);

    if (!p.path) { skip('sem pasta registada'); next.projects[name] = writeEntry(e); continue; }
    // No run to read THIS TICK is not evidence that the run changed: RUN.json is
    // written with a plain writeFileSync (lib/state-files.mjs), so a read can
    // catch it half-written and come back empty for one pass. Zeroing here would
    // erase two failed attempts, or an alarm already sent, on a read glitch.
    // Nothing is relaunched without a `running` run anyway, so keeping the
    // counter costs nothing and a run_id that is really new still resets it below.
    if (!run) { next.projects[name] = writeEntry(e); skip('sem run legível neste projeto — o contador fica como está'); continue; }
    // A run without an id in the shape Forja writes is unreadable by the same
    // rule as a missing RUN.json: no action, no reset, and the id itself is
    // NEVER echoed into the log or a notification.
    if (runId === null) { next.projects[name] = writeEntry(e); skip('run sem run_id utilizável — não relanço e o contador fica como está'); continue; }
    // Reset (a): a different run_id on disk is a different run — nothing the
    // guard learned about the old one carries over. Only a run_id we could
    // actually read counts as "different".
    if (e.run_id !== runId) e = blank(runId);
    // Reset (b): the run is no longer `running` — finished, failed, blocked or
    // gone. A `blocked` run is never relaunched: the runner would see `blocked`
    // and exit at once, and the relaunch would burn attempts on a wait for a
    // person.
    if (status !== 'running') {
      next.projects[name] = writeEntry(blank(runId));
      skip(status === 'blocked' ? 'run bloqueado — precisa de uma pessoa, a guarda nunca relança' : `run ${status || 'sem estado'}`);
      continue;
    }
    // Who drives the run (lib/driver.mjs, docs/ARCHITECTURE.md §3c). The guard
    // exists to recover a RUNNER that died; a run conducted by a conversation
    // has no runner to recover, and starting one would put a second executor on
    // top of the Lead. `unknown` (a run from before the field, with no runner
    // evidence for this run_id — or a caller that did not resolve it) is never
    // acted upon either: nothing executes on a guess. The counter is kept (it
    // belongs to this run_id), but the death clock is not: if the run is later
    // handed to the runner, the grace period starts from that moment.
    const driver = ['runner', 'interactive', 'core'].includes(run.driver) ? run.driver : 'unknown';
    if (!['runner', 'core'].includes(driver)) {
      e.dead_since = null; e.alive_since = null;
      next.projects[name] = writeEntry(e);
      skip(driver === 'interactive'
        ? 'run conduzido por uma conversa interativa — a guarda nunca lança um runner sobre ele'
        : 'responsável do run desconhecido (sem campo driver nem evidência do runner para este run_id) — não relanço');
      continue;
    }
    if (p.runnerAlive === true) {
      e.dead_since = null;
      // First tick we see it alive after a death (or after a clock that went
      // backwards): stamp the moment the healthy streak started.
      if (e.alive_since === null || e.alive_since > clock) e.alive_since = clock;
      // Reset (c): alive without a break for GUARD_HEALTHY_MS.
      if (clock - e.alive_since >= GUARD_HEALTHY_MS && (triesOf(e) > 0 || e.gave_up_at !== null)) {
        e.attempts = 0; e.failed_spawns = 0; e.last_attempt_at = null; e.gave_up_at = null;
        skip(`runner vivo há ${minutes(clock - e.alive_since)} min — contador a zero`);
      } else skip('runner vivo');
      next.projects[name] = writeEntry(e);
      continue;
    }
    // Dead. `dead_since > clock` is a clock that went backwards: re-stamp it
    // instead of producing a negative age (and never an action out of it).
    e.alive_since = null;
    if (e.dead_since === null || e.dead_since > clock) e.dead_since = clock;
    const deadFor = clock - e.dead_since;
    const sinceAttempt = e.last_attempt_at === null ? null : clock - e.last_attempt_at;
    const tries = triesOf(e);
    if (deadFor < GUARD_DEAD_GRACE_MS) skip(`runner morto há ${seconds(deadFor)}s — dentro da graça de ${seconds(GUARD_DEAD_GRACE_MS)}s`);
    else if (sinceAttempt !== null && sinceAttempt < GUARD_RETRY_MS) skip(`última tentativa há ${minutes(sinceAttempt)} min — espero ${minutes(GUARD_RETRY_MS)} min entre tentativas`);
    else if (tries >= GUARD_MAX_ATTEMPTS) {
      if (e.gave_up_at === null) { e.gave_up_at = clock; giveUps.push({ name, attempts: tries }); }
      else skip(`já desisti deste run (${tries} tentativas)`);
    } else actions.push({ name, path: p.path, visible: run.visible === true, attempt: tries + 1, ...(driver === 'core' ? { driver: 'core', runId } : {}) });
    next.projects[name] = writeEntry(e);
  }
  return { actions, giveUps, skips, state: next };
}

// ---------- action layer ----------
// `safeNotify`, `withClick` and `phoneUrl` (the phone's click-through link every
// Forja notification carries, sanitised by `notify` itself) come from
// lib/supervise.mjs: the viewer's side of the supervision sends the very same
// two notifications and must send them the very same way.

/**
 * One pass: decide, relaunch, notify, write the state, write one log line.
 * Every side effect is injectable; the defaults are the real ones.
 */
export async function runGuardOnce({
  dataDir: dir = dataDir(),
  forjaRoot: forja = forjaRoot,
  list = listProjectsWithStatus,
  spawn = launchRunner,
  spawnCore = launchCore,
  spawnPeer = launchForja,
  notify = defaultNotify,
  log = null,
  now = Date.now(),
  // When this guard process started watching. Never re-stamped per tick: the
  // 2 min grace on the viewer is measured from here, and that is what keeps a
  // guard that the viewer has just relaunched from relaunching the viewer back.
  // Without a value, the safest reading is "I started now" — which can only
  // delay an action, never cause one.
  selfStartedAt = now,
} = {}) {
  const paths = guardPaths(dir);
  const write = log || (line => appendGuardLog(paths.log, line));
  // A decision that is about to start a process is never taken from a cached
  // liveness value: the cache exists for the viewer's request path, not here.
  resetAliveCache();
  const projects = list(dir) || [];
  const state = readGuardState(paths.state);
  const plan = guardPlan(projects, state, now);
  const next = plan.state;
  const notes = []; const launched = []; const failed = [];
  const click = phoneUrl(dir);
  // A try that produced no process: the attempt is NOT spent (nothing was
  // relaunched), but the clock IS stamped and the try counted. Without this the
  // next pass would see "no attempt ever, nothing to wait for" and ask for the
  // very same spawn 60 s later, for ever — one broken spawn path hammering the
  // machine once a minute with nobody ever told. Now it waits GUARD_RETRY_MS
  // like any other try, and the third one ends in the give-up alarm.
  const spentTry = a => {
    const e = next.projects[a.name] || (next.projects[a.name] = writeEntry(blank(null)));
    e.failed_spawns = Math.min((Number(e.failed_spawns) || 0) + 1, GUARD_MAX_ATTEMPTS);
    e.last_attempt_at = isoOf(now); // dead_since stays: nothing was relaunched, the runner is still dead
    return `${a.attempt} de ${GUARD_MAX_ATTEMPTS}`;
  };

  for (const a of plan.actions) {
    const name = safeName(a.name);
    // The registry entry may have been written before the folder was moved or
    // deleted; `listProjectsWithStatus` already filters those out, and this is
    // the belt to that suspenders: never start a process in a folder that is gone.
    if (!existsSync(a.path)) { failed.push(name); notes.push(`${name}: pasta desapareceu — não relancei (tentativa ${spentTry(a)} não gasta, mas contada)`); continue; }
    let pid;
    try {
      pid = (a.driver === 'core' ? spawnCore : spawn)({
        dataDir: dir, forjaRoot: forja, project: { name: a.name, path: a.path, ...(a.driver === 'core' ? { runId: a.runId } : {}) },
        goal: null,                                    // never a goal: the guard only ever resumes an existing run
        extraArgs: a.visible ? ['--visivel'] : [],     // same mode the run started in, or its `claude --bg` sessions are orphaned
        via: 'guard', action: 'resume',
      });
    } catch (err) { failed.push(name); notes.push(`${name}: relançamento falhou (${String((err && err.message) || err).slice(0, 120)}) — tentativa ${spentTry(a)} não gasta, mas contada`); continue; }
    if (!pid) { failed.push(name); notes.push(`${name}: relançamento falhou (sem pid) — tentativa ${spentTry(a)} não gasta, mas contada`); continue; }
    // Only now does the attempt count: a spawn that produced no process must not
    // consume one of the three.
    const e = next.projects[a.name] || (next.projects[a.name] = writeEntry(blank(null)));
    e.attempts = Math.min((Number(e.attempts) || 0) + 1, GUARD_MAX_ATTEMPTS);
    e.last_attempt_at = isoOf(now);
    e.dead_since = null; // the grace period starts again from the relaunch
    launched.push({ name: a.name, pid, attempt: a.attempt, visible: a.visible });
    notes.push(`${name}: relançado (tentativa ${a.attempt} de ${GUARD_MAX_ATTEMPTS}, pid ${pid})`);
    // No phone ntfy here: the relaunch already fixed it — nothing waits on the Sponsor.
  }
  for (const g of plan.giveUps) {
    const name = safeName(g.name);
    notes.push(`${name}: desisti depois de ${g.attempts} tentativas`);
    await safeNotify(notify, gaveUpMessage(g.name, GUARD_MAX_ATTEMPTS), withClick({ priority: 'urgent', tags: ['rotating_light'], dedup: false }, click));
  }
  // ---- the other half of the mutual supervision: the viewer ----
  // Same tick, same single end-of-tick write, same log line. `data/up.stop`
  // present means `forja down` was asked for: the viewer is never relaunched
  // while it exists and the counter stays at zero — a `down` has to keep
  // meaning "stopped", not "stopped for two minutes".
  const viewer = await runPeerCheckOnce({
    peer: 'up', dataDir: dir, forjaRoot: forja, entry: state.up, now, selfStartedAt,
    alive: upAlive(dir),
    stopRequested: (() => { try { return existsSync(controlPaths(dir).stop); } catch { return false; } })(),
    spawn: spawnPeer, notify,
  });
  next.up = viewer.entry;

  try { writeGuardState(paths.state, next); } catch (err) { notes.push(`estado não gravado (${String((err && err.message) || err).slice(0, 120)})`); }
  // Status only: project names and states, never a goal and never a path.
  const quiet = plan.skips.map(s => `${safeName(s.name)}: ${s.why}`);
  // O estado do viewer vem logo a seguir à contagem de projetos e a nota já
  // começa por «o viewer», por isso não leva rótulo à frente (uma linha com
  // «viewer: o viewer: relançado» lia-se duas vezes).
  write(`guarda: ${projects.length} projeto(s) · ${viewer.note}${notes.length ? ` · ${notes.join(' · ')}` : ''}${quiet.length ? ` · sem ação — ${quiet.join(' · ')}` : ''}`);
  return { ...plan, launched, failed, notes, viewer };
}

// ---------- the process (`forja guard run`) ----------
// A guard's lock owner is alive when the pid is alive AND still a `forja guard`
// (Windows reuses pids in minutes — same rule, and same safe default for an
// unreadable command line, as the runner's own `ownerAlive`). `GUARD_CMD_RE` and
// `guardAlive` live in lib/supervise.mjs now, next to their twin for the viewer,
// and are re-exported at the top of this file.

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SLICE_MS = 1000; // the stop file is noticed within a second, not a poll

/**
 * A poll interval typed by a person (`--poll-ms 5000`, FORJA_GUARD_POLL_MS) is
 * refused loudly, exactly like a forjalvl typed by a person (`checkedLevel` in
 * bin/forja.mjs). `Number(true)` is 1 and `Number('abc')` is NaN, and both of
 * those in the loop mean a guard that spins on the CPU instead of polling — a
 * silent misbehaviour is the one outcome this must not have.
 */
export function checkedPollMs(value, where = '--poll-ms') {
  if (value === true || value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${where} precisa de um número de milissegundos (mínimo ${GUARD_MIN_POLL_MS}; por omissão ${GUARD_POLL_MS})`);
  }
  const n = Number(String(value).trim());
  if (!Number.isFinite(n) || n < GUARD_MIN_POLL_MS) {
    throw new Error(`${where}: "${value}" não é um número de milissegundos >= ${GUARD_MIN_POLL_MS} (por omissão ${GUARD_POLL_MS})`);
  }
  return Math.floor(n);
}
const envPollMs = () => (process.env.FORJA_GUARD_POLL_MS ? checkedPollMs(process.env.FORJA_GUARD_POLL_MS, 'FORJA_GUARD_POLL_MS') : GUARD_POLL_MS);

/**
 * The loop. Returns { ok, code, ticks, why } and never throws for a reason a
 * pass produced: one broken project must never stop the guard.
 * `control.stop = true` (set by the signal handlers of `forja guard run`) ends
 * it as cleanly as the stop file does.
 */
export async function guardLoop({
  dataDir: dir = dataDir(),
  forjaRoot: forja = forjaRoot,
  pollMs = envPollMs(),
  tick = runGuardOnce,
  control = { stop: false },
  maxTicks = Infinity,
  log = null,
} = {}) {
  const paths = guardPaths(dir);
  mkdirSync(paths.dir, { recursive: true });
  const write = log || (line => { appendGuardLog(paths.log, line); if (process.stdout.isTTY) console.log(`${nowIso()} ${line}`); });
  try { if (existsSync(paths.stop)) { rmSync(paths.stop, { force: true }); write('guarda: guard.stop antigo apagado'); } } catch {}

  const got = acquireLock(paths.lock, { project: 'guard', alive: guardAlive });
  if (!got.ok) return { ok: false, code: 3, owner: got.owner, ticks: 0, why: 'outra guarda viva' };
  if (got.lock.tookOverFrom) write(`guarda: lock anterior (pid ${got.lock.tookOverFrom}) estava morto ou parado há mais de ${LOCK_STALE_MS / 60_000} min — assumido`);
  write(`guarda: a vigiar os runners e o viewer de ${Math.round(pollMs / 1000)} em ${Math.round(pollMs / 1000)}s (pid ${process.pid}; cap de ${GUARD_MAX_ATTEMPTS} relançamentos cada)`);

  const stopped = () => { try { return existsSync(paths.stop); } catch { return false; } };
  // Stamped ONCE, here, at the start of this guard process — never per tick.
  // The viewer's 2 min grace is measured from this instant, so a guard that the
  // viewer has just relaunched spends its first two minutes unable to relaunch
  // the viewer back, whatever `dead_since` the state file happens to carry.
  const selfStartedAt = Date.now();
  let ticks = 0; let why = 'fim';
  try {
    for (;;) {
      if (control.stop) { why = 'sinal'; break; }
      if (stopped()) { why = 'guard.stop'; break; }
      if (!beatLock(paths.lock)) { write('guarda: perdi o lock (outra guarda assumiu ou o ficheiro foi apagado) — a sair'); why = 'lock perdido'; break; }
      try { await tick({ dataDir: dir, forjaRoot: forja, now: Date.now(), selfStartedAt }); }
      catch (err) { write(`guarda: a volta falhou (${String((err && err.stack) || err).split('\n')[0]}) — continuo na volta seguinte`); }
      ticks += 1;
      if (ticks >= maxTicks) { why = 'maxTicks'; break; }
      const until = Date.now() + pollMs;
      while (Date.now() < until) {
        await sleep(Math.min(SLICE_MS, Math.max(1, until - Date.now())));
        if (control.stop || stopped()) break;
      }
    }
  } finally {
    releaseLock(paths.lock);
  }
  write(`guarda: a sair (${why}, ${ticks} volta${ticks === 1 ? '' : 's'})`);
  return { ok: true, code: 0, ticks, why };
}

// ---------- CLI ----------
const out = obj => console.log(JSON.stringify(obj, null, 2));

// `forja guard status` — what the guard WOULD do right now, plus the state on
// disk. It launches nothing and writes nothing: this is the command a Reviewer
// can run without side effects.
function statusCmd(dir) {
  const paths = guardPaths(dir);
  const state = readGuardState(paths.state);
  const lock = readLock(paths.lock);
  resetAliveCache();
  const projects = listProjectsWithStatus(dir);
  const now = Date.now();
  const plan = guardPlan(projects, state, now);
  // The viewer half of the supervision, simulated the same way: `peerPlan` is
  // pure, so this launches nothing and writes nothing. A live guard's own start
  // time is what its grace is measured from; with no guard running, "now" is the
  // honest answer (and can only produce "within the grace period").
  const c = controlPaths(dir);
  const running = lock ? Boolean(guardAlive(lock.pid)) : false;
  const upStop = (() => { try { return existsSync(c.stop); } catch { return false; } })();
  const viewer = peerPlan({
    peer: 'up', alive: upAlive(dir), stopRequested: upStop, entry: state.up, now,
    selfStartedAt: running && lock && lock.since ? Date.parse(lock.since) : now,
  });
  out({
    ok: true,
    running,
    lock: lock ? { pid: lock.pid, since: lock.since, beat: lock.beat } : null,
    stopFile: existsSync(paths.stop) ? paths.stop : null,
    policy: { poll_ms: GUARD_POLL_MS, dead_grace_ms: GUARD_DEAD_GRACE_MS, retry_ms: GUARD_RETRY_MS, max_attempts: GUARD_MAX_ATTEMPTS, healthy_ms: GUARD_HEALTHY_MS },
    projects: projects.map(p => ({ name: p.name, status: p.run ? p.run.status : null, visible: p.run ? p.run.visible === true : false, driver: p.run ? p.run.driver || 'unknown' : null, runnerAlive: p.runnerAlive })),
    plan: { actions: plan.actions.map(a => ({ name: a.name, attempt: a.attempt, visible: a.visible })), giveUps: plan.giveUps, skips: plan.skips },
    state: state.projects,
    viewer: {
      running: upAlive(dir),
      stopFile: upStop ? c.stop : null,
      state: state.up,
      plan: { act: viewer.act, why: viewer.why },
    },
    note: 'simulação: nada foi lançado e o estado em disco não foi tocado',
  });
}

// `forja guard stop` — writes the stop file and nothing else. It never kills a
// runner, never kills the viewer, never deletes anything under docs/.
function stopCmd(dir) {
  const paths = guardPaths(dir);
  mkdirSync(paths.dir, { recursive: true });
  // Who we are about to ask, read BEFORE we ask: a guard that sees the stop file
  // within the second releases its lock, and the answer would say "there was
  // nobody there" about the very process it just stopped.
  const lock = readLock(paths.lock);
  const running = lock ? Boolean(guardAlive(lock.pid)) : false;
  writeFileSync(paths.stop, `${nowIso()} forja guard stop (pid ${process.pid})\n`);
  appendGuardLog(paths.log, `guarda: pedido de paragem (forja guard stop, pid ${process.pid})`);
  out({ ok: true, stopFile: paths.stop, guardPid: running ? lock.pid : null, note: running ? 'a guarda sai na volta seguinte (até um minuto)' : 'não havia guarda viva; o ficheiro fica escrito para o wrapper de arranque automático sair' });
}

export async function guard({ pos = [], opt = {} } = {}) {
  const dir = dataDir();
  const sub = pos[0] === undefined || pos[0] === true ? 'run' : String(pos[0]);
  if (sub === 'status') return statusCmd(dir);
  if (sub === 'stop') return stopCmd(dir);
  if (sub !== 'run') throw new Error('uso: forja guard [run|stop|status]');

  const paths = guardPaths(dir);
  const control = { stop: false };
  // Validated BEFORE the lock is taken and before a single signal handler is
  // installed: a refused flag must leave nothing behind.
  const pollMs = opt['poll-ms'] === undefined ? envPollMs() : checkedPollMs(opt['poll-ms'], '--poll-ms');
  // Ctrl+C, kill, Ctrl+Break and the console window being closed (Windows maps
  // that one to SIGHUP — the signal that killed `forja up` on 17 set 2026).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { control.stop = true; });
  process.on('exit', () => releaseLock(paths.lock));
  const r = await guardLoop({ dataDir: dir, forjaRoot, pollMs, control });
  if (!r.ok) {
    console.error(`forja guard: já há uma guarda viva (pid ${r.owner && r.owner.pid}, desde ${r.owner && r.owner.since}, último sinal ${r.owner && r.owner.beat}). Se morreu mesmo, apaga ${paths.lock}.`);
    process.exit(3);
  }
  out({ ok: true, ticks: r.ticks, why: r.why, log: paths.log });
  return r;
}

// ---------- autostart (the guard's own pair of files, lib/up.mjs installs them) ----------
// Modelled on startupPaths/launcherFiles in lib/up.mjs: only the .vbs goes in
// the Startup folder (two files there would mean two launches at login), the
// .cmd lives in data/autostart, CRLF because cmd.exe and wscript read them.
export function guardStartupPaths({ appData = process.env.APPDATA, data = dataDir() } = {}) {
  if (!appData) throw new Error('APPDATA não definido — `forja autostart` só funciona no Windows');
  const startupDir = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const paths = guardPaths(data);
  return { startupDir, launcher: join(startupDir, 'forja-guard.vbs'), wrapper: join(data, 'autostart', 'forja-guard.cmd'), consoleLog: guardConsoleLog(data), stop: paths.stop, lock: paths.lock, log: paths.log };
}

export function guardLauncherFiles(paths, { forja = forjaRoot, node = process.execPath } = {}) {
  const bin = join(forja, 'bin', 'forja.mjs');
  const wrapper = [
    '@echo off',
    'rem Forja: wrapper de arranque automatico da guarda dos runners, gerado por `forja autostart install` (remover com `forja autostart remove`).',
    'rem Corre `forja guard run`, que relanca um runner que morreu a meio de um run, e volta a arranca-lo se sair com erro.',
    'rem Sai quando a guarda termina limpa, quando ja ha outra guarda viva (codigo 3) ou quando existe o ficheiro guard.stop',
    'rem (escrito por `forja guard stop` / `forja autostart remove`). Nao arranca o viewer: `forja up` tem o seu proprio wrapper.',
    'rem Podes correr este ficheiro a mao para ver o que acontece numa janela normal.',
    `cd /d "${forja}"`,
    `if exist "${paths.stop}" del /q "${paths.stop}"`,
    ':loop',
    `"${node}" "${bin}" guard run >> "${paths.consoleLog}" 2>&1`,
    'set FORJA_CODE=%ERRORLEVEL%',
    'if %FORJA_CODE% EQU 0 goto end',
    'if %FORJA_CODE% EQU 3 goto end',
    `if exist "${paths.stop}" goto end`,
    `"${node}" -e "setTimeout(function(){}, ${GUARD_WRAPPER_RETRY_S * 1000})"`,
    `if exist "${paths.stop}" goto end`,
    'goto loop',
    ':end',
    '',
  ].join('\r\n');
  const launcher = [
    "' Forja: arranque automatico da guarda dos runners no login, gerado por `forja autostart install` (remover com `forja autostart remove`).",
    "' Windows corre este ficheiro ao entrar; ele lanca o wrapper sem janela nenhuma (estilo 0) e nao espera por ele.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "cmd.exe /c ""${paths.wrapper}""", 0, False`,
    '',
  ].join('\r\n');
  return { [paths.launcher]: launcher, [paths.wrapper]: wrapper };
}

// `forja autostart remove` asks the guard to stop without killing anything.
export function writeGuardStop(data = dataDir(), why = 'forja autostart remove') {
  const paths = guardPaths(data);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.stop, `${nowIso()} ${why} (pid ${process.pid})\n`);
  return paths.stop;
}
