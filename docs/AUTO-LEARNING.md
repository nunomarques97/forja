# Auto-learning (experimental)

**Status: experimental, branch `feat/auto-learning` only.** It is merged only if the measurement shows a benefit (Sponsor decision 2026-10-03). Nothing is released from this branch and `package.json` keeps its version.

Core learns from earlier finished runs of the same project. A deterministic extractor turns run history into a private lessons store; a later run with the `lessons` configuration flag receives a short, bounded, source-referenced lessons section in its planner, developer and reviewer packets. Lessons are data, never instructions: they never override the goal, task, decisions or project rules. With the flag off nothing changes.

This document records the design, the measurement and the decision log. The operator commands (`core lessons list|show|forget|clear`) are in docs/CORE-RUNBOOK.md.

## History inventory

Every Core run keeps its evidence in `.forja/runs/<run id>/` (ignored by Git and refused by the delivery privacy scan):

| Artifact | Content | Used by the extractor |
| --- | --- | --- |
| `state.json` | Frozen run state: status, `finished_at`, `invocations`, tasks with `title`, planned `files`, `checks`, `attempts`, `status`, `files_changed`, the last attempt's `validation` (command, args, exit code, `passed`, log path) and only the last `review`/`feedback`. | Yes, the authoritative run record. |
| `usage.jsonl` | One ledger row per provider invocation: `id`, `phase`, `task`, `attempt`, `provider`, `model`, `result` (`returned`, `error`, `interrupted`), `timed_out`, `rate_limited`, `context_limit_reached`, usage and duration. Rows also hold absolute paths of event logs. | Yes, for the per-attempt sequence and provider failures; absolute paths are never copied. |
| `call-N-result.json` | The structured result of invocation N: developer status/summary/findings, reviewer `approve`/`reject` with summary and findings. | Yes, because state keeps only the last review: earlier rejections and the fix that followed live here. |
| `<task>-a<attempt>-check-<i>.log` | Output of each deterministic check per attempt. | Yes, to name the first failing test of a failed check. |
| `<task>-change.patch`, `<task>-changed-files.json` | Diff and changed paths of the last attempt sent to review. | No: `state.json` already holds `files_changed`, and patches can be large. |
| `call-N-prompt.txt`, `-stream.json`, `-events.jsonl`, `-schema.json`, `SUMMARY.md` | Full packets, native provider output and traces. | No: large, provider-native and possibly private; nothing a lesson needs. |
| `.forja/current.json` | A copy of the active run state. | No: the run directory copy is authoritative and stays after the next run starts. |

Existing modules that are reused, not duplicated:

- `lib/core/diagnose.mjs` `readMetadata`: every read is bounded by a per-file limit and a shared read budget, refuses non-regular files and paths outside the project.
- `lib/core/metrics.mjs` `parseUsageLedger`: recovers intact ledger rows and reports damaged lines. The deduplication rule (an `interrupted` record yields to the real one) and the provider outcome classification follow `lib/core/model-evidence.mjs`.
- `tools/release-check.mjs` detectors: the new `redactPrivateText` helper derives its patterns from the same `DETECTORS` list (home paths, credential shapes, private keys), so the privacy rules keep one source. `contentFindings` is the final gate.
- `lib/core/quality.mjs` `checksFor`: maps a check log index back to its command.
- `lib/atomic-write.mjs` `writeFileAtomic`: the store is replaced atomically with the Windows rename retry.
- Retrieval (later task) reuses `lib/core/knowledge.mjs` `terms`/`rankChunks` for term matching. The A/B measurement (later task) reuses `metrics.mjs`, `model-evidence.mjs` and the alternating schedule pattern of `benchmark.mjs` and `evaluation-plan.mjs`.

## Extraction

`extractLessons(root)` in `lib/core/lessons.mjs`:

