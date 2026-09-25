import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inside, repoFiles } from './files.mjs';
import { protectedFileNames } from './protected-files.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateDelivery(config) {
  const value = config.delivery;
  if (value === undefined) return null;
  if (!object(value) || Object.keys(value).some(k => !['mode', 'policyFile', 'production', 'granularity'].includes(k)) || !['commit', 'push'].includes(value.mode))
    throw new Error('delivery requires mode commit or push and an optional policyFile.');
  if (value.granularity !== undefined && !['run', 'task'].includes(value.granularity))
    throw new Error('delivery.granularity must be run (default) or task.');
  if (value.production !== undefined && typeof value.production !== 'boolean') throw new Error('delivery.production must be an explicit boolean.');
  if (value.production && value.mode !== 'push') throw new Error('Production authorization requires delivery.mode push.');
  if (value.policyFile !== undefined) protectedFileNames({ protectedFiles: [value.policyFile] });
  if (value.mode === 'push' && !value.policyFile) throw new Error('Automatic push requires a delivery policyFile.');
  return value;
}

export function validatePublicationPolicy(value) {
  if (!object(value) || value.version !== 1 || Object.keys(value).some(k => !['version', 'destination', 'pipeline', 'pipelineFiles'].includes(k)) ||
      !object(value.destination) || Object.keys(value.destination).some(k => !['url', 'branch', 'baseBranch'].includes(k)) ||
      !object(value.pipeline) || Object.keys(value.pipeline).some(k => !['effect', 'description'].includes(k))) throw new Error('Invalid delivery policy.');
  const { url, branch, baseBranch } = value.destination;
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Delivery destination must be an explicit HTTPS or SSH URL.'); }
  if (!['https:', 'ssh:', 'file:'].includes(parsed.protocol) || parsed.password || (parsed.protocol !== 'ssh:' && parsed.username) || parsed.search || parsed.hash || /[\s\x00-\x1f]/.test(url))
    throw new Error('Unsafe delivery URL; credentials, options and URL rewrites are not accepted.');
  // file: supports local offline qualification and local Git servers; no shell URL syntax.
  for (const ref of [branch, baseBranch]) if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.split('/').some(p => p.startsWith('.') || p.endsWith('.lock')))
    throw new Error('Invalid delivery branch or baseBranch.');
  if (!['none', 'preview', 'production', 'unknown'].includes(value.pipeline.effect) || typeof value.pipeline.description !== 'string' || !value.pipeline.description.trim() || value.pipeline.description.length > 2000)
    throw new Error('Delivery policy must describe the known pipeline effect, including external hosting integrations.');
  protectedFileNames({ protectedFiles: value.pipelineFiles });
  if (!Array.isArray(value.pipelineFiles)) throw new Error('Delivery policy requires an explicit pipelineFiles list (possibly empty).');
  return value;
}

const pipelinePath = path => /^(?:\.github\/workflows\/|\.circleci\/|\.gitlab-ci\.yml$|azure-pipelines\.ya?ml$|Jenkinsfile$|vercel\.json$|netlify\.toml$|firebase\.json$|cloudbuild\.ya?ml$|bitbucket-pipelines\.yml$)/i.test(path);
export function deliveryPolicySnapshot(root, config) {
  const delivery = validateDelivery(config);
  if (!delivery?.policyFile) return null;
  const policy = validatePublicationPolicy(JSON.parse(readFileSync(inside(root, delivery.policyFile), 'utf8')));
  const paths = [...new Set([delivery.policyFile, ...policy.pipelineFiles, ...repoFiles(root).filter(pipelinePath)])].sort();
  const files = paths.map(path => {
    const abs = inside(root, path);
    if (!existsSync(abs)) throw new Error('A declared delivery policy/pipeline file is missing.');
    return { path, sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') };
  });
  return { policy, files };
}

export function assertDeliveryPolicy(root, run) {
  if (JSON.stringify(deliveryPolicySnapshot(root, run.config)) !== JSON.stringify(run.deliveryPolicy ?? null))
    throw new Error('Delivery contract or pipeline changed during the run. Publication is blocked; review the new contract explicitly.');
}

// Task granularity: one reviewed local commit per task that changes source.
export const taskGranularity = run => run.config?.delivery?.granularity === 'task';

export function publicationPermission(run) {
  if (run.config.delivery?.mode !== 'push') return { allowed: false, reason: 'Commit-only delivery was requested.' };
  const policy = run.deliveryPolicy?.policy;
  if (!policy || policy.pipeline.effect === 'unknown') return { allowed: false, reason: 'Pipeline effects are unknown; the local commit is preserved, push is blocked.' };
  if (policy.pipeline.effect === 'production' && run.config.delivery.production !== true)
    return { allowed: false, reason: 'This push deploys to production and needs explicit delivery.production authorization.' };
  return { allowed: true, destination: policy.destination, effect: policy.pipeline.effect };
}
