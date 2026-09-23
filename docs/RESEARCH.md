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

### Bounded asynchronous acceptance pilot

A new permit-pool case exercised FIFO capacity, idempotent release, queued cancellation, abort after grant, close, and synchronous commitment before Promise notification. The caller-owned contract and external evaluator were frozen before native execution. Controlled event-loop barriers observed pending work; a 300 ms guard turned missing required progress into a failure carrying its criterion and trigger. A separate 8 s child-process watchdog contained code that blocked the event loop. These are fixture budgets, not general production latency requirements.

The evaluator accepted **2/2 correct controls**, including an alternative that deferred Promise delivery with `setImmediate`, and rejected **12/12 seeded defects** before the process watchdog. Complete defect evaluations took approximately **87–2,228 ms**. Some failed with observed assertions, some with explicit missing-progress diagnostics, and one with unexpected target exceptions; these categories can overlap within one defective implementation. Additional probes classified target syntax failure as a target error, distinguished missing evaluator/executable infrastructure, and contained an intentional synchronous loop at approximately 8.054 s. That watchdog result was recorded separately and was **not** credited as a specific defect detection.

The native trial used the actual Core controller with a supplied single-task plan, protected acceptance files, one implementation attempt, two session slots and no rotations or repair. Native metadata confirmed `gpt-5.6-terra`/`medium` for development (86.051 s; ten-minute limit) and `gpt-5.6-sol`/`high` for independent review (107.576 s; eight-minute limit). No Claude or local-model session was used.

The implementation passed **12/12 external criteria** and its **6/6 worker tests** passed, with protected files unchanged. The reviewer nevertheless rejected an unmet requirement: the worker-owned asynchronous tests awaited progress without a Promise guard or per-test timeout, despite the explicit requirement to bound those waits. Source inspection confirmed that omission. The Core then blocked at its one-attempt limit. This is **0/1 approved native deliveries**, not a successful end-to-end run; no native timeout occurred and no repair or rerun was used to turn the result into approval.

The case demonstrates useful bounded diagnostics in an external oracle and a concrete omission caught by independent review after green checks. It does not show that generated tests generally provide those diagnostics, that the worker tests actually hung in this execution, or that every asynchronous requirement is covered. The existing Core records exit status and logs; the semantic failure categories belong to this evaluator, not a new scheduler classifier. The [runbook guidance](CORE-RUNBOOK.md#aceitação-assíncrona-com-falhas-limitadas) makes the method explicit. No new runtime version, mandatory specialist or model-route change follows. A future experiment should use a new case to test whether a reusable progress helper prevents this authoring omission without rejecting valid asynchronous implementations; the present case remains closed.

### Supplied progress helper comparison

A new paired single-flight task compared the same written bounded-test requirements with and without a dedicated importable progress helper. The contract covered deferred factory invocation, coalescing, settlement cleanup, key identity and invalidation generations. Both isolated projects could read the same external oracle, including its inline guard; the intervention was helper availability plus a path cue, not exclusive access to the method. The evaluator accepted **2/2 correct controls** and rejected **12/12 seeded defects** before the protocol was frozen. Arm order was randomized once: supplied helper, then guidance alone.

Each arm used the actual Core with one implementation attempt, a supplied plan, protected acceptance files, no repair and no rotations. Native metadata confirmed Terra/medium development and Sol/high review in all four sessions, with ten/eight-minute limits and no native timeout. Both independent reviews approved: **1/1 delivery per arm**, each passing **12/12 external criteria**. The helper arm wrote six passing tests using the supplied 500 ms guard and 1000 ms test timeouts; guidance alone wrote seven passing tests with its own 1000 ms guard and test timeouts. Protected files remained unchanged.

Frozen post-run probes replaced only the implementation in separate copies, preserving the generated tests. Both suites accepted both correct alternatives, including `setImmediate` invocation. Both suites also rejected fulfilled-outcome and rejected-outcome stalls before the 20 s process watchdog. Complete stalled-suite executions took approximately 3.128/1.625 s with the supplied helper and 7.151/3.127 s with guidance alone; different guard durations and test counts prevent interpreting this as an implementation speedup.

The predeclared diagnostic classifier recognized **1/2** stalled variants as explicit bounded-progress failures in the helper arm and **2/2** in the guidance arm. Those original classifications remain unchanged. Supplemental source/log inspection found that the helper's rejected-outcome stall did expire at the named 500 ms guards, but `assert.rejects` applied outside those guards wrapped their errors as `ERR_ASSERTION`; the runner therefore omitted the original `CONTRACT_PROGRESS` code. Guidance-arm timeouts appeared as cancelled tests with `testTimeoutFailure`, not as event-loop-empty cancellation or a process-watchdog expiry. Bounded rejection and preservation of a machine-readable failure category are separate outcomes. The runbook now illustrates placing the progress guard outside the rejection assertion; that exact example was checked for expected rejection, wrong reason, unexpected fulfillment and missing progress.

This pair did not reproduce the missing-guard omission in either arm and does **not** establish that supplying the helper improves reliability. A single pair, unblinded reviewers, shared oracle access and different generated suites limit attribution. The earlier rejected permit-pool run remains closed and unchanged. Keep the helper optional and the existing runtime/model routes; no new version, mandatory phase or automatic classifier follows. Further testing should target a concrete integration gap, such as overlapping request invalidation and lifecycle cleanup, rather than repeat these utility cases to improve their scores.

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
