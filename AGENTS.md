# FORJA development

FORJA is a Node 24, zero-dependency orchestration CLI. Shared execution rules: [docs/CORE.md](docs/CORE.md). Delivery and publication policy: [docs/RELEASE.md](docs/RELEASE.md).

- Core entrypoint: `forja start`; implementation in `lib/core/`. Core is the only workflow; the legacy crew workflow was removed in 0.22.0 ([docs/LEGACY-REMOVAL.md](docs/LEGACY-REMOVAL.md)).
- Validate JavaScript changes with `npm test` and `npm run check`.
- Keep provider invocation details in adapters; workflow state and routing belong to the core.
- Preserve user edits and existing run state. Publish only to explicitly authorized repositories, after reviewing the exact snapshot and outgoing history. Never transfer private ancestry into a public repository.
- Static viewer changes follow `docs/design/DESIGN.md` and require desktop/mobile visual verification.
- The delivery agent reviews an explicit staged file list and runs `npm run release:check` before an authorized commit. Never stage raw conversations, user questions/answers, private run evidence or unrelated user edits. Public pushes require the full snapshot/history review in docs/RELEASE.md and authorization for the destination.
- Monitoring components (viewer, guard, notifications, project registry) are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); keep the registry (`data/projects.json`) and `.forja/` state formats unchanged, because external read-only tools depend on them.