- Lists `.forja/runs/` and ingests only run directories not yet recorded in the store, oldest id first, at most 50 per call. A run is read only when its `state.json` is version 1, names the same run id and has status `done` or `failed`; `finished_at` (or `updated_at` for a failed run) becomes the occurrence time.
- Makes no model, network, process or clock call. All reads go through `readMetadata` with a 64 MiB budget per extraction and per-file limits (state and ledger 4 MiB, result 256 KiB, check log 1 MiB, store 8 MiB). At most 1,000 run directories, 100 tasks and 200 invocations per run are considered.
- Skips with a warning, never throws: unfinished runs (ingested later, once finished), malformed or oversized state, unexpected task ids, links/junctions or files in place of a run directory, malformed ledger lines, malformed or oversized result files and check logs. A finished run with damaged parts is ingested from its intact parts. When the read budget runs out, the run is not recorded and the next extraction continues there.
- A damaged store is refused with an error instead of being rebuilt, because a rebuild would recount ingested runs and lose forgotten lessons.
- Writes `.forja/lessons/store.json` only when its bytes change. Re-running over the same runs changes nothing (no double counting) and the bytes stay identical; ingesting the same runs one by one or all at once yields the same bytes.

### Lesson kinds

| Kind | Derived from | Grouping key |
| --- | --- | --- |
| `check_failure` | Failed checks of the final attempt (`validation[].passed === false`), and checks of an earlier attempt that never reached review whose log shows a test-runner failure marker (`not ok N`, `# fail N`, `ℹ fail N`, `✖`). Text: command, exit code, task title, first failing test or error line. | Command and normalized first failure. A count of 2 or more is a recurring check failure. |
| `review_rejection` | Each `reject` in `call-N-result.json` of a review row: summary and the first two findings. | Normalized summary. |
| `fix_after_rejection` | A review `approve` that follows a rejection of the same task: the rejection summary and the developer summary of the approved attempt. Files: the task's `files_changed`. | Normalized rejection and fix summaries. |
| `provider_failure` | Ledger rows with `result: error` or `context_limit_reached`: `timeout`, `provider_limit`, `context_limit` or `provider_error`, and whether a later session of the same phase and task returned (recovered) or not. | Provider, model, phase, code, recovered. |
| `relevant_files` | Each file in `files_changed` of an approved task that changed at most 30 files (broad tasks say little about relevance). | The file path. A count of 2 or more is a frequently relevant file. |

Interrupted invocations are operator actions, not failures, and produce no lesson.

### Store format

```json
{
  "version": 1,
  "runs": { "F-<id>": { "status": "done", "finished_at": "<ISO time>" } },
  "forgotten": ["L-<16 hex>"],
  "lessons": [{
    "id": "L-<16 hex>",
    "kind": "check_failure",
    "text": "Check \"node --test test/dates.test.mjs\" failed (exit 1) in task \"...\"; first failure: parses dates.",
    "files": ["lib/dates.mjs"],
    "evidence": [{ "run": "F-<id>", "task": "T1", "path": ".forja/runs/F-<id>/T1-a1-check-0.log" }],
    "count": 2,
    "first_seen": "<ISO time>",
    "last_seen": "<ISO time>",
    "confidence": 0.7,
    "half_life_days": 30
  }]
}
```

- `id` is a hash of the kind and the redacted grouping key, so the same lesson from another run merges into one record.
- `text` is capped at 280 characters; `files` at 8 project-relative paths; `evidence` keeps the 3 newest pointers (run id, task id, project-relative file or `.forja/runs/...` artifact path). Absolute paths from state or the ledger are never copied; artifact paths are rebuilt from the run id, task id and attempt.
- On a merge, `count` grows by one per occurrence, `first_seen`/`last_seen` widen and the newest occurrence's text wins.
- Each kind keeps its 100 strongest lessons (highest count, then most recent, then id).
- `forgotten` lists ids the operator removed; extraction never re-creates them.

### Confidence and decay

`confidence = min(0.9, 0.3 + 0.2 × count)`: 0.5 for one occurrence, 0.7 for two, 0.9 from three. Retrieval applies the decay with `lessonWeight(lesson, now) = confidence × 0.5^(age_days / 30)`, where `age_days` counts from `last_seen`. The decay is computed when a packet is built, not stored, so the store bytes never depend on the clock.

## Retrieval

The run config key `lessons` (passed with `--config`, frozen with the run) accepts `true` or `false`; absent means `false`. Any other value is refused by `createRun` before state is written, and by state validation on every load.

