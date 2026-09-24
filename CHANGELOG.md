# Changelog

## 0.18.0 — Reliable Core entrypoints and bounded continuation

- Prepare Core projects by default with `bootstrap`; retain crew installation behind explicit `--legacy`. Repair skill description quoting, keep workflow methods manual-only, and reversibly archive recognized legacy agents only when their run is known to be inactive.
- Preserve bounded private progress notes across development sessions. Stop unchanged context rotations and bound repeated forced stops even when superficial edits or notes keep changing.
- Give planning explicit context estimates and the no-intermediate-commits delivery contract, with advisory scope and Git-state warnings. Keep legacy handovers and archived agents out of automatic knowledge discovery.
- Suppress obsolete dead-subagent alerts after their parent closes or Core takes over. Continue inspecting healthy projects when another project's state is unreadable.
- Harden migration preflight, YAML validation and rollback against unknown run states, custom agents and concurrent archive collisions. Preserve existing work, run state and model profiles.

## 0.17.1 — Core entrypoint migration

- Migrate legacy project instruction blocks to Core without changing product rules, unfinished work, model profiles or run state.
- Make legacy methods manual-only and default newly bootstrapped project guidance to the Core controller, preventing conversational agents from selecting the old Lead workflow automatically.
- Keep initialization idempotent, portable and recoverable; validate legacy markers and skill destinations before any writes.

## 0.17.0 — Visible validation and attempt evidence

- Add read-only task-attempt accounting to model evidence, with explicit unknown coverage and no attribution of retries to model defects. Preserve historical triage behavior.
- Show the latest validation counts in the Core viewer, separating passed, failed, unknown and missing records. Missing or malformed summaries remain unavailable rather than implying zero failures.
- Require readable desktop/mobile section evidence in the existing planning, frontend and review methods; distinguish full-page composition from text-level inspection and delegate capture to controller checks when workers are restricted. Existing runs retain their frozen methods.

## 0.16.0 — Selective specialist methods

- Supply concise planning, design, frontend, backend, security and review methods within the existing Core phases, with explicit conditional reads compatible with restricted workers. Mixed tasks can use multiple methods without extra model sessions.
- Freeze method versions and hashes inside each new run; preserve older runs, project knowledge policies and model routing. Stop on missing or changed method snapshots instead of silently refreshing them.
- Document specialist responsibilities, context boundaries and visual evidence requirements; keep legacy crew definitions separate.

## 0.15.0 — Model evidence, bounded comparisons and creative planning

- Add read-only `core evidence` reports for current or explicitly selected archived runs, separating model identities, execution failures, recorded review responses and measurement coverage.
- Add `core evaluation-plan` to triage explicit run selections and prepare a comparison protocol. Repeated concerns request investigation; they do not establish model degradation or change routing.
- Add explicit, budgeted `core benchmark` comparisons through Claude with frozen inputs, alternating candidates, retained results and isolated Python checks. Creative assessment remains manual; recommendations are scoped to the selected synthetic tasks and never promote profiles automatically.
- Explore a small set of viable art directions within the existing planner for open visual briefs. Preserve approved designs, connect the chosen direction to task acceptance criteria, and add no agent or mandatory review session.
- Preserve existing models, configurations and active run state. Research transcripts and private evaluation results are excluded from the release.

## 0.14.0 — Isolate controller checks and automate reviewer-approved delivery

- Add optional Linux/WSL bubblewrap checks with read-only source snapshots, isolated network/process namespaces, bounded scratch/output and deterministic teardown. Refuse unavailable isolation without host fallback; record snapshot evidence for acceptance and final checks.
- Let the existing final reviewer approve the exact delivery tree and commit message in the same session. The controller creates the approved commit using a separate index; no additional agent, model route or model invocation is introduced.
- Add explicit per-run commit/push authorization and a protected project deployment contract. Unknown effects and unapproved production block push; exact-commit production approval is available through `core deliver --approve-production`.
- Refuse unrelated initial edits, changed review inputs, pipeline drift, private snapshot findings and unpublished local ancestry. Preserve receipts and local commits on blocked or uncertain publication; never force-push, merge, tag or bypass server protection.
- Document prerequisite and deployment limits. Both capabilities are opt-in; active configurations, historical runs and provider models are unchanged.

