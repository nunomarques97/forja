import { formatBytes } from './format.mjs';

export function statusLine(job) {
  const artifact = job.artifactBytes ? `, artifact ${formatBytes(job.artifactBytes)}` : '';
  return `${job.name}: ${job.ok ? 'ok' : 'failed'}, took ${job.durationMs}ms${artifact}`;
}

export function summaryData(jobs) {
  return { jobs: jobs.length, failed: jobs.filter(job => !job.ok).length, totalMs: jobs.reduce((ms, job) => ms + job.durationMs, 0) };
}

export function summary(jobs) {
  const { jobs: count, failed, totalMs } = summaryData(jobs);
  return `${count} jobs, ${failed} failed, total ${totalMs}ms`;
}
