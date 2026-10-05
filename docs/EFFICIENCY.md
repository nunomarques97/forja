# Efficiency: measured waste and the offline benchmark

Where Core spends tokens, context and model calls, measured before changing anything. Two tools produce the numbers:

- `tools/efficiency-audit.mjs` reads the run folders that real Core runs leave in `.forja/runs/<id>/` (`state.json`, `usage.jsonl`, `call-N-prompt.txt`, `call-N-result.json`, the Claude `call-N-stream.json`). It is read-only (opens files for reading only, never follows a link out of a run folder, launches nothing) and prints aggregates only: no goal, prompt, finding, path, project or run name. Labels that do appear (context source names, stop codes, tool names, phases) are FORJA's closed vocabulary, filtered by shape.
- `tools/efficiency-bench.mjs` is an offline, deterministic benchmark of the controller's deterministic parts. It calls no model: whole `drive()` runs use the `custom` provider with a scripted provider function in throwaway Git projects in the OS temp directory. It prints stable metrics and their SHA-256.

Only aggregates from other projects are committed here; raw measurements stay on the machine that produced them (see [RESEARCH.md](RESEARCH.md)).

## How to reproduce

```text
node tools/efficiency-audit.mjs --root <folder of projects> [--root <project>] [--days N] [--json]
node tools/efficiency-bench.mjs [--json] [--fixture small-api|wide-plan|wide-repo]
node tools/efficiency-replay.mjs --root <folder of projects> [--root <project>] [--days N] [--json]
node tools/efficiency-bench.mjs live plan|run [--detach]|status|report|stop [--lab <dir>]
node --test test/efficiency-bench.test.mjs
```

