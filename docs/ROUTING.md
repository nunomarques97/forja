# Model routing and quality gates

Core keeps the same plan → developer → executable checks → independent review workflow. Routing selects the executor for each existing phase; it does not introduce an agent team, proxy service or another orchestration framework. Existing configurations retain their provider and native model defaults.

Dynamic capability-specific assistance is a [research proposal](ADAPTIVE-ORCHESTRATION.md), not a supported routing mode. For full access in all existing phases, use [core-full-access.json](../config/core-full-access.json) or merge its settings into your model profile; this permission option does not select models or add agents.

## Start with an explicit preset

From the project root, with the chosen CLI installed and authenticated:

```powershell
$forjaRoot = 'C:\tools\forja'
node "$forjaRoot\bin\forja.mjs" start --provider codex --config "$forjaRoot\config\core-economy.json" --goal "Implement the feature and its acceptance criteria"
```

| Preset | Planning/development | Review | Status |
|---|---|---|---|
| `core-economy.json` | Codex Terra; Luna for easy tasks; Sol for hard, security, architecture or retries | Codex Sol | Experimental; medium UI trial interrupted |
| `core-haiku.json` with `--provider claude` | Haiku for easy tasks, Sonnet for normal, Opus for stronger tiers | Opus | Configuration example; not live-tested for this release |
| `core-local-pilot.json` | Same Codex routes, with installed Ollama model for the first easy development attempt | Codex Sol | Experimental hybrid; still uses cloud sessions |

