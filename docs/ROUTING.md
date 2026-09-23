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

`maxSessions` limits all native invocations; `maxCloudSessions` additionally limits nonlocal invocations. `0` permits only local routes. Both counters persist across recovery and count started attempts, including failures. One invocation can contain many model calls: neither limit is a token, euro or subscription-percentage ceiling. Older runs conservatively count previous invocations as cloud. A route's `maxMinutes` can shorten the global per-invocation cap; it cannot extend it. There is no built-in whole-run wall-clock limit.

Authentication, availability, timeout, schema and local preflight failures block the run without an automatic provider fallback. A rejected implementation or failed check can trigger another development attempt within budget: that retry selects `strong`, which **is a cloud route in the hybrid preset**. Review and planning also use cloud. To prohibit all cloud use, set `maxCloudSessions: 0` and explicitly configure every phase that will execute as local. Do not use the hybrid preset expecting an offline workflow.

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

## Acceptance checks owned by the caller

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
