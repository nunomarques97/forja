import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync, accessSync, mkdirSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, delimiter, isAbsolute, resolve } from 'node:path';
import { providerTrace } from './provider-trace.mjs';
import { processTree } from './process-tree.mjs';
import { validateWorkerAccess, restrictedSettings, restrictedMcp, workerScratch, workerAccessPrompt, seedProgressNotes, readProgressNotes, progressNotesPrompt } from './worker-access.mjs';

// Resolve npm launchers without concatenating task text into a shell command.
export function providerInstallation(provider, config = {}, { cwd = process.cwd() } = {}) {
  if (!['claude', 'codex', 'kilo'].includes(provider)) return { provider, installed: null, context_guard: 'unavailable', note: 'Custom executors require manual verification.' };
  const guard = ['claude', 'kilo'].includes(provider) ? 'observed_request' : 'unavailable';
  let command;
  try { command = nativeCommand(provider, config); } catch { return { provider, installed: false, context_guard: guard, note: 'Native executable not found. Install the provider CLI or configure provider.command.' }; }
  const candidates = isAbsolute(command) || /[\\/]/.test(command) ? [resolve(cwd, command)] : (process.env.PATH || '').split(delimiter).filter(Boolean).flatMap(dir => [join(dir, command), ...(process.platform === 'win32' && !command.endsWith('.exe') ? [join(dir, command + '.exe')] : [])]);
  const installed = candidates.some(path => {
    try { if (!statSync(path).isFile()) return false; accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
  });
  return { provider, installed, context_guard: guard, ...(provider === 'kilo' && installed ? { command } : {}), note: installed ? 'Executable found. Authentication, model access and quota were not checked; no provider was invoked.' : 'Native executable not found. Install the provider CLI or configure provider.command.' };
}

// Organization builds of the Kilo Code VS Code extension (publisher.kilo-code)
// bundle a CLI with their own gateway provider; the public npm CLI does not
// know that provider. Prefer the newest bundled CLI over PATH.
export function kiloExecutable({ home = homedir(), platform = process.platform } = {}) {
  const exe = platform === 'win32' ? 'kilo.exe' : 'kilo';
  const bundled = [];
  for (const root of ['.vscode/extensions', '.vscode-insiders/extensions', '.cursor/extensions']) {
    let entries = [];
    try { entries = readdirSync(join(home, root)); } catch { continue; }
    for (const name of entries) {
      const match = name.match(/^[\w-]+\.kilo-code-(\d+)\.(\d+)\.(\d+)$/);
      const path = join(home, root, name, 'bin', exe);
      if (match && existsSync(path)) bundled.push({ path, version: match.slice(1).map(Number) });
    }
  }
  bundled.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
  return bundled.length ? bundled[0].path : executable('kilo');
}
const nativeCommand = (provider, config = {}) => config.command || (provider === 'kilo' ? kiloExecutable() : executable(provider));

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
  // The npm kilo shim wraps a platform binary package, nested or hoisted.
  if (name === 'kilo')
    for (const p of candidates)
      for (const native of [
        'node_modules/@kilocode/cli/node_modules/@kilocode/cli-windows-x64/bin/kilo.exe',
        'node_modules/@kilocode/cli-windows-x64/bin/kilo.exe',
      ].map((rel) => join(dirname(p), rel)))
        if (existsSync(native)) return native;
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
    onStdoutLine = null,
    processTree: treeOptions = {},
  } = {},
) {
  return new Promise((resolve) => {
    const started = Date.now();
    const monotonicStart = performance.now();
    let stdout = '',
      stderr = '',
      bytes = 0,
      timedOut = false,
      overflow = false,
      interrupted = false,
      contextExceeded = false,
      lastContextTokens = null,
      lineBuffer = '',
      observationError = null,
      closed = false,
      exited = false,
      tree = null,
      cleanup = null,
      child;
    // While the spawned process has not exited its PID cannot be reused, so the
    // whole live tree can be killed by PID; afterwards only the tracked tree.
    const kill = () => {
      if (closed || exited || !child?.pid) return;
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
      if (child.pid) tree = processTree(child.pid, { ...treeOptions, spawnedAt: Date.now() });
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
    // The operator's Ctrl+C (or a termination signal) is not a command failure:
    // callers must stop instead of recording a result.
    const stop = () => {
      interrupted = true;
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
    const observeLine = (line) => {
      if (onStdoutLine && !observationError) {
        try { onStdoutLine(line, Math.floor(performance.now() - monotonicStart)); }
        catch (error) {
          observationError = `Provider trace failed: ${error.message}`;
          kill();
        }
      }
      if (!contextLimit || contextExceeded) return;
      try {
        const tokens = requestContextTokens(JSON.parse(line));
        if (tokens !== null) {
          lastContextTokens = tokens;
          if (lastContextTokens >= contextLimit) { contextExceeded = true; kill(); }
        }
      } catch {}
    };
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
          if (contextLimit || onStdoutLine) {
            lineBuffer += b.toString();
            let newline;
            while ((newline = lineBuffer.indexOf('\n')) >= 0) {
              const line = lineBuffer.slice(0, newline);
              lineBuffer = lineBuffer.slice(newline + 1);
              observeLine(line);
            }
          }
        } else stderr += b.toString();
      });
    child.on('error', (e) => {
      stderr += e.message;
    });
    // The session ended: terminate what it left behind. A leftover process that
    // still holds the output pipes would otherwise delay 'close' indefinitely.
    child.on('exit', () => {
      exited = true;
      if (!tree) return;
      tree.exited();
      cleanup = tree.cleanup();
      cleanup.then(() => setTimeout(() => {
        if (!closed) { child.stdout.destroy(); child.stderr.destroy(); }
      }, 2000).unref());
    });
    child.on('close', async (code) => {
      closed = true;
      clearTimeout(timer);
      const processReport = tree ? await (cleanup || tree.cleanup()) : null;
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      if (lineBuffer) observeLine(lineBuffer);
      resolve({
        code: code ?? -1,
        stdout,
        stderr,
        timedOut,
        overflow,
        interrupted,
        contextExceeded,
        lastContextTokens,
        observationError,
        processCleanup: processReport,
        duration_ms: Date.now() - started,
      });
    });
  });
}
// Request context observed in a stream event: Claude assistant usage or a Kilo
// step_finish (whose input excludes cache reads and writes).
export function requestContextTokens(event) {
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  if (event?.type === 'assistant') {
    const u = event.message?.usage;
    if (u && [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].every(valid))
      return u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  }
  if (event?.type === 'step_finish') {
    const t = event.part?.tokens;
    if (t && [t.input, t.cache?.read, t.cache?.write].every(valid)) return t.input + t.cache.read + t.cache.write;
  }
  return null;
}
export const TIERS = ['fast', 'normal', 'strong', 'critical'];
export function tierFor(phase, task, attempt = 1) {
  if (phase === 'review') return task?.risk?.security ? 'critical' : 'strong';
  if (
    attempt > 1 ||
    task?.risk?.security || task?.risk?.architecture ||
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
  kilo: { fast: null, normal: null, strong: null, critical: null },
};
// Kilo permission policy per phase. "*": "deny" hides every tool not listed;
// user and project Kilo configuration is excluded by kiloEnv. Kilo has no
// per-path deny that FORJA can rely on, so protected paths remain enforced by
// the controller's own state, HEAD and protected-file checks.
export function kiloPermissions({ readOnly = false, restricted = false, fullAccess = false, research = false } = {}) {
  if (fullAccess) return { '*': 'allow' };
  const permission = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' };
  if (readOnly) return research ? { ...permission, webfetch: 'allow', websearch: 'allow' } : permission;
  // Develop writes progress notes in the invocation scratch, outside the project.
  Object.assign(permission, { edit: 'allow', todowrite: 'allow', external_directory: 'allow' });
  if (!restricted) permission.bash = KILO_DEVELOP_BASH;
  return permission;
}
// Workers never commit; a local developer in the stress suite still ran
// git commit and the controller stopped on the changed HEAD with a correct
// change. Kilo refuses these Git subcommands (also after `git -c k=v`) and
// reports the refusal to the model; the controller's HEAD check stays.
const GIT_DENIED = ['commit', 'push', 'pull', 'fetch', 'reset', 'rebase', 'merge', 'cherry-pick', 'revert', 'am', 'stash', 'tag', 'checkout', 'switch', 'branch', 'update-ref', 'symbolic-ref', 'worktree', 'notes', 'replace', 'filter-branch', 'gc'];
export const KILO_DEVELOP_BASH = Object.freeze({ '*': 'allow', ...Object.fromEntries(GIT_DENIED.flatMap(sub => [[`git ${sub}*`, 'deny'], [`git * ${sub}*`, 'deny']])) });
// A local route enables only the loopback Ollama provider, so neither the task
// model nor Kilo's auxiliary (title) model can reach a cloud provider.
export function kiloLocalConfig(model, contextTokens = null) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('A local Kilo route requires an explicit Ollama model.');
  const id = `ollama/${model}`;
  return {
    enabled_providers: ['ollama'],
    model: id,
    small_model: id,
    provider: {
      ollama: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama (local)',
        options: { baseURL: `${OLLAMA_ENDPOINT}/v1` },
        models: { [model]: { name: model, tool_call: true, ...(Number.isSafeInteger(contextTokens) && contextTokens > 0 ? { limit: { context: contextTokens, output: Math.min(8192, Math.floor(contextTokens / 4)) } } : {}) } },
      },
    },
  };
}
export function kiloEnv({ scratchPath, readOnly, restricted, fullAccess, research, local = null }) {
  if (typeof scratchPath !== 'string' || !isAbsolute(scratchPath)) throw new Error('Kilo invocations require an invocation scratch directory.');
  // An empty config home excludes the user's global Kilo permissions; auth
  // lives in Kilo's data directory and is unaffected.
  const configHome = join(dirname(scratchPath), 'kilo-config');
  mkdirSync(configHome, { recursive: true, mode: 0o700 });
  return {
    XDG_CONFIG_HOME: configHome,
    KILO_DISABLE_PROJECT_CONFIG: '1',
    KILO_DISABLE_AUTOUPDATE: '1',
    KILO_DISABLE_SHARE: '1',
    KILO_DISABLE_SESSION_INGEST: '1',
    KILO_CONFIG_CONTENT: JSON.stringify({
      permission: kiloPermissions({ readOnly, restricted, fullAccess, research }),
      share: 'disabled',
      autoupdate: false,
      // Kilo's undo snapshots are slow to build on large repositories; the
      // controller already snapshots the tree and Git tracks every change.
      snapshot: false,
      mcp: {},
      ...(local ? kiloLocalConfig(local.model, local.contextTokens) : {}),
    }),
  };
}
// Local models in the stress suite planned like developers (calling edit and
// bash, then reporting a fix) and reviewed with status "done": next to the
// schema, a local session is told its phase and the result that phase returns.
export const KILO_PHASE_ROLES = {
  plan: 'FORJA phase: plan. You are the planner, not the developer: this session has only read tools, so do not edit files, run commands or implement the change, and do not report it as done. After reading what you need, answer with the plan: a JSON object with "tasks" (1-30 tasks, each with id, title, criteria, files, risks, complexity, checks and after) and "decisions". A plan has no "status" field.',
  develop: 'FORJA phase: develop. "status" is exactly one of "ready_for_validation", "done", "blocked" or "checkpoint", with "summary" and "findings".',
  review: 'FORJA phase: review. This session has only read tools; do not edit files or run commands. "status" is exactly "approve" or "reject" ("blocked" only when access prevents the review), with "summary" and "findings".',
};
// Kilo has no structured-output flag; the final message carries the JSON.
export function kiloSchemaPrompt(schemaPath, phase = null) {
  return `\n${KILO_PHASE_ROLES[phase] ? `${KILO_PHASE_ROLES[phase]}\n` : ''}FORJA result format: end with a final message that is exactly one JSON object conforming to this JSON Schema, with no Markdown fence and no other text. Write file paths with forward slashes:\n${readFileSync(schemaPath, 'utf8')}\n`;
}
export function finalJson(text) {
  if (typeof text !== 'string') return null;
  const object = (candidate) => {
    for (const source of [candidate, candidate.replace(/\\(["\\/bfnrtu])|\\/g, (m, valid) => valid ? m : '\\\\')])
      try {
        const value = JSON.parse(source);
        if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      } catch {}
    return null;
  };
  // Balanced top-level objects, outside JSON strings; models may add prose or
  // fences around the answer, echo a draft first, or leave Windows paths with
  // single backslashes (repaired above). The last parseable object wins.
  const candidates = [];
  let depth = 0, from = -1, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"' && depth > 0) quoted = true;
    else if (c === '{') { if (depth++ === 0) from = i; }
    else if (c === '}' && depth > 0 && --depth === 0) candidates.push(text.slice(from, i + 1));
  }
  for (const candidate of candidates.reverse()) {
    const value = object(candidate);
    if (value) return value;
  }
  return null;
}
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
    responseOnly = false,
    research = false,
    scratchPath,
    protectedPaths = [],
    cwd,
    config = {},
    localContextTokens = null,
  },
) {
  validateWorkerAccess(provider, config);
  const restricted = config.writePolicy === 'restricted';
  if (typeof responseOnly !== 'boolean' || (responseOnly && (provider !== 'claude' || !restricted || !readOnly)))
    throw new Error('Response-only calls require restricted read-only Claude.');
  if (restricted) {
    restrictedMcp(mcpPath);
    if (typeof scratchPath !== 'string' || !isAbsolute(scratchPath) || !statSync(scratchPath).isDirectory()) throw new Error('Restricted writePolicy requires an invocation scratch directory.');
  }
  if (provider === 'claude')
    return {
      command: config.command || executable('claude'),
      args: [
        ...(config.args || []),
        ...(restricted ? ['--restricted', '--safe-mode', '--no-session-persistence', '--permission-prompts', 'none',
          '--add-dir', scratchPath, '--settings', JSON.stringify(restrictedSettings(protectedPaths)),
          ...(responseOnly ? [] : ['--allowedTools', readOnly ? 'Read,Grep,Glob' : 'Read,Grep,Glob,Write,Edit']), '--disallowedTools', 'mcp__*'] : []),
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--json-schema',
        readFileSync(schemaPath, 'utf8'),
        '--permission-mode',
        restricted ? 'dontAsk' : config.fullAccess === true ? 'bypassPermissions' : 'auto',
        ...(config.fullAccess === true ? ['--settings', JSON.stringify({ sandbox: { enabled: false } })] : []),
        '--strict-mcp-config',
        '--mcp-config',
        mcpPath,
        '--tools',
        responseOnly ? '' : restricted ? (readOnly ? 'Read,Grep,Glob' : 'Read,Write,Edit,Grep,Glob') : config.fullAccess === true ? 'default' : readOnly
          ? 'Read,Grep,Glob' + (research ? ',WebSearch,WebFetch' : '')
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
        ...(research && config.localProvider !== 'ollama' ? ['--search'] : []),
        'exec',
        ...(config.localProvider === 'ollama'
          ? ['--ignore-user-config', '--oss', '--local-provider', 'ollama', '-c', 'model_context_window=32768', '-c', 'model_auto_compact_token_limit=24000', ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : [])]
          : []),
        '--json',
        '--sandbox',
        config.fullAccess === true ? 'danger-full-access' : readOnly ? 'read-only' : 'workspace-write',
        ...(config.fullAccess === true ? ['-c', 'approval_policy="never"'] : []),
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
  if (provider === 'kilo') {
    const local = config.localProvider === 'ollama';
    if (local && (typeof model !== 'string' || !model.trim())) throw new Error('A local Kilo route requires an explicit Ollama model.');
    return {
      command: nativeCommand('kilo', config),
      args: [
        ...(config.args || []),
        'run',
        '--format',
        'json',
        // Kilo resolves its project from PWD, which a parent shell may have set.
        ...(cwd ? ['--dir', cwd] : []),
        ...(model ? ['--model', local ? `ollama/${model}` : model] : []),
        ...(effort ? ['--variant', effort] : []),
      ],
      env: { ...kiloEnv({ scratchPath, readOnly, restricted, fullAccess: config.fullAccess === true, research, local: local ? { model, contextTokens: localContextTokens } : null }), ...(cwd ? { PWD: cwd } : {}) },
    };
  }
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
// The reset time a usage-limit rejection reports (rate_limit_info.resetsAt):
// Unix seconds, Unix milliseconds or an ISO 8601 timestamp, as an ISO string.
// Anything else is no reported reset, never a guess.
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
export function resetTime(value) {
  let ms = null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) ms = value < 1e11 ? value * 1000 : value;
  else if (typeof value === 'string' && ISO_TIME.test(value)) ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > 8.64e15) return null;
  return new Date(ms).toISOString();
}
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
  } else if (provider === 'kilo') {
    const steps = events.filter((e) => e.type === 'step_finish' && e.part);
    session = events.find((e) => typeof e.sessionID === 'string')?.sessionID ?? null;
    calls = steps.length || null;
    // The answer is normally in the message that finished the run; a model may
    // still add a short closing message after it, so earlier messages follow.
    const textOf = (id) => events
      .filter((e) => e.type === 'text' && e.part?.messageID === id && typeof e.part.text === 'string')
      .map((e) => e.part.text)
      .join('');
    const messages = [...new Set(steps.map((e) => e.part.messageID))].reverse();
    for (const id of messages) if ((result = finalJson(textOf(id)))) break;
    const lastReason = steps.at(-1)?.part.reason;
    if (steps.length) {
      const sum = (f) =>
        steps.every((e) => count(f(e.part.tokens)) !== null)
          ? steps.reduce((n, e) => n + f(e.part.tokens), 0)
          : null;
      usage = {
        input_tokens: sum((t) => t?.input),
        cache_creation_input_tokens: sum((t) => t?.cache?.write),
        cached_input_tokens: sum((t) => t?.cache?.read),
        output_tokens: sum((t) => (count(t?.output) !== null && count(t?.reasoning) !== null ? t.output + t.reasoning : null)),
        source: 'provider step_finish sum; input excludes cache fields; output includes reasoning',
      };
      const models = [...new Set(steps.map((e) => e.part.model && `${e.part.model.providerID}/${e.part.model.modelID}`).filter(Boolean))];
      model = models.join(', ') || null;
      if (steps.every((e) => Number.isFinite(e.part.cost) && e.part.cost >= 0))
        reportedCost = steps.reduce((n, e) => n + e.part.cost, 0);
    }
    const failure = events.findLast((e) => e.type === 'error');
    error = failure
      ? failure.error?.data?.message || failure.error?.name || 'Kilo reported an error'
      : !result
        ? `Kilo returned no final JSON result${lastReason ? ` (last finish reason: ${lastReason})` : ''}`
        : null;
  } else {
    const e = events.at(-1);
    result = e?.result || e;
    usage = e?.usage || null;
  }
  // Only Claude's explicit rejection is a usage limit; warnings and text never are.
  const rejected = provider === 'claude' ? events.findLast(e => e?.type === 'rate_limit_event' && e.rate_limit_info?.status === 'rejected') : undefined;
  return {
    result,
    usage,
    calls,
    turns: agentTurns,
    session,
    error,
    reported_model: model,
    reported_cost_usd: reportedCost,
    rate_limited: rejected !== undefined,
    rate_limit_reset_at: rejected === undefined ? null : resetTime(rejected.rate_limit_info.resetsAt),
  };
}
export async function runProvider(provider, options) {
  validateWorkerAccess(provider, options.config);
  // Codex OSS keeps its original preflight; Kilo also needs a context window
  // that holds its own system prompt (about 8k tokens) plus the FORJA packet.
  const local = options.config?.localProvider === 'ollama' ? await localPreflight(options.model, fetch, { minContext: provider === 'kilo' ? KILO_LOCAL_MIN_CONTEXT : null }) : null;
  const restricted = options.config?.writePolicy === 'restricted';
  if (restricted) {
    restrictedMcp(options.mcpPath);
    restrictedSettings(options.protectedPaths);
    if (provider === 'claude') {
      const version = await execute(options.config.command || executable(provider), ['--version'], { cwd: options.cwd, timeoutMs: 10000, maxBytes: 4096 });
      const match = version.stdout?.trim().match(/^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/);
      if (version.code !== 0 || !match || (+match[1] < 2 || (+match[1] === 2 && (+match[2] < 1 || (+match[2] === 1 && +match[3] < 280)))))
        throw new Error('Restricted writePolicy requires Claude Code 2.1.280 or newer; no fallback.');
    }
  }
  const scratchPath = workerScratch();
  const spec = invocation(provider, { ...options, scratchPath, localContextTokens: local?.contextTokens ?? null });
  const env = { ...process.env, ...spec.env };
  for (const key of ['FORJA_SCRATCH_DIR', 'TMPDIR', 'TEMP', 'TMP']) env[key] = scratchPath;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.FORJA_RUNNER;
  // A worker's read-only git status must not rewrite the index under a delivery review.
  env.GIT_OPTIONAL_LOCKS = '0';
  if (local) {
    env.OLLAMA_HOST = '127.0.0.1:11434';
    // Codex OSS must stay on the preflighted loopback endpoint.
    delete env.OLLAMA_BASE_URL;
  }
  // Develop sessions get a notes file seeded with the previous session's notes.
  delete env.FORJA_PROGRESS_NOTES;
  const notesPath = typeof options.progressNotes === 'string' && !options.readOnly ? seedProgressNotes(scratchPath, options.progressNotes) : null;
  if (notesPath) env.FORJA_PROGRESS_NOTES = notesPath;
  const contextLimit = ['claude', 'kilo'].includes(provider) ? options.contextLimit : null;
  const trace = options.tracePath ? providerTrace(options.tracePath, provider) : null;
  let result, observations;
  try {
    result = await execute(spec.command, spec.args, {
      ...options,
      input: (options.input || '') + (options.responseOnly ? '\nFORJA response-only evaluation: all inputs are inline. No external tools, files, commands, research or delegation. Return only the requested structured response.\n' : provider === 'custom' ? '' : workerAccessPrompt({ scratch: scratchPath, restricted, readOnly: options.readOnly }) + (notesPath ? progressNotesPrompt(notesPath, contextLimit) : '')) + (provider === 'kilo' ? kiloSchemaPrompt(options.schemaPath, local ? options.phase : null) : ''),
      env,
      onStdoutLine: trace ? (line, elapsed) => trace.observe(line, elapsed) : null,
      contextLimit,
    });
    if (local && provider === 'kilo') result = await kiloResultFollowUp(spec, result, { ...options, env, contextLimit, trace });
  } finally { observations = trace?.finish() ?? null; }
  const progressNotes = notesPath ? readProgressNotes(notesPath) : null;
  writeFileSync(
    options.logPath,
    JSON.stringify({ stdout: result.stdout, stderr: result.stderr }),
  );
  const parsed = parseOutput(provider, result.stdout, options.resultPath);
  return {
    ...result,
    ...parsed,
    observations,
    ...(notesPath ? { progressNotes } : {}),
    access: { policy: restricted ? 'restricted' : options.config?.fullAccess === true ? 'fullAccess' : 'provider-default', scratch: scratchPath },
    error: result.observationError || parsed.error,
  };
}

