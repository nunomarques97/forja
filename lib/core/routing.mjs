import { tierFor, modelFor, TIERS } from './providers.mjs';
import { risks } from './context.mjs';
import { validateWorkerAccess } from './worker-access.mjs';

const providers = ['claude', 'codex', 'kilo', 'custom'];
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
      // Codex OSS is the original pilot; Kilo drives loopback Ollama on hosts without Codex.
      if (route.localProvider !== undefined && (!['codex', 'kilo'].includes(route.provider) || route.localProvider !== 'ollama' || !route.model || /cloud/i.test(route.model))) throw new Error('Local routes require Codex or Kilo, Ollama and an explicit local model.');
      if (route.maxMinutes !== undefined && (!Number.isInteger(route.maxMinutes) || route.maxMinutes < 1 || route.maxMinutes > 180)) throw new Error('Route maxMinutes must be in 1..180.');
    }
  }
  if (config.providers !== undefined && (!object(config.providers) || Object.entries(config.providers).some(([name, settings]) => !providers.includes(name) || !object(settings)))) throw new Error('Invalid provider configuration map.');
  for (const settings of [config.provider, ...Object.values(config.providers || {})].filter(v => v !== undefined)) {
    if (!object(settings)) throw new Error('Provider settings must be an object.');
    if (settings.fullAccess !== undefined && typeof settings.fullAccess !== 'boolean') throw new Error('Provider fullAccess must be a boolean.');
    if (settings.writePolicy !== undefined && settings.writePolicy !== 'restricted') throw new Error('Invalid provider writePolicy.');
    if (settings.command !== undefined && (typeof settings.command !== 'string' || !settings.command.trim())) throw new Error('Provider command must be a non-empty string.');
    if (settings.args !== undefined && (!Array.isArray(settings.args) || settings.args.some(a => typeof a !== 'string'))) throw new Error('Provider args must be a string array.');
    for (const field of ['models', 'efforts']) if (settings[field] !== undefined && (!object(settings[field]) || Object.entries(settings[field]).some(([tier, value]) => !TIERS.includes(tier) || (value !== null && (typeof value !== 'string' || !value.trim()))))) throw new Error(`Invalid provider ${field}.`);
  }
  if (config.maxCloudSessions !== undefined && (!Number.isInteger(config.maxCloudSessions) || config.maxCloudSessions < 0 || config.maxCloudSessions > 200)) throw new Error('maxCloudSessions must be in 0..200.');
  validateEscalation(config);
  if (config.provider) validateWorkerAccess(defaultProvider, { ...config.provider, ...config.providers?.[defaultProvider] });
  for (const [name, settings] of Object.entries(config.providers || {})) validateWorkerAccess(name, settings);
  if (config.mcp && Object.values(config.providers || {}).concat(config.provider || []).some(s => s.writePolicy === 'restricted') &&
      (!object(config.mcp.mcpServers) || Object.keys(config.mcp).some(k => k !== 'mcpServers') || Object.keys(config.mcp.mcpServers).length))
    throw new Error('Restricted writePolicy requires an empty MCP configuration.');
}

// Opt-in escalation: a develop task on a local route that exhausts its
// attempts or ends without a usable result continues on one explicit Claude
// CLI route. It is the only path from local to cloud, so the target is closed:
// the subscription CLI, never a local or other provider.
const ESCALATION_FIELDS = ['route', 'maxEscalations', 'attempts'];
export const ESCALATION_MAX = 10;
export function validateEscalation(config = {}) {
  const policy = config.escalation;
  if (policy === undefined) return;
  if (!object(policy) || Object.keys(policy).some(k => !ESCALATION_FIELDS.includes(k))) throw new Error(`escalation must be an object with ${ESCALATION_FIELDS.join(', ')}.`);
  const route = policy.route;
  if (!object(route) || route.provider !== 'claude') throw new Error('escalation.route must name provider "claude" (the subscription Claude CLI).');
  for (const name of Object.keys(route)) if (!['provider', 'model', 'effort', 'maxMinutes'].includes(name)) throw new Error(`Unknown escalation route field: ${name}; an escalation route cannot be local.`);
  if (route.model !== undefined && (typeof route.model !== 'string' || !route.model.trim())) throw new Error('Escalation model must be a non-empty string.');
  if (route.effort !== undefined && !['low', 'medium', 'high', 'max', 'xhigh'].includes(route.effort)) throw new Error('Invalid escalation effort.');
  if (route.maxMinutes !== undefined && (!Number.isInteger(route.maxMinutes) || route.maxMinutes < 1 || route.maxMinutes > 180)) throw new Error('Escalation maxMinutes must be in 1..180.');
  if (policy.maxEscalations !== undefined && (!Number.isInteger(policy.maxEscalations) || policy.maxEscalations < 1 || policy.maxEscalations > ESCALATION_MAX)) throw new Error(`escalation.maxEscalations must be in 1..${ESCALATION_MAX}.`);
  if (policy.attempts !== undefined && (!Number.isInteger(policy.attempts) || policy.attempts < 1 || policy.attempts > 5)) throw new Error('escalation.attempts must be in 1..5.');
  if (config.maxCloudSessions === 0) throw new Error('escalation needs cloud sessions: maxCloudSessions 0 forbids it. Remove escalation or allow cloud sessions.');
  if (!Object.entries(config.routes || {}).some(([key, r]) => key.split('.')[0] === 'develop' && r?.localProvider)) throw new Error('escalation applies to local develop routes only; this profile has none.');
}
// An API key or endpoint override would turn the Claude CLI into a paid API client.
export const escalationEnvironmentProblem = (env = process.env) =>
  ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'].filter(key => env[key]).join(', ') || null;

export function routeFor(run, phase, task = null) {
  const plannedRisk = task ? risks(task, task.files || []) : {};
  const detected = task ? { ...task, risk: Object.fromEntries(Object.keys(plannedRisk).map(k => [k, plannedRisk[k] || task.risk?.[k] === true])) } : null;
  const tier = tierFor(phase, detected, task?.attempts || 1);
  const escalated = phase === 'develop' && !!task?.escalation && !!run.config.escalation;
  const key = escalated ? 'escalation' : run.config.routes?.[`${phase}.${tier}`] ? `${phase}.${tier}` : run.config.routes?.[phase] ? phase : 'default';
  const route = escalated ? run.config.escalation.route : key === 'default' ? { provider: run.provider } : run.config.routes[key];
  // A command for one native executor must never leak into another provider.
  const config = { ...(route.provider === run.provider ? run.config.provider || {} : {}), ...run.config.providers?.[route.provider] };
  validateWorkerAccess(route.provider, config);
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
