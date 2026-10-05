// Per-project goal queue: `forja core queue add|list|remove` and the hidden
// `core queue start --expected-run <id>` the guard launches. The queue lives in
// .forja/queue.json (private run state, never committed), is written
// atomically and changes only under its own exclusive lock, so `queue add`
// works while a run holds the project lock. Starting a queued goal takes the
// project lock first and then the queue lock, re-checks that the run that
// finished is still the current one with status done, and removes the entry
// only after createRun accepted it. A refusal (dirty tree, legacy run, invalid
// configuration) keeps the entry with a bounded reason; allow-dirty is never
// applied. Reads for observation (queueLength) take no lock.
//
// The mutating paths import the engine lazily: observation (observe.mjs, the
// guard and the viewer) only needs the read-only half of this module.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inside, git } from './context.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';

export const QUEUE_FILE = '.forja/queue.json';
export const QUEUE_MAX_ENTRIES = 50;
export const QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const QUEUE_CONFIG_MAX_CHARS = 32000;
export const QUEUE_REFUSAL_MAX_CHARS = 500;
const GOAL_MAX = 16000;
const PREVIEW_CHARS = 120;
const ID_RE = /^Q-\d{1,16}-[a-f0-9]{6}$/;
const RUN_ID_RE = /^F-\d+-[a-f0-9]{6}$/;
const PROVIDERS = ['claude', 'codex', 'kilo', 'custom'];
const BUDGET_KEYS = ['maxSessions', 'maxAttempts', 'maxMinutes', 'maxRotations', 'maxContextTokens', 'maxCloudSessions', 'providerRetries', 'checkTimeoutMinutes'];
const DELIVERED = ['committed', 'pushed', 'no_changes'];
const QUEUE_LOCK = { file: 'queue-lock.json', takeover: 'queue-takeover.json', label: 'Goal queue' };
const LOCK_WAIT_MS = 3000;
const LOCK_STEP_MS = 50;

// Flags of each `core queue` subcommand besides --project (--help is handled
// before). `start` is the internal path lib/spawn-runner.mjs launchCoreQueue uses.
export const QUEUE_FLAGS = Object.freeze({
  add: ['goal-file', 'config', 'provider'],
  list: [],
  remove: [],
  start: ['expected-run'],
});
const QUEUE_COMMANDS = 'Use forja core queue add --goal-file <file> [--config <json>] [--provider claude|codex|kilo|custom] [budget flags] | core queue list | core queue remove <id>; nothing was changed.';

const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isoTime = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const pause = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const oneLine = (text, max) => String(text).replace(/\s+/g, ' ').trim().slice(0, max);

export const queuePath = (root) => inside(root, QUEUE_FILE);

// Throws on any entry or file shape this module would not write itself.
function validateQueue(data) {
  if (!plain(data) || data.version !== 1 || !Array.isArray(data.entries)) throw new Error('unexpected file shape');
  if (Object.keys(data).some((k) => !['version', 'entries'].includes(k))) throw new Error('unexpected top-level field');
  if (data.entries.length > QUEUE_MAX_ENTRIES) throw new Error(`more than ${QUEUE_MAX_ENTRIES} entries`);
  const ids = new Set();
  data.entries.forEach((e, i) => {
    const bad = (why) => { throw new Error(`entry ${i + 1}: ${why}`); };
    if (!plain(e)) bad('not an object');
    if (Object.keys(e).some((k) => !['id', 'added_at', 'provider', 'goal', 'config', 'budgets', 'last_refusal'].includes(k))) bad('unexpected field');
    if (typeof e.id !== 'string' || !ID_RE.test(e.id) || ids.has(e.id)) bad('invalid or duplicate id');
    ids.add(e.id);
    if (!isoTime(e.added_at)) bad('invalid added_at');
    if (!PROVIDERS.includes(e.provider)) bad('invalid provider');
    if (typeof e.goal !== 'string' || !e.goal.trim() || e.goal.length > GOAL_MAX) bad('invalid goal');
    if (e.config !== null && !plain(e.config)) bad('invalid config');
    if (e.config && JSON.stringify(e.config).length > QUEUE_CONFIG_MAX_CHARS) bad('config too large');
    if (!plain(e.budgets) || Object.entries(e.budgets).some(([k, v]) => !BUDGET_KEYS.includes(k) || !Number.isSafeInteger(v))) bad('invalid budgets');
    if (e.last_refusal !== undefined && (!plain(e.last_refusal) || !isoTime(e.last_refusal.at) ||
        typeof e.last_refusal.reason !== 'string' || e.last_refusal.reason.length > QUEUE_REFUSAL_MAX_CHARS ||
        Object.keys(e.last_refusal).some((k) => !['at', 'reason'].includes(k)))) bad('invalid last_refusal');
  });
  return data;
}

