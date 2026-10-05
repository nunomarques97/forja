import { formatBytes } from './format.mjs';

export function statusLine(job) {
  const artifact = job.artifactBytes ? `, artifact ${formatBytes(job.artifactBytes)}` : '';
  return `${job.name}: ${job.ok ? 'ok' : 'failed'}, took ${job.durationMs}ms${artifact}`;
}

export function summary(jobs) {
  const failed = jobs.filter(job => !job.ok).length;
  const total = jobs.reduce((ms, job) => ms + job.durationMs, 0);
  return `${jobs.length} jobs, ${failed} failed, total ${total}ms`;
}
