// Keep the worker's acceptance boundary identical to the scheduler's gate,
// including integration checks retained when a completed task needs repair.
export function finalChecksApply(run, task) {
  return !!task && (
    run.finalCheckTaskId === task.id ||
    (run.tasks.some(t => t.status !== 'done') &&
      run.tasks.every(t => t.id === task.id || t.status === 'done'))
  );
}

export function taskScope(run, task) {
  return {
    final_checks_required: finalChecksApply(run, task),
    remaining_tasks: run.tasks
      .filter(t => t.id !== task?.id && t.status !== 'done')
      .map(t => ({
        id: t.id,
        title: t.title,
        criteria: t.criteria,
        files: t.files,
        after: t.after,
      })),
  };
}

export function scopeGuidance(run, task) {
  if (!task || !run.tasks.some(t => t.id !== task.id && t.status !== 'done')) return '';
  return ' For development and review, task.criteria and task.checks define the current acceptance boundary; the goal provides overall context. task_scope.remaining_tasks identifies work assigned elsewhere, including in shared files: preserve it without completing it early. Make supporting changes needed by the current criteria, but do not absorb unrelated criteria from remaining tasks. final_checks are required now only when task_scope.final_checks_required is true; otherwise they are integration context, not an intermediate completion gate. Verification focus applies to the current changes and their regressions; it does not expand the task to all remaining work.';
}