// The queue as stored; an absent file is an empty queue. A corrupt, oversized
// or foreign file is reported and never reset: nothing reads it as empty.
export function readQueue(root) {
  const path = queuePath(root);
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > QUEUE_MAX_BYTES) throw new Error(`larger than ${QUEUE_MAX_BYTES} bytes`);
    return validateQueue(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new Error(`The goal queue ${QUEUE_FILE} is unreadable (${oneLine(error.message, 200)}). It was not reset and nothing was started; inspect or remove it yourself.`);
  }
}

// Read-only, lock-free count for observation: { length, error: null }, or
// { length: null, error } for a file that cannot be read.
export function queueLength(root) {
  try {
    return { length: readQueue(root).entries.length, error: null };
  } catch {
    return { length: null, error: 'Goal queue is unreadable; check it locally.' };
  }
}

// Queue entries carry provider settings that start processes. A queue that
// arrived through Git (committed under .forja) is never trusted or changed.
function assertPrivateQueue(root) {
  if (git(root, ['ls-files', '--', QUEUE_FILE]).trim())
    throw new Error(`The goal queue ${QUEUE_FILE} is tracked by Git; a queue is private run state and is never used from a commit. Untrack it yourself; nothing was changed.`);
}

function writeQueue(root, data) {
  const body = JSON.stringify(validateQueue(data), null, 2) + '\n';
  if (Buffer.byteLength(body) > QUEUE_MAX_BYTES) throw new Error(`The goal queue would exceed ${QUEUE_MAX_BYTES} bytes; nothing was changed.`);
  writeFileAtomic(queuePath(root), body);
}

// Exclusive queue lock. Queue operations are short, so a live holder is waited
// for briefly before the refusal; an unreadable lock is reported at once.
async function lockQueue(root) {
  const { lockProject } = await import('./engine.mjs');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      return lockProject(root, QUEUE_LOCK);
    } catch (error) {
      if (!/still alive|already in progress/.test(error.message) || Date.now() >= deadline)
        throw new Error(`The goal queue is busy or its lock needs inspection (${error.message}); nothing was changed.`);
      pause(LOCK_STEP_MS);
    }
  }
}

async function withQueue(root, change) {
  assertPrivateQueue(root);
  const lock = await lockQueue(root);
  try {
    return change(readQueue(root));
  } finally {
    lock.release();
  }
}

