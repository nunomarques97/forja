# FORJA: Claude adapter

Read AGENTS.md for repository development instructions and docs/CORE.md for the shared FORJA execution contract.

New runs: node bin/forja.mjs start --goal "..." --provider claude. Core state is in .forja/, with native provider usage in each run's usage.jsonl. Core is the only workflow; no crew agents or extra skills are needed.

Monitoring (viewer, guard, notifications, project registry) is described in docs/ARCHITECTURE.md. Older projects may still hold legacy run files: `core init` archives them and Core never executes them (docs/LEGACY-REMOVAL.md).
