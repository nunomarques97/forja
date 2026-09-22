import { risks } from './context.mjs';
import { finalChecksApply } from './task-scope.mjs';

export function validateFinalChecks(config) {
  if (config.finalChecks === undefined) return;
  if (!Array.isArray(config.finalChecks) || config.finalChecks.length > 20 || config.finalChecks.some(c => !c || typeof c.command !== 'string' || !c.command.trim() || !Array.isArray(c.args) || c.args.some(a => typeof a !== 'string')))
    throw new Error('finalChecks must contain at most 20 executable command/args checks.');
}

export function checksFor(run, task) {
  // User-owned acceptance checks apply only once every other task is complete.
  // Intermediate implementation tasks need not already satisfy the whole goal.
  if (!finalChecksApply(run, task)) return task.checks;
  const final = run.config.finalChecks || [];
  const same = (a, b) => a.command === b.command && a.args.length === b.args.length && a.args.every((v, i) => v === b.args[i]);
  // Share only an exact suffix/prefix overlap at the integration boundary.
  // Both ordered check sequences (and repeats inside each) remain intact;
  // removing arbitrary matches could reorder build-dependent checks.
  let overlap = Math.min(task.checks.length, final.length);
  while (overlap && !final.slice(0, overlap).every((check, i) => same(task.checks[task.checks.length - overlap + i], check))) overlap--;
  return [...task.checks, ...final.slice(overlap)];
}

export function reviewFocus(task, goal = '') {
  const risk = task?.risk || risks(task || {}, task?.files || []);
  const text = [goal, task?.title, ...(task?.criteria || [])].join(' ');
  const probes = ['Trace each acceptance criterion to executed evidence; inspect source for cases the checks omit.'];
  if (risk.visual) probes.push('Exercise loading, empty, error, retry and success states; verify keyboard focus and live announcements across refresh, repeat lifecycle setup/cleanup/setup (for example React StrictMode), and inspect desktop/mobile evidence.');
  if (/async|search|pag(e|ing|ination)|request|refresh|import|race|cancel|pesquisa|pedido/i.test(text)) probes.push('Trace overlapping success and failure completions, invalidation during paging, empty-result refresh and retry after a failed refresh. Verify cursor/query ownership and pending-state cleanup on every exit.');
  if (risk.security) probes.push('Inspect trust boundaries, negative input, authorization and sensitive output; passing happy-path checks is insufficient.');
  return probes;
}