// Refuses unknown subcommands, flags and stray positionals before any effect.
export async function assertQueueArguments(pos = [], opt = {}) {
  const sub = pos[0];
  if (!Object.hasOwn(QUEUE_FLAGS, sub ?? '')) throw new Error(QUEUE_COMMANDS);
  const name = `core queue ${sub}`;
  const allowed = new Set(['project', ...QUEUE_FLAGS[sub]]);
  const { LIMIT_FLAGS } = await import('./engine.mjs');
  if (sub === 'add') for (const flag of LIMIT_FLAGS) allowed.add(flag);
  const unknown = Object.keys(opt).filter((flag) => !allowed.has(flag));
  if (unknown.length)
    throw new Error(`Unknown flag ${unknown.map((flag) => `--${flag}`).join(', ')} for ${name}; nothing was changed. See core --help.`);
  const extra = pos.slice(sub === 'remove' ? 2 : 1);
  if (extra.length)
    throw new Error(`Unexpected argument ${extra.map((a) => JSON.stringify(String(a))).join(', ')} for ${name}; nothing was changed. See core --help.`);
  for (const flag of QUEUE_FLAGS[sub])
    if (Object.hasOwn(opt, flag) && (opt[flag] === true || !String(opt[flag]).trim()))
      throw new Error(`--${flag} needs a value; nothing was changed.`);
  if (sub === 'remove' && (typeof pos[1] !== 'string' || !ID_RE.test(pos[1])))
    throw new Error('core queue remove needs one queue entry id (Q-...), as shown by core queue list; nothing was changed.');
  if (sub === 'start' && (typeof opt['expected-run'] !== 'string' || !RUN_ID_RE.test(opt['expected-run'])))
    throw new Error('core queue start is internal and needs --expected-run <run id>; nothing was changed.');
  if (sub === 'add' && !Object.hasOwn(opt, 'goal-file'))
    throw new Error('core queue add needs --goal-file <file> (UTF-8); nothing was changed.');
}

// Validates an entry with the validators createRun applies, without touching
// the project; allow-dirty is refused because a queued start never applies it.
export async function queueEntry(root, opt = {}, cwd = process.cwd()) {
  const engine = await import('./engine.mjs');
  const { validateRouting } = await import('./routing.mjs');
  const { validateFinalChecks } = await import('./quality.mjs');
  const { validateCheckIsolation } = await import('./check-isolation.mjs');
  const { validateDelivery } = await import('./delivery-policy.mjs');
  const { coreBudgets } = await import('./budgets.mjs');
  const { validateLessonsConfig } = await import('./lessons.mjs');
  const goal = engine.startGoal({ 'goal-file': opt['goal-file'] }, cwd);
  const provider = opt.provider ?? 'claude';
  if (!PROVIDERS.includes(provider)) throw new Error('Provider must be claude, codex, kilo or custom; nothing was changed.');
  let config = null;
  if (Object.hasOwn(opt, 'config')) {
    let text;
    try {
      text = readFileSync(resolve(cwd, opt.config), 'utf8');
    } catch (error) {
      throw new Error(`Cannot read the configuration file ${JSON.stringify(opt.config)} (${error.code || error.message}); nothing was changed.`);
    }
    if (text.length > QUEUE_CONFIG_MAX_CHARS) throw new Error(`The configuration file is larger than ${QUEUE_CONFIG_MAX_CHARS} characters; nothing was changed.`);
    try {
      config = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      throw new Error(`The configuration file ${JSON.stringify(opt.config)} is not valid JSON; nothing was changed.`);
    }
    if (!plain(config)) throw new Error('The configuration file must hold a JSON object; nothing was changed.');
    if (Object.hasOwn(config, 'allowDirty') && config.allowDirty !== false)
      throw new Error('A queued goal always starts from a clean tree: remove allowDirty from the configuration; nothing was changed.');
  }
  let raw;
  try {
    raw = engine.limitConfig(opt);
    const effective = { ...(config || {}), ...raw };
    validateRouting(effective, provider);
    validateFinalChecks(effective);
    validateCheckIsolation(effective);
    validateDelivery(effective);
    engine.validateUsageLimitResume(effective);
    validateLessonsConfig(effective);
    coreBudgets(effective);
  } catch (error) {
    throw new Error(`${error.message.replace(/\.?$/, '.')} Nothing was changed.`);
  }
  // Validated above as plain digits (budget() in coreBudgets), stored as numbers.
  const budgets = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
  return { goal, provider, config, budgets };
}