These are starting configurations, not a claim that the cheapest model always produces the cheapest successful result. Availability depends on the account and installed CLI. The [Codex model guide](https://learn.chatgpt.com/docs/models) describes the model families; the [Claude model configuration](https://code.claude.com/docs/en/model-config) documents aliases. Prices and subscription usage are not inferred from model names.

## Selection and budgets

`routes["phase.tier"]` takes precedence over `routes["phase"]`, followed by the run's `--provider`. Phases are `plan`, `develop`, `review`; tiers are `fast`, `normal`, `strong`, `critical`. Easy development starts at `fast`; hard work, architecture/security signals and repeated attempts select `strong`; review uses `strong` or `critical` for security. Source/path signals supplement declared risks, but remain heuristics.

Each route has `provider` and optional `model`, `effort`, `maxMinutes` and `localProvider`. `providers.codex` / `providers.claude` configure native commands and default model/effort maps separately. Legacy `provider` settings apply only to the run's default provider, so a Claude command cannot accidentally become the Codex command. Explicit routes can override these mappings, including choosing a weaker model: the operator is responsible for suitable review capability.

`maxSessions` limits all native invocations; `maxCloudSessions` additionally limits nonlocal invocations. `0` permits only local routes. Both counters persist across recovery and count started attempts, including failures. One invocation can contain many model calls: neither limit is a token, euro or subscription-percentage ceiling. Older runs conservatively count previous invocations as cloud. `maxMinutes` (`--max-minutes`, 1..180, default 30) is the per-call provider timeout; `core resume --max-minutes N` can only raise it. A route's `maxMinutes` can shorten it for that route; it cannot extend it, and it stays fixed for the run. `core status` shows the effective value, the routes that lower it and, after a timeout, the limit reached with its invocation (`provider_timeout`). There is no built-in whole-run wall-clock limit.

Authentication, availability, timeout, schema and local preflight failures block the run without an automatic provider fallback. The one exception is the same-provider automatic retry (`providerRetries`, 0..1, default 1): a develop session that ends on the output budget or on the per-call timeout gets one fresh session per implementation attempt in total, on the same route, keeping the work on disk and the progress notes and spending no attempt. On a local route the same retry also covers a develop session that fails without a result or returns no valid result JSON, and a local plan or review session that returns no usable plan or verdict (a status outside its phase, no JSON, a Kilo failure or a per-call timeout without a result) gets one fresh session of its phase: planning once per controller start, review once per validated tree, both disabled by `providerRetries: 0`; before that, a local Kilo session whose final JSON is not a result of its phase gets one same-session reminder naming the problem, and local schemas list only the statuses of their phase. A local plan with more than one task that cannot finish within the remaining sessions (`2 × tasks > remaining − 1`: one develop and one review session per task plus one spare) is merged by the controller into one task in dependency order (`merged_from` in task state). Cloud routes keep the immediate stop for those cases. A second such failure in the attempt, or a cloud plan or review timeout, blocks with the `timeout` or `output` recovery code; a timeout message names the minutes reached and how to raise them. A rejected implementation or failed check can trigger another development attempt within budget: that retry selects `strong`, which **is a cloud route in the hybrid preset**. Review and planning also use cloud. To prohibit all cloud use, set `maxCloudSessions: 0` and explicitly configure every phase that will execute as local. Do not use the hybrid preset expecting an offline workflow.

The usage ledger records requested model, effort, route, provider, backend and local flag; `core usage` aggregates by provider and backend. Missing cost/token observations remain unknown. A local route describes the configured inference backend, not a guarantee of network isolation for all CLI features or custom executables.

## Restricted Claude file tools

For new Claude runs, `config/core-restricted-claude.json` opts into a file-tools-only worker:

```sh
node bin/forja.mjs start --provider claude --project <project> --config config/core-restricted-claude.json --goal "Implement the change and its tests"
```

The provider setting is `providers.claude.writePolicy: "restricted"`. It requires Claude Code 2.1.280 or newer and refuses `fullAccess: true`, extra provider CLI arguments, nonempty MCP configuration, and use on Codex/custom. There is no fallback to unrestricted execution. Existing configurations and persisted runs retain their selected access mode; the new example does not change model routing.

The adapter uses Claude's [`--restricted` mode](https://code.claude.com/docs/en/cli-reference), safe mode and noninteractive permission denials. Development exposes Read, Glob, Grep, Write and Edit. Planning/review expose only Read, Glob and Grep. Shells, Git commands, code execution, subagents, MCP tools, web tools and user customizations are unavailable. Workers write test files; the controller executes the scheduled checks with its existing permissions. Tasks requiring browser evidence or worker commands need a separately authorized execution arrangement and must not claim those checks ran.

Native file tools are confined to the project and the invocation's scratch directory. Edit deny rules additionally protect `.forja`, `.git`, `.claude`, `.codex` and caller `protectedFiles`, including writes through the Write tool. This uses the [native permission rules](https://code.claude.com/docs/en/permissions), not a shell-command blacklist or a hook that can time out. Unsupported versions stop before inference.

Every provider process receives a fresh scratch directory through `FORJA_SCRATCH_DIR`, `TMPDIR`, `TEMP` and `TMP`. The parent's environment is unchanged. The private usage ledger records its location and the effective access policy. Scratch is retained as evidence; FORJA does not recursively delete it. Custom stdin remains unchanged. Full-access/default/custom modes get separate scratch but **do not acquire confinement** from environment variables.

This is a native tool boundary, not an OS sandbox, protection from another process running as the same user, or confinement of controller checks. Trusted native executables and administrative policy remain part of the trust boundary. Native Windows probes exercised allowed source/scratch writes, denials of new external files by absolute/traversal/junction paths, Git/scheduler/caller-file protection, and a read-only reviewer tool set. A hard-link write replaced the project link while the external sentinel remained unchanged; do not infer broader filesystem guarantees from this one probe. The [Claude sandbox documentation](https://code.claude.com/docs/en/sandboxing) separately describes OS sandbox support and its native Windows limitation. Codex retains its existing native sandbox/access settings; this option does not claim equivalent qualification for Codex.

## Kilo CLI provider

`--provider kilo` runs each phase through `kilo run --format json`. It exists for environments where models are only reachable through an organization gateway configured inside a Kilo Code build (for example a company-distributed VS Code extension), not through Claude Code or Codex. Kilo has no default models in FORJA; name the gateway's models explicitly:

```json
{
  "providers": {
    "kilo": {
      "models": { "fast": "<gateway>/claude-sonnet-4-6", "normal": "<gateway>/claude-sonnet-4-6", "strong": "<gateway>/claude-opus-4-6", "critical": "<gateway>/claude-opus-4-6" }
    }
  }
}
```

`kilo models <gateway>` lists the IDs. `efforts` map to Kilo's `--variant`. Without `provider.command`, FORJA uses the newest CLI bundled with an installed `*.kilo-code-<version>` extension (`.vscode`, `.vscode-insiders` or `.cursor`), then `kilo` on PATH. The bundled CLI matters: a public npm CLI does not know an organization's built-in gateway provider and fails with `Provider not found`.

Each invocation gets an empty Kilo config home (`XDG_CONFIG_HOME` under the invocation's scratch owner) and `KILO_DISABLE_PROJECT_CONFIG=1`, so user and project permissions such as `"*": "allow"` do not apply. `KILO_CONFIG_CONTENT` then sets FORJA's policy with `"*": "deny"` and an allow list: planning/review get `read`, `glob`, `grep` and `list`; development adds `edit`, `todowrite` and `external_directory` (for progress notes in scratch) plus `bash` unless `writePolicy` is `restricted`; `fullAccess` allows everything. MCP servers are empty; sharing, autoupdate, session ingest and Kilo undo snapshots are disabled. Authentication lives in Kilo's data directory and is not changed. Kilo has no per-path deny that FORJA relies on, so `.forja`, `.git` and protected files are guarded by the controller's own state, HEAD and protected-file checks, as for Codex.

Kilo has no structured-output flag. FORJA appends the phase schema to the prompt and takes the last complete JSON object from the final message; a run without one is a provider failure. Usage is the sum of `step_finish` tokens (input excluding cache, cache reads/writes, output including reasoning) and cost. The context guard uses each `step_finish` input plus cache, like Claude. The project directory is passed with `--dir`, because Kilo otherwise resolves it from an inherited `PWD`.

To start FORJA from the Kilo chat, copy [`examples/kilo/forja.md`](../examples/kilo/forja.md) to `%USERPROFILE%\.config\kilo\command\` and [`examples/kilo/forja-kilo.cmd`](../examples/kilo/forja-kilo.cmd) to `%USERPROFILE%`, and save the model profile as `%USERPROFILE%\forja-kilo.json`. Files copied from a downloaded ZIP carry the Mark of the Web; run `Unblock-File` on the launcher once, or Windows waits on an invisible security prompt when the chat agent starts it. Appending [`examples/kilo/AGENTS.md`](../examples/kilo/AGENTS.md) to `%USERPROFILE%\.config\kilo\AGENTS.md` also lets a plain "use FORJA to ..." request follow the same steps. `/forja <request>` then has the chat agent write `%USERPROFILE%\forja-goals\<project folder>.md` (one goal file per project), confirm it with the user, check for a clean tree, open FORJA in its own visible window with `--goal-file`, and confirm through `core status` that the run started. The window title ends in `running`, `DONE` or `STOPPED`, with a short sound at the end. The chat agent is not notified when FORJA ends; asking it for FORJA's status runs `core status`, and asking it to resume opens a window with `core resume`. Workers never see this global command, because each invocation uses its own config home. Without `delivery` in the profile, FORJA leaves changes uncommitted.

`forja start` adds `.forja/` to the repository's local `.git/info/exclude` when it is not already ignored, so run state stays out of `git status` without changing the project's `.gitignore`.

Validated on the public Kilo CLI 7.8.1 with free gateway models: read-only phases could not write, development wrote inside the project, and a FORJA run went through plan, develop, controller checks and review (the free reviewer answered with a develop status, which the controller blocked as it should). Isolation from a real user config with `"*": "allow"` and organization gateways must be confirmed on the target machine before relying on it.

## Acceptance checks owned by the caller

Controller checks can separately opt into [bubblewrap isolation](CONTROLLER-DELIVERY.md#isolated-controller-checks). Reviewer-owned automatic delivery is also opt-in and reuses the existing final review route; there is no additional `delivery` model phase.

Add commands to the configuration passed with `--config`:

```json
{
  "finalChecks": [
    { "command": "npm", "args": ["run", "build"] },
    { "command": "node", "args": ["tools/acceptance.mjs"] }
  ]
}
```

The scheduler appends these to the last remaining task's checks before review. Intermediate tasks can finish without satisfying the complete goal. Failed final checks return to development within the original attempt budget. Later final regression repairs revalidate integration. Logs identify the executed commands and results; reviewer approval cannot replace a failing command.

Commands are trusted caller configuration, executed in the project root with the scheduler's permissions. Use independently maintained acceptance tests; keep authoritative oracles outside the developer's writable scope where practical. Do not let a worker weaken them to pass. Core state protection is not a sandbox for arbitrary check commands. The quality prompts direct attention to stale responses, failure/retry transitions, empty-state loading and keyboard focus; prompts alone do not prove coverage.

## Local Ollama routes through Kilo

Where Codex is not installed, the Kilo CLI drives a local Ollama model for any phase. A route names Kilo, the local provider and the plain Ollama tag:

```json
{
  "maxCloudSessions": 0,
  "routes": {
    "plan": { "provider": "kilo", "localProvider": "ollama", "model": "qwen3-coder:30b-32k", "maxMinutes": 8 },
    "develop": { "provider": "kilo", "localProvider": "ollama", "model": "qwen3-coder:30b-32k" },
    "review": { "provider": "kilo", "localProvider": "ollama", "model": "qwen3-coder:30b-32k", "maxMinutes": 8 }
  }
}
```

Routes can be mixed with cloud routes per phase or tier, as in the Codex pilot below. With `maxCloudSessions: 0` and every phase local, the run uses no cloud session; any phase left without a local route blocks before launch with the cloud budget message.

Requirements: Kilo CLI (7.8.1 tested; bundled or on PATH, as for the gateway provider above), Ollama running at `127.0.0.1:11434`, and an installed model with tool support whose Modelfile sets `num_ctx` to at least 16,384. Ollama otherwise loads the model with its server default (4,096 tokens on 0.35.0) and silently cuts the prompt: Kilo's own system prompt and tools are about 8,100 tokens before the FORJA packet. Create a larger-context variant of an installed model as for the pilot below (`PARAMETER num_ctx 32768`). FORJA does not pull or create models.

Before each local call FORJA reads `/api/tags` and `/api/show` on the fixed loopback endpoint (nothing is loaded) and refuses, with the cause in the message, when the server is unreachable or does not answer within 5 seconds, the model is not installed, is a remote/cloud model, has no tool support, or declares no or too small a context. There is no fallback to cloud: the run blocks with the `provider` recovery code. `core doctor --config <profile>` runs the same checks for every model of the profile's local routes (one `ollama:<model>` line naming its routes) without invoking a model; profiles without local routes do not probe Ollama.

The invocation is the gateway Kilo invocation with three additions to its inline config: only the `ollama` provider is defined (OpenAI-compatible, base URL `http://127.0.0.1:11434/v1`), `enabled_providers` is `["ollama"]`, and both `model` and `small_model` are the route model, so neither the task nor Kilo's auxiliary title call can select another provider. The model's declared context is passed as its Kilo context limit. FORJA's per-phase permission policy, empty config home, disabled project config, empty MCP and disabled sharing are unchanged; `OLLAMA_HOST` is set to the loopback endpoint. Route `maxMinutes` is the per-call timeout, the ledger records `provider: kilo`, `backend: ollama`, `local: true`, and local calls do not count against `maxCloudSessions`. Kilo can still contact its own services for non-inference features (for example its model catalogue); this is not network isolation.

Local models often do the work but, after long tool use, end with prose instead of the result JSON appended to the prompt. When a local Kilo call exits cleanly without one and at least 15 seconds of its call time remain, FORJA sends one short reminder in the same Kilo session (`--session`, same permissions, remaining time) asking only for the JSON; usage and calls of both processes are summed and the ledger records `result_follow_up`. There is no second reminder, and gateway Kilo routes do not get one.

Smoke results on Windows 11 (RTX 5060 Ti 16 GB, Ollama 0.35.0, Kilo 7.8.1, 2026-10-05), all in scratch projects outside the repository:

- Direct Kilo call with `qwen3-coder:30b-32k`: read, edit, ran `node -e` and returned the JSON result in 48 s. With `qwen3:8b` (no `num_ctx`) the prompt was truncated to the 4,096-token default and the model never saw the task, which is why the context preflight exists.
- FORJA run, every phase `qwen3-coder:30b-32k`, `maxCloudSessions: 0`, small slug-fixing goal: plan 85 s, develop 105 s (correct fix and tests; controller `npm test` passed), review 40 s; 3 local invocations, 0 cloud. The run blocked because the local reviewer answered `done` instead of `approve`/`reject`, a model limitation already seen with a free gateway reviewer. In an earlier run the plan was only accepted thanks to the follow-up above (56 s).
- Before the follow-up existed, `qwen3-coder:30b-32k` (plan, develop) and `forja-gpt-oss:20b-32k` (plan) ended without a result JSON; both tried to edit during planning and the read-only policy denied it.

This establishes that the local route works for every phase on this host. It does not establish that local models complete tasks unattended.

### Recommended local profile

[`config/core-local.json`](../config/core-local.json) is the local-only preset chosen by the [local model bake-off](research/local-models-2026-10-04.md) on this PC: `qwen3-coder:30b-32k` for plan, develop and review, `maxCloudSessions: 0`, no escalation, 8 sessions, 2 attempts, per-call 8/15/8 minutes. Nine models ran the same small coding tasks through FORJA; `devstral-small-2` (24B) was the most correct developer by one task but about twice as slow and over the 16 GB card at 32k context, `gpt-oss:20b` the fastest but failed most plans. No local reviewer rejected a failing change, so the project's checks are the real gate in a local-only run.

```powershell
node bin/forja.mjs core doctor --config config/core-local.json
node bin/forja.mjs start --provider kilo --config config/core-local.json --goal "..."
```

`node tools/local-bakeoff.mjs plan|run --detach|status|report|stop|cleanup` reruns the bake-off (see the report for caps and method).

## Escalation of local develop tasks to Claude (opt-in)

A profile with local develop routes can name one Claude CLI route that takes over a task the local model cannot finish. It is off unless the profile has an `escalation` object:

```json
{
  "maxCloudSessions": 4,
  "routes": {
    "plan": { "provider": "kilo", "localProvider": "ollama", "model": "qwen3-coder:30b-32k" },
    "develop": { "provider": "kilo", "localProvider": "ollama", "model": "qwen3-coder:30b-32k" },
    "review": { "provider": "kilo", "localProvider": "ollama", "model": "qwen3-coder:30b-32k" }
  },
  "escalation": { "route": { "provider": "claude", "model": "sonnet", "effort": "high" }, "maxEscalations": 1, "attempts": 1 }
}
```

- **When.** A develop task on a local route escalates when it uses all its implementation attempts without approval (`attempts`), or when a develop session ends without a usable result after its automatic provider retry: per-call timeout (`timeout`), output budget (`output`), provider failure (`provider`), or no valid result JSON (`invalid_result`). Plan and review routes never escalate; the escalated task is still checked and reviewed by its configured review route. Provider usage limits, context rotations and `blocked` results do not escalate.
- **What happens.** The task's develop sessions from then on use the escalation route (selector `escalation`), with exactly its own `attempts` (1–5, default 1) after the attempts already spent, even when the run's `maxAttempts` had attempts left (a stuck session at attempt 1 of 3 with `attempts: 1` gets one Claude attempt). Only a later `core retry --max-attempts N` above the run limit at escalation time adds attempts, by the difference; `core status` shows the limit in effect as `tasks[].escalated.attempt_limit`. Work on disk and progress notes stay; the first Claude session gets feedback naming the reason and the earlier feedback. Each task escalates at most once.
- **Validation.** `route.provider` must be `claude` (the subscription CLI): no `localProvider`, `command` or other provider; `model`, `effort` and `maxMinutes` as for routes. `maxEscalations` is 1–10 (default 1) per run. The profile must have a local develop route, and `maxCloudSessions: 0` forbids escalation (start and `core doctor` refuse the profile).
- **Budgets.** Escalated sessions count against `maxSessions` and `maxCloudSessions` like any cloud session. When the escalation budget, the session or cloud budget is exhausted, or `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL` is set (which would make the CLI a paid API client), the run blocks exactly as without escalation and the message ends with `Escalation to the Claude route was not started: <reason>.` The environment rule is checked again before every launch on the escalation route, including after `core resume` or `core retry` from another environment: with one of those variables set the run blocks with stop code `provider` before the launch, names the variable (never its value) and spends no attempt; unset it and resume. A `providers.claude.command` in the profile still selects the Claude executable for escalated sessions, as for any Claude route.
- **Evidence.** The ledger row of the first escalated session (`usage.jsonl`, route `escalation`) has an `escalation` object with `task`, `reason`, `attempt`, `after_invocation` (for a stuck session), `from_route`, `from_backend`, `from_model`, `to_route`, `to_provider`, `to_model` and `invocation`. `core status` shows `escalation` (`max`, `used`, the route and every escalation) and `tasks[].escalated`. The record is part of the run state, so a resume continues on the Claude route and never escalates the same task again.

Escalation is tested with mock executors only (`test/escalation.test.mjs`); no real Claude call was made to validate it.

## Optional Ollama pilot

Requires a recent Codex CLI supporting `exec --oss --local-provider ollama`, an already running Ollama server at `127.0.0.1:11434`, and a locally installed model with tool support. See [Codex local-provider configuration](https://learn.chatgpt.com/docs/config-file/config-advanced). FORJA does not install or pull model weights. If `gpt-oss:20b` is already installed, the supplied Modelfile creates a separate 32k-context alias:

```powershell
ollama create forja-gpt-oss:20b-32k -f C:\tools\forja\config\ollama.Modelfile
```

Inspect the Modelfile and ensure the base model is installed first: running `ollama create` yourself can obtain a missing base. The FORJA preflight only inspects existing tags/model metadata and rejects remote/cloud models or models without tools. Its endpoint is fixed to loopback. The local invocation ignores user configuration, sets a 32k context window and native compaction threshold of 24k, and, by default, preserves `workspace-write` / `read-only` phase sandboxes. Explicit provider `fullAccess: true` instead selects `danger-full-access` with approval prompts disabled, as for cloud Codex. On Windows it selects the elevated native sandbox; initial sandbox setup must already work. It never uses the sandbox-bypass flag. User instructions, skills/plugins and CLI background features can still affect execution; this is not full network isolation.

A native Windows smoke test edited a file and executed its assertion in approximately 28 seconds. This establishes basic tool execution only. Memory/VRAM needs and speed depend on the model and hardware. There is no GPU scheduler: do not overlap the pilot with another project's Ollama workload. Stop or finish one workload before starting the other. Cloud-only presets do not load an Ollama model.

## Validation status

Routing, cloud budgets, final-check repair and provider boundaries have deterministic regression coverage. Native local editing passed the small smoke test above. Neither establishes successful unattended completion of a medium product task.

A bounded UI reliability trial used a frozen executor, isolated source copy and fixed external checks. Its first planner returned prose instead of dependency IDs; validation blocked it before product edits. A stricter schema and clearer field instructions were added, and a second plan succeeded. The Sol development invocation then reached its ten-minute cap. Work was preserved, the run remained blocked, and no task received independent approval. Three native cloud invocations were started across both attempts; timeout usage was incomplete, so no total cost or token-saving claim is made.

Post-stop scoring passed the build and six unit tests but only 6/11 fixed browser checks and 1/4 supplemental checks. Several failures reflected a changed search-field accessibility role and one navigation timeout, not established behavioral defects. A separate diagnostic adapting the selector and navigation timeout passed the eleven functional scenarios. The fixed score was not overwritten. Keyboard focus loss and a React StrictMode setup/cleanup/setup failure were reproduced; the latter informed the current review guidance. This was unfinished code, not an approved final product. It does not demonstrate either completed-task speed or quality superiority. Keep the established native defaults unless deliberately evaluating a preset on your own acceptance suite.