## 0.13.0 — Restrict Claude worker file tools

- Add explicit Claude `writePolicy: "restricted"`, requiring CLI 2.1.280 or newer. Limit workers to native file tools within the project and a dedicated scratch directory; planning and review receive only read tools. Disable shell, Git, MCP, subagent and code-execution capabilities in this mode.
- Deny native edits to Git, scheduler and tool-configuration metadata and caller-protected files. Reject conflicting full access, extra CLI arguments, nonempty MCP configuration and unsupported providers without falling back. Preserve existing access settings and model routes.
- Give every invocation its own retained scratch directory and child-only temporary environment; record policy/scratch metadata privately. Direct probes to that directory instead of shared temporary names. Custom executors retain their stdin protocol.
- Document the native tool boundary, opt-in example and controller-check limitations; add adapter, concurrency, routing and workflow regression coverage. This is not an OS sandbox for arbitrary processes.

## 0.12.0 — Focus execution diagnostics

- Filter read-only Core diagnostics by invocation ID, phase or both, through the API and `core diagnose --invocation ID --phase PHASE`. Preserve the unfiltered report schema and global ledger warnings; no matches return an empty invocation list.
- Validate selectors before reading project state. Accept canonical decimal CLI IDs from 1 to 200 and known phases; report generic errors without echoing supplied values.
- Read only selected trace files after reconciling the complete ledger, so unrelated traces do not consume the diagnostic read budget. Preserve pending-record handling, lifecycle checks and privacy.
- Cover API compatibility, CLI validation, read budgets, global warnings and read-only behavior with regression tests; document selectors and limits.

## 0.11.2 — Recover initialization and report incomplete tool traces

- Preflight all Core initialization targets before writing. Reject links and unexpected file types; restore original bytes and remove new outputs after an in-process failure, including partial writes and failed directory creation. Preserve existing state and report incomplete recovery without stopping other rollback actions.
- Keep initialization idempotent and its returned file list independent of future calls. Recovery is best effort, not crash-atomic or safe against concurrent edits.
- Mark unfinished tool traces as partial, validate lifecycle statuses before counting tools, and retain the first accepted lifecycle when later records contradict it. Compare terminal status and normalized exit code when replaying completions.
- Ignore malformed end records without closing the trace or hiding later events. Preserve diagnostic privacy, read limits and interval union semantics; add fault-injection and lifecycle regression coverage.

## 0.11.1 — Preserve handoffs and validate execution budgets

- Apply legacy answers under the driver claim mutex, rereading current state and refusing a replaced run. Preserve concurrent handoff requests, ownership changes and checkpoints.
- Synchronize the runner handoff regression with explicit session release instead of a fixed delay; cover stale answer snapshots with deterministic concurrent CLI tests.
- Make `core doctor` validate execution budgets with the same defaults, coercion and bounds as startup, before inspecting executors. Keep diagnostics private, project files unchanged and cloud routing limits strict.

## 0.11.0 — Recover preserved work with explicit limits

- Persist checkpoint receipts across controller restarts, retain partial edits and account for continuations separately from implementation attempts. Refuse exhausted budgets before charging an attempt or starting another provider.
- Add an explicit cloud-session recovery limit. Keep route time caps and provider quota distinct; expose actual time/context enforcement without claiming live context measurement for Codex/custom executors.
- Show public-safe recovery reasons and guidance in the Core viewer and CLI, with expandable limits, preserved focus and status announcements. General recovery stays in the terminal.
- Add read-only `core doctor` checks for Node, Git, project setup, routing and native executor presence. Do not invoke models, change project files, inspect login credentials or claim account/model/quota readiness.

## 0.10.3 — Reject unresolved acceptance targets before development

- Validate task checks and caller final checks before spending development attempts. Reject blank executables, NUL bytes and recognizable unresolved target placeholders without executing or rewriting commands.
- Keep historical run state readable and abandonable; block execution of invalid saved checks while preserving their commands and evidence.
- Preserve inline source, HTML, concrete URLs and future helper paths. Report check positions without copying private argument values into diagnostics.
- Cover plan rejection, legacy recovery, target boundaries and diagnostic privacy with regression tests; document the conservative detection limits.