- **Flag off (default).** Packets, the worker prompt and run state are byte-identical to a build without this module, whether or not a store exists. No `lessons` key, framing sentence or record is produced and nothing is ingested.
- **Ingestion.** With the flag on, the controller runs the extractor once per run, at the first scheduling pass under the project lock, and records `lessonsIngest` (time, ingested run ids, store size, warning count, or a one-line error). A failed or damaged store never stops the run.
- **Selection.** `selectLessons` scores each lesson by file overlap with the task files (a planned directory matches files below it), BM25 terms of the task title, criteria and files (the goal when planning) with words shared by every lesson template removed, and a per-kind weight (fix after rejection 1.3, review rejection and check failure 1.2, provider failure 0.8, relevant files 0.7); provider failures in the same phase score extra and relevant-files lessons need file overlap. The score is multiplied by `lessonWeight`, so older lessons decay. At most 5 lessons are sent, and the whole section, with its note and method, stays within 3,000 characters.
- **Packet section.** Plan, develop and review packets carry `lessons` after `knowledge`: a note that lessons are data and never override the goal, task, decisions or project rules; each selected lesson with kind, text, files, evidence pointers (run, task, artifact path), count, last seen and weight; and the method. The provider framing adds one matching sentence only when lessons were sent.
- **Budget.** Lessons are the first optional context `fitPacket` removes, before the criteria of other remaining tasks; the trim is listed in packet sources as `trimmed lessons`. `planPacketProblems` still refuses plans whose task packets exceed the task packet budget, and the planning contract names the lessons trim only with the flag on.
- **Record.** Each invocation appends `{ invocation, phase, task, ids }` (plus `trimmed` or `warning` when applicable) to `lessonsSent` in run state, keeping the last 100 entries.

## Privacy

- The store lives under `.forja/lessons/`: ignored by Git, refused by the delivery privacy scan and never sent anywhere except this project's own packets.
- Every lesson text, file and evidence path passes `redactPrivateText` with the project root: the root (slash, backslash and JSON-escaped forms, case-insensitive) becomes `<project>`, other home paths become `<home>`, credential shapes and private key blocks become `<redacted>`.
- A lesson that still has a `contentFindings` result in its raw or JSON form (for example a pasted conversation export, which cannot be redacted) is dropped with a warning. The serialized store is scanned once more before writing; a finding then aborts the write.
- Tests prove that `contentFindings` of the written store is empty and that the project root and the credential do not appear in it.

## Measurement

The A/B evaluation asks one question: does a second execution of the same kind of task do better with lessons than without? The harness is `lib/core/lessons-eval.mjs` with the command `tools/lessons-ab.mjs`. It reuses `metrics.mjs` for the ledger and the alternating arm order of `benchmark.mjs`, but not `runBenchmark`, which compares single model calls.

### Pre-registered design

`LESSONS_AB` (version 1, `lessons-ab-v1`) is fixed before any live run; `--dry-run` prints it with its SHA-256.

- **Fixtures.** Two synthetic projects, each a fresh Git repository in the OS temp directory with a fixed one-task plan (no planner call) and seeded synthetic history under `.forja/runs/`, so the extractor sees what it sees in use:
  - `slug-ligatures` (`rejected_then_fixed`): a prior run whose slugify helper was rejected because ß, æ, ø and œ disappeared, then fixed and approved.
  - `dates-offset` (`recurring_check_failure`): two prior runs whose first attempt failed the same date-offset test before a fix passed.
- **Arms.** `off` (config `lessons: false`) and `on` (`lessons: true`); everything else comes from the same operator profile. Profiles that set `delivery`, `finalChecks` or `allowDirty` are refused.
- **Schedule.** 3 repetitions × 2 fixtures × 2 arms = 12 runs. Odd repetitions run `off` first, even ones `on` first.
- **Budget.** Each run is capped at 4 sessions (`maxSessions`), so the A/B starts at most **48 provider sessions**, on the subscription, at 0 EUR. Live mode refuses to start unless `--confirm-sessions` equals that maximum.

### Metrics

Per run, from run state and the usage ledger only (`parseUsageLedger`, `summarizeUsage`): status of the first review (from its `call-N-result.json`), rejections, sessions, input tokens including cache plus output tokens, duration, final pass (run done, every task done with all validation passed) and the lessons actually sent (`lessonsSent`). A run with an invalid ledger, missing invocation records, incomplete token or duration coverage, a provider error, timeout or interruption, or an unreadable review result is marked with a measurement gap. Per arm: first-review approval rate (a run that never reached review counts as not approved), rejections, sessions, tokens and duration per run, and final pass rate.

### Verdict rule

`lessonsVerdict` is deterministic; it is a triage of a small sample, not a statistical test.

