# Local model bake-off (2026-10-04 run, measured 2026-10-05)

Which local Ollama model should take each FORJA Core phase (plan, develop, review) on this PC, measured by running the same small real coding tasks through this worktree's `bin/forja.mjs` with Kilo CLI 7.8.1 and Ollama 0.35.0? The recommendation is [`config/core-local.json`](../../config/core-local.json).

## Setup

- **Machine.** Windows 11, RTX 5060 Ti 16 GB, Ollama 0.35.0 at `127.0.0.1:11434`, Kilo CLI 7.8.1 on PATH, Node 24. An Android emulator was open during the run; GPU utilization stayed under the wait threshold, so no step waited.
- **Harness.** [`tools/local-bakeoff.mjs`](../../tools/local-bakeoff.mjs) with [`test/bakeoff/config.json`](../../test/bakeoff/config.json), started detached (`run --detach`), resumable, results in `<lab>\bakeoff\results.json` (`<lab>` is a lab folder outside this repository) with each run's log, diff and acceptance output under `runs\`. `node tools/local-bakeoff.mjs report` prints the tables below from that file.
- **Each run.** A fresh copy of the task template under `forja-lab\bakeoff\projects\` (new Git repository), then `forja start --provider kilo --config <profile>` where the profile routes plan, develop and review to the same local model through Kilo (`maxCloudSessions: 0`, 6 sessions, 2 attempts, no provider retry, per-call 6/10/6 minutes, 3-minute check timeout). The harness kills the process tree at 20 minutes (screening) or 25 minutes (full tasks) and stops at 180 minutes of active time. A separate data folder keeps the nested runs out of the installed checkout's project registry and notifications.
- **One model at a time.** Before each probe and run the harness unloads every other candidate model and waits while `nvidia-smi` shows heavy use by another process (see [decision log](../DECISIONS.md), "bakeoff").
- **Speed probe.** One `/api/generate` call per model (a 530-token prompt, 128 output tokens, temperature 0) gives load time, prompt and generation speed as Ollama reports them. The "effective" tokens/s in the run table is output tokens divided by wall time of the phase, which includes prompt processing, tool execution and Kilo overhead.

## Tasks and correctness

Four tasks in [`test/bakeoff/tasks/`](../../test/bakeoff/tasks), each a small Node project with tests, a goal, a fixed one-task plan, a hidden acceptance test and a reference solution (`test/local-profile.test.mjs` proves each hidden test fails on the template and passes on the solution):

| Task | Kind | Stage |
|---|---|---|
| `duration-fix` | bug fix: parse `1h30m`-style durations, reject the rest with `RangeError` | screening (all models) |
| `coupon-feature` | multi-file feature: coupon module, rounding rule, case-insensitive codes | full (finalists) |
| `safe-path` | security fix: path traversal, encoded separators, sibling-prefix directory, drive letters | full (finalists) |
| `paginate-regression` | failing tests after a refactor, keep the existing assertions, add validation | full (finalists) |

Correctness of a run is (1) the hidden acceptance test, run from outside the scratch project after the run, (2) the project's own `node --test`, and (3) my reading of the saved diff. A plan is usable when the controller accepted it (at least one valid task). A review verdict is valid when the reviewer returned `approve` or `reject`, and correct when its last verdict matches the hidden acceptance result. A model whose own plan was refused also ran the task with the fixed plan, so its developer and reviewer were still measured; that run does not count for the planner.

## Candidates

Nine models (configuration in [`test/bakeoff/config.json`](../../test/bakeoff/config.json)): the two 32k variants already installed (`qwen3-coder:30b-32k`, `forja-gpt-oss:20b-32k`), `forja-bk-*:32k` context variants of the installed `qwen3:14b`, `qwen3:8b`, `qwen3:4b` and `llama3.2`, and three free models pulled for the bake-off:

| Pulled model | Size | License | Why |
|---|---|---|---|
| `devstral-small-2:24b` | 15 GB | Apache 2.0 | agentic coding model with tool support; weights fit 16 GB |
| `qwen2.5-coder:14b` | 9 GB | Apache 2.0 | code model with tool support |
| `rnj-1:8b` | 5.1 GB | Apache 2.0 | small coding/STEM model with tool support |

Larger current coding models in the Ollama library (18 GB and up) were left out because they do not fit 16 GB; cloud tags were excluded. The run took 113 minutes of active harness time (cap 180) between 2026-10-05 01:31 and 03:24 UTC (two stop-and-resume cycles to fix the fixed plans and the full-stage order, see below); no step had to wait for the GPU.

### Speed probe (Ollama's own numbers)

"Loaded GB (on GPU)" is the size Ollama reports with the 32k context; when it exceeds the GPU part, the rest runs on the CPU.

| Model | Parameters, quantization | Generation tok/s | Prompt tok/s | Load s | Loaded GB (on GPU) |
|---|---|---|---|---|---|
| `qwen3-coder:30b-32k` | 30.5B Q4_K_M | 59.3 | 490 | 23.0 | 22.1 (14.8) |
| `forja-gpt-oss:20b-32k` | 20.9B MXFP4 | 89.5 | 1447 | 11.1 | 12.8 (12.8) |
| `forja-bk-qwen3-14b:32k` | 14.8B Q4_K_M | 42 | 1180 | 10.5 | 14.4 (14.4) |
| `forja-bk-devstral-small-2-24b:32k` | 24.0B Q4_K_M | 11.3 | 545 | 14.7 | 20.2 (14) |
| `forja-bk-qwen2.5-coder-14b:32k` | 14.8B Q4_K_M | 35.1 | 1276 | 7.4 | 15.7 (14.6) |
| `forja-bk-qwen3-8b:32k` | 8.2B Q4_K_M | 73.1 | 1958 | 5.4 | 10 (10) |
| `forja-bk-rnj-1-8b:32k` | 8.3B Q4_K_M | – | – | – | – (–) |
| `forja-bk-qwen3-4b:32k` | 4.0B Q4_K_M | 122.9 | 3344 | 4.4 | 7.5 (7.5) |
| `forja-bk-llama3.2:32k` | 3.2B Q4_K_M | 152.8 | 4192 | 3.7 | 6 (6) |


### Every run

Screening runs every model on `duration-fix`; the three best screening scores (`qwen3-coder`, `devstral-small-2`, `gpt-oss`) ran the full tasks. "Run end" is where the FORJA run stopped. Hidden acceptance counts are passed/total hidden tests; the second value is the project's own test suite after the run.

| Stage | Model | Task | Plan | Develop: hidden acceptance / own tests | Review verdicts | Run end | Time s | Sessions | Effective output tok/s plan / develop / review |
|---|---|---|---|---|---|---|---|---|---|
| screening | `qwen3-coder:30b-32k` | duration-fix | ok (82 s) | pass (2/2) / pass, 1× 153 s | done | review did not approve or reject. | 327 | 3 | 21.3 / 29.8 / 34.1 |
| screening | `forja-gpt-oss:20b-32k` | duration-fix | failed (10 s) | not reached | – | Plan must contain 1–30 cohesive tasks. | 11 | 1 | 3.5 / – / – |
| screening | `forja-gpt-oss:20b-32k` | duration-fix (fixed plan) | fixed plan | pass (2/2) / pass, 1× 51 s | none | Provider review failed (Kilo reported an error); see call-2-stream.json. No automatic retry of review provider failures. | 64 | 2 | – / 54.4 / 14.2 |
| screening | `forja-bk-qwen3-14b:32k` | duration-fix | ok (101 s) | fail (0/1) / fail, 2× 247 s | – | fix-duration-parser exhausted 2 implementation attempts. | 350 | 3 | 27.9 / 30.4 / – |
| screening | `forja-bk-devstral-small-2-24b:32k` | duration-fix | ok (187 s) | pass (2/2) / pass, 1× 326 s | done | review did not approve or reject. | 624 | 3 | 4.7 / 4.9 / 3.5 |
| screening | `forja-bk-qwen2.5-coder-14b:32k` | duration-fix | ok (26 s) | fail (0/2) / pass, 1× 20 s | – | unknown status. | 47 | 2 | 7.7 / 5.3 / – |
| screening | `forja-bk-qwen3-8b:32k` | duration-fix | ok (125 s) | fail (1/2) / pass, 1× 178 s | none | length)); see call-3-stream.json. No automatic retry of review provider failures. | 574 | 3 | 50.9 / 50.1 / 51.4 |
| screening | `forja-bk-rnj-1-8b:32k` | duration-fix | failed (132 s) | not reached | – | exit status 0xc0000409: The system detected an overrun of a stack-based buffer in this application. This overrun could potentially allow a malicious user to gain control of this application.: GGML_ASSERT(hparams.is_swa_any())  | 132 | 1 | – / – / – |
| screening | `forja-bk-rnj-1-8b:32k` | duration-fix (fixed plan) | fixed plan | fail (0/2) / pass, 1× 107 s | – | exit status 0xc0000409: The system detected an overrun of a stack-based buffer in this application. This overrun could potentially allow a malicious user to gain control of this application.: GGML_ASSERT(hparams.is_swa_any( | 108 | 1 | – / – / – |
| screening | `forja-bk-qwen3-4b:32k` | duration-fix | ok (46 s) | fail (1/2) / pass, 1× 137 s | done | review did not approve or reject. | 254 | 3 | 62.3 / 71.9 / 71.8 |
| screening | `forja-bk-llama3.2:32k` | duration-fix | failed (26 s) | not reached | – | Plan must contain 1–30 cohesive tasks. | 27 | 1 | 1.6 / – / – |
| screening | `forja-bk-llama3.2:32k` | duration-fix (fixed plan) | fixed plan | fail (0/2) / pass, 1× 24 s | – | unknown status. | 25 | 1 | – / 17.3 / – |
| full | `qwen3-coder:30b-32k` | coupon-feature | failed (146 s) | not reached | – | Plan must contain 1–30 cohesive tasks. | 147 | 1 | 21.9 / – / – |
| full | `qwen3-coder:30b-32k` | coupon-feature (fixed plan) | fixed plan | fail (4/5) / pass, 1× 162 s | done | review did not approve or reject. | 253 | 2 | – / 20.8 / 22.8 |
| full | `qwen3-coder:30b-32k` | paginate-regression | ok (152 s) | pass (3/3) / pass, 1× 78 s | done | review did not approve or reject. | 324 | 3 | 30.6 / 27.2 / 29.7 |
| full | `qwen3-coder:30b-32k` | safe-path | ok (115 s) | fail (4/5) / fail, 1× 602 s | – | 10 minutes (develop secure_path_resolution call-2). Raise it with core resume --max-minutes N (N from 11 | 718 | 2 | 30.8 / 33.8 / – |
| full | `forja-gpt-oss:20b-32k` | coupon-feature | ok (35 s) | fail (2/5) / pass, 1× 45 s | – | stop)); see call-2-stream.json. No automatic retry of provider failures. | 81 | 2 | 20.5 / 34.9 / – |
| full | `forja-gpt-oss:20b-32k` | paginate-regression | failed (13 s) | not reached | – | Provider plan failed (Kilo reported an error); see call-1-stream.json. No automatic retry of plan provider failures. | 14 | 1 | 8.3 / – / – |
| full | `forja-gpt-oss:20b-32k` | paginate-regression (fixed plan) | fixed plan | pass (3/3) / pass, 1× 85 s | done | review did not approve or reject. | 115 | 2 | – / 42.9 / 34.5 |
| full | `forja-gpt-oss:20b-32k` | safe-path | failed (142 s) | not reached | – | stop)); see call-1-stream.json. No automatic retry of plan provider failures. | 143 | 1 | 50.7 / – / – |
| full | `forja-gpt-oss:20b-32k` | safe-path (fixed plan) | fixed plan | fail (4/5) / pass, 1× 173 s | approve | done | 308 | 2 | – / 50.5 / 68.1 |
| full | `forja-bk-devstral-small-2-24b:32k` | coupon-feature | ok (89 s) | pass (5/5) / fail, 1× 600 s | – | 10 minutes (develop add-coupon-support call-2). Raise it with core resume --max-minutes N (N from 11 to  | 692 | 2 | 2.1 / 4.5 / – |
| full | `forja-bk-devstral-small-2-24b:32k` | paginate-regression | ok (110 s) | pass (3/3) / pass, 1× 277 s | none | Provider review failed (Kilo reported an error); see call-3-stream.json. No automatic retry of review provider failures. | 458 | 3 | 3.7 / 4 / 1.5 |
| full | `forja-bk-devstral-small-2-24b:32k` | safe-path | ok (73 s) | fail (4/5) / fail, 1× 602 s | – | 10 minutes (develop fix-path-traversal call-2). Raise it with core resume --max-minutes N (N from 11 to  | 677 | 2 | 4 / 4.8 / – |


### Per model and role

Fixed-plan runs count for develop and review only. "Review correct" uses the strict rule (an `approve` or `reject` that matches the hidden test). Effective output tokens/s over all runs, plan / develop / review: `qwen3-coder` 26.5 / 30.6 / 29.0, `gpt-oss` 40.2 / 47.2 / 60.0, `devstral-small-2` 3.8 / 4.6 / 2.7, `qwen3:14b` 27.9 / 30.4 / –, `qwen3:8b` 50.9 / 50.1 / 51.4, `qwen3:4b` 62.3 / 71.9 / 71.8, `qwen2.5-coder` 7.7 / 5.3 / –, `llama3.2` 1.6 / 17.3 / –.

| Model | Plan usable | Develop accepted | Review valid verdict / correct | Mean s plan / develop / review |
|---|---|---|---|---|
| `qwen3-coder:30b-32k` | 3/4 | 2/4 | 0/3 / 0/3 | 124 / 249 / 89 |
| `forja-gpt-oss:20b-32k` | 1/4 | 2/4 | 1/3 / 0/3 | 50 / 88 / 55 |
| `forja-bk-qwen3-14b:32k` | 1/1 | 0/1 | 0/0 / 0/0 | 101 / 247 / – |
| `forja-bk-devstral-small-2-24b:32k` | 4/4 | 3/4 | 0/2 / 0/2 | 115 / 451 / 89 |
| `forja-bk-qwen2.5-coder-14b:32k` | 1/1 | 0/1 | 0/0 / 0/0 | 26 / 20 / – |
| `forja-bk-qwen3-8b:32k` | 1/1 | 0/1 | 0/1 / 0/1 | 125 / 178 / 268 |
| `forja-bk-rnj-1-8b:32k` | 0/1 | 0/1 | 0/0 / 0/0 | 132 / 107 / – |
| `forja-bk-qwen3-4b:32k` | 1/1 | 0/1 | 0/1 / 0/1 | 46 / 137 / 70 |
| `forja-bk-llama3.2:32k` | 0/1 | 0/1 | 0/0 / 0/0 | 26 / 24 / – |


Measured order (rate, then mean time): plan forja-bk-qwen2.5-coder-14b:32k > forja-bk-qwen3-4b:32k > forja-bk-qwen3-14b:32k > forja-bk-devstral-small-2-24b:32k > forja-bk-qwen3-8b:32k > qwen3-coder:30b-32k > forja-gpt-oss:20b-32k > forja-bk-llama3.2:32k > forja-bk-rnj-1-8b:32k; develop forja-bk-devstral-small-2-24b:32k > forja-gpt-oss:20b-32k > qwen3-coder:30b-32k > forja-bk-qwen2.5-coder-14b:32k > forja-bk-llama3.2:32k > forja-bk-rnj-1-8b:32k > forja-bk-qwen3-4b:32k > forja-bk-qwen3-8b:32k > forja-bk-qwen3-14b:32k; review forja-gpt-oss:20b-32k > forja-bk-qwen3-4b:32k > qwen3-coder:30b-32k > forja-bk-devstral-small-2-24b:32k > forja-bk-qwen3-8b:32k.

The "measured order" line ranks by rate alone, so a model with one easy screening run (1/1) sorts above a finalist with 3/4 over harder tasks. The ranking below weighs the sample size and my reading of the diffs.

### Own review of the diffs

- **qwen3-coder.** `duration-fix` correct (anchored regex plus tests). `paginate-regression` correct, also validates the items array. `coupon-feature` (fixed plan) rounds the discounted total instead of the discount: 899 with SAVE10 gives 809, not 810. `safe-path` special-cases the string `/etc/passwd`, leaves malformed `%` encoding uncaught, and its own sibling-prefix test fails; the develop call hit the 10-minute cap.
- **devstral-small-2.** `duration-fix` correct but verbose and partly redundant. `coupon-feature` correct (separate coupon module, discount floored, total never below 0), though one of its own tests expects 446 where the correct value is 441, so the project's suite failed; the develop call hit the 10-minute cap after writing the code. `paginate-regression` correct. `safe-path` handles traversal, encoding and drive letters but checks containment with a plain string prefix, so `../app-evil/file.txt` passes; develop hit the cap again.
- **gpt-oss.** `duration-fix` and `paginate-regression` correct (fixed plans). `coupon-feature`: wrote a correct coupon function but never wired it into `cart.mjs`, then ended without a result JSON. `safe-path` (fixed plan) rejects every nested path such as `/a/b.txt` and any `..`, even inside the root: over-restrictive, yet its reviewer approved it.
- **Screening-only models.** `qwen3:14b` wrote `&#39;` HTML entities into JavaScript and deleted the original tests, failing both attempts. `qwen3:8b` uses `matchAll(...).length` (always undefined), so the empty string is not rejected. `qwen3:4b` rejects valid zero-valued groups such as `1h0m1s`. `qwen2.5-coder:14b` and `llama3.2` (fixed plan) made no edit and returned no valid status. `rnj-1:8b` crashed Ollama's runner on every call (`GGML_ASSERT(hparams.is_swa_any())`, exit `0xc0000409`) on Ollama 0.35.0.

