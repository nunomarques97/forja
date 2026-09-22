<p align="center">
  <img src="docs/assets/forja-hero.svg" alt="FORJA — Build. Check. Review." width="100%">
</p>

<h1 align="center">Software work, with evidence.</h1>

<p align="center">Turn a goal into code changes, executable checks, and a separate review.<br>Claude Code and Codex do the engineering. FORJA keeps the work moving and the evidence on disk.</p>

<p align="center">
  <a href="https://github.com/nunomarques97/forja/tree/v0.8.3"><img src="https://img.shields.io/badge/version-0.8.3-ff9955" alt="Version 0.8.3"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-24-339933" alt="Node.js 24"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/runtime_dependencies-0-9ce0bd" alt="Zero runtime dependencies"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<p align="center"><a href="#quick-start">Quick start</a> · <a href="#how-it-works">Workflow</a> · <a href="#quality-and-control">Quality</a> · <a href="#status-and-evidence">Status</a> · <a href="#releases">Releases</a> · <a href="#documentation">Docs</a></p>

FORJA is a **Node.js orchestration CLI** for development in an existing Git project. Each phase starts a fresh native coding-agent session with relevant context; a small controller owns task state, checks, retry limits and recovery.

- **A checkable result.** Implementation passes through executed checks and independent review before a task can finish.
- **Work survives interruptions.** State, changes and logs remain available when a run stops. Recovery is explicit and bounded.
- **Your tools and decisions.** Use Claude Code, Codex or explicit mixed routes. Reported paid or unknown-cost choices pause for the Sponsor.

The aim is high-quality delivered software. More agents and fewer tokens are possible means, not success criteria.

## Quick start

You need **Node.js 24**, **Git**, and an installed, authenticated **Claude Code or Codex CLI**. FORJA is developed on Windows; some supervision helpers are Windows-specific.

```powershell
git clone https://github.com/nunomarques97/forja.git
Set-Location forja
$forja = (Resolve-Path .\bin\forja.mjs).Path

# Work from the Git root of the project you want to change.
Set-Location 'C:\path\to\your-project'
node $forja start --provider codex --goal "Add name search, preserve existing filters, and test empty results"
```

Use `--provider claude` for Claude Code. The project must have a clean working tree unless you explicitly pass `--allow-dirty`. Ignore the project's `.forja/` directory: it contains private run state and logs. Optional `core init` adds the ignore rule and short instruction references; review and commit those setup changes before a clean-tree start.

Workers edit files and execute commands. They are instructed not to commit or publish. Starting an ordinary chat does not automatically start FORJA.

## How it works

```mermaid
flowchart LR
    Goal[Goal + criteria] --> Plan[Plan]
    Plan --> Build[Developer]
    Build --> Check[Controller checks]
    Check --> Review[Independent review]
    Review --> Done[Task complete]
    Check -->|Failed, within budget| Build
    Review -->|Rejected, within budget| Build
```

Supply `--plan plan.json` to skip planning. For each task, the developer implements and runs focused tests, then hands scheduled validation to the controller with `ready_for_validation`. That handoff is not completion: the required checks must pass and a separate reviewer must approve. The controller repeats the loop for remaining tasks and revalidates when later changes invalidate earlier evidence.

**The controller owns completion.** Source-changing checks, unauthorized review edits, invalid results, timeouts and exhausted limits leave the run blocked with work preserved. An impressive partial implementation is not a successful run.

## Quality and control

| What you control | What FORJA enforces |
|---|---|
| **Acceptance** | Caller-defined `finalChecks` run at integration, before approval. Required failures cannot be waived by a review. |
| **Protected contracts** | `protectedFiles` pins declared tests, fixtures and contracts. Changed, missing or linked files block further execution at checked boundaries. |
| **Independent review** | A separate session inspects source, criteria and evidence. Review must preserve project files. |
| **Paid choices** | Reported paid or unknown-cost alternatives require an explicit Sponsor selection, even when a free alternative is recommended. A selection does not authorize payment. |
| **Execution access** | Native defaults remain available; opt into full access for **both providers and all phases** with `config/core-full-access.json`. |
| **Models and budgets** | Explicit phase/tier routes, invocation limits, cloud-session limits and per-invocation deadlines. Started failures still consume session allowance. |