1. **inconclusive** when the schedule is incomplete or out of order, a run errored, any run has a measurement gap or an unknown mean, an `on` run received no lessons, or an `off` run received any.
2. Otherwise **benefit** when all of these hold:
   - at least one gain: first-review approval rate up by at least 0.34, or rejections per run down by at least 0.5, or sessions per run down by at least 0.5;
   - no regression: the `on` arm's final pass rate and first-review approval rate are not lower and its rejections per run not higher;
   - tokens per run in the `on` arm at most 25% above the `off` arm.
3. Otherwise **no_benefit**, with the reasons listed.

### Commands

Windows PowerShell 5.1 (one command per line; the profile is a Core run config such as the selected Claude profile):

```powershell
node tools/lessons-ab.mjs --dry-run --config "$env:USERPROFILE\forja-profile.json"
node tools/lessons-ab.mjs --confirm-sessions 48 --config "$env:USERPROFILE\forja-profile.json"
```

The first prints the schedule and the maximum session count and writes nothing. The second runs the 12 live Core runs, each in its own OS temp directory that is removed afterwards (`--keep` keeps them), and writes the results JSON to `$env:TEMP\forja-lessons-ab-live-<time>.json`. `--out <file>` chooses another path; a path inside a Git work tree that is not ignored, or an existing file, is refused. Results are saved after every run, so an interrupted A/B keeps what it spent and is judged inconclusive.

`node tools/lessons-ab.mjs --simulate` runs the whole harness with a scripted provider and no provider calls (about a minute). Its scripted developer avoids the trap only when it receives lessons or feedback, so its `benefit` proves the wiring, not a real benefit. `test/lessons-eval.test.mjs` runs it and checks that only the `on` arm receives lessons.

### Current verdict

**inconclusive (live A/B not yet executed).** The harness, the verdict rule and the simulated end-to-end run are tested; the 48-session live A/B is run by the operator with the command above, and this section is then updated with the results file summary and its verdict. Until a live verdict of `benefit`, the branch is not merged.

## Decision log

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-10-03 | Experimental branch, merged only if a measurement shows benefit; version unchanged; nothing released. | Sponsor decision. |
| 2026-10-04 | Deterministic extraction from existing run artifacts; no model call. | Zero cost, reproducible and testable; the history already holds the signals. |
| 2026-10-04 | Read `call-N-result.json` in addition to `state.json`. | State keeps only the last review and the last attempt's validation; earlier rejections and fixes exist only in call results. |
| 2026-10-04 | Incremental store keyed by ingested run ids, with occurrence times taken from the runs. | Idempotent re-runs, no double counting, byte-identical output, cheap at run start. |
| 2026-10-04 | Earlier-attempt check failures need a test-runner failure marker in the log. | State records exit codes only for the last attempt; a marker avoids counting passing logs as failures. |
| 2026-10-04 | Redaction helper exported from `tools/release-check.mjs`, built from its detectors. | One source for privacy rules; the delivery scan and the lessons store agree. |
| 2026-10-04 | Decay computed at retrieval time with a 30-day half-life. | Keeps stored bytes independent of the clock. |
| 2026-10-04 | A damaged store is refused, not rebuilt. | A rebuild would double count and forget the operator's forgotten ids. |
| 2026-10-04 | Lessons are selected per packet by file overlap, terms and kind with decay, at most 5 within 3,000 characters, and trimmed before any other optional context. | Bounded, relevant context that never displaces mandatory packet data; flag-off packets keep today's trimming order and bytes. |
| 2026-10-04 | Planned: config key `lessons` (frozen with the run), lessons trimmed first in packets, `core lessons` commands, A/B harness with fixed plans and a budget of at most 48 subscription sessions (2 fixtures × 3 repetitions × 2 arms × 4 sessions) at 0 EUR. | Recorded in the run plan; implemented by the following tasks. |
| 2026-10-04 | A/B harness separate from `runBenchmark`, with fixed plans, seeded synthetic history and an alternating schedule. | `runBenchmark` compares single model calls; fixed plans cut variance and sessions. Planner-packet lessons are covered by unit tests only. |
| 2026-10-04 | Pre-registered verdict thresholds; any gap, error or missing lessons gives inconclusive. | Avoids reading a benefit into incomplete or contaminated evidence from a small sample. |
| 2026-10-04 | Workers do not run the live A/B; the operator runs the documented command. | It launches up to 48 provider sessions, outside a worker's mandate. |
