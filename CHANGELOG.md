# Changelog

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