### Ranking per role

| Role | Ranking | Basis |
|---|---|---|
| Plan | 1. `devstral-small-2` (4/4 usable, 115 s mean), 2. `qwen3-coder` (3/4, 124 s), 3. `gpt-oss` (1/4, 50 s); screening-only models unranked | Only the finalists planned more than the screening task. `qwen3-coder`'s miss was `coupon-feature` (result JSON `{}`, plan refused). `gpt-oss` returned tool arguments instead of a plan, hit a Kilo error, or ended without JSON in three of four plans. `llama3.2` and `rnj-1` failed even the screening plan. |
| Develop | 1. `devstral-small-2` (3/4 hidden pass, 451 s mean, 2 per-call timeouts), 2. `qwen3-coder` (2/4, 249 s, 1 timeout), 3. `gpt-oss` (2/4 with fixed plans, 88 s); then `qwen3:4b` and `qwen3:8b` (one of two hidden tests), `qwen3:14b`, `qwen2.5-coder`, `llama3.2`, `rnj-1` (none) | No model fixed `safe-path` (security task). The gap between the top two is one task (coupon rounding); `devstral-small-2` is about twice as slow on every task because a third of it runs on the CPU. |
| Review | No local reviewer is reliable. By intent (reading `done` with an approving summary as approve): `qwen3-coder` 2/3 matching, `gpt-oss` 1/2, `devstral-small-2` 1/1 (its other review returned no output), `qwen3:4b` 0/1; strict verdicts: only `gpt-oss` returned `approve` once, on a failing change | Every reviewer that answered approved the change: 0 of the 3 failing changes that reached a verdict were rejected. |

