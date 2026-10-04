# Legacy crew workflow removal (0.22.0)

This document is the inventory and decision record for removing the legacy crew
workflow. It is the single source for the keep/remove decision of each legacy
surface, the removed CLI command set and its Core replacements (the 0.22.0
migration note), and the search patterns and allowlist for the "no remaining
references" proof. Later tasks of the removal implement these decisions; they
do not reopen them.

## Decision log

### D-2026-10-03: Core is the only supported workflow

- **Decision (Sponsor, 2026-10-03):** remove the legacy crew workflow from FORJA.
  FORJA Core (`forja start`, `forja core ...`) is the only supported workflow.
  Released as 0.22.0 (minor) with a migration note in CHANGELOG.md.
- **Why:** every registered project's legacy run (`docs/forja/RUN.json`) is
  terminal (finished or failed, none active), and the Sponsor's rules already
  say Core by default. The legacy code, crew agents and skills are dead weight
  and mislead readers (for example `.claude/agents/qa.md` suggests a QA role that
  Core never calls).
- **Reversible:** yes, through Git history (0.21.2 is the last release with the
  legacy workflow).
- **Unchanged by this decision:**
  - `lib/core/` stays byte-identical to the base commit `5089a41` (0.21.2). This
    covers the controller, workers, the six `forja-core-*` methods, checks,
    review, delivery and `status`/`resume`/`retry`/`abandon`/`deliver`, and the
    legacy *detection* Core already has (see below).
  - Core state formats under `.forja/` stay unchanged: Core writes them only from
    `lib/core/`, so the byte-identical `lib/core/` is the proof.
  - The project registry `data/projects.json` keeps its 0.21.2 byte format
    (`upsertProject` in `lib/projects.mjs`), proven by a golden test.
  - External read-only tools depend on both formats; neither is migrated.
- **Where recorded:** this entry is the decision-log record. CHANGELOG.md points
  here. `docs/forja/DECISIONS.md` is Git-ignored and refused by the delivery
  privacy scan, so it is not used for this decision.

## Legacy detection that stays

Older projects can still contain legacy files. Core keeps recognising them,
without executing anything legacy:

| Where | What it does | Decision |
|---|---|---|
| `lib/core/init.mjs` | `core init` archives legacy crew agents, skills and run files of an older project and disables them | keep (detection and archiving only) |
| `lib/core/instructions.mjs` `LEGACY_SKILLS`, `LEGACY_AGENTS` | names that `core init` recognises as legacy | keep |
| `lib/core/engine.mjs` | refuses to start while a legacy `docs/forja/RUN.json` is `running` | keep |
| `lib/core/instructions.mjs` managed AGENTS/CLAUDE block | still mentions legacy `runner`/`run start` as explicit compatibility commands | keep unchanged (lib/core frozen); residual, see "Follow-up" |
| `viewer/lib/state.mjs`, `viewer/lib/feed.mjs` | read historical legacy event lines so `data/events.jsonl` still replays | keep |

## Inventory

Columns: **Depends on it** lists what still uses the item today (before
removal). **Task** is the removal task that implements the decision
(T2 viewer launcher, T3 monitoring backend, T4 crew assets and bootstrap,
T5 CLI and legacy libraries, T6 docs and reference proof, T7 release).

### 1. Crew agents

| Item | Depends on it | Decision | Task |
|---|---|---|---|
| `.claude/agents/architect.md`, `backend-dev.md`, `frontend-dev.md`, `product-designer.md`, `product-manager.md`, `qa.md`, `reviewer.md`, `security-reviewer.md`, `technology-scout.md` | legacy runner prompts and `forja-lead`/`forja-crew` skills; `tools/check.mjs` (model policy, sample byte-copy check); `lib/bootstrap.mjs --legacy` (copies them) | remove all | T4 |
| `examples/sample-project/.claude/agents/*.md` (same nine files) | `tools/check.mjs` sample byte-copy check; `bootstrap --legacy` hint | remove all | T4 |

Core never calls a crew agent. Core specialists are frozen methods in
`.claude/skills/forja-core-*` read by the controller packet.

### 2. Skills