// Local models often finish the work but, after long tool use, end with prose
// instead of the result format appended to the prompt. One follow-up in the
// same Kilo session (same permissions, remaining call time) asks for it alone.
// The same single follow-up names the problem when the final JSON is there but
// is not a result of the phase (options.resultProblem, supplied by the engine).
export const KILO_RESULT_REMINDER = '\nFORJA result format reminder: your session ended without the required final JSON result. Do not call tools or change files. Reply now with only the final JSON object conforming to the JSON Schema of the first message: no Markdown fence and no other text.\n';
export const kiloInvalidResultReminder = (problem, phase = null) =>
  `\nFORJA result format reminder: your final JSON is not a valid ${phase ? `${phase} ` : ''}result: ${String(problem).slice(0, 600)}${KILO_PHASE_ROLES[phase] ? ` ${KILO_PHASE_ROLES[phase]}` : ''} Do not call tools or change files. Reply now with only the corrected final JSON object conforming to the JSON Schema of the first message: no Markdown fence and no other text.\n`;
const FOLLOW_UP_MIN_MS = 15000;
export async function kiloResultFollowUp(spec, first, { timeoutMs = 900000, trace = null, resultProblem = null, phase = null, ...options } = {}) {
  if (first.code !== 0 || first.timedOut || first.overflow || first.interrupted || first.contextExceeded || first.observationError) return first;
  const parsed = parseOutput('kilo', first.stdout, null);
  const remaining = timeoutMs - (first.duration_ms ?? timeoutMs);
  const missing = !!parsed.error?.startsWith('Kilo returned no final JSON result');
  let invalid = null;
  if (!parsed.error && parsed.result && typeof resultProblem === 'function')
    try { invalid = resultProblem(parsed.result); } catch (error) { invalid = error.message; }
  if (!(missing || invalid) || typeof parsed.session !== 'string' || !/^[\w-]{1,200}$/.test(parsed.session) || remaining < FOLLOW_UP_MIN_MS) return first;
  const offset = first.duration_ms;
  const next = await execute(spec.command, [...spec.args, '--session', parsed.session], {
    ...options,
    input: invalid ? kiloInvalidResultReminder(invalid, phase) : `${KILO_RESULT_REMINDER}${KILO_PHASE_ROLES[phase] ? `${KILO_PHASE_ROLES[phase]}\n` : ''}`,
    timeoutMs: remaining,
    onStdoutLine: trace ? (line, elapsed) => trace.observe(line, elapsed + offset) : null,
  });
  return {
    ...next,
    stdout: `${first.stdout}${first.stdout.endsWith('\n') ? '' : '\n'}${next.stdout}`,
    stderr: first.stderr + next.stderr,
    duration_ms: first.duration_ms + next.duration_ms,
    lastContextTokens: next.lastContextTokens ?? first.lastContextTokens,
    // Survivors of the first process stay reported even if the follow-up ended cleanly.
    processCleanup: first.processCleanup?.survivors?.length || first.processCleanup?.error ? first.processCleanup : next.processCleanup ?? first.processCleanup,
    resultFollowUp: { reason: invalid ? 'invalid' : 'missing', duration_ms: next.duration_ms, code: next.code, timed_out: !!next.timedOut },
  };
}
export const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434';
export const KILO_LOCAL_MIN_CONTEXT = 16384;
const OLLAMA_TIMEOUT_MS = 5000;
const NO_FALLBACK = 'FORJA does not download models or fall back to cloud.';
// The context a model runs with comes from its Modelfile num_ctx; without one
// Ollama uses its server default (4096 on this release), which silently
// truncates long prompts.
export function ollamaContextTokens(parameters) {
  const match = /^num_ctx\s+(\d+)\s*$/m.exec(typeof parameters === 'string' ? parameters : '');
  return match ? Number(match[1]) : null;
}
async function ollamaRequest(request, path, init = {}) {
  let response;
  try { response = await request(`${OLLAMA_ENDPOINT}${path}`, { ...init, signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) }); }
  catch (error) {
    const cause = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? `no answer within ${OLLAMA_TIMEOUT_MS / 1000} seconds` : error?.cause?.code || error?.message || 'connection failed';
    throw new Error(`Local Ollama is unavailable at ${OLLAMA_ENDPOINT} (${cause}). Start Ollama on this machine; ${NO_FALLBACK}`);
  }
  if (!response?.ok) throw new Error(`Local Ollama at ${OLLAMA_ENDPOINT} answered ${path} with HTTP ${response?.status ?? 'error'}; ${NO_FALLBACK}`);
  try { return await response.json(); }
  catch { throw new Error(`Local Ollama at ${OLLAMA_ENDPOINT} returned an unreadable ${path} answer; ${NO_FALLBACK}`); }
}
// Installed models from /api/tags. Listing and inspecting never load a model.
export async function ollamaModels(request = fetch) {
  const listed = (await ollamaRequest(request, '/api/tags'))?.models;
  if (!Array.isArray(listed)) throw new Error(`Local Ollama at ${OLLAMA_ENDPOINT} returned no model list; ${NO_FALLBACK}`);
  return listed;
}
export async function localPreflight(model, request = fetch, { minContext = null, listed = null } = {}) {
  if (typeof model !== 'string' || !model.trim() || /cloud/i.test(model)) throw new Error('An explicit installed local Ollama model is required.');
  const entry = (listed ?? await ollamaModels(request)).find(m => m?.name === model || m?.model === model);
  if (!entry) throw new Error(`Local Ollama model ${model} is not installed; ${NO_FALLBACK} Choose an installed model (ollama list).`);
  const remote = `Ollama model ${model} is a remote (cloud) model; local routes require local weights.`;
  if (entry.remote_host || entry.remote_model) throw new Error(remote);
  const info = await ollamaRequest(request, '/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
  if (info?.remote_host || info?.remote_model) throw new Error(remote);
  if (!Array.isArray(info?.capabilities) || !info.capabilities.includes('tools')) throw new Error(`Ollama model ${model} has no tool support; local routes require local weights with tool support.`);
  const contextTokens = ollamaContextTokens(info.parameters);
  if (minContext && !(contextTokens >= minContext))
    throw new Error(`Ollama model ${model} runs with ${contextTokens ? `a ${contextTokens}-token` : "the server's default (often 4096-token)"} context; Kilo local routes need num_ctx of at least ${minContext}, or prompts are silently truncated. Create a variant with PARAMETER num_ctx 32768 (see config/ollama.Modelfile).`);
  return { backend: 'ollama', model, ...(contextTokens ? { contextTokens } : {}) };
}
