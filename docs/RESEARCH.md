# Selected architecture research

FORJA keeps a small provider-neutral scheduler. External projects inform specific choices; their popularity and advertised speedups are not evidence that replacing the runtime improves this workload. Core requires no external agent framework.

For task-dependent capabilities, see the [adaptive-orchestration proposal and initial acceptance study](ADAPTIVE-ORCHESTRATION.md). The completed comparison found the same faulty variants rejected and all correct controls accepted in both arms; contract-only authoring took 24.1% longer in that small sample. An apparent assertion-count gain was a difference in failure classification, not additional faulty implementations rejected. The proposal retains recovery/budget requirements and future evaluation gates. No adaptive team mode is enabled by this research.

## Knowledge without repository noise

Keep concise, reviewed architecture, conventions and consequential decisions in Git Markdown. Execution state belongs in JSON; raw conversations, handovers, prompts, reports and measurements stay in ignored local storage. Promote a useful lesson by rewriting it as a technical invariant, without personal details or dialogue. See [publication policy](RELEASE.md).

Obsidian is an optional interface over Markdown. It does not choose the right excerpts, enforce freshness or determine what may be published. FORJA selects bounded lexical excerpts with path/line/hash provenance and optional required notes. Source remains authoritative. The current declaration map is heuristic, not an AST or dependency graph. Native executors load detailed code on demand.

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