| Item | Depends on it | Decision | Task |
|---|---|---|---|
| `.claude/skills/forja-core-backend`, `-design`, `-frontend`, `-planner`, `-reviewer`, `-security` | `lib/core/specialists.mjs` (frozen method copies); `tools/check.mjs` core-skill sample-copy check | **keep, byte-identical** | none |
| `.claude/skills/forja-crew`, `forja-debug`, `forja-design`, `forja-implementer`, `forja-lead`, `forja-performance`, `forja-plan`, `forja-product`, `forja-qa`, `forja-release`, `forja-review`, `forja-scout`, `forja-security`, `forja-visual-check` | legacy runner prompts; crew agents; `tools/check.mjs` (autonomy rule, TASKS.json and sample-copy checks); `bootstrap --legacy` | remove all | T4 |
| `examples/sample-project/.claude/skills/forja-core-*` (six) | `tools/check.mjs` core-skill sample-copy check | **keep, byte-identical** | none |
| `examples/sample-project/.claude/skills/` non `forja-core-*` (the same fourteen) | sample byte-copy check only | remove all | T4 |

There is no other non `forja-core-*` skill in either tree. `forja-decide` is
named only in `LEGACY_SKILLS` (detection) and has no file.

### 3. CLI commands (`bin/forja.mjs`)

| Command | Depends on it | Decision | Task |
|---|---|---|---|
| `start`, `core *` | Core (delegates to `lib/core/engine.mjs`) | keep | none |
| `serve`, `token` (`lib/serve.mjs`) | viewer, phone access | keep | none |
| `up`, `down`, `autostart` (`lib/up.mjs`) | viewer + tunnel + guard autostart | keep; drop runner command-line handling | T3 |
| `guard` (`lib/guard.mjs`) | Core controller relaunch, viewer supervision | keep; drop legacy runner relaunch | T3 |
| `projects list|prune` (`lib/projects.mjs`) | registry listing | keep; status from Core state only | T3 |
| `bootstrap <repo> [--dry-run]` | Core preparation (`initCore`) + registry registration | keep as Core preparation alias | T4 |
| `bootstrap --legacy`, `--keep-legacy` | legacy crew install only | remove; refuse (exit non-zero, writes nothing) | T4 |
| the whole "Legacy (existing runs)" usage block: `run`, `task`, `runner`, `forjalvl`/`models`, `autonomy`, `decide`, `decisions`, `technology`, `obsidian`, `ask`, `answers`, `fallback`, `progress`, `report`, `notify`, `status`, `context`, `resume` | legacy runs only (`docs/forja/RUN.json`, `TASKS.json`, Sponsor queue) | remove; each refuses with exit 2 (see migration table) | T5 |

### 4. Libraries

