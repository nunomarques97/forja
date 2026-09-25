import { risks } from './context.mjs';
import { finalChecksApply } from './task-scope.mjs';
import { assertCheckTargets } from './check-targets.mjs';

// strict (default) guards new runs; persisted legacy state uses strict: false.
export function validateFinalChecks(config, { strict = true } = {}) {
  if (config.finalChecks === undefined) return;
  if (!Array.isArray(config.finalChecks) || config.finalChecks.length > 20 || config.finalChecks.some(c => !c || typeof c.command !== 'string' || !c.command.trim() || !Array.isArray(c.args) || c.args.some(a => typeof a !== 'string')))
    throw new Error('finalChecks must contain at most 20 executable command/args checks.');
  if (strict) assertCheckTargets(config.finalChecks, 'finalChecks');
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

// A check that asserts the working tree has no changes against the index or
// HEAD (git diff --exit-code/--quiet) proves something about the tree at its
// own task only. Later accepted work makes it fail on the final tree, so the
// final regression skips it instead of sending a repair back to that task.
export function snapshotBoundCheck(check) {
  if (!check || typeof check.command !== 'string' || !/^git(\.exe)?$/i.test(check.command.split(/[\\/]/).at(-1))) return false;
  const args = check.args || [];
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c'].includes(args[i]) ? 2 : 1;
  if (!['diff', 'diff-index', 'diff-files'].includes(args[i])) return false;
  const options = args.slice(i + 1, args.includes('--') ? args.indexOf('--') : undefined);
  return options.some(a => a === '--exit-code' || a === '--quiet');
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
