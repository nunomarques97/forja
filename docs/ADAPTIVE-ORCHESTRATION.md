# Adaptive orchestration: proposal and evaluation plan

**Status: research proposal, not an implemented mode.** Core still runs optional planning, development, controller checks and independent review. This document defines the next experiment and the conditions for adding capability-specific assistance. It does not activate extra agents, extend budgets or change old runs.

## Decision

Keep the current workflow as the default. Investigate **one bounded request for assistance**, made when a worker can identify a specific unresolved question or verification gap. Start with sequential assistance and one project writer. Do not introduce a permanent architect, researcher or second reviewer for every task.

The smallest useful experiment is an independent executable acceptance check for an uncertain contract. Its author receives the contract before seeing the implementation, and its tests must accept alternative correct implementations as well as reject defects. This tests whether another capability adds reliable evidence, rather than assuming a new role name improves quality.

Production integration waits for that experiment. A keyword router choosing a larger team would be easy to implement but would not establish that the team is appropriate. A model's claimed confidence is also not a calibrated probability of success.

## What Core already adapts

[Routing](../lib/core/routing.mjs) combines explicit phase/tier routes with [provider tiers](../lib/core/providers.mjs) and [source/path risk signals](../lib/core/context.mjs). Easy implementation selects `fast`; hard work, architecture/security signals and repeated attempts select `strong`. Review selects `strong`, or `critical` for security. Explicit operator routes can still choose any configured model.

[The scheduler](../lib/core/engine.mjs) handles implementation checkpoints, validation failures, rejected reviews and bounded repair. A provider timeout or protocol failure blocks instead of silently retrying. A route can shorten the run's per-invocation time limit, not extend it. There is no built-in whole-run deadline.

These mechanisms select executor strength and preserve work. They do not classify why a task is difficult, allocate specialist capabilities, verify that a browser/database is available, replan a dependency graph or coordinate concurrent project writers. Existing risk labels are signals, not a complete capability inventory.

## External evidence and what it supports