## 0.10.2 — Discover existing projects from the Core workspace

- Show a concise notice and legacy viewer link for registered projects without Core state, including when there are no Core runs yet. Keep filter no-results and genuinely empty onboarding distinct.
- Expose only an aggregate count in the authenticated Core API; unreadable Core state remains an error project. Preserve stale snapshots, focus and compatibility with older servers.
- Verify mixed and empty registries, malformed state, safe metadata handling, and desktop/mobile browser transitions.

## 0.10.1 — English workspace and viewer screenshots

- Use English throughout the Core workspace and sign-in page, including status, decisions, errors, accessibility labels and number/time formatting. Project goals, task names and generated decision content retain their original language; compatibility views remain in Portuguese.
- Illustrate the public README with reviewed desktop and mobile screenshots using fictional projects. No private run data, credentials or local paths appear in these images.
- Preserve authentication, decision handling and refresh behavior. Existing services need a restart from the updated checkout to serve the new text.

## 0.10.0 — A Core-first workspace

- Make the responsive Core workspace the default at `/`, `/core` and `/m`. Move the previous event/roster pages to `/legacy` and `/legacy/m`, preserving authentication and legacy APIs.
- Lead with projects, attention needed, current goals and task progress. Add search/status filters; move task validation and session consumption into expandable details. Preserve choices, focus and expanded details across refresh.
- Bound reads and decision submissions, including response bodies; supersede obsolete reads and invalidate them before a decision. Keep stale data visible on errors, support retry, and clean up page lifecycles. No new dependencies, providers or execution phases.
- Verify desktop/mobile presentation and controlled network/decision transitions. Existing running services require restart from the updated checkout; active runs are not migrated.

## 0.9.0 — Explicit on-demand knowledge references

- Add opt-in version 2 knowledge manifests with `mode: "reference"` and a short `when` condition. Every worker phase receives the source path and consultation condition without automatic indexing or injection of the document body. Automatic excerpts and complete required notes remain available, including explicitly listed ADRs outside discovery folders.
- Reserve the shared context budget for required notes and the reference catalog before ranking optional excerpts. Reject contradictory required/reference policies, invalid modes, duplicate paths and out-of-project sources. Report missing or stale references; preserve mandatory freshness failures and existing version 1/no-manifest retrieval. Empty manifests explicitly report disabled discovery.
- Configure FORJA's specialist runbook, research, publication and design documents as references while retaining complete Core invariants. Keep reference conditions and excerpts framed as source data, not overriding instructions. No extra model session, agent phase, runtime dependency or model-route change.
- Cover retrieval noise, requirement preservation, reference discovery across phases, archived ADRs, budgets, freshness, compatibility and prompt framing with deterministic regressions. These checks establish controller behavior, not native model compliance, actual token savings or improved task completion.

## 0.8.3 — Contract-first acceptance research decision

- Document a frozen, four-session comparison of implementation-aware and contract-only test authors. Both accepted all four correct controls and rejected the same 23 of 24 faulty variants without grading timeout; contract-only authoring took 24.1% longer in this sample.
- Preserve the original assertion-only score and explain why its apparent improvement did not establish additional defect detection. Record the shared asynchronous test timeout and distinguish authoring measurements from end-to-end product delivery.
- Keep the current runtime and model routes. No helper phase, prompt change, budget increase or new default is introduced; refine future evaluation guidance to compare actual faulty variants and failure categories.

## 0.8.2 — Recover handoffs and invalidate stale approval

