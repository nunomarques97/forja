// Deterministic, advisory plan checks. They never change or reject a plan; the
// controller logs them after planning and `core status` reports them.
import { existsSync, statSync } from 'node:fs';
import { inside } from './files.mjs';
import { snapshotBoundCheck } from './quality.mjs';

// Observed first-request input of a Claude Code develop session (system prompt,
// tools and the FORJA packet) before the worker reads anything.
export const PROVIDER_BASELINE_TOKENS = 35000;
export const DEFAULT_CONTEXT_TOKENS = 120000;

const READ_HEAVY = /\b(audit|review|investigat\w*|survey|assess\w*|inspect\w*)\b/i;
const HEAD_DEPENDENCY = /\bHEAD\b|\bcommitted (?:content|objects?|work|changes|tree|files)\b|\bgit (?:log|show|archive|ls-tree|cat-file|rev-list)\b|\bafter (?:each|every|the) (?:task|change)s? (?:is |are )?committed\b/;

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
  tasks.forEach((task, index) => {
    const text = [task.title, ...(task.criteria || [])].join('\n');
    const directories = (task.files || []).filter((path) => directoryScope(root, path));
    if ((READ_HEAVY.test(text) && directories.length >= 2) || directories.length >= 4)
      warnings.push({
        code: 'context_scope',
        task: task.id,
        message: `${task.id} reads ${directories.length} whole directories (${directories.slice(0, 6).join(', ')}); a Claude develop session has about ${budget} tokens of working context using a reference baseline estimate. Split read-heavy work by area, each with its own criteria and checks.`,
      });
    if (HEAD_DEPENDENCY.test(text) && (index > 0 || task.after?.length))
      warnings.push({
        code: 'head_dependency',
        task: task.id,
        message: `${task.id} depends on committed Git state (HEAD), but workers never commit and no commit happens between tasks${run.config?.delivery ? `; delivery ${run.config.delivery.mode} creates at most one commit after the run` : '; this run has no delivery and creates no commit'}. Work on the working tree or defer the step to a later run.`,
      });
    if (tasks.length > 1 && (task.checks || []).some(snapshotBoundCheck))
      warnings.push({
        code: 'snapshot_check',
        task: task.id,
        message: `${task.id} has a git diff --exit-code/--quiet check, which proves the tree only at this task; later tasks change the diff, so the final regression skips it. Keep lasting guarantees in checks that stay true on the final tree.`,
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
    context_budget_note: 'The 35,000-token baseline is a Claude reference estimate, not a measurement of this session. Actual overhead depends on provider, tools and instructions. Live context-limit enforcement is available only for Claude; do not assume this working-context estimate describes Codex or custom routes.',
    delivery: run.config?.delivery?.mode || 'none',
    commits_during_run: false,
  };
}