`tools/efficiency-replay.mjs` replays packet candidates over the packets that real runs recorded in `call-N-prompt.txt` (see [Improvements: packet size and repeated context](#improvements-packet-size-and-repeated-context)), and the final regression, context budget and check-failure rework candidates over `state.json` and the Claude streams (see [Improvements: model calls, retries, rotations, re-plans and idle waits](#improvements-model-calls-retries-rotations-re-plans-and-idle-waits)). It is read-only and prints aggregates only, like the audit.

`efficiency-bench.mjs live` (code in `tools/efficiency-live.mjs`) is the only part that calls a model: the paired A/B of the kept changes through local Ollama models, in scratch projects outside the repository (see [Live A/B through Ollama](#live-ab-through-ollama)).

A root is either a project (it holds `.forja/runs`) or a folder whose direct subfolders are projects. On the Sponsor's machine the baseline used the projects folder (`%USERPROFILE%\Desktop\Repositorios`) and one project outside it.

## Baseline: real runs (2026-10-04)

Scope: 147 Core runs in 31 projects, all on the Claude provider; 2,167 invocations; 651 of 925 tasks done. Run outcomes: 112 done, 29 failed, 5 running, 1 blocked. The ledger had no damaged lines.

Accounting notes:

- Input tokens include cache creation and cache reads once (`lib/core/metrics.mjs`).
- A develop session stopped at the context limit is killed before Claude reports usage, so its ledger row has `usage: null`. Its stream still records every request; the audit uses the stream total for those rows (331 develop invocations) and never counts a row twice. Without this the ledger under-reports input by about a quarter.
- "Context tokens" below are the request sizes of every top-level model call in the Claude streams (2,159 sessions, 64,345 model calls), the closest measure of what each call actually sends.

### Tokens by phase

| Phase | Invocations | Input tokens (incl. cache) | Share | Model calls |
| --- | ---: | ---: | ---: | ---: |
| plan | 128 | 143,307,575 | 2.1% | 1,859 |
| develop | 1,237 | 6,055,471,588 | 87.8% | 52,921 |
| review | 802 | 695,593,432 | 10.1% | 9,565 |
| total | 2,167 | 6,894,372,595 | 100% | 64,345 |

Output: 46,460,710 tokens (0.7% of input).

### Where the context of a session goes

| Measure | Value |
| --- | ---: |
| Session baseline (first call request size), p50 / p90 / max | 29,987 / 35,930 / 64,459 tokens |
| Largest request per session, p50 / p90 / max | 104,158 / 203,088 / 394,804 tokens |
| Baseline resent on every call (baseline × calls) | 29.4% of context tokens |
| of which the FORJA prompt (prompt characters / 4 × calls) | 8.5% of context tokens |
| Tool results resent on every later call (characters / 4 × later calls) | 26.6% (Bash 18.8%, Read 7.3%, Grep 0.3%) |
| Tool results of 20,000+ characters (2,670 results) | 7.5% |
| Tokens in calls made with more than 100k / 150k / 200k context | 67.9% / 40.8% / 19.2% |

### Prompt (packet) sizes

Submitted prompt characters per invocation (FORJA rules, phase instructions, framing and the JSON packet):

| Phase | p50 | p90 | max |
| --- | ---: | ---: | ---: |
| plan | 27,666 | 31,044 | 35,619 |
| develop | 36,640 | 46,318 | 55,406 |
| review | 37,484 | 46,279 | 56,062 |

Share of submitted prompt characters by source: repository_map 16.2%, knowledge 14.4%, task_scope 14.0%, goal 11.3%, stable FORJA rules 9.8%, decisions 6.7%, task 5.6%, provider-facing framing 5.1%, specialist_context 4.3%, phase instructions 2.9%, changes 2.3%, progress_notes 2.2%, the rest under 1.5% each.

Repeated context across invocations: 63.3% of the 79.6 million submitted prompt characters repeat a part (an instruction line or a top-level packet key, compared by hash) already sent earlier in the same run: goal 94%, decisions 94%, instruction lines 87%, specialist_context 81%, task_scope 67%, task 67%, knowledge 41%, repository_map 30%. The 79.6 million characters are about 20 million tokens, 0.3% of input: repetition across sessions is cheap by itself; its cost comes from the per-call resend above.

### Rotations, retries, rejections, re-plans and waits

| Measure | Value |
| --- | ---: |
| Develop sessions stopped at the context limit | 311 sessions, 1,830,631,869 input tokens (26.6% of input) |
| Context rotations recorded on tasks | 327 (0 stalled) |
| Develop invocations after a task's first attempt (rework after failed checks or rejection) | 244 invocations, 324,973,914 tokens (4.7%) |
| Implementation attempts after the first | 241 |
| Reviews: approve / reject / other | 673 / 127 / 2 (rejection 15.9%) |
| Input tokens of rejected reviews | 121,526,500 (1.8%) |
| Automatic provider retries | 0 |
| Extra plan invocations (re-plans) | 0 |
| Failed invocations: timeout / error / interrupted | 12 / 19 / 10, 156,269,214 tokens (2.3%) |
| Repeated file reads within a session | 254 of 16,765 reads (133,436 characters) |
| Repeated identical shell commands within a session | 103 |
| Gap between invocations, p50 / p90 | 4.5 s / 192 s |
| Waits of 15+ minutes between invocations | 45, 91.8 h in total (blocked runs waiting for an operator or a usage limit) |
| Recorded check time / provider time | 19.6 h / 302 h |

## Baseline: offline benchmark

`node tools/efficiency-bench.mjs` on 2026-10-04, metrics SHA-256 `145acfc2d21e440e3afa4cf72465506e35dd6c22bb1414ae6f4cc4fc5dbb448d`. Two fixtures in `test/fixtures/efficiency/`:

- `small-api`: three small tasks in a Node module with a few knowledge notes.
- `wide-plan`: ten tasks in one shared directory with long criteria, a long goal, eight decisions and fourteen knowledge notes (synthetic text from a seeded generator).

Packets (characters of the normalized JSON packet):

| Fixture | Plan packet | Develop packets, total / max | Largest develop sources |
| --- | ---: | ---: | --- |
| small-api | 9,781 | 27,069 / 9,176 | knowledge 5,569 (61%), specialist_context 1,472, task_scope 574 |
| wide-plan | 20,367 | 323,536 / 32,358 | task_scope 12,080 (37%), knowledge 5,971, goal 5,963, decisions 3,132, repository_map 2,117 |

Trimming of the `wide-plan` develop packet: nothing is trimmed at 48,000 or 40,000 characters; at 24,000 the criteria of the other remaining tasks go first (21,671 characters left); at 12,000 the mandatory parts alone exceed the limit and the packet stops with `task_packet`. No plan task is over the planning budget in either fixture.

Scripted runs (sessions per phase and submitted prompt characters, normalized):

| Fixture / scenario | Status | Sessions (plan/develop/review) | Prompt characters | Repeated |
| --- | --- | ---: | ---: | ---: |
| small-api / happy | done | 1 / 3 / 3 | 135,967 | 60.1% |
| small-api / review_reject_once | done | 1 / 4 / 4 | 174,073 | 68.4% |
| small-api / check_fail_once | done | 1 / 4 / 3 | 154,780 | 64.9% |
| small-api / context_rotation | done | 1 / 4 / 3 | 155,118 | 64.7% |
| small-api / output_retry | done | 1 / 4 / 3 | 155,220 | 64.7% |
| wide-plan / happy | done | 1 / 10 / 10 | 769,367 | 73.7% |
| wide-plan / review_reject_once | done | 1 / 11 / 11 | 854,638 | 76.3% |
| total | | 84 sessions | 2,399,163 | 1,708,913 characters |

Retry/rotation decision matrix: 2 of 48 cases retry (develop output and develop timeout with an unused retry); rotation exhaustion as expected in 4 cases.

The benchmark measures the FORJA prompt only. It cannot see provider tool definitions, tool results or the number of model calls inside a session; those come from the audit.

## Ranked waste candidates

Ranked by the measured share of input they touch. "Expected gain" is an estimate from the numbers above, to be confirmed or rejected by a before/after measurement; the table is the baseline ranking; outcomes are in the improvement sections below. Area: context (task eff-context) or calls (task eff-calls).

| # | Candidate | Evidence | Expected gain | Area |
| --- | --- | --- | --- | --- |
| 1 | Long develop sessions at high context: earlier checkpoints, a context budget that rotates before calls get expensive, tighter task read scope at planning | 40.8% of context tokens are in calls above 150k context, 19.2% above 200k; context-limit sessions use 26.6% of input | Large but bounded by the re-read cost of a fresh session (baseline about 30k tokens plus re-reads); an offline replay of the per-call request sizes in the streams must estimate the net before any change | calls |
| 2 | Large tool outputs that every later call resends (full test suites, long logs, whole-file reads) | Tool results resent are 26.6% of context tokens; 2,670 results of 20,000+ characters are 7.5% | About 3-4% of input if large outputs were capped or filtered at half their size; needs a guard that failure details stay visible | context |
| 3 | Rework after failed checks or review rejection | 4.7% of input in develop invocations after the first attempt, 1.8% in rejected reviews; rejection rate 15.9% | Up to 2-3% if a quarter of rejections were avoided; quality-sensitive, measurable only live | calls |
| 4 | Knowledge excerpts in develop and review packets that are weakly related to the task | 14.4% of prompt characters; 61% of the small-api develop packet for a three-line task | Packet share of input is 8.5%, so halving knowledge text saves about 0.6% of input | context |
| 5 | Repository map in every packet, including review (which has the change patch) | 16.2% of prompt characters; only 30% repeats across invocations | About 0.5-0.7% of input if dropped from review or halved | context |
| 6 | task_scope criteria of other tasks sharing a directory | 14.0% of prompt characters; 37% of the wide-plan develop packet | About 0.4-0.6% of input; the plan pointer keeps full criteria available | context |
| 7 | Goal and decisions resent in full to develop and review | goal 11.3% and decisions 6.7% of prompt characters, 94% repeated | About 0.5% of input; the goal is the overall context of every task, so quality risk is high | context |
| 8 | Failed invocations (timeouts, errors, interruptions) | 2.3% of input in 41 invocations | Small; most are external (provider errors, operator stops) | calls |

Measured and not worth a change now:

- Re-plans: 0 extra plan invocations in 147 runs.
- Automatic provider retries: 0 used.
- Repeated reads within a session: 1.5% of reads, 133k characters in total.
- Idle waits: the median gap between invocations is 4.5 s; the 45 long waits are blocked runs waiting for a person or a usage limit (night mode already resumes due usage-limit waits), not controller time. Checks are 6.5% of provider time.

Coverage limits: all 147 runs used Claude, so Codex/Kilo behaviour is not measured. Tool and context statistics need the Claude stream file; 2,159 of 2,167 invocations had one. Tool result resend is an estimate (characters / 4); provider tokenization and context management can differ.

## Improvements: packet size and repeated context

Task eff-context (2026-10-04/05) tried the packet candidates of the table above (#4 to #7 touch the packet builder) one at a time, in the order of their measured share of real packet resend. Iteration stopped by the stop rule: two consecutive candidates without a gain that kept quality.

### Method

- **Real-data replay.** `tools/efficiency-replay.mjs` applies each candidate as a transform of the JSON packet recorded in every `call-N-prompt.txt` (2,190 packets of the 147 runs above) and weighs the characters it removes by the model calls of that session (ledger `calls`), because the packet is resent on every call. Packet resend is 470.7 million tokens (about 6.8% of the audit's 6,894 million input tokens). A candidate tried after a kept change is measured on top of it.
- **Offline benchmark.** The candidate is implemented and `tools/efficiency-bench.mjs` runs before and after. A third fixture, `wide-repo` (packets only: four tasks in 200 source files), fills the repository map to its budget; the two older fixtures have maps under 3,000 characters.
- **Quality probes**, counted before and after on both: task files listed in the repository map (replay and bench), required knowledge kept, best-ranked knowledge chunk kept, remaining tasks sharing a file that keep criteria, and those whose criteria arrive whole (replay); expected knowledge paths per task (bench, `expect_knowledge` in `small-api`); scenario status, sessions and attempts (bench).
- **Rule.** A candidate is kept when it lowers packet resend in the replay or prompt/packet characters in the benchmark, every probe covering the information it removes stays at 100%, and no scenario outcome changes. A size gain that removes information no probe shows to be redundant counts as no gain.

The instrumented benchmark (probes, review packet totals, `wide-repo`) changed no controller behaviour: scenario prompt characters stayed 2,399,163. Its baseline is packet suite 888,841 characters, metrics SHA-256 `31b273d625e11ee7fddd8bf1cc963e7c7b11fe0815724d33eb64288787c350a8`.

### Candidates, in the order tried

| # | Candidate | Replay: resend saved | Benchmark | Quality probes | Result |
| --- | --- | --- | --- | --- | --- |
| 1 | Repository map 3,000 characters in develop and review packets (plan keeps 6,000), plain cut | 44.6 M tokens: 9.48% of packet resend, 0.65% of all input | not implemented | task files in map 9,732 / 11,543 | rejected: drops 16% of the task files the map listed |
| 2 | Same budget, the task's own files listed first | 44.6 M tokens: 9.49% of packet resend, 0.65% of all input | packet suite 888,841 → 864,177 (−2.8%); `wide-repo` develop 68,628 → 56,296 (−18.0%), review 69,460 → 57,128 (−17.8%); scenarios unchanged | all 100% (task files 11,543 / 11,543) | **kept** |
| 3 | Criteria of remaining tasks sharing a file capped at 600 characters (was 1,200) | 27.5 M tokens: 5.85% of packet resend, 0.40% of all input | scenario prompts 2,399,163 → 2,291,973 (−4.5%); packet suite 864,177 → 767,282 | complete shared-task criteria 7,482 → 1,650; `wide-plan` truncated 0 → 9 of 9 | rejected: cuts the criteria of 78% of the overlapping tasks |
| 4 | No repository map in review packets (after #2) | 7.6 M tokens: 1.61% of packet resend, 0.11% of all input | scenario prompts 2,399,163 → 2,348,648 (−2.1%); packet suite 864,177 → 828,914 | review packets lose the whole map (task files in map 11,543 → 6,696) | rejected: no probe shows the reviewer does not need the neighbouring files and symbols |

"All input" is the audit total of 6,894 million tokens, which includes sessions killed at the context limit; the replay's own ledger total (4,977 million) excludes them, so the same savings are 0.90%, 0.55% and 0.15% of it.

Kept change (#2): `repoMap` in `lib/core/context.mjs` takes the task files as pinned paths that rank first; task packets use `TASK_MAP_CHARACTERS` (3,000) and the plan packet `PLAN_MAP_CHARACTERS` (6,000). Benchmark after the change: metrics SHA-256 `abc7c2c6edd733424a61da77ea47fc47b99b8cc291372edf7d2214541068e5aa`. Regression tests in `test/efficiency-bench.test.mjs`: the map test (a low-ranked task file stays first and the map stays within 3,000 characters in develop and review, 6,000 for the plan), the quality probes in the packet measurement test and the replay test. `.forja` formats are unchanged.

Expected effect on real runs: about 0.65% of all input tokens (44.6 M of 6,894 M in the measured runs), mostly in develop sessions, where the packet is resent on every call. The benchmark does not see provider tool definitions or tool results, so it cannot show a session-level effect; the live A/B (task eff-live-ab) measures that.

### Not tried (stop rule) and open

- Knowledge relevance cut (optional chunks under half the best score): replay 6.7 M tokens, 1.43% of packet resend, 0.10% of all input; best chunk and required notes kept. Not tried after two consecutive rejections.
- Goal and decisions resent in full (#7): not tried; they are the overall context of every task.
- Large tool outputs resent on every call (#2 of the ranked table, the largest context candidate): not a packet change. Its lever is the provider's tool-output limit in the adapter (`lib/core/providers.mjs`) or worker behaviour, and its quality guard (failure details stay visible) can only be checked in a live run.
- #4 above is the candidate a live A/B could revisit: its gain is real, only its quality cost is unmeasured offline.

## Improvements: model calls, retries, rotations, re-plans and idle waits

Task eff-calls (2026-10-05) tried the candidates of the ranked table that concern sessions, rework, rotations and waits (#1, #3 and #8, plus the idle time the audit counts), one at a time, in the order of the evidence. Re-plans (0) and automatic provider retries (0) had nothing to remove. Iteration stopped by the stop rule after candidates 2 and 3.

### Method

- **Offline benchmark.** The benchmark now also counts check executions per scenario (`checks`: the last validation pass of each task, the final regression and final entries recorded without running, by reason) and has a fourth fixture, `shared-checks` (scenarios only, no packets: four sequential tasks, each with its own check plus the two project-wide checks every task repeats, like `npm test` and a check script). This instrumentation changed no number of the earlier fixtures (prompt characters 2,399,163 + 262,003 for the new fixture = 2,661,166; packet suite 864,177). Re-baseline before any candidate: metrics SHA-256 `1c5789facf7b59e4029489ba25ff08a0786751f3f6726060914e5308796bb6aa`, 46 final check runs.
- **Real-data replay.** `tools/efficiency-replay.mjs` gained three read-only, aggregate-only sections over the same 147 runs: `final_regression` (from `state.json`), `context_budget` and `check_failure_rework` (from the Claude streams of 1,236 develop sessions).
- **Rule.** As in eff-context: kept only with a measured gain, no lost check, review or budget, and unchanged scenario outcomes (status, sessions, attempts).

### Candidates, in the order tried

| # | Candidate | Measurement | Quality | Result |
| --- | --- | --- | --- | --- |
| 1 | Final regression: do not run again a check (same command and args) that already passed on the same tree, in the same pass or in the validation that accepted the final task | Replay: in the 84 of 96 runs whose regression passed in one pass, 638 of 1,092 final checks (58%) repeated such a check: 19,802 of 29,175 s (67.9%) of final regression time; per run p50 74 s, p90 759 s, max 2,825 s. Benchmark: final check runs 46 → 34; `shared-checks` 9 → 3 per scenario | every check of every task still has a passing result on the final tree, recorded per task; sessions, prompts, statuses and attempts unchanged in every scenario | **kept** |
| 2 | Lower develop context budget (rotate before calls get expensive), the largest waste of the ranked table | Replay with re-orientation measured on 230 real continuations after a context-limit stop (median 13 calls and +39,656 tokens before the first edit; a fresh first session takes 16 calls): a budget of 200,000 saves an estimated 9.2% of develop stream tokens (562 M) with 212 more rotations; 160,000 saves 14.0% (861 M) with 502; 120,000 saves 13.4% (823 M) with 1,297 | 200,000: 1 task over its rotation budget, 0 sessions at the streak limit; 160,000: 7 and 4; 120,000: 63 and 182 (each stops the run for an operator). The quality cost of losing a session's working memory is not measurable offline | not kept: no code change. The gain only exists by lowering a budget the Sponsor configured per run (the default is already 120,000); a recommendation, below |
| 3 | Put the failing check's log in the rework feedback, so the developer does not spend a call to open it | Replay: 60 develop sessions followed a failed check; 56 named the check log in their first model call (median call 1, at the baseline context) | — | not kept: no call to save; not implemented |

Kept change (#1): the final regression in `lib/core/engine.mjs` keeps a map of checks that passed on the current tree (keyed by tree hash, command and args), seeded from the final task's validation when that validation passed on the same tree. A repeat is recorded in the task's `finalValidation` as `{ skipped: 'same_tree_passed', reused: '<task> validation' | '<task> final check <n>', passed: true }`, next to the existing `snapshot_bound` entries; nothing else in `.forja` changes. Any source change between two runs of a check changes the key, so the check runs again; a failed check is never stored. Benchmark after the change: metrics SHA-256 `ffbebaad25cefef38f179e320baa12c188300f66ff03b7de27943e2a9e0fd22f`, final check runs 34. Regression tests in `test/efficiency-bench.test.mjs`: reuse from the final task's validation and from earlier in the pass, a pass on an earlier tree is not reused, and the replay counts. `test/check-timeout.test.mjs` and `test/protected-files.test.mjs` give their second task its own check, because their final-regression cases (a check timeout, a check that changes a protected file) relied on the identical check running again.

Assumption of the kept change: a check's result is a function of the tracked tree. Checks may write only to temporary or Git-ignored output, so a check that depends on ignored output of an earlier check in the same pass (a build then a test) is the one case where the repeat could differ; in task validation that order already ran once on the same tree.

Expected effect on real runs: about 5.5 h of the 8.1 h of final regression measured in single-pass runs, about two thirds of final regression time; no token change (checks call no model).

### Recommendation (not a code change)

For long Claude runs, a `maxContextTokens` of 200,000 in the run configuration or profile (instead of the 250,000-300,000 used by about half the measured runs) is the low-risk point of the replay: an estimated 9% fewer develop tokens with one task in 190 over its rotation budget. Its quality effect (fresh sessions re-orient from progress notes) is unmeasured; the replay is a model, not a measurement of real runs at that budget. The local live A/B (task eff-live-ab) cannot test it: local routes do not use Claude streams.

### Not tried

- Idle waits: the median gap between invocations is 4.5 s and the 45 waits of 15+ minutes are runs waiting for a person or a usage limit. A snapshot of a 262-file project takes about 67 ms, so removing repeated snapshots would save under a second per invocation.
- Rework after review rejection (15.9% of reviews): fewer rejections, or a re-review that receives the previous findings, changes model behaviour and can only be measured live.
- Failed and blocked runs (31): their recorded causes are operator decisions, goal changes and plan packets (already planned again once with measured sizes), not a single controller defect.

## Live A/B through Ollama

Task eff-live-ab (2026-10-05) ran the kept changes that affect model input or call count through local models, change on against change off, on the same tasks.

### What was tested

- **Tested: the task-packet repository map** (eff-context #2: 3,000 characters with the task files first, against the earlier 6,000 characters without pinning). It is the only kept change that alters model input.
- **Not tested: the final regression reuse** (eff-calls #1). It changes check executions, not model input or calls, and no run in this A/B reached the final regression (see limitations).

### Method

- **Harness.** `node tools/efficiency-bench.mjs live run --detach` (code in `tools/efficiency-live.mjs`), resumable, results in `<lab>/live-ab/results.json` with each run's log, diff and acceptance output; `live report` prints the tables below. Nothing runs inside the repository or the installed checkout.
- **Arms.** "on" runs this worktree's `bin/forja.mjs`. "off" runs a scratch copy of the same runtime files (`<lab>/live-ab/forja-off`, rebuilt on every harness start) in which only the map call in `packet()` is put back to `repoMap(root, query)`; the harness refuses to build it unless that call appears exactly once, and records the hashes of both `context.mjs` versions and of `lib/` (the same for all 18 runs).
- **Tasks.** Three bake-off tasks with their fixed one-task plans (`--plan`, so the plan packet, which the change does not touch, is skipped) and their hidden acceptance tests: `duration-fix`, `paginate-regression`, `coupon-feature` (`test/bakeoff/tasks/`). Each run is a fresh copy plus 150 generated neighbouring modules (`packages/<area>/<noun>-<verb>.mjs`, no test names, no word of a task query), so the map exceeds both budgets: about 3,150 characters on, 6,200 off. Bake-off projects alone have maps under 300 characters, where both arms would send the same packet.
- **Profile and caps.** `config/core-local.json` (`qwen3-coder:30b-32k` through Kilo in every phase, `maxCloudSessions: 0`) with `maxSessions` 4; the harness refuses any non-Ollama route or escalation. 14 minutes per run (the harness kills the process tree), 90 minutes of active harness time in total. Before every run it checks the GPU with `nvidia-smi` and Ollama's loaded models (the bake-off rule) and waits while another process uses it; utilization was 0-1% with about 1.1-1.5 GB used by other processes, so no run waited.
- **Pairs.** Each task and repeat is a pair; the arm that goes first alternates. Planned sample: 2 repeats (6 pairs). Verdict rule fixed before the runs (`summarizeLive`): contradicts when "on" passes fewer hidden tests in complete pairs or its median paired input is higher; confirms when it passes at least as many and both median paired input and input per call are lower; otherwise inconclusive.
- **Measures.** Ledger input tokens (input plus cache, as Kilo reports them), model calls, sessions and wall time per run; hidden acceptance test and the project's own tests; repository map characters per packet from the ledger's context sources; and, added after the first pair, the first model request of each session from Kilo's `step_finish` events (system prompt, tools, FORJA prompt and packet: the part every later call of the session resends).

The first attempt was stopped after two minutes: the off copy lacked `.claude/skills` (the Core specialist methods), so its runs never started. That attempt was discarded and set aside; the harness now stops when a run creates no Core run.

### Results

18 runs, 9 complete pairs, 62 minutes of active time. After 6 pairs the verdict was already "contradicts" (hidden passes on 3, off 5), resting on two discordant pairs; a third repeat was added within the cap, and its three pairs were all concordant.

| Arm | Runs | Hidden test pass | Own tests pass | Sessions | Calls | Input tokens | Output tokens | Input per call | Map characters per packet (median) | First request, develop / review (median tokens) | Wall s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| off | 9 | 7 | 9 | 17 | 250 | 3,878,079 | 46,854 | 15,512 | 6,203 | 13,286 / 10,716 | 1,745 |
| on | 9 | 5 | 9 | 17 | 268 | 3,974,869 | 51,046 | 14,832 | 3,155 | 12,517 / 9,953 | 1,858 |

Paired, on minus off (9 pairs, medians): input −25,151 tokens, calls −2, input per call −504, first develop request −776 tokens, wall +11 s; "on" had less input in 5 of 9 pairs.

Per run (d/r: first request of each develop/review session):

| Pair | Arm | Hidden test | Run end | Calls | Input tokens | First request | Wall s |
|---|---|---|---|---:|---:|---|---:|
| duration-fix r1 | on | fail (0/2) | provider failure, no edit | 3 | 38,224 | d 12,507 | 35 |
| duration-fix r1 | off | pass (2/2) | review without verdict | 44 | 755,007 | d 13,283, r 10,717 | 263 |
| paginate-regression r1 | off | pass (3/3) | review without verdict | 24 | 362,267 | d 13,286, r 10,703 | 201 |
| paginate-regression r1 | on | pass (3/3) | review without verdict | 51 | 808,867 | d 12,502, r 9,915 | 395 |
| coupon-feature r1 | on | fail (4/5) | review without verdict | 25 | 326,699 | d 12,557, r 9,971 | 164 |
| coupon-feature r1 | off | pass (5/5) | review without verdict | 27 | 385,386 | d 13,329, r 10,760 | 149 |
| duration-fix r2 | off | pass (2/2) | invalid develop result | 33 | 587,720 | d 13,275 | 308 |
| duration-fix r2 | on | pass (2/2) | review without verdict | 26 | 334,691 | d 12,519, r 9,953 | 181 |
| paginate-regression r2 | on | pass (3/3) | review without verdict | 31 | 476,675 | d 12,510, r 9,933 | 212 |
| paginate-regression r2 | off | pass (3/3) | review without verdict | 27 | 386,658 | d 13,286, r 10,707 | 174 |
| coupon-feature r2 | off | fail (4/5) | review without verdict | 29 | 456,968 | d 13,317, r 10,752 | 183 |
| coupon-feature r2 | on | fail (4/5) | review without verdict | 27 | 365,986 | d 12,565, r 9,981 | 148 |
| duration-fix r3 | on | pass (2/2) | invalid develop result | 54 | 943,010 | d 12,515, d 12,595 | 436 |
| duration-fix r3 | off | pass (2/2) | review provider failure | 20 | 320,545 | d 13,283, r 10,715 | 157 |
| paginate-regression r3 | off | pass (3/3) | review without verdict | 23 | 303,280 | d 13,286, r 10,693 | 178 |
| paginate-regression r3 | on | pass (3/3) | review without verdict | 21 | 278,129 | d 12,510, r 9,931 | 145 |
| coupon-feature r3 | on | fail (4/5) | review without verdict | 30 | 402,588 | d 12,553, r 9,965 | 142 |
| coupon-feature r3 | off | fail (4/5) | review without verdict | 23 | 320,248 | d 13,329, r 10,760 | 131 |

What the numbers show:

- **Model input per request: confirmed.** Every "on" session started smaller than every "off" session: develop 12,502-12,595 against 13,275-13,329 tokens (−5.8% at the median), review 9,915-9,981 against 10,693-10,760 (−7.1%). Input per call over all calls was 4.4% lower. This is the offline gain (about 3,000 map characters, about 770 tokens per request) reaching the model unchanged.
- **Whole-run tokens, calls and time: not measurable at this sample.** One run used between 38 thousand and 943 thousand input tokens and 3 to 54 calls, depending on how long the model kept working. Summed, "on" used 2.5% more input, 7% more calls and 6% more wall time; by paired medians it used 25 thousand fewer tokens and 2 fewer calls. A 5-7% smaller request cannot be separated from a spread of that size with 9 pairs.
- **Pass rate: the rule says "contradicts", the failures do not point at the map.** The difference is two pairs, both in the first repeat. In `duration-fix` r1 the "on" developer stopped after 3 calls and 35 seconds without a result JSON and without editing anything (Kilo "no final JSON", which Core does not retry); the same failure ended an "off" review in r3. In `coupon-feature` r1 the "on" developer floored the discounted total (899 → 809, not 810): the mistake both arms made in r2 and r3 and `qwen3-coder` made in the bake-off. Both arms list the task files first; the lines the change removes are neighbouring padding modules that no task reads. With 2 discordant pairs and none the other way, an exact McNemar test gives p = 0.5.

### Decision

The map change is **kept and flagged**, not reverted (decision log, "eff-live-ab"): its input gain is confirmed per request, and the pass-rate difference that triggers the pre-set "contradicts" rule is two failures with causes outside the map, at a sample that cannot detect a quality effect of this size in either direction. The flag stays until a larger live sample (the stress suite runs with the change on) shows no pass-rate loss attributable to the map.

### Limitations

- 9 pairs, 3 small JavaScript tasks, one local model, one machine; only very large pass-rate differences are detectable.
- The neighbouring files are synthetic and unrelated to the tasks. A repository where the files beyond the 3,000 characters matter (an unfamiliar codebase where the map is the main guide) is not represented; the stress suite's unfamiliar-codebase scenarios are.
- No review returned `approve` or `reject` (the bake-off's `done` defect, left to task stress-fix), so every run ended after one develop and one review session, or earlier. Rework after rejection and the final regression were never reached; the final regression reuse is therefore untested live.
- Kilo reports input including its prompt cache; Ollama reuses its cache for a shared prefix, so fewer input tokens become less prompt processing time only in part. Wall time also includes model speed variation.
- The sample was extended from 6 to 9 pairs after seeing the first 6; both are reported, and the verdict was the same. The first-request measure was added after the first pair; it is computed from the saved streams of every run and does not enter the verdict rule.