| Source inspected | Useful finding | FORJA decision |
|---|---|---|
| [Anthropic: composable agent patterns](https://www.anthropic.com/engineering/building-effective-agents) | Routing, parallel sections, orchestrator-workers and evaluator feedback solve different problems. Complexity should follow measured value. | Select a capability to answer a concrete question; do not equate a difficult task with a fixed roster. |
| [Anthropic: long-running application harness](https://www.anthropic.com/engineering/harness-design-long-running-apps) | Independent interaction-based evaluation found missing behavior; the useful amount of scaffolding changed with model capability. | Keep independent review, assess actual behavior and reevaluate additions against the exact configured models. Their application examples do not establish a FORJA speedup. |
| [OpenHands task manager, pinned source](https://github.com/OpenHands/software-agent-sdk/blob/cd02db3a181c0bed5ee34711b46c06c88288854e/openhands-tools/openhands/tools/task/manager.py) | Subtasks have distinct conversation identities, inherited/overridden limits and shared parent workspace in this implementation. | Preserve provenance and account for every child. A lock on task metadata does not provide independent filesystem workspaces or enforce FORJA's global budget. |
| [OpenHands delegation example](https://github.com/OpenHands/software-agent-sdk/blob/cd02db3a181c0bed5ee34711b46c06c88288854e/examples/01_standalone_sdk/25_agent_delegation.py) | Two independent analyses are delegated and consolidated. | Useful API pattern, not evidence that parallel developers safely edit the same project or produce better software. |
| [Ruflo status](https://github.com/ruvnet/ruflo/blob/9c61c86f06b439af2a95085ae9bb0ca839662e41/docs/STATUS.md) and [README](https://github.com/ruvnet/ruflo/blob/9c61c86f06b439af2a95085ae9bb0ca839662e41/README.md) | A broad orchestration surface is presented separately from operational status and deeper guides. | Borrow the separation of introduction, status and reference. Do not import a framework or treat advertised capability counts as comparative quality evidence. |

This was a review of selected source/documents, not an audit or execution of those systems. No new framework or service is required. Shared state, retries and integration remain engineering work even when a delegation API exists.

## Choose by the missing evidence

The following are proposed decision boundaries, not implemented automatic routes. Routine tasks retain independent review.

| Situation | First response | When additional assistance is justified |
|---|---|---|
| Small reproducible bug | Developer, focused regression, controller checks, reviewer | No additional role unless a concrete unresolved cause remains. |
| Medium cohesive feature | Existing plan and implementation/review loop | Missing contract or required tool, not file count alone. |
| Ambiguous behavior | Locate the authoritative requirement; record the unresolved question | Contract investigation if a reasonable engineering interpretation can be tested; Sponsor if consequential product intent remains undecidable. |
| Cross-cutting architectural change | Compare constraints, migration and failure behavior during planning | Architecture investigation when conflicting invariants or migration options remain unresolved. Output a decision and a falsifiable prototype, not a second full plan. |
| Security-sensitive feature | Strong implementation, critical review, negative tests | A focused security review when a particular trust boundary lacks evidence. It supplements, rather than votes away, general review findings. |
| Difficult bug after failed repair | Preserve the reproduction, failing logs and source version | A debugger asked to distinguish explicit competing causes. Repeating the implementation prompt with a new role name is not a new strategy. |
| UI redesign | Define interaction/visual criteria and exercise the real interface | UI evaluation only with an available browser and usable environment. Screenshots alone cannot demonstrate interactions. |
| Two apparently independent modules | Check dependency and integration boundaries | Parallel implementation only after isolated workspaces, integration ownership and whole-project revalidation exist. Defer in the first increment. |
| Missing authentication, paid choice or exhausted budget | Block with the relevant reason | Another agent cannot supply authorization or make exhausted limits disappear. |

Do not infer uncertainty from prose length or an invented numeric confidence. A request should name an unresolved question, supporting evidence, alternatives considered and the observation that would resolve it. Capability detection must distinguish declared availability from a probe that actually succeeded.

## Proposed assistance contract

Before extending the public schema, prototype the following contract in an isolated experiment:

1. **Request:** task ID, capability (`contract`, `debugging`, `architecture`, `security`, `visual`), one bounded question, evidence references, requested deliverable and stopping condition. Keep text/items bounded. These are proposed values, not valid current configuration fields.
2. **Eligibility:** controller checks explicit opt-in, unresolved Sponsor decisions, supported capability, available tools, current source version and remaining global/phase budgets. No silent provider fallback or automatic increase of limits.
3. **Reservation:** persist a unique request ID, source hash, original task status, selected route, reserved invocation allowance and pending child identity before launch. Count started assistance against the same cloud/session totals. Reserve room for required validation and review; inability to reserve means blocked.
4. **Execution:** one helper, no nested delegation, no concurrent source writer. Full-access settings remain respected; one-writer ownership is a workflow rule, not a claim of OS isolation. Give the helper only relevant contracts and references, with data/instruction boundaries intact.
5. **Result:** bounded conclusion, executed evidence, remaining uncertainty and artifact hashes. Advice is untrusted evidence, not approval or a new Sponsor decision. Missing/invalid output and source changes cannot be accepted as success.
6. **Integration:** verify source/contract hashes before consuming results. Hand findings to the existing developer; only normal controller checks and independent review can complete the task. Do not reset implementation attempts, context rotations or acceptance baselines to buy free retries.

For the initial acceptance experiment, write helper tests in a dedicated scratch fixture with only the contract and interface scaffold. Calibrate them before adding them to a candidate's acceptance set. Declaring those generated tests authoritative in the live project before calibration would simply move the same overfitting risk into another agent.

## Persistence and recovery design

A future optional state extension needs a policy/version marker and explicit `requested → reserved → running → completed | failed | stale` assistance records. Older runs without it keep their exact workflow. The request ID must make resume idempotent; a persisted pending invocation is not permission to launch a duplicate helper.

The first increment must specify all of these transitions before a native pilot:

| Event | Required behavior |
|---|---|
| Crash before launch, reservation persisted | Reconcile the reserved record without double-counting or silently losing the allowance. |
| Crash after launch or unknown child liveness | Preserve the pending record; do not launch another helper until process ownership is resolved. |
| Helper returns after code or contract changed | Mark evidence stale; do not inject it into the new source version. |
| Helper times out, fails authentication or returns invalid JSON | Record the failure and block under the original limits; no automatic recursive assistance. |
| Helper modifies protected files or controller state | Use existing integrity checks and preserve the offending files for inspection. |
| Helper suggests a paid/unknown-cost option | Enter the existing Sponsor decision path before adoption. Advice cannot answer on the Sponsor's behalf. |
| Two reviews disagree | Resolve a reproducible finding against criteria; no majority-vote approval over a valid defect. |
| Retry, validate-only recovery or final regression | Preserve counters and provenance; no automatic repeat of a completed helper or replacement of acceptance bytes. |

## Evaluation before implementation

Freeze new fixtures, exact provider/model/effort, budgets, run order, grading and stopping rules before any calls. Keep earlier closed studies closed. Use the ordinary configured models; do not validate a cheap route with an unrelated stronger model.

**First experiment: independent acceptance.** Use two new behavioral families, each with at least two materially different correct implementations and independently witnessed defective variants. Compare the current developer-generated tests with a contract-only helper's executable tests. Evaluate held-out variants that were not used to calibrate the helper. Measure false rejection of valid behavior separately from missed defects. Do not expose hidden variants to either author, and record any root intervention as assistance.

Promotion gate for this bounded experiment: no false rejection of the held-out correct variants, no family regression in defect detection, at least two additional independently witnessed defects detected overall, and no weakened acceptance/source integrity. These are prospective engineering thresholds, not a statistical guarantee. If both arms hit a ceiling, retain the current default; a tie is not evidence for another mandatory agent.

Report total native time, complete controller wall time, input/cache/output coverage, calls, retries, repair, timeouts and incomplete runs. Quality is primary: extra time is acceptable when it purchases demonstrated improvement. Do not count speculative parallel time savings, missing usage as zero, or passing partial code as autonomous completion.

**Only after a positive result:** implement an opt-in sequential assistance path, deterministic tests for the transition table, and fresh end-to-end success/failure controls. Check the six task classes above for unnecessary helper requests as well as missed requests. Expand to debugging/security/architecture individually only when each has an evaluation contract. Parallel writing and dynamic replanning need separate design and integration tests.

## Implementation sequence and exit criteria

1. Run the independent-acceptance experiment outside the scheduler. Exit with a frozen result, including negative findings; no runtime migration.
2. If justified, add typed assistance schemas and a pure eligibility/reservation policy. Test boundaries, request duplication, budgets and compatibility with old state without launching models.
3. Add one sequential helper adapter route and persisted recovery transitions. Reuse controller evidence/integrity mechanisms, but explicitly handle generated artifact ownership. Run the complete suite and a fresh native pilot.
4. Document effective capability, reason, model, added time and outcome in existing observation surfaces. A future UI change requires its own desktop/mobile verification.
5. Consider isolated parallel work and replanning only after integration ownership, cancellation, stale evidence, shared budgets and source conflicts are demonstrated to work.

Do not remove the current final checks, independent review or Sponsor gates to simplify the prototype. Do not enable an unproven route merely because its deterministic state-machine tests pass. The test harness establishes orchestration correctness; representative native evaluation must establish whether the extra capability helps.