### Failure modes

| Mode | Where | Class |
|---|---|---|
| Reviewer returns `done` instead of `approve`/`reject` (run blocks "review did not approve or reject") | 6 runs: every `qwen3-coder` review, `devstral-small-2`, `gpt-oss` paginate, `qwen3:4b` | pipeline: the review result schema shares the status enum of every phase, so `done` validates. Candidate for the stress-fix task. |
| Approves a failing change | `qwen3-coder` coupon, `gpt-oss` safe-path, `qwen3:4b` duration | model |
| Plan without tasks, `{}` or tool arguments as the result JSON | `gpt-oss` 3/4, `qwen3-coder` 1/4, `llama3.2` | model, made worse by result extraction: Kilo's last JSON is taken even when it is not schema-valid, so the one-time reminder is not sent (pipeline candidate) |
| No final result JSON after work | `gpt-oss` coupon develop and safe-path plan | model (the reminder was sent and not answered) |
| Kilo ends the session: permission auto-rejected (`external_directory` in a read-only phase), empty model output, or output length | `gpt-oss` review, `devstral-small-2` review, `qwen3:8b` review | provider/model; the auto-rejected permission ending the session is a pipeline candidate |
| Per-call timeout at 10 minutes | `devstral-small-2` coupon and safe-path, `qwen3-coder` safe-path | budget versus model speed |
| Runner crash | `rnj-1:8b` | runtime (Ollama 0.35.0) |

