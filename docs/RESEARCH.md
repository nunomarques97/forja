# Selected architecture research

FORJA keeps a small provider-neutral scheduler. External projects inform specific choices; their popularity and advertised speedups are not evidence that replacing the runtime improves this workload. Core requires no external agent framework.

For task-dependent capabilities, see the [adaptive-orchestration proposal and initial acceptance study](ADAPTIVE-ORCHESTRATION.md). The completed comparison found the same faulty variants rejected and all correct controls accepted in both arms; contract-only authoring took 24.1% longer in that small sample. An apparent assertion-count gain was a difference in failure classification, not additional faulty implementations rejected. The proposal retains recovery/budget requirements and future evaluation gates. No adaptive team mode is enabled by this research.

## Knowledge without repository noise

Keep concise, reviewed architecture, conventions and consequential decisions in Git Markdown. Execution state belongs in JSON; raw conversations, handovers, prompts, reports and measurements stay in ignored local storage. Promote a useful lesson by rewriting it as a technical invariant, without personal details or dialogue. See [publication policy](RELEASE.md).

Obsidian is an optional interface over Markdown. It does not choose the right excerpts, enforce freshness or determine what may be published. FORJA selects bounded lexical excerpts with path/line/hash provenance and optional required notes. Version 2 manifests also offer explicit source references with consultation conditions, without injecting their document bodies. Source remains authoritative. The current declaration map is heuristic, not an AST or dependency graph. Native executors load detailed code on demand.

### Initial native reference pilot

A frozen four-session comparison used two new Node utility tasks: a small label-parser correction with irrelevant specialist documents, and artifact-retention implementation governed by an accepted ADR. Each task ran once with automatic excerpts and once with explicit references, with reversed arm order for the second task. Both arms used the same current prompt guidance, corpus and acceptance contract; this isolates manifest policy rather than comparing entire runtime versions. Native metadata confirmed `gpt-5.6-terra` with `medium` effort in all four sessions (Codex CLI 0.155.0-alpha.16), each limited to ten minutes, with no retries or repairs. No Claude or local-model session was used.

Before native execution, the external evaluator was checked against two correct controls and eleven seeded defects. Both controls passed and every defect failed. The oracle and fixtures were then frozen; all four generated implementations passed, with seven parser checks and eleven retention checks per arm. Project instructions, documentation and dependencies were preserved. This was one developer session per fixture, not a complete planning/development/independent-review workflow.

| Observed across two tasks per arm | Automatic excerpts | Explicit references |
|---|---:|---:|
| Implementations passing external acceptance | 2/2 | 2/2 |
| Acceptance checks passed | 18/18 | 18/18 |
| Irrelevant specialist bodies injected (source/task pairs) | 7/7 | 0/7 |
| Irrelevant specialist reads observed in native tool output | 0/7 | 0/7 |
| Complete relevant ADR observed in native tool output | 1/1 | 1/1 |
| Provider-reported input tokens, including cached input | 168,472 | 160,776 |
| Cached subset of those input tokens | 139,264 | 118,016 |
| Input tokens excluding the cached subset | 29,208 | 42,760 |
| Provider-reported output tokens | 2,706 | 2,856 |
| Total native session time | 79.444 s | 72.585 s |

The reference arm opened the relevant ADR and implemented its requirements without receiving its body in the initial prompt. A successful read had empty output in the CLI's public JSON stream; the exact native session's tool-output record contained the complete ADR. The original stdout-only classification and the supplementary native-record audit were retained separately. A path appearing in a command, or a document appearing in a repository map, is not by itself proof that its contents were returned. Tool-output evidence establishes exposure, not cognitive attention or universal observability.

The result supports retaining the explicit catalog without adding a classifier or a mandatory phase. It does **not** establish superior implementation quality, fewer specialist file reads, lower billed cost or general speedups. Although total input was 4.6% lower in this sample, input excluding cache was 46.4% higher; the parser reference session alone used more total input than its counterpart. Repeated context, tool sequencing and caching prevent attributing session token totals directly to document length. Two task pairs, one attempt each, cannot establish general reliability, prompt-injection resistance, or behavior across models and complex repositories. No runtime change or new release follows from this study.

## Ruflo / Claude Flow

