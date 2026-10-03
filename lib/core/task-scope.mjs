// Keep the worker's acceptance boundary identical to the scheduler's gate,
// including integration checks retained when a completed task needs repair.
export function finalChecksApply(run, task) {
  return !!task && (
    run.finalCheckTaskId === task.id ||
    (run.tasks.some(t => t.status !== 'done') &&
      run.tasks.every(t => t.id === task.id || t.status === 'done'))
  );
}

// Criteria of a remaining task enter the packet only when it shares a file with
// the current task, capped per task, so task_scope grows with the number of
// remaining tasks but never with the length of their criteria.
export const REMAINING_CRITERIA_CAP = 1200;

const scopePath = path => String(path).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

// Equal paths, or one is a directory that contains the other.
export function sharesFiles(a = [], b = []) {
  const left = (a || []).map(scopePath), right = (b || []).map(scopePath);
  return left.some(x => right.some(y =>
    x === y || x === '' || x === '.' || y === '' || y === '.' || y.startsWith(`${x}/`) || x.startsWith(`${y}/`)));
}

function cappedCriteria(criteria = []) {
  const kept = [];
  let used = 0;
  for (const criterion of criteria || []) {
    const text = String(criterion);
    if (used + text.length <= REMAINING_CRITERIA_CAP) {
      kept.push(text);
      used += text.length;
      continue;
    }
    const room = REMAINING_CRITERIA_CAP - used;
    if (room > 0) kept.push(`${text.slice(0, room)}…`);
    return { criteria: kept, truncated: true };
  }
  return { criteria: kept, truncated: false };
}

export function planStatePath(run) {
  return `.forja/runs/${run.run_id || '<run_id>'}/state.json`;
}

export function taskScope(run, task) {
  const remaining = run.tasks.filter(t => t.id !== task?.id && t.status !== 'done');
  return {
    final_checks_required: finalChecksApply(run, task),
    remaining_tasks: remaining.map(t => {
      const entry = { id: t.id, title: t.title, files: t.files, after: t.after };
      if (!task || !sharesFiles(task.files, t.files)) return entry;
      const { criteria, truncated } = cappedCriteria(t.criteria);
      return { id: t.id, title: t.title, criteria, ...(truncated ? { criteria_truncated: true } : {}), files: t.files, after: t.after };
    }),
    ...(remaining.length
      ? { plan: { path: planStatePath(run), note: `Criteria are listed only for remaining tasks sharing a file with the current task, each capped at ${REMAINING_CRITERIA_CAP} characters; every task's full criteria are in tasks[] of this file.` } }
      : {}),
  };
}

export function scopeGuidance(run, task) {
  if (!task || !run.tasks.some(t => t.id !== task.id && t.status !== 'done')) return '';
  return ' For development and review, task.criteria and task.checks define the current acceptance boundary; the goal provides overall context. task_scope.remaining_tasks identifies work assigned elsewhere, including in shared files: preserve it without completing it early. It always lists id, title, files and after; criteria appear only for tasks sharing a file with the current task, capped per task, and task_scope.plan.path holds the full criteria of every task if you need them. Make supporting changes needed by the current criteria, but do not absorb unrelated criteria from remaining tasks. final_checks are required now only when task_scope.final_checks_required is true; otherwise they are integration context, not an intermediate completion gate. Verification focus applies to the current changes and their regressions; it does not expand the task to all remaining work.';
}