No run completed end to end: the best result is correct code blocked at review. The completion rate of a local-only profile therefore depends first on the reviewer status fix, then on model quality.

## Recommendation

[`config/core-local.json`](../../config/core-local.json) uses `qwen3-coder:30b-32k` for plan, develop and review, with `maxCloudSessions: 0`, no escalation, 8 sessions, 2 attempts, 1 rotation, 1 provider retry, a 15-minute run call cap, per-call 8/15/8 minutes (plan/develop/review) and a 5-minute check timeout.

- **Why not `devstral-small-2` for develop, although it ranks first?** Its lead is one task out of four, while it is about twice as slow on every task (4.6 against 30.6 effective tokens/s), hit the 10-minute call cap on half of its tasks, and does not fit the 16 GB card with the 32k context Kilo needs (20.2 GB loaded, 14 GB on the GPU). The stress suite and A/B tasks that use this profile run dozens of scenarios under wall-clock caps; with `devstral-small-2` they would fit about half as many runs. It stays installed (`keep` in the bake-off config) as the quality alternative: set it on the develop route, with `maxMinutes` 20, when time does not matter.
- **One model for every phase.** Mixing would mean swapping two models of about 20 GB on each phase change; `qwen3-coder` is the second-best planner and the most consistent reviewer by intent, so a single model costs little.
- **`gpt-oss` is the fast option** (fully on the GPU, 47 tokens/s effective in develop) but failed three of four plans and most result contracts; not recommended for unattended runs.
- **Budgets.** The longest plan took 187 s and the longest review that returned a verdict 132 s, so 8 minutes leaves room for a loaded machine. Develop gets 15 minutes because 10 minutes cut off two correct-but-slow developers. One provider retry covers the empty-output and auto-rejected-permission endings seen above.