The inspected source snapshot is [a4f2199](https://github.com/ruvnet/ruflo/tree/a4f219935ff4035421bc01157a5a1abc74529ad2). This review covers selected implementation and test files, not certification of the whole platform; no Ruflo runtime or benchmark was executed locally.

| Concrete implementation | Useful idea | FORJA decision |
|---|---|---|
| [hybrid-retrieval.ts](https://github.com/ruvnet/ruflo/blob/a4f219935ff4035421bc01157a5a1abc74529ad2/v3/%40claude-flow/cli/src/memory/hybrid-retrieval.ts): pure BM25 statistics, normalized sparse/dense scores, separate title/body weights and MMR | Rank relevant material and avoid spending the packet on near-duplicates | Sparse bounded ranking and source references already fit Core. Evaluate field weighting/diversity on labelled queries before adding them. Dense retrieval needs a measured recall benefit. |
| [graceful-retrieval.test.ts](https://github.com/ruvnet/ruflo/blob/a4f219935ff4035421bc01157a5a1abc74529ad2/v3/%40claude-flow/memory/src/graceful-retrieval.test.ts): missing/failing embedder falls back to keyword results and emits degraded health | Retrieval failure should be observable and should not require an external embedding service to find known identifiers | Preserve a lexical path if a future semantic retriever is introduced. Current Core needs no embedder. |
| [memory provenance CLI regression](https://github.com/ruvnet/ruflo/blob/a4f219935ff4035421bc01157a5a1abc74529ad2/v3/%40claude-flow/cli/__tests__/adr-323-memory-provenance.test.ts): distinguishes user claims, agent output and tool results | Remember where a statement came from; do not promote a generated summary into established truth | Keep file/hash and authoritative check evidence. Typed origin/trust is a useful future extension, independent of an entire memory database. |
| [agentdb-retrieval-guard.ts](https://github.com/ruvnet/ruflo/blob/a4f219935ff4035421bc01157a5a1abc74529ad2/v3/%40claude-flow/memory/src/agentdb-retrieval-guard.ts): size gate and content screening before context assembly; opt-in and separate strict mode | Retrieved knowledge is untrusted data and needs limits | Retain Core's source boundaries and budgets. Do not assume this optional guard proves immunity to malicious memory or adopt security claims without testing. |

Ruflo provides substantially broader orchestration and memory facilities. FORJA's advantage here is a smaller native-CLI execution path, authoritative deterministic checks, distinct review sessions and no added runtime service. HNSW, SQLite/AgentDB, swarm coordination and automatic learning would add installation, invalidation and operational costs. Adopt a mature component if a controlled test demonstrates better quality per total cost, not merely more features.

## Other useful patterns

- [Aider repository map](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py) and [Serena symbol tools](https://github.com/oraios/serena/blob/8833e5e87363afaa1608f9347f5ad6adf7066b0f/src/serena/tools/symbol_tools.py): ranked definitions and symbol/reference lookup are candidates for large cross-module tasks. Avoid mandatory parser/LSP setup before measuring the gain.
- [mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py): explicit loop budgets and retained trajectories support a small inspectable runtime.
- [SWE-bench evaluation](https://github.com/SWE-bench/SWE-bench/blob/02e7a74ffd0b707aab73d203fe87bdc7c76afc8e/swebench/harness/run_evaluation.py): evaluate produced code independently from execution, preserving failed and interrupted work.

## Cost routing: explicit native execution

Changing model tiers within an existing native executor is smaller work than adding a new coding-agent runtime. A local Ollama model still needs an executor that performs file/tool operations and produces the shared result contract. API compatibility alone does not supply that loop. Core 0.2.0 adds explicit phase/tier routing and an optional Ollama route through Codex OSS; see [configuration and limitations](ROUTING.md).

Begin with narrow low-risk tasks, mandatory checks, bounded retries and recorded effective model/provider. Compare approved-task cost and elapsed time, including repair work. Do not silently fall back to a metered provider when a budget is exhausted. Hardware, model quality and context limits determine whether local inference is worthwhile.

[Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) and its [partial OpenAI API compatibility](https://docs.ollama.com/api/openai-compatibility) provide integration surfaces. [OmniRoute](https://github.com/diegosouzapw/OmniRoute) is a possible gateway for multi-provider routing; the current native-CLI pilot does not require a gateway. No proxy service, account provisioning or automatic model download is added. Local inference remains opt-in and needs workload-specific evaluation.
