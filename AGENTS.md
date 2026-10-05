# FORJA development

FORJA is a Node 24, zero-dependency orchestration CLI. Shared execution rules: [docs/CORE.md](docs/CORE.md). Delivery and publication policy: [docs/RELEASE.md](docs/RELEASE.md).

- Core entrypoint: `forja start`; implementation in `lib/core/`. Core is the only workflow; the legacy crew workflow was removed in 0.22.0 ([docs/LEGACY-REMOVAL.md](docs/LEGACY-REMOVAL.md)).
- Validate JavaScript changes with `npm test` and `npm run check`.
- Keep provider invocation details in adapters; workflow state and routing belong to the core.
- Preserve user edits and existing run state. Publish only to explicitly authorized repositories, after reviewing the exact snapshot and outgoing history. Never transfer private ancestry into a public repository.
- Static viewer changes follow `docs/design/DESIGN.md` and require desktop/mobile visual verification.
- The delivery agent reviews an explicit staged file list and runs `npm run release:check` before an authorized commit. Never stage raw conversations, user questions/answers, private run evidence or unrelated user edits. Public pushes require the full snapshot/history review in docs/RELEASE.md and authorization for the destination.
- Monitoring components (viewer, guard, notifications, project registry) are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); keep the registry (`data/projects.json`) and `.forja/` state formats unchanged, because external read-only tools depend on them.

<!-- forja-core:begin -->
## FORJA core
New FORJA tasks use Core. The conversation agent prepares the goal, starts the controller and reports its result; it does not act as Lead or manually dispatch the legacy crew.
Resolve `<forja>` from the caller-provided installation, `FORJA_ROOT`, or an existing FORJA hook path in `.claude/settings.json`. If unavailable, ask for the installation path; do not guess or install another copy.
Read `<forja>/docs/CORE.md` and `<forja>/docs/CORE-RUNBOOK.md`. From this project: `node "<forja>/bin/forja.mjs" start --goal "..." --provider claude|codex|kilo`. Supply the explicitly selected profile with `--config`; installing or updating FORJA does not select models.
The controller owns planning, development, checks and independent review. Workers read only the phase and applicable domain methods supplied in `specialist_context`. Do not load `forja-lead` or other legacy crew skills for Core work.
Core state and usage live in `.forja/`. Inspect existing changes before starting; preserve them and use `--allow-dirty` only when work on that snapshot is authorized. Git delivery requires explicit configuration and the controller delivery contract.
Preparation does not start a run. Never silently resume or replace an active Core or legacy run. Stop existing executors before an explicitly authorized handover; preserve their state and unfinished work.
Legacy `runner` and `run start` are compatibility commands only when explicitly requested. Their state remains in `docs/forja/`; read legacy methods as files for that workflow. Restart the conversation after migration to discard previously loaded legacy instructions.
<!-- forja-core:end -->