export async function addToQueue(root, opt = {}, cwd = process.cwd()) {
  // Same project-root rule as start, before .forja is created.
  if (resolve(git(root, ['rev-parse', '--show-toplevel']).trim()).toLowerCase() !== resolve(root).toLowerCase())
    throw new Error('Run core queue add from the Git project root (or pass --project <root>); nothing was changed.');
  const fields = await queueEntry(root, opt, cwd);
  return withQueue(root, (queue) => {
    if (queue.entries.length >= QUEUE_MAX_ENTRIES) throw new Error(`The goal queue already holds ${QUEUE_MAX_ENTRIES} entries; nothing was changed.`);
    const entry = { id: `Q-${Date.now()}-${randomUUID().slice(0, 6)}`, added_at: new Date().toISOString(), ...fields };
    writeQueue(root, { version: 1, entries: [...queue.entries, entry] });
    return { entry, position: queue.entries.length + 1 };
  });
}

export async function removeFromQueue(root, id) {
  // Without a queue file there is nothing to remove: no lock, no .forja.
  if (!existsSync(queuePath(root))) throw new Error(`No queued goal ${id}; nothing was changed. See core queue list.`);
  return withQueue(root, (queue) => {
    const entries = queue.entries.filter((e) => e.id !== id);
    if (entries.length === queue.entries.length) throw new Error(`No queued goal ${id}; nothing was changed. See core queue list.`);
    writeQueue(root, { version: 1, entries });
    return { removed: id, remaining: entries.length };
  });
}

// What `core queue list` prints: no full goal and no configuration content.
export function listQueue(root) {
  return readQueue(root).entries.map((e) => ({
    id: e.id,
    added_at: e.added_at,
    provider: e.provider,
    goal_preview: oneLine(e.goal, PREVIEW_CHARS) + (oneLine(e.goal, PREVIEW_CHARS + 1).length > PREVIEW_CHARS ? '…' : ''),
    budgets: e.budgets,
    config: e.config !== null,
    last_refusal: e.last_refusal || null,
  }));
}

// Starts the head of the queue as a new run when `expectedRunId` is still the
// current run with status done (and delivered, when delivery is configured).
// The project lock proves no controller or worker is alive. Returns
// { run, entry } when a run was created, { empty: true } for an empty queue and
// { refused, entry } when createRun refused it (the entry stays queued).
// Identity, lock and queue-file problems throw before any change.
export async function startFromQueue(root, { expectedRunId } = {}) {
  const { lockProject, current, validateState, createRun } = await import('./engine.mjs');
  if (typeof expectedRunId !== 'string' || !RUN_ID_RE.test(expectedRunId)) throw new Error('Queue start needs the run id that finished.');
  const lock = lockProject(root);
  try {
    let run;
    try {
      run = validateState(JSON.parse(readFileSync(current(root), 'utf8')), root);
    } catch (error) {
      throw new Error(`Queue start cancelled: the current run is unreadable (${oneLine(error.message, 200)}); nothing was changed.`);
    }
    if (run.run_id !== expectedRunId || run.status !== 'done')
      throw new Error('Queue start cancelled: run identity or status changed; nothing was changed.');
    if (run.config.delivery && !DELIVERED.includes(run.delivery?.status))
      throw new Error('Queue start cancelled: the finished run has not completed its delivery; nothing was changed.');
    if (run.queueHold)
      throw new Error(QUEUE_HELD);
    return await withQueue(root, (queue) => {
      const head = queue.entries[0];
      if (!head) return { empty: true };
      const config = { ...(head.config || {}), ...head.budgets };
      if (Object.hasOwn(config, 'allowDirty') && config.allowDirty !== false)
        throw new Error(`Queued goal ${head.id} asks for allowDirty, which a queued start never applies; remove it with core queue remove ${head.id}.`);
      let created;
      try {
        created = createRun(root, { goal: head.goal, provider: head.provider, config });
      } catch (error) {
        const reason = oneLine(error.message, QUEUE_REFUSAL_MAX_CHARS);
        head.last_refusal = { at: new Date().toISOString(), reason };
        writeQueue(root, queue);
        return { refused: reason, entry: head.id };
      }
      try {
        writeQueue(root, { version: 1, entries: queue.entries.slice(1) });
      } catch (error) {
        throw new Error(`Run ${created.run_id} was created from queued goal ${head.id}, but the entry could not be removed (${error.message}); remove it with core queue remove ${head.id} before it starts again.`);
      }
      return { run: created, entry: head.id };
    });
  } finally {
    lock.release();
  }
}

