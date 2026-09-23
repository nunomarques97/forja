import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { providerInstallation } from './providers.mjs';
import { validateRouting } from './routing.mjs';
import { validateFinalChecks } from './quality.mjs';
import { coreBudgets } from './budgets.mjs';

export function doctor(root, { provider = 'claude', config = {}, inspectProvider = providerInstallation } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 24 ? 'ok' : 'error', `Node ${process.versions.node}; requires Node 24 or newer.`);
  const version = git(['--version']);
  add('git', version.status === 0 ? 'ok' : 'error', version.status === 0 ? 'Git is available.' : 'Git is missing or could not run.');
  const project = git(['rev-parse', '--show-toplevel']);
  const isRoot = project.status === 0 && (process.platform === 'win32' ? resolve(project.stdout.trim()).toLowerCase() === resolve(root).toLowerCase() : resolve(project.stdout.trim()) === resolve(root));
  add('project', isRoot ? 'ok' : 'error', isRoot ? 'Current directory is the Git project root.' : 'Run from the target Git project root or pass --project.');
  if (isRoot) {
    const status = git(['status', '--porcelain']);
    add('worktree', status.status !== 0 ? 'error' : status.stdout.trim() ? 'warning' : 'ok', status.status !== 0 ? 'Could not inspect working-tree status.' : status.stdout.trim() ? 'Uncommitted work exists. Review it before using --allow-dirty; FORJA preserves existing edits.' : 'Working tree is clean.');
    const ignored = git(['check-ignore', '--no-index', '.forja/current.json']);
    add('private_state', ignored.status === 0 ? 'ok' : 'warning', ignored.status === 0 ? '.forja state is ignored.' : 'Ignore .forja/ before starting. core init can add it and instruction references; review its changes.');
  }
  try { coreBudgets(config); validateRouting(config, provider); validateFinalChecks(config); }
  catch { add('configuration', 'error', 'Invalid budget, routing or finalChecks configuration. Check the documented budget ranges, config schema and concrete command targets.'); return { ready: false, checks, providers: [] }; }
  add('configuration', 'ok', 'Budget, routing and finalChecks configuration is valid.');
  const usesDefault = ['plan', 'develop', 'review'].some(phase => !config.routes?.[phase]);
  const names = [...new Set([...(usesDefault ? [provider] : []), ...Object.values(config.routes || {}).map(r => r.provider)])];
  const providers = names.map(name => inspectProvider(name, { ...(name === provider ? config.provider || {} : {}), ...config.providers?.[name] }, { cwd: root }));
  for (const item of providers) add(`provider:${item.provider}`, item.installed === false ? 'error' : item.installed === true ? 'ok' : 'warning', item.note);
  return { ready: !checks.some(c => c.status === 'error'), checks, providers, note: 'Local prerequisites only; readiness does not confirm account login, model availability, quota or task success. No model calls or project changes were made.' };
}
