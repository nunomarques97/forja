# Bounded model comparison

`forja core benchmark --config <file>` executes a comparison explicitly. It is separate from the read-only `core evaluation-plan` triage: an investigation signal never launches calls by itself. The first executor supports Claude subscription access, exact model/effort pairs and the existing bubblewrap check backend (Linux, or an explicitly named WSL distribution on Windows). There is no host fallback, API-key override or automatic profile change.

Use a private JSON configuration with `version: 1`, `baseline` and `candidate` objects containing `model` and `effort`, a `tasks` array selected from `implement`, `review`, `plan`, and these explicit budgets:

| Field | Accepted values |
|---|---|
| `repetitions` | 3–5 per task and profile |
| `maxCalls` | 6–30; must cover the complete selected schedule |
| `timeoutMs` | 1,000–180,000 per provider process |
| `maxDurationMs` | At least `timeoutMs`, at most 1,800,000 |
| `checkIsolation` | `{"backend":"bubblewrap"}` on Linux; add `"distribution":"Ubuntu"` or the actual installed distribution on Windows |

Both profiles must be distinct, use explicit `claude-…` model identifiers and `low`, `medium`, `high` or `max` effort. Authentication/model access is still validated by the native provider. The total budget is checked at call boundaries, reserving a full provider timeout before each call; supervision and isolated grading can run past that boundary, after which the run stops. There are no retries or resumptions. A failed run is retained; a later experiment creates a new directory and does not replace it.

The controller creates a fresh directory under the OS temporary directory, prints its path in the report, and leaves all evidence there. Move/copy that directory to private durable storage if needed; OS cleanup may remove temporary files later. No project code, `.forja` state or active routing is read or modified. Native subscription configuration remains subject to the installed provider; rate-limit observations are not a billing guarantee. API environment overrides are refused. Observed overage, a rejected quota event or weekly utilization at least 95% stops further calls.

## Frozen inputs and execution

Before calls, `protocol.json` captures exact prompts/schemas, profiles, schedule, budgets, source hashes, native CLI and Node versions, oracle, review controls and creative rubric. A SHA-256 binds that file. Source hashes and protocol bytes are checked before and after each call. This is tamper detection during an experiment, not a signed or adversarially tamper-proof archive.

Candidates alternate first/second position across repetitions. Their prompts are identical within a task, with no earlier answers or oracle feedback. Claude runs in restricted response-only mode without external tools. The synthetic tasks and independent checks are curated source assets; user conversations and real project material are never included implicitly.

- **Implementation:** generate a bounded Python interval-merging function. The controller runs independent checks in a fresh bubblewrap snapshot with no network. A known correct reference must pass, while four known defects must fail, before model calls begin. Generated code never runs through host `eval`, a JavaScript VM or an unrestricted subprocess.
- **Review:** classify eight related implementations, including correct controls and known defects. The controller counts false approvals and false rejections; explanations and every response remain in the private artifacts. These small, related cases do not measure general reviewer ability.
- **Planning:** produce three art directions for one creative brief, followed by technology choice and tradeoffs. Structure is checked automatically; creative merit remains `manual_review_required`. The rubric covers distinct directions, specificity, feasibility, mobile performance and accessibility. No keyword or library-name score substitutes for a blind assessment across the responses.

Incorrect answers remain recorded and the schedule continues. Execution errors, unauthorized tools, unconfirmed/mixed model identity, quota conditions, changed frozen inputs or expired budget stop subsequent calls. Check infrastructure failures are unavailable evidence, not model defects. `started.json`, the provider response, native trace, assessment and append-only attempt ledger distinguish a started call from an assessed result. A process crash may leave an incomplete initial report; inspect the preserved call artifacts rather than rerunning into the same directory.

## Decision limits

The report can recommend `retain_baseline`, `propose_profile_change` or `insufficient_evidence`, scoped only to the selected tasks. Native execution, the full paired schedule, confirmed identities and complete measurements are prerequisites. Any creative task requires a later assessment and yields insufficient evidence in this version.

A candidate proposal requires every selected check to pass when the baseline has at least one failure. If the baseline passes all checks, it is retained; a faster candidate cannot compensate for a correctness failure, and a tie does not force a profile change. Duration and input/output tokens are observations, not statistical significance, pricing or subscription charges. Simulated execution is explicitly labeled and cannot produce a native adoption recommendation.

This fixed battery validates the comparison mechanism. It is not a universal qualification suite, a creativity certification or evidence that one model is consistently superior. Add representative frozen tasks before adopting a profile for a broader workload; keep promotion explicit, reversible and limited to new runs.