Local review cannot be trusted to catch defects: in this sample it never rejected a failing change. The controller's deterministic checks (the project's tests) remain the real gate in a local-only run.

## Limitations

- Four small JavaScript tasks, one run per model and task, one machine; a one-task difference is not significant. Screening-only models were measured on one easy task.
- Each model played every role in its own runs, so the reviewer judged its own model's code.
- Effective tokens/s includes prompt processing, tool execution and Kilo overhead; `devstral-small-2` and `qwen3-coder` are partly offloaded to the CPU at 32k context, so their speed depends on CPU load (an Android emulator was open).
- `coupon-feature` for `qwen3-coder` needed a second fixed-plan run: the first failed before any model call because the fixed plans used an invalid complexity value (fixed in the task files; `test/local-profile.test.mjs` now validates every fixed plan).

## Cleanup

`node tools/local-bakeoff.mjs cleanup --confirm` removed only what the bake-off added: `qwen2.5-coder:14b`, `rnj-1:8b` and the `forja-bk-*:32k` variants of `qwen3:14b`, `qwen2.5-coder:14b`, `qwen3:8b`, `rnj-1:8b`, `qwen3:4b` and `llama3.2`. It kept `devstral-small-2:24b` and its `forja-bk-devstral-small-2-24b:32k` variant (the documented alternative) and every model that was installed before the bake-off.
