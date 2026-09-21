import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Resolve npm launchers without concatenating task text into a shell command.
export function executable(name) {
  if (process.platform !== 'win32') return name;
  const r = spawnSync('where.exe', [name], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const candidates = (r.stdout || '').trim().split(/\r?\n/);
  const exe = candidates.find((p) => p.endsWith('.exe'));
  if (exe) return exe;
  if (name === 'claude')
    for (const p of candidates) {
      const native = join(
        dirname(p),
        'node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      );
      if (existsSync(native)) return native;
    }
  if (existsSync(name) && name.endsWith('.exe')) return name;
  throw new Error(
    `Cannot resolve native ${name} executable. Configure provider.command as an executable path.`,
  );
}
export function execute(
  command,
  args,
  {
    cwd,
    input = '',
    timeoutMs = 900000,
    maxBytes = 16 * 1024 * 1024,
    env = process.env,
    onLaunch = () => {},
    contextLimit = null,
  } = {},
) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '',
      stderr = '',
      bytes = 0,
      timedOut = false,
      overflow = false,
      contextExceeded = false,
      lastContextTokens = null,
      lineBuffer = '',
      child;
    const kill = () => {
      if (!child?.pid) return;
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    try {
      child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({
        code: -1,
        stdout,
        stderr: e.message,
        duration_ms: Date.now() - started,
      });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const stop = () => {
      stderr += '\nFORJA execution interrupted';
      kill();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    child.on('spawn', () => {
      try {
        onLaunch(child.pid);
      } catch (e) {
        stderr += e.message;
        kill();
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    for (const [stream, key] of [
      [child.stdout, 'stdout'],
      [child.stderr, 'stderr'],
    ])
      stream.setEncoding('utf8').on('data', (b) => {
        bytes += Buffer.byteLength(b);
        if (bytes > maxBytes) {
          overflow = true;
          kill();
          return;
        }
        if (key === 'stdout') {
          stdout += b.toString();
          if (contextLimit && !contextExceeded) {
            lineBuffer += b.toString();
            let newline;
            while ((newline = lineBuffer.indexOf('\n')) >= 0) {
              const line = lineBuffer.slice(0, newline);
              lineBuffer = lineBuffer.slice(newline + 1);
              try {
                const event = JSON.parse(line),
                  u = event.type === 'assistant' ? event.message?.usage : null;
                if (
                  u &&
                  [
                    u.input_tokens,
                    u.cache_creation_input_tokens,
                    u.cache_read_input_tokens,
                  ].every((n) => Number.isSafeInteger(n) && n >= 0)
                ) {
                  lastContextTokens =
                    u.input_tokens +
                    u.cache_creation_input_tokens +
                    u.cache_read_input_tokens;
                  if (lastContextTokens >= contextLimit) {
                    contextExceeded = true;
                    kill();
                    break;
                  }
                }
              } catch {}
            }
          }
        } else stderr += b.toString();
      });
    child.on('error', (e) => {
      stderr += e.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        overflow,
        contextExceeded,
        lastContextTokens,
        duration_ms: Date.now() - started,
      });
    });
  });
}
export const TIERS = ['fast', 'normal', 'strong', 'critical'];
export function tierFor(phase, task, attempt = 1) {
  if (phase === 'review') return task?.risk?.security ? 'critical' : 'strong';
  if (
    attempt > 1 ||
    task?.complexity === 'hard' ||
    task?.risks?.some((risk) => ['security', 'architecture'].includes(risk))
  )
    return 'strong';
  return task?.complexity === 'easy' ? 'fast' : 'normal';
}
const defaultModels = {
  claude: {
    fast: 'sonnet',
    normal: 'sonnet',
    strong: 'opus',
    critical: 'opus',
  },
  codex: { fast: null, normal: null, strong: null, critical: null },
};
export function modelFor(provider, tier, config = {}) {
  return config.models?.[tier] ?? defaultModels[provider]?.[tier] ?? null;
}
export function invocation(
  provider,
  {
    model,
    effort,
    schemaPath,
    resultPath,
    mcpPath,
    readOnly = false,
    config = {},
  },
) {
  if (provider === 'claude')
    return {
      command: config.command || executable('claude'),
      args: [
        ...(config.args || []),
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--json-schema',
        readFileSync(schemaPath, 'utf8'),
        '--permission-mode',
        'auto',
        '--strict-mcp-config',
        '--mcp-config',
        mcpPath,
        '--tools',
        readOnly
          ? 'Read,Grep,Glob'
          : 'Read,Write,Edit,Bash,PowerShell,Grep,Glob',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
      ],
    };
  if (provider === 'codex')
    return {
      command: config.command || executable('codex'),
      args: [
        ...(config.args || []),
        'exec',
        '--json',
        '--sandbox',
        readOnly ? 'read-only' : 'workspace-write',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        resultPath,
        ...(model ? ['--model', model] : []),
        ...(effort
          ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`]
          : []),
        '-',
      ],
    };
  // Future providers implement the same stdin/result/usage contract via an explicit executable.
  if (provider === 'custom' && config.command)
    return {
      command: config.command,
      args: (config.args || []).map((s) =>
        s.replaceAll('{schema}', schemaPath).replaceAll('{result}', resultPath),
      ),
    };
  throw new Error(`Unsupported provider: ${provider}`);
}
const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : null);
export function parseOutput(provider, stdout, resultPath) {
  let result = null,
    usage = null,
    calls = null,
    agentTurns = null,
    session = null,
    error = null,
    model = null,
    reportedCost = null;
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  if (provider === 'claude') {
    const e = events.findLast((e) => e.type === 'result') || events.at(-1);
    if (e) {
      result = e.structured_output;
      session = e.session_id;
      agentTurns = count(e.num_turns);
      const ids = new Set(
        events
          .filter(
            (x) => x.type === 'assistant' && typeof x.message?.id === 'string',
          )
          .map((x) => x.message.id),
      );
      calls = ids.size || null;
      error = e.is_error ? e.result || e.subtype : null;
      if (!result && e.result)
        try {
          result = JSON.parse(e.result);
        } catch {}
      const u = e.usage;
      if (u)
        usage = {
          input_tokens: count(u.input_tokens),
          cache_creation_input_tokens: count(u.cache_creation_input_tokens),
          cached_input_tokens: count(u.cache_read_input_tokens),
          output_tokens: count(u.output_tokens),
          source: 'provider result; input excludes cache fields',
        };
      model = e.modelUsage ? Object.keys(e.modelUsage).join(', ') : null;
      if (Number.isFinite(e.total_cost_usd) && e.total_cost_usd >= 0)
        reportedCost = e.total_cost_usd;
    }
  } else if (provider === 'codex') {
    if (existsSync(resultPath))
      try {
        result = JSON.parse(readFileSync(resultPath, 'utf8'));
      } catch {}
    const turns = events.filter((e) => e.type === 'turn.completed');
    session = events.find((e) => e.type === 'thread.started')?.thread_id;
    if (turns.length) {
      const sum = (f) =>
        turns.every((e) => count(e.usage?.[f]) !== null)
          ? turns.reduce((n, e) => n + e.usage[f], 0)
          : null;
      usage = {
        input_tokens: sum('input_tokens'),
        cached_input_tokens: sum('cached_input_tokens'),
        output_tokens: sum('output_tokens'),
        source: 'provider turn.completed; cached is subset of input',
      };
    }
    // A Codex turn can contain many model calls; do not call it one model call.
    error =
      events.find((e) => e.type === 'turn.failed' || e.type === 'error')
        ?.message ||
      events.find((e) => e.type === 'turn.failed')?.error?.message ||
      null;
  } else {
    const e = events.at(-1);
    result = e?.result || e;
    usage = e?.usage || null;
  }
  return {
    result,
    usage,
    calls,
    turns: agentTurns,
    session,
    error,
    reported_model: model,
    reported_cost_usd: reportedCost,
  };
}
export async function runProvider(provider, options) {
  const spec = invocation(provider, options);
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.FORJA_RUNNER;
  const result = await execute(spec.command, spec.args, {
    ...options,
    env,
    contextLimit: provider === 'claude' ? options.contextLimit : null,
  });
  writeFileSync(
    options.logPath,
    JSON.stringify({ stdout: result.stdout, stderr: result.stderr }),
  );
  return {
    ...result,
    ...parseOutput(provider, result.stdout, options.resultPath),
  };
}
