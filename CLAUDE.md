# FORJA: Claude adapter

Read AGENTS.md for repository development instructions and docs/CORE.md for the shared FORJA execution contract.

New runs: node bin/forja.mjs start --goal "..." --provider claude. Core state is in .forja/, with native provider usage in each run's usage.jsonl. No legacy crew is needed.

For an existing legacy run through forja runner or the viewer, read docs/LEGACY-CLAUDE.md and docs/ARCHITECTURE.md. Legacy RUN.json.autonomy (normal or total) continues to apply through lib/autonomy.mjs. Do not migrate a live run implicitly.
