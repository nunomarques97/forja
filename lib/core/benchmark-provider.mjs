// Provider-specific controls stay outside the benchmark scheduler.
import { execute, executable, runProvider } from './providers.mjs';

function subscriptionEnvironment() {
  if (['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'].some(key => process.env[key]))
    throw Error('Benchmark requires the configured Claude subscription environment; API overrides are refused.');
}
export async function benchmarkAccess() {
  subscriptionEnvironment();
  const command = executable('claude');
  const r = await execute(command, ['--version'], { timeoutMs: 10000, maxBytes: 4096 });
  const version = r.stdout?.trim(), m = version?.match(/^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/);
  if (r.code !== 0 || !m || +m[1] < 2 || (+m[1] === 2 && (+m[2] < 1 || (+m[2] === 1 && +m[3] < 280))))
    throw Error('Benchmark requires Claude Code 2.1.280 or newer; no fallback.');
  return { command, version };
}
export function benchmarkTelemetry(stdout = '') {
  const events = stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const rates = events.filter(e => e?.type === 'rate_limit_event').map(e => e.rate_limit_info);
  const used = events.filter(e => e?.type === 'assistant').flatMap(e => Array.isArray(e.message?.content) ? e.message.content : [])
    .filter(c => c?.type === 'tool_use').map(c => c.name);
  return {
    stop_for_quota: rates.some(r => r?.isUsingOverage === true || r?.status === 'rejected' || r?.unifiedWindows?.seven_day?.utilization >= 0.95),
    quota_observed: rates.length > 0,
    unauthorized_tools: used.some(name => name !== 'StructuredOutput'),
  };
}
export async function benchmarkCall(options, access) {
  const current = await benchmarkAccess();
  if (current.command !== access.command || current.version !== access.version) throw Error('Benchmark provider installation changed.');
  const result = await runProvider('claude', { ...options, readOnly: true, responseOnly: true,
    config: { command: access.command, writePolicy: 'restricted' }, maxBytes: 4 * 1024 * 1024, contextLimit: 45000 });
  return { ...result, benchmark: benchmarkTelemetry(result.stdout) };
}
