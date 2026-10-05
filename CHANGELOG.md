# Changelog

## 0.23.0 — Night mode, measured efficiency changes, auto-learning and an experimental local profile

Builds on 0.22.0 (Core only). Highlights: unattended operation (usage-limit wait and resume, a per-project goal queue, `core status --all`); the fix for #36; two efficiency changes kept on measured evidence; auto-learning behind an off-by-default flag; a local Kilo/Ollama profile with opt-in escalation to Claude, a local model bake-off and a stress harness. **The local profile is experimental:** its stress baseline completed 0 of 24 scenarios (#37, #38, #40). No change to the `.forja` state formats beyond the new optional fields named below.

### Night mode: usage-limit wait and resume, per-project goal queue, status of every project

- Usage-limit wait. A Claude `rate_limit_event` with status `rejected` (the existing distinction from warnings and other provider failures is kept) now blocks the run as `provider_limit` with a stored wait (`usageLimitWait`): the reset time from `rate_limit_info.resetsAt` (Unix seconds or milliseconds, or ISO 8601, parsed by `resetTime()` in `lib/core/providers.mjs`), clamped to between 1 minute and 8 days ahead, or a conservative 60-minute default when none is reported. A develop session stopped by the limit no longer spends an implementation attempt (as in the legacy runner); the session still counts against the session budgets. `core status` (`usage_limit_wait`, `recovery.guidance`) and the viewer, which shows a distinct "Waiting for usage limit" state with the local reset time, report it. The guard resumes the run 60 s after the reset, at most 6 automatic resumes per run, with its existing spacing, attempt cap, identity checks and locks; under the project lock the engine re-checks the run id, the block code, the due time, the cap and a pending operator stop, so no other block is ever reopened. Opt out per run with config `usageLimitResume: false`, frozen at start; `core resume` still works by hand.
- Per-project goal queue. `core queue add --goal-file <file> [--config <json>] [--provider claude|codex|kilo|custom] [budget flags]`, `core queue list` and `core queue remove <id>` keep up to 50 goals in `.forja/queue.json` (private run state; a queue tracked by Git is refused). Entries are validated like `start`; `--allow-dirty` and `allowDirty` are refused because a queued start always needs a clean tree, so chaining needs a committed or clean result (with delivery `none` the next goal is refused and stays queued with `last_refusal`). When a run ends `done`, and delivered when `delivery` is configured, the controller starts the head as a new run with the checks of `start` and the entry's configuration frozen; a blocked or failed run never starts the queue, and an operator stop pending when the run ended holds it. The guard starts a queued goal for a done project without a live controller through a hidden `core queue start --expected-run <run id>` child that reads the goal from disk. One writer per project: queue changes use their own lock (`.forja/queue-lock.json`), so `queue add` works during a run; a start takes the project lock and then the queue lock and removes the entry only after the run is created.
- `core status --all [--json]`: one line per registered project with a Core run (project, status, tasks done/total, current task, phase and attempt, last update, block reason, queue length), with a stable JSON shape for scripts. Read-only: no lock is taken and no `.forja` is written, and one unreadable project never hides the others.
- docs/CORE.md, docs/CORE-RUNBOOK.md (new "Operação noturna" section), docs/forja/CORE-CONVENTIONS.md and docs/design/DESIGN.md describe the behaviour. New test/core-usage-limit.test.mjs, test/core-queue.test.mjs and test/core-status-all.test.mjs, and new cases in test/guard.test.mjs, test/spawn-runner.test.mjs, test/recovery-observe.test.mjs, test/core-viewer.test.mjs and test/core-cli-help.test.mjs.

### Delivery: worker staging no longer blocks before review (#36)

- With `delivery` configured, the controller records the staged content of the index before each develop session. When the session changed it, nothing was staged before, HEAD did not move, and every staged entry (mode and content) equals what delivery would stage from the working tree, compared through a scratch index so a staged executable bit or symlink is never lost under `core.fileMode=false`, the controller unstages those entries (`git restore --staged`), records the paths in the ledger (`worker_index`) and in the task (`index_restored`), and continues to checks and review. Staged work that predates the session, staged content that differs from the working tree and unmerged entries are left in place and still block before review. The occupied-index refusal now names the staged paths. Develop instructions tell workers not to stage. New test/delivery-worker-index.test.mjs; docs/CONTROLLER-DELIVERY.md describes the behaviour.

### Efficiency: measured before and after

