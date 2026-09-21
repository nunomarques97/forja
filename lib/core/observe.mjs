// Read-only Core projection. No prompts, source paths or raw provider output cross the viewer API.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inside } from './context.mjs';
import {
  parseUsageLedger,
  summarizeUsage,
  normalizedUsage,
} from './metrics.mjs';

const str = (v, n = 600) => (typeof v === 'string' ? v.slice(0, n) : null);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const measured = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
export function coreAlive(root, alive = processAlive) {
  try {
    const file = inside(root, '.forja/lock.json');
    if (!existsSync(file)) return false;
    const lock = JSON.parse(readFileSync(file, 'utf8'));
    // Match the engine's conservative exclusion: never launch over a live worker.
    if (!lock || !Number.isInteger(lock.pid)) return true;
    return alive(lock.pid) || alive(lock.child);
  } catch {
    return true;
  } // Unknown is not proof of death.
}
export function coreObservation(root, { details = false, alive } = {}) {
  try {
    const file = inside(root, '.forja/current.json');
    if (!existsSync(file)) return null;
    const r = JSON.parse(readFileSync(file, 'utf8'));
    if (
      !r ||
      r.version !== 1 ||
      !/^F-[A-Za-z0-9-]+$/.test(r.run_id) ||
      !['running', 'blocked', 'done', 'failed'].includes(r.status) ||
      !Array.isArray(r.tasks)
    )
      throw new Error('Invalid state');
    const run = {
      run_id: r.run_id,
      status: r.status,
      goal: str(r.goal),
      provider: str(r.provider, 32),
      started_at: str(r.created_at, 40),
      updated_at: str(r.updated_at, 40),
      driver: 'core',
      visible: false,
    };
    const result = {
      run,
      runnerAlive: coreAlive(root, alive),
      invocations: count(r.invocations),
    };
    if (!details) return result;
    const ledger = inside(root, join('.forja/runs', r.run_id, 'usage.jsonl'));
    const { rows, warnings } = parseUsageLedger(
      existsSync(ledger) ? readFileSync(ledger, 'utf8') : '',
    );
    const safeRows = rows.map((x) => ({
      id: x.id,
      phase: str(x.phase, 32),
      task: str(x.task, 64),
      attempt: count(x.attempt),
      provider: str(x.provider, 32),
      backend: str(x.backend ?? x.provider, 32),
      local: x.local === true,
      model: str(x.model, 100),
      reported_model: str(x.reported_model, 200),
      reported_cost_usd:
        Number.isFinite(x.reported_cost_usd) && x.reported_cost_usd >= 0
          ? x.reported_cost_usd
          : null,
      effort: str(x.effort, 32),
      tier: str(x.tier, 32),
      result: str(x.result, 32),
      usage: x.usage
        ? Object.fromEntries(
            [
              'input_tokens',
              'output_tokens',
              'cache_creation_input_tokens',
              'cached_input_tokens',
            ].map((k) => [
              k,
              Number.isSafeInteger(x.usage[k]) && x.usage[k] >= 0
                ? x.usage[k]
                : null,
            ]),
          )
        : null,
      normalized: normalizedUsage(x),
      calls: measured(x.calls),
      calls_source: str(x.calls_source, 100),
      duration_ms: measured(x.duration_ms),
      prompt_characters: measured(x.prompt_characters),
    }));
    result.usage = summarizeUsage(safeRows, {
      expectedInvocations: r.invocations,
    });
    result.ledger_warnings = warnings.length;
    const p = r.pending;
    result.pending = p
      ? {
          id: p.id,
          phase: str(p.phase, 32),
          provider: str(p.provider, 32),
          backend: str(p.backend ?? p.provider, 32),
          task: str(p.task, 64),
          model: str(p.model, 100),
          effort: str(p.effort, 32),
          started_at: str(p.started_at, 40),
        }
      : null;
    result.tasks = r.tasks.map((t) => ({
      id: str(t.id, 64),
      title: str(t.title, 500),
      status: str(t.status, 32),
      attempts: count(t.attempts),
      rotations: count(t.rotations),
      checks_total: Math.max(t.checks?.length || 0, t.validation?.length || 0),
      checks_passed: t.validation?.filter((v) => v.passed).length || 0,
      review: str(t.review?.status, 32),
    }));
    return result;
  } catch {
    return {
      run: null,
      runnerAlive: true,
      error: 'Estado Core ilegível; verificar localmente antes de recuperar.',
    };
  }
}