- Persist an accepted `done` or `ready_for_validation` handoff before publishing its result artifact. After controller death, resume can restore the artifact and enter mandatory validation/review without repeating development or charging another attempt/session.
- Bind recovery to the task, attempt, invocation, source hash and Git HEAD. Changed source/HEAD blocks replay; explicit task retry discards the receipt. Technology choices must be processed before retry can discard their cost evidence. Review budgets and Sponsor decisions remain mandatory.
- Cover abrupt process death before result publication, during the handoff and again during replay, plus source/HEAD changes, manual recovery, exhausted budgets, malformed state and legacy results. This is process-crash recovery, not power-loss durability or exactly-once external execution; checkpoints and incomplete provider calls are unchanged.
- Revalidate and request fresh review when source changes after the final task approval but before the run completes. Passing final checks cannot renew independent approval for different source; unchanged source needs no extra review, and existing session limits still apply.

## 0.8.1 — Project presentation and adaptive orchestration research

- Refresh the public README with an original lightweight SVG identity, an earlier quick start, concise quality controls, provider behavior, evidence limits and visible release history.
- Document a proposed bounded assistance protocol, source/version provenance, shared budgets, recovery transitions and a staged evaluation plan. Dynamic specialist allocation and parallel project writers remain unimplemented.
- Clarify optional full-access behavior in the routing reference. Runtime code, prompts, models, budgets and existing runs are unchanged; previous v0.8.0 regression counts are explicitly historical.

## 0.8.0 — Explicit full access for native workers

- Add provider-level `fullAccess: true` for every Core phase. Codex uses `danger-full-access` with approvals disabled; Claude uses `bypassPermissions`, disables its command sandbox for the session and exposes the default built-in tools, including during planning and review.
- Add a shared full-access configuration for both native providers. Existing configurations retain their previous permissions; provider-specific settings remain isolated across mixed routes. Custom executors must configure their own permissions.
- Keep controller checks, protected acceptance files, review source-integrity checks and Sponsor cost decisions. Full access changes native execution permissions, not acceptance criteria or operating-system privileges.
- Refresh the README version overview, including the 0.6.0 diagnostics and 0.7.0 protected-file releases.

## 0.7.0 — Protected acceptance files

- Add optional `protectedFiles` configuration for caller-owned acceptance tests, fixture data and contracts. Snapshot their hashes before work and block changed, missing or linked files before further workers/checks, including resume and final regression validation.
- Preserve changed files for inspection; retries and validation-only recovery cannot silently replace the initial acceptance baseline. Workers receive the protected paths and can add separate tests. Existing runs without this configuration retain their workflow and budgets.
- Bound file reads and validate the persisted manifest. This guards declared bytes at execution boundaries; it neither infers check dependencies nor proves test coverage or isolates hostile processes. No additional model session or runtime dependency is introduced.

## 0.6.0 — On-demand execution diagnostics

- Add `core diagnose`, a read-only summary of existing invocation ledgers and metadata journals. Show observed tool completions/failures, unfinished events, first file-change receipt, overlapping tool intervals and unattributed time without running a provider or changing execution budgets.
- Make missing, truncated, unsupported and inconsistent evidence explicit. Codex v1 metadata supports tool summaries; other providers and absent journals remain unavailable instead of reporting fabricated zeroes. Recorded coverage does not guarantee every native tool was exposed.
- Bound file/request/event reads and retain metadata-only output. No prompts, command contents, native session files, inferred token costs or automatic recovery are introduced. Execution quality and end-to-end speed are unchanged by this diagnostic capability.

## 0.5.1 — Current release documentation

- Replace stale README version labels with links to the package version, changelog and published tags. Document the validation handoff and its unchanged acceptance/review requirements.
- Update the public release overview and identify the v0.5.0 test results explicitly. This patch changes documentation and package version metadata only; runtime behavior is unchanged.

## 0.5.0 — Explicit implementation handoff for validation

- Developers can return `ready_for_validation` after implementation and focused tests, identifying scheduled checks still to run. The controller executes task checks and applicable caller acceptance checks before independent review; the handoff does not declare completion or claim those checks passed.
- Preserve legacy `done` results, source-integrity checks, bounded repairs, intermediate-task acceptance boundaries and Sponsor decisions. Unscheduled visual/security evidence remains the worker's responsibility. No additional agent, phase or budget is introduced; timeouts and intermediate messages are not treated as valid handoffs.
- Cover failing checks, interrupted validation, review approval requirements and preservation of existing validation and decision gates with regression tests.

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