Example acceptance configuration, passed through `--config acceptance.json`:

```json
{
  "protectedFiles": ["test/acceptance.test.mjs", "test/fixtures/expected.json"],
  "finalChecks": [{ "command": "node", "args": ["--test", "test/acceptance.test.mjs"] }]
}
```

Create those files before starting. Declare their relevant helpers and fixture data too: FORJA does not infer all dependencies. Hash checks protect declared bytes at execution boundaries; they do not provide continuous isolation or prove test quality. UI acceptance still needs actual browser/visual evidence. Cost discovery depends on what the worker reports and the sources it consults.

Full access is explicit:

```powershell
node $forja start --provider claude --config C:\path\to\forja\config\core-full-access.json --goal "Implement the feature and its acceptance tests"
```

The same profile supports `--provider codex`. It removes the native sandbox/approval restrictions configured by FORJA, including during planning and review, without changing models or budgets. Merge its provider settings into an existing profile to retain your routes. OS privileges, managed policies, authentication and available tools still apply. Existing runs and the legacy runner are unchanged. [Details](docs/CORE-RUNBOOK.md#acesso-completo-dos-executores).

### Providers and models

| Provider | Default model selection | Customization |
|---|---|---|
| Claude Code | `sonnet` for fast/normal tiers; `opus` for strong/critical tiers | Explicit model and effort per route. |
| Codex | Inherits the installed CLI's model/effort when unspecified | Pin model and effort for repeatable runs. |
| Custom executor | Caller-supplied executable using the result contract | Adapter-defined behavior and permissions. |

Hard work, architecture/security signals and implementation retries select stronger tiers; security-sensitive review selects `critical`. These are routing signals, not calibrated difficulty estimates. See [routing and presets](docs/ROUTING.md) before selecting experimental economy or Ollama configurations. A session limit is not a token or currency ceiling.

## Know what happened

```powershell
node $forja core status
node $forja core usage
node $forja core diagnose
node $forja core resume
```

`diagnose` summarizes existing execution metadata without calling a model or resuming work. Missing or incomplete measurements stay explicit. `resume` continues eligible preserved work; it does not resolve a Sponsor decision or erase exhausted limits.

Since **0.8.2**, a recorded valid developer handoff can survive controller death without another development session. Recovery checks source and Git HEAD, then runs the required checks and review. Source changes after the last approval also require fresh validation and review before an unfinished run can complete. Unchanged approved source needs no extra review. These are process-crash guarantees, not power-loss durability or exactly-once external execution. [Recovery details](docs/CORE-RUNBOOK.md).

Run `node $forja serve` from the FORJA checkout to open the local viewer. Its `/core` page shows tasks, checks and usage and accepts pending Sponsor choices. A configured notification transport can alert the Sponsor. See the [runbook](docs/CORE-RUNBOOK.md) for project/run selection, notification setup and recovery.

## Status and evidence

| Available now | Still experimental or proposed |
|---|---|
| Sequential Core workflow, separate review, executable checks, recovery, protected acceptance, explicit routing, full access and diagnostics. | Economy/Ollama presets are opt-in experiments. Dynamic specialist allocation, parallel project writers and adaptive replanning are **not implemented**. |

The **v0.8.2** public regression run recorded **871 tests: 869 passed, zero failed, two skipped** because private historical evidence was unavailable. Sixteen new tests cover interrupted handoffs and stale review approval, including abrupt process death and unchanged-source controls. The suite uses fixtures and simulated executors; native-model evaluations are separate. Passing controller tests does not prove reliable autonomous delivery of every complex product.

The initial [contract-only acceptance study](docs/ADAPTIVE-ORCHESTRATION.md#initial-acceptance-study) found no additional faulty implementation rejected: both methods rejected the same **23/24** defective variants without grading timeout and accepted **4/4** correct controls. Contract-only authoring took **504 s versus 406 s (+24.1%)** in this small sample. Version **0.8.3** records that decision; runtime remains unchanged from v0.8.2. Bounded assistance for a specific capability gap remains a proposal, with no mandatory extra agent.

For development, run `npm test`, `npm run check` and `npm run release:check`. Start with [Core tests](test/core.test.mjs), [protected files](test/protected-files.test.mjs), [full access](test/full-access.test.mjs) and [technology decisions](test/technology.test.mjs). Review the [contribution and publication rules](docs/RELEASE.md) before staging evidence or publishing changes.

## Releases

**Current: [v0.8.3](https://github.com/nunomarques97/forja/tree/v0.8.3)** — document the acceptance study and evaluation criteria; runtime unchanged.

| Release | Main change |
|---|---|
| [0.8.2](https://github.com/nunomarques97/forja/tree/v0.8.2) | Recover accepted handoffs after controller death and invalidate stale review approval. |
| [0.8.1](https://github.com/nunomarques97/forja/tree/v0.8.1) | Project presentation and proposed adaptive orchestration; runtime unchanged. |
| [0.8.0](https://github.com/nunomarques97/forja/tree/v0.8.0) | Explicit full access for every Codex and Claude phase. |
| [0.7.0](https://github.com/nunomarques97/forja/tree/v0.7.0) | Protected caller-owned acceptance files. |
| [0.6.0](https://github.com/nunomarques97/forja/tree/v0.6.0) | On-demand execution diagnostics. |

<details>
<summary>Earlier Core releases</summary>

| Release | Main change |
|---|---|
| [0.5.1](https://github.com/nunomarques97/forja/tree/v0.5.1) | Release documentation refresh. |
| [0.5.0](https://github.com/nunomarques97/forja/tree/v0.5.0) | Explicit implementation handoff for controller validation. |
| [0.4.3](https://github.com/nunomarques97/forja/tree/v0.4.3) | Avoid repeating an exact overlap of task and final checks. |
| [0.4.2](https://github.com/nunomarques97/forja/tree/v0.4.2) | Reject validation that changes project source. |
| [0.4.1](https://github.com/nunomarques97/forja/tree/v0.4.1) | Resume after a recorded Sponsor technology choice. |
| [0.4.0](https://github.com/nunomarques97/forja/tree/v0.4.0) | Technology comparisons and Sponsor cost decisions. |
| [0.3.0](https://github.com/nunomarques97/forja/tree/v0.3.0) | Explicit task boundaries and incremental execution metadata. |
| [0.2.0](https://github.com/nunomarques97/forja/tree/v0.2.0) | Caller final checks and explicit model/provider routing. |
| [0.1.0](https://github.com/nunomarques97/forja/tree/v0.1.0) | Core scheduler, native executors, checks, review and recovery. |

</details>

[Complete changelog](CHANGELOG.md) · [Published tags](https://github.com/nunomarques97/forja/tags). The legacy `runner` remains a compatibility workflow; active legacy runs are not automatically migrated.

## Documentation

| Start here | Go deeper |
|---|---|
| [Execution contract](docs/CORE.md) | [Core runbook — Portuguese](docs/CORE-RUNBOOK.md) |
| [Routing, models and presets](docs/ROUTING.md) | [Scheduler](lib/core/engine.mjs) · [Adapters](lib/core/providers.mjs) |
| [Adaptive orchestration proposal](docs/ADAPTIVE-ORCHESTRATION.md) | [Selected architecture research](docs/RESEARCH.md) |
| [Release and privacy policy](docs/RELEASE.md) | [Changelog](CHANGELOG.md) |

[MIT](LICENSE) · Copyright (c) 2026 Nuno Marques.
