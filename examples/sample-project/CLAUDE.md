# sample-project — project rules

- Keep every module in `lib/` dependency-free; tests use `node --test` only.
- Greetings are always in Portuguese and end with an exclamation mark.

<!-- forja:begin -->
## Forja
- Forja repo: `C:\dev\forja`
- This folder is prepared for Forja; that does not start anything. Each run has ONE driver, recorded in `docs/forja/RUN.json` (`driver`), and it is chosen per run:
  - In a conversation (the Claude Code extension or a terminal session is the Lead): load skill `forja-lead` and run `node "C:/dev/forja/bin/forja.mjs" run start --goal "<goal>"` — the run is `interactive`, and the guard never launches a runner on it.
  - Unattended: `node "C:/dev/forja/bin/forja.mjs" runner --goal "<goal>"` from this folder (see `C:\dev\forja\docs\RUNBOOK-UNATTENDED.md`) — the run is `runner`, and the guard recovers it if the runner dies.
  - Hand-over between the two is explicit: `node "C:/dev/forja/bin/forja.mjs" run driver show|set interactive|runner`.
- Crew (core): Lead, Architect, Frontend Dev, Backend Dev, Reviewer. On demand: Product Manager, Product Designer, Technology Scout, QA, Security Reviewer (trigger table in docs/ARCHITECTURE.md §2b).
- All Forja runs keep state in docs/forja/.
<!-- forja:end -->