const QUEUE_HELD = 'Queue start cancelled: an operator stop was requested before the finished run ended, so the queue is held for that run; nothing was changed. The next run that ends done (for example one started with core start) continues the queue.';
const finishedClean = (run) => run?.status === 'done' && (!run.config?.delivery || DELIVERED.includes(run.delivery?.status));

// After a controller session: while the run ended done (and delivered), start
// and drive the next queued goal. Blocked and failed runs never start the queue.
export async function continueQueue(root, result, options = {}, { log = console.log, warn = console.error } = {}) {
  const { drive } = await import('./engine.mjs');
  while (finishedClean(result)) {
    if (result.queueHold) {
      if (queueLength(root).length !== 0) log('FORJA queue: the operator stop requested during this run is honoured; the queued goals were not started and stay queued.');
      break;
    }
    let next;
    try {
      next = await startFromQueue(root, { expectedRunId: result.run_id });
    } catch (error) {
      warn(`FORJA queue: the next queued goal was not started: ${error.message}`);
      return { result, refused: error.message };
    }
    if (next.empty) break;
    if (next.refused) {
      warn(`FORJA queue: queued goal ${next.entry} was not started and stays queued: ${next.refused}`);
      return { result, refused: next.refused };
    }
    log(`FORJA queue: started queued goal ${next.entry} as run ${next.run.run_id}.`);
    result = await drive(root, { ...options, expectedRunId: next.run.run_id });
  }
  return { result, refused: null };
}

// `forja core queue <add|list|remove|start>`; arguments are checked first.
export async function queueCommand(root, pos = [], opt = {}) {
  await assertQueueArguments(pos, opt);
  const sub = pos[0];
  if (sub === 'list') {
    console.log(JSON.stringify({ queue: listQueue(root) }, null, 2));
    return;
  }
  if (sub === 'add') {
    const { entry, position } = await addToQueue(root, opt);
    console.log(JSON.stringify({ added: entry.id, position, message: 'Queued. It starts as a new run after the current run ends done, from a clean tree.' }, null, 2));
    return;
  }
  if (sub === 'remove') {
    console.log(JSON.stringify(await removeFromQueue(root, pos[1]), null, 2));
    return;
  }
  // start: internal guard path. A refusal or a cancelled start exits non-zero.
  let next;
  try {
    next = await startFromQueue(root, { expectedRunId: opt['expected-run'] });
  } catch (error) {
    process.exitCode = 1;
    throw error;
  }
  if (next.empty) {
    console.log('FORJA queue: no queued goal; nothing was started.');
    return;
  }
  if (next.refused) {
    process.exitCode = 1;
    console.error(`FORJA queue: queued goal ${next.entry} was not started and stays queued: ${next.refused}`);
    return;
  }
  const { drive } = await import('./engine.mjs');
  const { upsertProject } = await import('../projects.mjs');
  upsertProject({ path: root });
  console.log(`FORJA queue: started queued goal ${next.entry} as run ${next.run.run_id}.`);
  const { result } = await continueQueue(root, await drive(root, { expectedRunId: next.run.run_id }));
  if (result.status !== 'done' || (result.delivery && !DELIVERED.includes(result.delivery.status))) process.exitCode = 1;
  return result;
}