- New read-only, aggregate-only tools: `tools/efficiency-audit.mjs` (real run folders), `tools/efficiency-replay.mjs` (replays candidates over recorded packets and streams) and `tools/efficiency-bench.mjs` (offline, deterministic `drive()` benchmark with a stable metrics SHA-256; `live` runs a paired A/B through local Ollama models). Method, baseline and every candidate are in docs/EFFICIENCY.md. Baseline over 147 real Claude runs: develop is 87.8% of input tokens, sessions stopped at the context limit 26.6%, tool results resent on later calls 26.6% of context tokens.
- Kept: task packets use a 3,000-character repository map with the task's own files pinned first (the plan packet keeps 6,000). Replay: 9.49% less packet resend, about 0.65% of all input, every task file still listed; `wide-repo` develop packet −18.0%. Live A/B (9 pairs, local model): first request −5.8% (develop) and −7.1% (review), input per call −4.4%; the pass-rate difference (5/9 against 7/9) rests on two failures unrelated to the map (McNemar p = 0.5), so the change is kept and flagged until the stress rerun (#40).
- Kept: the final regression no longer runs again a check (same command and arguments) that already passed on the same tree; the repeat is recorded as `skipped: same_tree_passed` with the reused result. Real runs repeated such checks in 58% of final regression executions, 67.9% of its time (about 5.5 h of 8.1 h); benchmark final check runs 46 → 34.
- Rejected on evidence: a plain 3,000-character map cut, a 600-character cap on shared-task criteria, no map in review packets, the failing check log in rework feedback. Recommended but not changed: `maxContextTokens` 200,000 for long Claude runs (replay: about 9% fewer develop tokens; #39). Not tried yet: large tool outputs (#42).

### Auto-learning (experimental, off by default)

- With config `lessons: true` (frozen at start), Core extracts lessons deterministically from the project's finished runs (failed checks, review rejections and the fixes that followed, provider failures, frequently relevant files) into the private `.forja/lessons/store.json`, and adds at most 5 relevant lessons within 3,000 characters to planner, developer and reviewer packets, trimmed before any other optional context. No model call; text is redacted with the release scanner's detectors. With the flag off, packets are byte-identical.
- `core lessons list|show|forget|clear`; `tools/lessons-ab.mjs` is the A/B harness. The live A/B has not been run, so the verdict is inconclusive (#41). docs/AUTO-LEARNING.md.

### Local models through Kilo and Ollama (experimental)

- A route `{ "provider": "kilo", "localProvider": "ollama", "model": "<tag>" }` runs any phase on a local Ollama model through the installed Kilo CLI, with only the loopback `ollama` provider enabled inside Kilo (no cloud path). A preflight reads `/api/tags` and `/api/show` and refuses, with the cause, an unreachable server, a missing, remote or tool-less model, or a declared context under 16,384 tokens; `core doctor --config` runs the same checks. Local calls do not count against `maxCloudSessions`.
- Local sessions that end without a usable result get one JSON-only reminder in the same Kilo session, a phase-specific result schema (a reviewer can only answer `approve`, `reject` or `blocked`), and one fresh session of their phase under `providerRetries`. Local developers cannot run Git commands that move HEAD or change the index; a local plan too large for the remaining sessions is merged into one task.
- Opt-in `escalation`: a local develop task that exhausts its attempts or ends without a usable result can hand off to one configured Claude CLI route (`maxEscalations`, `attempts`), refused when an Anthropic API key or base URL is set, recorded in the ledger and in `core status`. Tested with mock executors only.
- `config/core-local.json` (`qwen3-coder:30b-32k` in every phase) is the profile chosen by the local model bake-off of nine models (docs/research/local-models-2026-10-04.md, `tools/local-bakeoff.mjs`). No local reviewer rejected a failing change in the bake-off (#38): with local review, the project's checks are the real gate.
- Stress harness: 24 scenarios in 8 categories (`test/stress/`, `tools/stress-run.mjs`), with hidden acceptance checks proven to fail untouched and pass on a reference solution. Baseline with the local profile: **0 of 24 completed**, every failure a pipeline stop on the first malformed structured result of a local session (12 planning, 6 review, 6 recovery), 5 of them blocking a change that passed the hidden check (docs/research/stress-2026-10-04.md). Part of the fixes above came from it; the full rerun is pending (#37, #40).

### Other

- Fixed: test runs and tooling no longer flash console windows on Windows. `npm test` loads `test/support/hide-windows.mjs`, which makes every child process of the suite default to `windowsHide: true` (an explicit value is kept; new test/hide-windows.test.mjs), and `tools/check.mjs`, `tools/release-check.mjs` and `tools/shot.mjs` pass the option themselves.
- docs/DECISIONS.md: append-only decision log of the 0.23.0 work.
- Known follow-ups opened as issues: the night-mode paragraph in the worker contract (#43) and the legacy sentence still written by `core init` (#44).

## 0.22.0 — Core is the only workflow: legacy crew workflow removed

Sponsor decision 2026-10-03, recorded in [docs/LEGACY-REMOVAL.md](docs/LEGACY-REMOVAL.md) (decision log, inventory, migration note and reference proof). 0.21.2 is the last release with the legacy workflow; it stays available through Git history.

- Removed the legacy crew workflow: the legacy CLI commands, the nine crew agents (`.claude/agents/`), the fourteen legacy skills, `bootstrap --legacy`/`--keep-legacy`, the legacy runner and its libraries (`lib/runner.mjs`, `lib/driver.mjs`, `lib/autonomy.mjs`, `lib/models.mjs`, `lib/run-cost.mjs`, `lib/obsidian-sync.mjs`, `lib/usage-counts.mjs`, `config/mcp-forja.json`), the legacy measurement tools (`tools/content.mjs`, `tools/first.mjs`, `tools/par3.mjs`, `tools/perrun.mjs`, `tools/subcontent.mjs`, `tools/usage.mjs`, `tools/medir-contexto.mjs`, `tools/stats.mjs`), `docs/LEGACY-CLAUDE.md`, `docs/RUNBOOK-UNATTENDED.md`, the legacy sections of `docs/ARCHITECTURE.md`, and the legacy-only tests. The same agents and skills were removed from `examples/sample-project/`. `lib/state-files.mjs` keeps only its path and JSON helpers.
- Every removed command exits 2 with an English message that names it, says it was removed in 0.22.0 and points to the Core command to use instead; it writes nothing. `bootstrap --legacy`/`--keep-legacy` refuse the same way. New test/legacy-cli.test.mjs covers each refusal and runs `core init`, `core status`, `start` and `resume`/`retry` on a fixture that still holds legacy files.
- Viewer: the phone run launcher is gone; `GET /projects` and `POST /runs` answer 410 with a pointer to the terminal. The `/core` panel, the `/legacy` session page (replays historical events), the watchdog with the #28 Core transition behaviour and guard–viewer supervision are unchanged.
- Monitoring: `guard` relaunches only dead Core controllers and never a legacy runner, even when a legacy `docs/forja/RUN.json` says `running`. `projects list` reads only Core state. `up`/`down` no longer recognise a legacy runner command line. The lock, pid and command-line helpers they share moved to the new `lib/process-lock.mjs`. `lib/notify.mjs` (ntfy) is unchanged.
- Unchanged: `lib/core/` is byte-identical to 0.21.2, so the controller, workers, the six `forja-core-*` methods, checks, review, delivery and the `.forja/` state formats are the same. `core init` still recognises and archives legacy files of older projects (detection only). The registry `data/projects.json` keeps its byte format (new test/registry-format.test.mjs). `hooks/log-event.mjs` and the `.claude/settings.json` hooks stay.
- `tools/check.mjs` drops the crew byte-copy, model-policy, autonomy-rule and TASKS.json checks. New test/legacy-references.test.mjs fails on any remaining reference to a removed command, flag, agent, skill, module or doc outside the allowlist in docs/LEGACY-REMOVAL.md, and on broken relative Markdown links. New test/readme.test.mjs checks that the package version, the README badge and release links and the top CHANGELOG heading agree.
- README, CLAUDE.md, AGENTS.md, docs/CORE-RUNBOOK.md, docs/ARCHITECTURE.md (now only the viewer, guard, notifications and registry), docs/forja/CORE-CONVENTIONS.md and viewer/README.md describe Core as the only workflow. docs/CORE.md, the worker contract the controller sends to every session, already described Core only and is unchanged, so worker prompts are the same as in 0.21.2.
- README: new "See it live: forja-office" section after the badges, introducing the separate read-only 3D view of Core runs with a link to its demo video (demo mode, fictional projects).

### Migration from the legacy workflow

Finish or abandon any legacy run before upgrading: 0.22.0 cannot continue one, and Core refuses to start while a legacy `docs/forja/RUN.json` is `running`. Run `forja core init` in an older project to archive its legacy agents, skills and run files. Global copies of the crew agents and skills outside this repository are not touched; remove them yourself.

| Removed | Use instead |
|---|---|
| `forja run start --goal "..."` | `forja start --goal "..." --provider claude\|codex\|kilo` (or `--goal-file <path>`) |
| `forja run resume`, `forja resume` | `forja core resume` |
| `forja run checkpoint`, `forja run finish` | nothing: the Core controller records progress; inspect it with `forja core status` |
| `forja run fail`, `forja run block` | `forja core abandon --why "..."` or `forja core stop` |
| `forja run driver show\|set` | nothing: the Core controller always drives, and the guard relaunches a dead Core controller |
| `forja task add\|show\|start\|review\|done\|fail\|block` | the Core planner and controller own tasks: `forja start --plan <json>` to supply a plan, `forja core status` to inspect, `forja core retry --task T1 --why "..."` (add `--reopen` for an approved task) |
| `forja runner` | `forja start` for a new run, `forja core resume` to continue one |
| `forja forjalvl show\|set`, `forja models` | a Core profile: `forja start --config <profile.json>`, checked with `forja core doctor --config <profile.json>` |
| `forja autonomy show\|set` | Core budgets and the profile; paid choices always reach the Sponsor as a pending decision |
| `forja decide "..."` | `forja core decide --run <id> --decision <D> --option <id> --why "..."` for Sponsor technology choices |
| `forja decisions reindex`, `forja technology split` | nothing: Core records technology choices in its run state (`forja core decide`) |
| `forja obsidian sync` | nothing: Obsidian is an optional human interface, not a FORJA step |
| `forja ask`, `forja answers` | the pending Sponsor decision in `forja core status` and the viewer `/core` panel, answered with `forja core decide` |
| `forja fallback` | the provider and model per phase in the Core profile (`--config`); `forja core retry` after a provider failure |
| `forja progress`, `forja report` | `forja core status`, `forja core usage`, `forja core evidence`, viewer `/core` |
| `forja notify` | automatic Core notifications (ntfy) |
| `forja status` | `forja core status` |
| `forja context` | `forja core context --query "..."` |
| `forja bootstrap <repo> --legacy [--keep-legacy]` | `forja core init` in the repository, or `forja bootstrap <repo>` without flags |
| crew agents (`architect`, `backend-dev`, `frontend-dev`, `product-designer`, `product-manager`, `qa`, `reviewer`, `security-reviewer`, `technology-scout`) | the Core controller phases (plan, develop, controller checks, independent review) |
| legacy skills (`forja-lead`, `forja-crew`, `forja-plan`, `forja-product`, `forja-scout`, `forja-design`, `forja-implementer`, `forja-review`, `forja-qa`, `forja-security`, `forja-debug`, `forja-performance`, `forja-release`, `forja-visual-check`) | the six frozen `forja-core-*` methods (planner, reviewer, design, frontend, backend, security), selected by the controller |
| phone run launcher in the viewer (`POST /runs`) | `forja start` / `forja core resume` in a terminal; the viewer `/core` panel to follow the run |

Kept commands: `start`, `core *`, `serve`, `up`, `down`, `token`, `autostart`, `guard`, `projects`, `bootstrap <repo> [--dry-run]`.

## 0.21.2 — Delivery: Git configuration of sibling worktrees no longer voids approvals

Fixes #35 (related #30).

- `lib/core/delivery.mjs` bound delivery approvals to a hash of the whole `git config --list --show-origin`. Worktrees share `.git/config`, so a branch created with tracking in a sibling worktree (`git branch --track`, `git switch -c`/`-C` from a remote ref, `git push -u`, `git worktree add -b`) wrote `branch.<other>.*` entries and blocked the delivery with `Delivery inputs changed during review; approval cannot be applied.` The approval now binds only configuration that can change the created commit, its tree or the authorized push: `user.*`, `author.*`, `committer.*`, `commit.*`, `gpg.*`, `core.*`, `filter.*`, `i18n.*`, `url.*`, the delivery branch's own `branch.<target>.*` (case-sensitive subsection, dotted names supported), `remote.pushDefault`, and `remote.<name>.*` for the target branch's remote and any remote whose URL is the authorized destination. Changing, adding or removing a bound key still blocks in both granularities, during review, before a task or run commit is installed and before a push.
- Receipts store one digest per bound key, never values. Block messages now name the changed inputs (`HEAD`, `branch`, `source`, `index`, `candidate tree`, `manifest`, `patch`, `Git config <key>`) after the existing wording, without configuration values; credentials in a `url.<base>` key name are masked. Receipts written before 0.21.2 keep the whole-configuration comparison.
- docs/CONTROLLER-DELIVERY.md and docs/CORE-RUNBOOK.md list the bound keys, the named block message and a note to avoid Git configuration changes in sibling worktrees while a delivery review runs. New test/delivery-config.test.mjs covers sibling worktrees, bound-key changes and legacy receipts in both granularities.

## 0.21.1 — Delivery: binary files no longer count toward the 4 MiB review limit

- `prepareDelivery()` and `prepareTaskDelivery()` in `lib/core/delivery.mjs` built the review patch with `git diff --binary`, so screenshots and other binary assets were included as base85 literals and a small code change with UI evidence blocked with `Delivery diff exceeds the 4 MiB review limit.` The review patch is now built without `--binary` (and with `--no-renames`): each binary file is one `Binary files ... differ` line, and the 4 MiB limit applies to the text. Text over 4 MiB still blocks. Fixes #34.
- The delivery manifest and receipt list every binary in the candidate under `binaries` with its path, change (added, modified or deleted), byte size and SHA-256, never its bytes. The approval stays bound to the exact tree, which includes the blob ids, so changing a binary after review voids it. The reviewer framing (run and task granularity) explains this representation.
- New optional `delivery.maxBinaryBytes` (positive integer, 32 MiB by default) caps the total bytes of added and modified binaries per delivery candidate. Going over blocks before review with a message naming the limit and the largest files.
- The privacy scan is unchanged and still runs on every file, binaries included. docs/CONTROLLER-DELIVERY.md and docs/CORE-RUNBOOK.md describe the text limit, the binary listing and the cap. New test/delivery-binary.test.mjs covers both granularities.

## 0.21.0 — Kilo CLI provider

- New Core provider `kilo` (`start --provider kilo`, `core doctor --provider kilo`, `provider: "kilo"` in routes): each phase runs through `kilo run --format json` with explicit gateway models, an isolated Kilo configuration (empty config home, no project configuration, autoupdate, sharing and session ingest disabled, undo snapshots off) and a per-phase deny-by-default permission list. The final JSON result is recovered after prose, closing messages or Windows paths; step usage, cost and request context are recorded like Claude's, so the context guard applies. The CLI bundled with a Kilo Code VS Code extension is preferred over the npm shim. Kilo receives the same worker environment as the other providers (process-tree cleanup, `GIT_OPTIONAL_LOCKS=0`, scratch directory).
- `examples/kilo/` holds a global Kilo instruction and a chat command that hands a plain "use FORJA" request to a Core run, plus a visible Windows launcher that reports the outcome, status and resume command. docs/ROUTING.md describes the setup.
- Core adds `.forja/` to the project's local Git exclude when a run starts, so a project without a `.gitignore` entry does not see run state as untracked work.
- The legacy runner reads a process command line without flashing a PowerShell window.
- `start --goal-file` (0.20.3) is the single implementation; the Kilo branch's earlier variant was merged into it.

## 0.20.15 — Delivery privacy scan: rules up front, base pre-scan, .env templates, file and line

- With `delivery` configured, `planning_contract.delivery_scan_rules` and the develop instructions state the delivery privacy scan rules (refused paths, home-path, private-key and credential content, the `.env` template allowance), so the planner and developer do not plan or create content that is deterministically refused.
- `start` pre-scans every tracked file of the run base before any model session, prints the pre-existing findings with file and line, and records the report in run state (`base_scan` in `core status`). `core doctor` reports the same on HEAD when the configuration has `delivery`. The pre-scan only reports: a delivery that stages a file with a pre-existing finding still blocks before review, and its message says the finding was already in the run base.
- `.env.example`, `.env.sample` and `.env.template` pass the scan when every non-comment, non-blank line is `KEY=` with an empty value or an obvious placeholder (`<value>`, `your-api-key`, `changeme`, `xxx`, `...`). Any real-looking value, every other `.env` name, keys and credential files keep blocking. Credential, private-key and home-path detection is not weakened, and home paths inside Markdown code are still reported.
- Findings name file and line (the first match of each kind, never the matched text): in the delivery block message and `delivery-scan.json` / `T<id>-<n>-scan.json` (`path:line reason`), and in `tools/release-check.mjs` JSON (`line`) and stderr. docs/RELEASE.md, docs/CONTROLLER-DELIVERY.md and docs/CORE-RUNBOOK.md describe the rules. New test/delivery-privacy.test.mjs and new cases in test/release-check.test.mjs and test/core-doctor.test.mjs. Fixes #32.

## 0.20.14 — Task commits include reverts and deletions of earlier task changes

- With task granularity, `prepareTaskDelivery()` in `lib/core/delivery.mjs` staged only the paths changed since the run began (`changedFiles(run.initial, now)`) on top of the last task commit. A path that an earlier task committed and that was later restored to its run-start content was not in that set, so the revert was silently left out of every later commit and stayed as an uncommitted change after the run. The candidate tree is now the last task commit updated with every non-ignored working-tree difference from it: paths changed since the run began plus paths earlier task commits touched. A later revert of an earlier task's change and the deletion of a file an earlier task created are committed by the next task. Ignored files and `.forja/` are never staged; the 500-path and portable-path limits and the privacy scan apply to the staged set; a task whose working tree equals the last task commit still records `no_changes`.
- A task that followed an earlier task's deletion of a file present at run start no longer fails with "Delivery Git add failed": paths absent from both the disk and the last task commit are not staged.
- `snapshot()` in `lib/core/context.mjs` no longer records a missing file that the Git index still lists (it recorded `null`). Installing a task commit that records a deletion removes that index entry, which changed the working-tree hash of an unchanged tree, so a final task that deleted a file was validated and reviewed a second time and reported `no_changes`. `changedFiles()` treats a `null` entry in a snapshot stored by an earlier version as absent.
- docs/CONTROLLER-DELIVERY.md describes which paths a task commit stages. test/delivery-task.test.mjs gains a revert case, a deletion case and a snapshot case. Fixes #31.

## 0.20.13 — A read-only git status during review no longer voids the delivery approval

- Delivery receipts (run and task granularity) stored a hash of the raw `.git/index` bytes and required the same bytes after review and again before a task commit was installed (`commitTaskDelivery`). A read-only `git status` or `git diff` run during the review, by the reviewer or by the operator in another terminal, refreshes the stat cache and rewrites `.git/index` without changing staged content, so the approval was discarded with "Delivery inputs changed during review" and a full check and review cycle was spent, possibly again and again. `lib/core/delivery.mjs` now records and compares a hash of the staged content: `git ls-files --stage` (mode, blob and stage number, so unmerged entries count) plus the intent-to-add entries. A real staged change during review (`git add` of a modified file, `git add -N`) still blocks.
- Worker provider invocations run with `GIT_OPTIONAL_LOCKS=0` added to their otherwise unchanged inherited environment, and the delivery and controller Git calls (`lib/core/delivery.mjs`, `lib/core/files.mjs`) use it too, so their own reads never rewrite the index. A receipt prepared by an earlier version with the raw-bytes hash no longer matches; that task's delivery blocks once and `core retry --task ID --validate-only` prepares a new one.
- docs/CONTROLLER-DELIVERY.md and docs/CORE-RUNBOOK.md describe the content comparison and advise `core status` or `GIT_OPTIONAL_LOCKS=0 git` during a run. New test/delivery-index-content.test.mjs covers a stat-only refresh (approval kept) and staged-content changes (approval voided) in both granularities, and the worker environment. Fixes #30.

## 0.20.12 — A concurrent reader on Windows no longer stops the Core controller

- Core state writes (`lib/core/engine.mjs` `write()`, used for `current.json` and each run's `state.json`), the repository index writer in `lib/core/context.mjs` (`.forja/index.json`) and the stop request writer in `lib/core/stop.mjs` renamed their tmp file over the target once; on Windows a concurrent reader (guard, `up`, viewer, forja-office) made `renameSync` fail with `EPERM`/`EBUSY` and killed the controller. They now use the bounded retry that the legacy state files already had: a rename failing with `EPERM`, `EBUSY` or `EACCES` is retried up to 20 times with 10 ms pauses, any other error is rethrown at once, the tmp file is removed when replacement finally fails and the previous complete file is kept, never truncated. Core keeps unique per-call tmp names created with flag `wx`.
- The retry lives in the new shared module `lib/atomic-write.mjs`, used by Core and by `lib/state-files.mjs` (which keeps its per-process tmp name), so Core no longer carries its own rename and does not import legacy state code. docs/CORE-RUNBOOK.md describes the behaviour. New test/atomic-write.test.mjs covers transient `EPERM`/`EBUSY` renames, a permanent failure and a non-retryable code for the helper and each Core writer. Fixes #29.

## 0.20.11 — Bounded task scope; optional packet context is trimmed before a task stops

- `task_scope.remaining_tasks` in develop and review packets no longer carries the full criteria of every unfinished task, which made a normal multi-task plan block on its first task with "Task packet exceeds 48,000 characters". Each remaining task always keeps `id`, `title`, `files` and `after`; its criteria are included only when it shares a file with the current task (equal paths, or a directory containing the other), capped at 1,200 characters per task and marked `criteria_truncated` when cut. `task_scope.plan.path` points at the run's state file (`.forja/runs/<run_id>/state.json`), which holds every task's full criteria.
- A packet over the 48,000-character limit now trims optional context in a defined order until it fits: remaining-task criteria, then optional knowledge excerpt text (paths, lines, hashes, references and required notes stay), then the repository map text. Each trim is recorded in the packet sources (`trimmed ...`, `characters` 0, `trimmed_characters`). The run stops with `task_packet` only when the mandatory parts (goal, phase, current task, decisions, technology, final checks, feedback, changes and other fields) alone exceed the limit, and the message names what was already trimmed. The current task's criteria are never truncated. Plan acceptance measures each develop packet with the same trimming against the 40,000-character planning budget.
- The planner instruction, `planning_contract.task_packet_note`, the scope guidance, docs/CORE.md and docs/CORE-RUNBOOK.md describe the bound and the trimming order. New test/packet-budget.test.mjs covers a 12-task plan with long criteria. Fixes #33.

## 0.20.10 — No burst of dead-session alerts after a Core run ends

- The viewer watchdog no longer reports a session as a dead main session ("sessão principal parece morta") when its last sign of life came before the project's Core run ended: the conversation that launched the run and finished or stopped worker sessions are quiet by design, and the run ending `done`, failed or abandoned does not make them dead. `viewer/core-api.mjs` now lists every registered Core run with its status and, for a terminal run, its end time (`coreProjectRuns`: `finished_at`, else `updated_at`, else the state file time; `coreDrivenProjects` still lists only running or blocked runs). The Core observation exposes `finished_at`. A session with activity after the end that then goes silent is still alerted. Dead main sessions now produce one notification per project, which covers all of them and names the most recent one; later 30-second polls do not resend it, and only a session that dies afterwards starts a new alert. docs/ARCHITECTURE.md describes the rule. Fixes #28.

## 0.20.9 — Worker process trees are cleaned up after each session

- When a process launched through the provider adapter ends (normal end, timeout, context stop, output budget or interruption), the controller terminates what is left of the process tree it spawned. POSIX signals the spawned process group. Windows keeps `taskkill /T /F` of the live spawned PID and also records the descendants while the session runs (PID, parent PID and creation time from a bounded CIM process snapshot through one `powershell.exe`, every 3 s by default), so orphans whose parent already exited are terminated too. Only processes proven to descend from the spawned PID, with matching PID and creation time, are touched: a process counts as a child only when it was created before the start of the last snapshot that still listed its parent, so PID reuse (even by a process that already exited), older processes and processes the controller did not start are left alone. If the snapshot `powershell.exe` ends early (for example on the operator's Ctrl+C), cleanup starts one replacement; if no snapshot answers, the descendants last seen alive are reported as survivors. Processes still alive after up to two rounds and a short grace period are reported with their PIDs in the usage ledger (`process_cleanup` with `terminated`, `survivors` and `error`), in `core status` (`process_cleanup`) and in the stop reason of a provider failure. A snapshot or kill failure never hides the session result and is reported in `error`. docs/CORE-RUNBOOK.md describes the cleanup. Fixes #23.

## 0.20.8 — Configurable check timeout; a timed-out check is not a failure

- New bounded run setting `checkTimeoutMinutes` (1..180), set in the config or with `start --check-timeout-minutes N` and raised (never lowered) with `core resume --check-timeout-minutes N`. It replaces the fixed `min(--max-minutes, 10)` check timeout; without it a run keeps that earlier value, and runs created before this version read unchanged. `isolatedCheck` now accepts any timeout up to 180 minutes instead of refusing anything above 600,000 ms.
- A task or final-regression check killed by the timeout now blocks with the new recovery code `check_timeout` instead of failing validation: the message and `recovery.guidance` name the task, the check (`checks[i]` or `finalChecks[i]`), the command and the limit in minutes; no implementation attempt is spent and no reject feedback is recorded; the task stays at validation (a done task in the final regression stays done and unvalidated), so a resume with a higher limit re-runs its checks. The validation entry records `timed_out` and `timeout_minutes`. `core status` shows the effective check timeout in `check_timeout` and `recovery.check_timeout_minutes`. docs/CORE-RUNBOOK.md documents the option. Fixes #22.

## 0.20.7 — One automatic fresh session after a develop provider timeout

- A develop session that reaches the per-call provider timeout (`--max-minutes`) now gets the same automatic fresh session as an output-budget failure (0.20.6) instead of blocking: it spends no attempt, keeps the work on disk and the progress notes, and its feedback states the minutes reached and asks for bounded commands, no background processes and a checkpoint before the limit. Each implementation attempt still gets at most one automatic provider retry in total, across timeout and output budget; `providerRetries` 0 disables it, and the usage ledger's `automatic_retry` records the minutes. A second timeout in the same attempt, or a plan or review timeout, blocks with the `timeout` code; the message and `recovery.guidance` state the per-call minutes reached, the invocation and how to raise them (`core resume --max-minutes N`, 1..180), name a route `maxMinutes` below the run limit (which `--max-minutes` cannot raise) and ask for `--max-attempts` when the task's attempts are used up. `core status` shows `provider_timeout`: the effective per-call timeout, the routes that lower it and, after a timeout, the limit reached with its invocation. Fixes #21.

## 0.20.6 — One automatic fresh session after an output-budget failure

- The worker contract (docs/CORE.md, in every prompt) now says: never print binary or base64 to the terminal; inspect images with the image read tool; keep command output short. When a develop session ends on the provider output budget, the controller starts at most one automatic fresh develop session for the same implementation attempt instead of blocking: it spends no attempt, keeps the work on disk and the progress notes, gets that rule as feedback together with the earlier feedback of the attempt, and counts against the session and cloud budgets (an exhausted budget blocks as before and says the retry did not start). The usage ledger marks the repeated call with `automatic_retry`. A second output-budget failure in the same attempt, a plan or review overflow, or `providerRetries` 0 block with the `output` recovery code as before. New bounded run setting `providerRetries` (0..1, default 1; `start --provider-retries`, raise-only on recovery; older runs read as 1) shown in `core status` with the automatic retries of each task (`tasks[].provider_retries`). Fixes #25.

## 0.20.5 — Checks that write the project are named and replaceable

- The planner is told that checks must be read-only verifiers: no artifact, screenshot or report generators, rewriting formatters or other commands that create or modify non-ignored project files. When a task check or a final-regression check changes project files, the run blocks with the new `check_writes` recovery code instead of the generic `inspect`; the message names the task, the check (`checks[i]` or `finalChecks[i]`), its command and arguments and the changed paths (up to 20, plus the total), the validation entry records `changed_paths` and `changed_total`, and `recovery.guidance` points at replacing the check. New `core retry --task ID --checks-file <json> --why "..."` replaces the checks of an unfinished task without abandoning the run, alone or with `--validate-only`: the UTF-8 JSON array of `{"command","args"}` (BOM stripped) passes the same target, Windows launch and check-isolation rules as a new plan, and the old and new checks are recorded in `recovery.jsonl`. Done or unknown tasks, a missing `--why` and a missing, empty or invalid file are refused without changing state; final checks and protected files cannot be replaced. Fixes #24.

## 0.20.4 — Task packet budget checked at planning

- The planner is told the per-task packet budget (`planning_contract.task_packet_budget_characters`: 40,000 of the 48,000-character limit, with 8,000 reserved for later feedback and review data). Before tasks are stored, the controller builds the develop packet of every planned task with the real packet builder; a plan with a task over the budget is planned again once, with feedback naming each task, its size and its own entry size. That re-plan is a normal counted session. A second violation blocks with the new `plan_packet` recovery code, stores no task and spends no attempt; the message and `recovery.guidance` name the tasks and sizes, and `core resume` plans again with them as feedback. A develop-time packet overflow now blocks with `task_packet`, naming the task, its size and the limit, and still spends no session or implementation attempt. Fixes #20.

## 0.20.3 — Goals from a file

- Add `start --goal-file <path>`: the goal is read as UTF-8 from a file relative to the current folder, a leading BOM is stripped and the rest is stored byte-exact, so long goals with double quotes never go through shell quoting (Windows PowerShell 5.1 cuts them at the first inner quote). The 1–16,000-character bounds still apply. `--goal` with `--goal-file`, a missing, unreadable, empty or non-UTF-8 file are refused before any run state is written. A `--goal` with an unbalanced double quote prints a stderr warning recommending `--goal-file` and the run still starts, and the refusal of stray `start` arguments names `--goal-file`. Fixes #19.

## 0.20.2 — Help never resumes a run

- `--help` and `-h` on `start` and on every `core` subcommand print the Core usage and exit 0 without taking the project lock, reading or writing `.forja` state or launching a provider; `core resume --help` no longer resumes a blocked run. `start`, `core resume`, `retry`, `abandon`, `stop`, `deliver`, `decide` and `init` refuse unknown flags and extra positional arguments before any effect, naming the flag or argument; the flags used by the guard and viewer launchers stay accepted. The CLI no longer drops positional arguments after `start` and `core <command>`. Fixes #27.

## 0.20.1 — Privacy scan without URL false positives

- Stop the privacy scanner's personal home path rule from flagging URL and route segments, which blocked Core task delivery for REST paths such as the Google Calendar v3 `users/me/calendarList` pathname, Microsoft Graph and GitHub `users` endpoints, and `home` web routes. Home paths are now detected only as filesystem paths: the Windows drive form stays case-insensitive and also matches JSON-escaped backslashes; the macOS `Users` form (capital U) and the Linux `home` form must start a path (start of text, whitespace, a quote, backtick, `=`, `(`, `:` or `file://`) and have a username followed by a separator. Credential, private key and conversation export detection are unchanged (#26).

## 0.20.0 — Commit per task, reopen approved tasks

- Add opt-in `delivery.granularity: "task"`: each task that changes source gets one local commit, approved with its message by that task's existing reviewer in the same session. Tasks without changes create no empty commit. Manual commits and occupied indexes are never adopted, and an interrupted installation resumes with the same commit. Push mode publishes the approved chain once, after the whole run passes, and scans every outgoing commit (#12).
- Add `core retry --task ID --reopen --why "..."` to reopen an approved task that later proves defective; it goes through implementation, checks and independent review again, and the reopening is recorded (#15).
- Shorten an oversize worker summary or findings list instead of discarding completed work; the result schema declares the limits, and remaining validation errors name the field and length (#17).
- Stop the watchdog from reporting a quiet conversation as a dead main session every 30 minutes while Core drives the project (#18).

## 0.19.1 — Fewer avoidable blocks

- Skip task-local `git diff --exit-code`/`--quiet` checks in the final regression, where later accepted work necessarily changes the diff, instead of reopening the task and blocking the run; plans with such a check in a multi-task run get a `snapshot_check` warning (#14).
- Refuse a check whose executable resolves nowhere before any task, on every platform: a bare name must be on `PATH` (on Windows also in the project root) and an explicit path must exist, unless a task's `files` scope covers it (#16).
- When a repeated context stop also exhausted the task's rotations, the stop message and `recovery.guidance` name the minimum `--max-rotations` to raise in the same resume (#13).

## 0.19.0 — Clean stops and reliability fixes

- Add `core stop` (next invocation boundary) and `core stop --after-task` (after the current task's checks, review and repairs). The run pauses with recovery reason `operator_stop`, spends no attempt, and `core resume` continues.
- Pause with `interrupted` when Ctrl+C stops a check or provider call, instead of recording a failed check or a provider failure; an interrupted developer session keeps its attempt.
- Reject plans with duplicate technology capabilities atomically, so a paid choice can never skip the Sponsor gate.
- Keep watchdog notifications status-only (tool name at most) and send one notification per permission episode.
- Spend no implementation attempt when the developer call is refused before launch (packet size, knowledge, protected files).
- Keep status and abandon usable when a worker leaves a link to outside the project; record dangling symlinks by target instead of failing.
- Parse budgets strictly (integers or digit strings) and refuse a limit flag without a value.
- Build review patches and delivery staging without exceeding the Windows command-line limit; bound the changed-file list in the review packet and keep the full list in run evidence.
- Refuse Windows checks that only resolve to `.cmd`/`.bat` shims before any task, with planner guidance; find `npm-cli.js` beside an `npm.cmd` on PATH.
- Document first runs, troubleshooting by recovery code, notifications and legacy bootstrap more accurately.

## 0.18.1 — Notification log follows the data directory

- Resolve the notification log path on every send instead of at import, so a data directory configured later (tests, alternate installations) receives its own log entries and deduplication reads the same file it writes.
- Add regression coverage that the installation's notification log stays unchanged when the data directory changes after import.

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