| Module | Depends on it today | Decision | Task |
|---|---|---|---|
| `lib/core/**` | Core | keep, byte-identical | none |
| `lib/atomic-write.mjs` | Core, state-files | keep | none |
| `lib/notify.mjs` (ntfy) | `lib/core/observe.mjs`, `lib/core/sponsor.mjs`, guard, supervise, up, viewer server; also runner and the `notify` command | **keep unchanged**; only its legacy callers go | none |
| `lib/serve.mjs` | `serve`, `token` | keep | none |
| `lib/runner.mjs` (+ `config/mcp-forja.json`, used only by it) | `bin/forja.mjs`, driver; lock helpers imported by guard, projects, supervise, up | remove after T3 moves the needed lock/pid helpers | T5 |
| `lib/driver.mjs` | `bin/forja.mjs`, runner, `projects.mjs` (`resolveDriver`) | remove | T3 (projects stops importing), T5 (delete) |
| `lib/autonomy.mjs` | `bin/forja.mjs`, runner, state-files | remove | T5 |
| `lib/models.mjs` | `bin/forja.mjs`, runner, state-files | remove | T5 |
| `lib/run-cost.mjs` | `bin/forja.mjs` (`run checkpoint`/`finish`) | remove | T5 |
| `lib/obsidian-sync.mjs` | `bin/forja.mjs` (`run finish`, `obsidian sync`) | remove | T5 |
| `lib/usage-counts.mjs` | run-cost, `tools/perrun.mjs`, `tools/usage.mjs` | remove (Core usage lives in `lib/core` and each run's `usage.jsonl`, shown by `core usage` and `/core`) | T5 |
| `lib/state-files.mjs` | see per-function table | mixed | T5 |
| `lib/bootstrap.mjs` | see per-function table | mixed | T4 |
| `lib/spawn-runner.mjs` | see per-function table | mixed | T2/T3 |
| `lib/supervise.mjs` | see per-function table | mixed | T3 |
| `lib/guard.mjs` | see per-function table | mixed | T3 |
| `lib/projects.mjs` | see per-function table | mixed | T3 |
| `lib/up.mjs` | see per-function table | mixed | T3 |
| `lib/process-lock.mjs` (new) | guard, supervise, projects, up after T3 | create: lock, pid and command-line helpers moved out of runner.mjs | T3 |

### 5. Mixed files: per-function decisions

**`lib/state-files.mjs`.** Keep `forjaRoot`, `dataDir`, `projectKey`,
`nowIso`, `readJson`, and `writeJson` (covered by the atomic-write and
state-atomic tests). Remove everything else: run/task/queue/handover/decision/
settings/technology/report helpers, `newRunId`, `emit`, `DECISIONS_HEADER`,
`QUEUE_HEADER`, and its imports of `autonomy.mjs` and `models.mjs`. Users after
removal: guard, projects, supervise, up, serve, `viewer/core-api.mjs`
(`projectKey`), bootstrap (`forjaRoot`).

**`lib/bootstrap.mjs`.** Keep `bootstrap()` Core path (`initCore`) and registry
registration, and `resolveTarget`. Remove `planBootstrap`, `applyPlan`,
`summarize`, `hookCommand`, `hookEntry`, `mergeSettings`, `managedBlock`,
`upsertManagedBlock`, `detectEol`, `listFiles` and the `--legacy`/
`--keep-legacy` branch (crew install, settings/hook merging, legacy file
removal); those flags refuse with an English pointer to `forja core init`.

**`lib/spawn-runner.mjs`.** Keep `DETACH_SCRIPT`, `defaultSpawnRunner`,
`launchCore` (guard, `viewer/core-api.mjs`) and `launchForja` (supervise peer
relaunch). Remove `launchRunner` (guard legacy relaunch, viewer launcher).

**`lib/supervise.mjs`.** Keep all guard/viewer mutual supervision (peer plan,
peer entries, `guardPaths`, `upWatchPaths`, `controlPaths`, `runPeerCheckOnce`,
`appendPeerLog`, alive caches, `phoneUrl`). Change only its imports:
`LOCK_STALE_MS`, `commandLineOf`, `pidAlive`, `readLock` come from
`lib/process-lock.mjs`.

**`lib/guard.mjs`.** Keep: the guard loop and lock, state file, logging,
notifications, `checkedPollMs`, autostart launcher files, `writeGuardStop`,
viewer supervision, and the Core branch of `guardPlan`/`runGuardOnce`
(relaunch a dead Core controller with `launchCore`, run-id validation, 3 tries
then give up, healthy reset). Remove: the legacy runner branch (`RUN.json`
`running` + driver `runner` → `launchRunner`, `visible` handling) and the
imports of runner/driver. A `running` legacy `RUN.json` is never relaunched
(tested).

**`lib/projects.mjs`.** Keep the registry API and its bytes: `projectsPath`,
`safeName`, `REGISTRY_UNREADABLE`, `loadProjects`, `readProjects`,
`missingProjects`, `pruneProjects`, `writeProjects`, `upsertProject`,
`removeProject`, `findProject`, the `projects` CLI, `runSummary`,
`projectStatus`, `listProjectsWithStatus` (Core state via
`coreObservation`). Remove: `legacySummary`, the legacy branch of
`observedRuns`, `runnerAlive` (runner lock) and `ownerAlive*` caches if no kept
caller needs them, and the runner/driver imports.

**`lib/up.mjs`.** Keep the tunnel, `up`, `down`, `autostart`, process-tree
kill and `isOurUp`. Remove the runner command-line recognition (`isRunnerCmd`,
`RUNNER_CMD_RE` import) from the kill planning.

**`viewer/server.mjs`.** Keep: login/token, `/`, `/core`, `/m` (Core panel,
`core.html`), `/api/core`, `/legacy` and `/legacy/m` session page (replays
historical events), `/state`, `/events`, `/feed`, `/assets/*`, the watchdog
(`watchdogPlan`, including its legacy branches that only read historical
events, and the #28 Core transition behaviour) and guard supervision. Remove:
`POST /answers` (it only feeds the removed `forja answers`), the runs launcher
wiring (`GET /projects`, `POST /runs` start/relaunch; `POST /runs` answers 410
with a JSON pointer to `forja start` / `forja core resume`).

**`viewer/runs-api.mjs`.** Keep `crossSite` and `readBody` (used by
`viewer/core-api.mjs`). Remove the legacy launcher and its imports of
`launchRunner` and `runnerAlive`.

**`viewer/core-api.mjs`, `viewer/core.html`, `viewer/lib/*`.** Keep unchanged
except import repoints required by kept modules.

**`viewer/assets/viewer.js`, `viewer.css`, `index.html`, `mobile.html`.** Keep
the session view and feed. Remove the "novo run" start/relaunch ticket and its
client code (T2).

**Usage and cost tracking.** Keep Core usage (`lib/core/metrics.mjs`, each
run's `usage.jsonl`, `core usage`, the `/core` coverage display). Remove the
legacy transcript-based tracking (`lib/run-cost.mjs`, `lib/usage-counts.mjs`,
usage tools).

### 6. Hooks and settings

| Item | Depends on it | Decision | Task |
|---|---|---|---|
| `hooks/log-event.mjs` | `.claude/settings.json` hooks; writes `data/events.jsonl` read by the viewer feed, session page and watchdog | keep | none |
| `.claude/settings.json` hooks block | Core monitoring of sessions in this repo | keep | none |
| hook/settings merging for target repos (`mergeSettings` in bootstrap) | `bootstrap --legacy` only | remove | T4 |

### 7. Tools and config

| Item | Depends on it | Decision | Task |
|---|---|---|---|
| `tools/check.mjs` | `npm run check` | keep the invisible-character, replay and core-skill sample-copy checks; remove the crew byte-copy, model-policy, autonomy-rule and TASKS.json checks and the `bootstrap --legacy` hint | T4 |
| `tools/release-check.mjs`, `tools/shot.mjs`, `tools/serve-fixture.mjs` | release, screenshots | keep (`shot.mjs` comment naming `forja-visual-check` is updated) | T5/T6 |
| `tools/content.mjs`, `first.mjs`, `par3.mjs`, `perrun.mjs`, `subcontent.mjs`, `usage.mjs`, `medir-contexto.mjs`, `stats.mjs` | legacy research/measurement of runner transcripts and state-files | remove | T5 |
| `config/mcp-forja.json` | `lib/runner.mjs` only | remove | T5 |
| `config/core-*.json`, `config/ollama.Modelfile` | Core profiles | keep | none |

### 8. Tests

| Tests | Decision | Task |
|---|---|---|
| `runner`, `autonomy`, `models`, `obsidian-sync`, `run-cost`, `usage-counts`, `technology-split`, `decisions-index`, `handover`, `answers-driver`, `medir-contexto`, `tools-medicao` (+ fixtures used only by them, such as `decisions-index-*.md`, `handover-t3-before.md`) | remove with their modules | T5 |
| `cli` | rewrite for the Core-only dispatch; new `legacy-cli` refusal test and Core-on-legacy-fixture test | T5 |
| `driver`, `terminal-history`, `guard`, `supervise`, `up` | rewrite against `lib/process-lock.mjs` and Core-only guard; new `registry-format` golden test | T3 |
| `runs-api`, `spawn-runner`, `viewer-page` | drop launcher cases, keep the rest | T2 |
| `bootstrap`, `check` | drop crew/legacy cases, add `--legacy` refusal | T4 |
| `core-migration`, `init-rollback`, `core-viewer`, `watchdog-core-transition`, `server`, `state`, `feed`, `hook`, `notify`, `atomic-write`, `state-atomic` and all Core tests | keep | none |
| new `legacy-references`, `readme` | add | T6, T7 |

### 9. Documentation and examples

| Item | Decision | Task |
|---|---|---|
| `docs/LEGACY-CLAUDE.md`, `docs/RUNBOOK-UNATTENDED.md` | delete | T6 |
| `docs/ARCHITECTURE.md` | keep only kept components (viewer, guard, notifications, registry: current §8-§13 and the Core extension) with the same numbering, or delete and repoint code comments | T6 |
| `README.md`, `CLAUDE.md`, `AGENTS.md`, `docs/CORE.md`, `docs/CORE-RUNBOOK.md`, `docs/ROUTING.md`, `docs/forja/CORE-CONVENTIONS.md`, `viewer/README.md` | rewrite legacy passages: Core is the only workflow | T6 |
| `docs/RESEARCH.md`, `docs/MODEL-BENCHMARK.md`, `docs/ADAPTIVE-ORCHESTRATION.md` | keep as history | none |
| `docs/CONTROLLER-DELIVERY.md`, `docs/CORE-SPECIALISTS.md`, `docs/RELEASE.md`, `docs/design/DESIGN.md` | keep | none |
| `CHANGELOG.md` | add the 0.22.0 entry with the migration note; older entries stay as history | T7 |
| `examples/sample-project/README.md` (legacy bootstrap hooks), `examples/sample-project/package.json` (ARCHITECTURE reference) | supporting edits with the crew removal and docs | T4/T6 |
| `examples/sample-project/AGENTS.md` | managed block generated from `lib/core/instructions.mjs`; unchanged while lib/core is frozen | none |
| `examples/kilo/*` | Core provider example; keep | none |

## Removed CLI commands and Core replacements (migration note)

Every removed command exits 2 with an English message that names it, says it
was removed in 0.22.0 and points to the Core equivalent. It writes nothing.

| Removed command | Use instead |
|---|---|
| `forja run start --goal "..."` | `forja start --goal "..." --provider claude\|codex\|kilo` (or `--goal-file <path>`) |
| `forja run resume`, `forja resume` | `forja core resume` |
| `forja run checkpoint`, `forja run finish` | nothing: the Core controller records progress; inspect with `forja core status` |
| `forja run fail`, `forja run block` | `forja core abandon --why "..."` or `forja core stop` |
| `forja run driver show\|set` | nothing: the Core controller always drives; the guard relaunches dead Core controllers |
| `forja task add\|show\|start\|review\|done\|fail\|block` | the Core planner and controller own tasks (`forja start --plan <json>` to supply a plan); `forja core status` to inspect; `forja core retry --task T1 --why "..."` (optionally `--reopen`) to retry or reopen |
| `forja runner` | `forja start` for a new run, `forja core resume` to continue one |
| `forja forjalvl show\|set`, `forja models` | a Core profile: `forja start --config <profile.json>`; check it with `forja core doctor --config <profile.json>` |
| `forja autonomy show\|set` | Core budgets and the profile; money and paid choices always reach the Sponsor as a pending decision |
| `forja decide "..."` | `forja core decide --run <id> --decision <D> --option <id> --why "..."` for Sponsor technology choices; other decisions go in the project's own docs |
| `forja decisions reindex` | nothing: the decisions log is a plain project file |
| `forja technology split` | nothing: Core records technology choices in its run state (`forja core decide`) |
| `forja obsidian sync` | nothing: Obsidian is an optional human interface, not a FORJA step |
| `forja ask`, `forja answers` | Core shows a pending Sponsor decision in `forja core status` and the viewer `/core` panel; answer with `forja core decide` |
| `forja fallback` | the provider and model per phase in the Core profile (`--config`); `forja core retry` after a provider failure |
| `forja progress`, `forja report` | `forja core status`, `forja core usage`, `forja core evidence`, viewer `/core` |
| `forja notify` | automatic Core notifications (ntfy through `lib/notify.mjs`) |
| `forja status` | `forja core status` |
| `forja context` | `forja core context --query "..."` |
| `forja bootstrap <repo> --legacy [--keep-legacy]` | `forja core init` in the repo, or `forja bootstrap <repo>` without flags |

Kept commands: `start`, `core *`, `serve`, `up`, `down`, `token`, `autostart`,
`guard`, `projects`, `bootstrap <repo> [--dry-run]`.

Removed assets: the nine crew agents (`.claude/agents/`) and the fourteen
legacy skills (`forja-lead`, `forja-crew`, `forja-plan`, `forja-product`,
`forja-scout`, `forja-design`, `forja-implementer`, `forja-review`, `forja-qa`,
`forja-security`, `forja-debug`, `forja-performance`, `forja-release`,
`forja-visual-check`). Core uses the six `forja-core-*` methods instead. Global
copies outside this repository are cleaned by the operator.

## Reference proof: patterns and allowlist

`test/legacy-references.test.mjs` (T6) applies these JavaScript regular
expressions line by line to every text file from
`git ls-files --cached --others --exclude-standard` (files containing a NUL
byte are binary and skipped). Any match outside the allowlist fails the test,
and a seeded violation proves it fails. The final report repeats the result.

| Id | What | Pattern |
|---|---|---|
| P1 | removed commands | `/\bforja(?:\.mjs)?["']?\s+(?:run\|task\|runner\|forjalvl\|models\|autonomy\|decide\|decisions\|technology\|obsidian\|ask\|answers\|fallback\|progress\|report\|notify\|status\|context\|resume)\b(?![-.\w])/` |
| P2 | bare legacy subcommands in code spans | ``/`(?:run (?:start\|resume\|checkpoint\|finish\|fail\|block\|driver)\|task (?:add\|show\|start\|review\|done\|fail\|block)\|runner\|forjalvl\|autonomy (?:show\|set)\|decisions reindex\|technology split\|obsidian sync)\b/`` |
| P3 | removed flags | `/--(?:legacy\|keep-legacy\|forjalvl\|visivel)\b(?![-\w])/` |
| P4 | crew agents | `/\.claude\/agents\b\|\b(?:product-manager\|product-designer\|technology-scout\|backend-dev\|frontend-dev\|security-reviewer)\b(?![-\w])/` |
| P5 | legacy skills | `/\bforja-(?:lead\|crew\|qa\|plan\|review\|implementer\|product\|design\|scout\|release\|debug\|performance\|security\|visual-check\|decide)(?![-\w])/` |
| P6 | removed modules, tools and config | `/(?:^\|[\/'"\x60(\s])(?:runner\|driver\|autonomy\|models\|run-cost\|obsidian-sync\|usage-counts)\.mjs\b\|\btools\/(?:content\|first\|par3\|perrun\|subcontent\|usage\|medir-contexto\|stats)\.mjs\b\|mcp-forja\.json/` |
| P7 | deleted docs | `/LEGACY-CLAUDE\.md\|RUNBOOK-UNATTENDED\.md/` |

The `(?![-\w])` lookaheads keep temporary-folder prefixes such as
`forja-plan-packet-` and Core names such as `forja-core-planner` out of P5;
`spawn-runner.mjs` and `check-runner.py` do not match P6. In this table `\|`
is the Markdown escape of `|`.

**Allowlist** (paths are repository-relative):

1. `CHANGELOG.md` (history and the 0.22.0 migration note).
2. `docs/LEGACY-REMOVAL.md` (this document).
3. History docs: `docs/RESEARCH.md`, `docs/MODEL-BENCHMARK.md`,
   `docs/ADAPTIVE-ORCHESTRATION.md`.
4. `lib/core/**` (legacy detection, frozen byte-identical) and
   `examples/sample-project/AGENTS.md` (managed block generated from
   `lib/core/instructions.mjs`).
5. Historical event readers: `viewer/lib/state.mjs`, `viewer/lib/feed.mjs`,
   the kept `/legacy` session page that renders crew role cards of historical
   runs (`viewer/index.html`, `viewer/mobile.html`, `viewer/assets/viewer.js`,
   `viewer/assets/viewer.css`), their tests (`test/state.test.mjs`,
   `test/feed.test.mjs`, `test/viewer-page.test.mjs`, `test/server.test.mjs`),
   `test/fixtures/*.jsonl` and `test/fixtures/build-fixtures.mjs`. The T2
   launcher removal still deletes the launcher code in these files; the
   allowlist covers only historical role names and event kinds.
6. Refusal and detection tests: `test/legacy-references.test.mjs`,
   `test/legacy-cli.test.mjs`, `test/cli.test.mjs`, `test/bootstrap.test.mjs`,
   `test/core-migration.test.mjs`, `test/init-rollback.test.mjs`,
   `test/guard.test.mjs`.
7. Refusal code regions in `bin/forja.mjs` and `lib/bootstrap.mjs`, only
   between the comment markers `legacy-references:allow-begin` and
   `legacy-references:allow-end`.

The same test checks that every relative Markdown link in tracked Markdown
files resolves to an existing path.

## Follow-up (outside 0.22.0)

- The managed AGENTS/CLAUDE block in `lib/core/instructions.mjs` (and its copy
  in `examples/sample-project/AGENTS.md`) still describes legacy `runner` and
  `run start` as explicit compatibility commands. Changing it means changing
  `lib/core`, which this release keeps byte-identical; a later release can
  replace the sentence and regenerate the sample.
- Global `~/.claude` skills and instructions that mention the legacy crew are
  cleaned by the operator after the run.
