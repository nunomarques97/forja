// Deterministic, advisory plan checks. They never change or reject a plan; the
// controller logs them after planning and `core status` reports them.
import { existsSync, statSync } from 'node:fs';
import { inside } from './files.mjs';

// Observed first-request input of a Claude Code develop session (system prompt,
// tools and the FORJA packet) before the worker reads anything.
export const PROVIDER_BASELINE_TOKENS = 35000;
export const DEFAULT_CONTEXT_TOKENS = 120000;

const READ_HEAVY = /\b(audit|review|investigat\w*|survey|assess\w*|inspect\w*)\b/i;

export function workingContextTokens(run) {
  return Math.max(0, (run.limits?.contextTokens || DEFAULT_CONTEXT_TOKENS) - PROVIDER_BASELINE_TOKENS);
}

function directoryScope(root, path) {
  if (/[\\/]$/.test(path) || path === '.') return true;
  try {
    const file = inside(root, path);
    return existsSync(file) && statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function planWarnings(run, root) {
  const warnings = [];
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const budget = workingContextTokens(run);
  tasks.forEach((task) => {
    const text = [task.title, ...(task.criteria || [])].join('\n');
    const directories = (task.files || []).filter((path) => directoryScope(root, path));
    if ((READ_HEAVY.test(text) && directories.length >= 2) || directories.length >= 4)
      warnings.push({
        code: 'context_scope',
        task: task.id,
        message: `${task.id} reads ${directories.length} whole directories (${directories.slice(0, 6).join(', ')}); a develop session has about ${budget} tokens of working context after the provider baseline. Split read-heavy work by area, each with its own criteria and checks.`,
      });
  });
  return warnings;
}

// Planner-facing contract for the plan phase packet.
export function planningContract(run) {
  return {
    develop_context_tokens: run.limits?.contextTokens || DEFAULT_CONTEXT_TOKENS,
    provider_baseline_tokens_estimate: PROVIDER_BASELINE_TOKENS,
    working_context_tokens_estimate: workingContextTokens(run),
  };
}
