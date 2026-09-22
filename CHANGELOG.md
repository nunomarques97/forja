# Changelog

## 0.4.3 — Avoid overlapping integration checks

- Share an exact overlap between the end of planned task checks and the start of caller-owned final checks. An acceptance command listed at both boundaries runs once before independent review.
- Preserve the order of both check sequences, explicit repetitions within each list, non-adjacent matches, intermediate-task gates and source-change revalidation. Commands and argument arrays must match exactly.

## 0.4.2 — Validation evidence bound to unchanged source

- Check the project snapshot after each acceptance command, including failed commands and final regression checks. A source change blocks continuation before later checks, review or automatic repair can conceal it or consume more worker sessions.
- Preserve changed files and check logs for inspection; never assign passing evidence to a source version that changed during validation. Generated output in Git-ignored paths remains allowed.
- Add regression coverage for source changes, changes restored by a later command, failed mutating checks, new non-ignored files and ignored output. This is a source-integrity check, not a sandbox for commands.

## 0.4.1 — Resume after Sponsor technology approval

- Clarify that the controller collects Sponsor choices before implementation; planners must not create redundant tasks to ask for or confirm approval.
- Define structured technology output as new unresolved choices only. Workers use recorded decisions and return an empty assessment instead of repeating approved alternatives.
- Keep duplicate and changed-decision rejection strict, with a regression protecting recorded Sponsor selections. No approval, budget or payment boundary is relaxed.

## 0.4.0 — Technology choices and Sponsor cost decisions

- New runs compare material unresolved technology choices within the existing planner, with bounded alternatives, evidence, cost basis and recommendation. Routine work returns an empty assessment; there is no mandatory Scout session. Planner adapters enable primary-source research for cloud providers.
- Any reported paid or unknown-cost alternative pauses the scheduler, including when the recommendation is free or the cost is discovered during implementation/review. Resume, retry and elapsed time cannot supply an answer. All-free choices are recorded automatically.
- Explicit Sponsor choices are available through `core decide` and the authenticated `/core` panel. No option is preselected. Run identity, project locks, input bounds, same-origin checks and idempotent answers protect continuation; budgets remain unchanged.
- Pending cost decisions attempt one status-only notification per pending set through the configured ntfy transport, with a five-second timeout and a credential-free panel link. Missing configuration or delivery failure leaves work blocked.
- Desktop/mobile decision forms preserve pending selection and focus across polling, handle stale/network failures and distinguish recorded answers from launched continuation. Existing runs remain readable and no runtime dependency is added.

The scheduler enforces reported decisions; technology discovery and cost classification still depend on model output and evidence. A choice never authorizes payment, subscriptions or credential access. Research can add time within existing limits; no general speed or product-quality improvement is claimed.

## 0.3.0 — Task boundaries and interruption diagnostics

- Worker context identifies remaining task criteria, shared files, dependencies and whether final integration checks apply now. Scheduler and prompts share the same gate predicate, including repairs. Additional scope guidance is omitted when no other task remains.
- Native provider invocations persist a bounded metadata-only event journal while running. Monotonic receipt times, event coverage and interrupted traces aid diagnosis without reconstructing missing token usage or treating receipt intervals as model inference time.
- Trace destinations reject existing files and symlinks; observation failures stop execution. Raw provider streams remain separate private run evidence.
- Legacy atomic state writes preserve the previous complete file and propagate replacement failures instead of falling back to an in-place write. Transient Windows replacement errors retain bounded retries.
- Documented cohesive task planning and its development/review session tradeoff. Existing routing/model defaults and independent review remain unchanged; there is no automatic task merging or new runtime dependency.
- Planner guidance keeps acceptance tests with implementation, performs discovery during planning, requires a reason for task boundaries and specifies executable behavioral checks without an implicit shell.

Task guidance is not a file sandbox or a guarantee of model compliance. Smaller task counts can reduce sessions for bounded cohesive work, but do not establish general product-quality, speed or monetary savings. Event journals are observational metadata, not model-call counts or token invoices. No automatic commit or push was added to Core workers.

## 0.2.0 — Quality gates and explicit routing

- User-configured final acceptance commands run at integration, before approval, and after relevant final regressions. Failed checks return to development within the existing attempt budget.
- Review prompts cover asynchronous success/failure transitions, paging recovery, empty states, keyboard focus, accessible loading feedback and repeated UI lifecycle setup/cleanup.
- Explicit provider/model/effort routes per phase and risk tier, isolated provider settings, per-route time caps and a persisted cloud-session budget. Native executor failures stop without automatic provider fallback.
- Economy and Haiku configuration examples; an opt-in Ollama pilot through Codex OSS checks for installed local tool-capable weights and retains the workspace sandbox. No automatic downloads or added runtime dependencies.
- Usage distinguishes executor from inference backend. Older runs remain compatible and their previous invocations count conservatively toward cloud limits.
- Replaced a machine-speed assertion with deterministic API coverage while liveness refreshes remain unresolved.

Presets require model access in the selected native CLI. Economy and local presets remain experimental: the medium UI trial hit its development timeout and its preserved partial output had reproducible defects; the native local edit/check smoke test does not establish medium-task quality. Existing native model defaults remain unchanged. Session limits are not token, currency or subscription-quota limits. No automatic commit or push was added.

## 0.1.0 — Core baseline

- Shared Node scheduler for native Claude and Codex: planning, development, deterministic checks and independent review.
- Persistent task state, bounded retries, checkpoints and explicit recovery with implementation preservation.
- Bounded source-backed Markdown retrieval, optional required-knowledge manifest and context-source accounting.
- Usage attribution by task, phase, provider, model and attempt; unknown usage and native cost coverage remain explicit.
- Read-only Core viewer, guarded interrupted-run recovery and executor-preserving viewer shutdown.
- Delivery policy and staged-content privacy checks; local research and conversation artifacts excluded from new release commits.
- Notification destinations moved to ignored local configuration; unconfigured clones send nothing. Portable synthetic fixtures replace dependencies on private run documents.

Legacy commands remain available. The repository has no added runtime dependencies. Product quality still depends on sufficient acceptance coverage; UI state transitions and accessibility are priorities for the next iteration. Native token/cost observations are not subscription invoices. Local-model routing remains experimental future work, not part of this release.
