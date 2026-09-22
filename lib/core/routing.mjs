import { tierFor, modelFor, TIERS } from './providers.mjs';
import { risks } from './context.mjs';

const providers = ['claude', 'codex', 'custom'];
const phases = ['plan', 'develop', 'review'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateRouting(config = {}, defaultProvider = 'claude') {
  if (!providers.includes(defaultProvider)) throw new Error('Invalid routing default provider.');
  if (config.routes !== undefined) {
    if (!object(config.routes)) throw new Error('routes must be an object.');
    for (const [key, route] of Object.entries(config.routes)) {
      const [phase, tier, extra] = key.split('.');
      if (!phases.includes(phase) || (tier !== undefined && !TIERS.includes(tier)) || extra !== undefined)
        throw new Error(`Unknown routing selector: ${key}`);
      if (!object(route) || !providers.includes(route.provider)) throw new Error(`Invalid route: ${key}`);
      for (const name of Object.keys(route)) if (!['provider', 'model', 'effort', 'localProvider', 'maxMinutes'].includes(name)) throw new Error(`Unknown route field: ${name}`);
      if (route.model !== undefined && (typeof route.model !== 'string' || !route.model.trim())) throw new Error('Route model must be a non-empty string.');
      if (route.effort !== undefined && !['low', 'medium', 'high', 'max', 'xhigh'].includes(route.effort)) throw new Error('Invalid route effort.');
      if (route.localProvider !== undefined && (route.provider !== 'codex' || route.localProvider !== 'ollama' || !route.model || /cloud/i.test(route.model))) throw new Error('Local routes require Codex, Ollama and an explicit local model.');
      if (route.maxMinutes !== undefined && (!Number.isInteger(route.maxMinutes) || route.maxMinutes < 1 || route.maxMinutes > 180)) throw new Error('Route maxMinutes must be in 1..180.');
    }
  }
  if (config.providers !== undefined && (!object(config.providers) || Object.entries(config.providers).some(([name, settings]) => !providers.includes(name) || !object(settings)))) throw new Error('Invalid provider configuration map.');
  for (const settings of [config.provider, ...Object.values(config.providers || {})].filter(v => v !== undefined)) {
    if (!object(settings)) throw new Error('Provider settings must be an object.');
    if (settings.fullAccess !== undefined && typeof settings.fullAccess !== 'boolean') throw new Error('Provider fullAccess must be a boolean.');
    if (settings.command !== undefined && (typeof settings.command !== 'string' || !settings.command.trim())) throw new Error('Provider command must be a non-empty string.');
    if (settings.args !== undefined && (!Array.isArray(settings.args) || settings.args.some(a => typeof a !== 'string'))) throw new Error('Provider args must be a string array.');
    for (const field of ['models', 'efforts']) if (settings[field] !== undefined && (!object(settings[field]) || Object.entries(settings[field]).some(([tier, value]) => !TIERS.includes(tier) || (value !== null && (typeof value !== 'string' || !value.trim()))))) throw new Error(`Invalid provider ${field}.`);
  }
  if (config.maxCloudSessions !== undefined && (!Number.isInteger(config.maxCloudSessions) || config.maxCloudSessions < 0 || config.maxCloudSessions > 200)) throw new Error('maxCloudSessions must be in 0..200.');
}

export function routeFor(run, phase, task = null) {
  const plannedRisk = task ? risks(task, task.files || []) : {};
  const detected = task ? { ...task, risk: Object.fromEntries(Object.keys(plannedRisk).map(k => [k, plannedRisk[k] || task.risk?.[k] === true])) } : null;
  const tier = tierFor(phase, detected, task?.attempts || 1);
  const key = run.config.routes?.[`${phase}.${tier}`] ? `${phase}.${tier}` : run.config.routes?.[phase] ? phase : 'default';
  const route = key === 'default' ? { provider: run.provider } : run.config.routes[key];
  // A command for one native executor must never leak into another provider.
  const config = { ...(route.provider === run.provider ? run.config.provider || {} : {}), ...run.config.providers?.[route.provider] };
  if (route.provider === 'custom' && config.fullAccess === true) throw new Error('fullAccess requires a native Claude or Codex provider; configure custom executor permissions directly.');
  const model = route.model ?? modelFor(route.provider, tier, config);
  const effort = route.effort ?? config.efforts?.[tier] ?? null;
  if (effort !== null && !['low', 'medium', 'high', 'max', 'xhigh'].includes(effort)) throw new Error('Invalid configured provider effort.');
  if (route.localProvider) {
    if (config.args?.length) throw new Error('Local routing refuses extra native CLI arguments; use the explicit local options.');
    config.localProvider = route.localProvider;
  } else if (config.localProvider) {
    throw new Error('Set localProvider in an explicit route, not shared provider settings.');
  }
  return { provider: route.provider, config, model, effort, tier, selector: key, backend: route.localProvider || route.provider, local: !!route.localProvider, maxMinutes: Math.min(run.limits.minutes, route.maxMinutes ?? run.limits.minutes) };
}
