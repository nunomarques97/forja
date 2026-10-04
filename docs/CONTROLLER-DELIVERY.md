# Isolated checks and reviewer-owned delivery

These are independent, opt-in Core capabilities. Existing runs and configurations retain their behavior. No extra model session is added for Git: the final code reviewer also decides whether the exact proposed snapshot is ready to commit and, when requested, publish. The controller performs Git operations and enforces authorization.

## Isolated controller checks

On Windows, merge this setting into the config passed to `forja start --config`:

```json
{
  "checkIsolation": { "backend": "bubblewrap", "distribution": "Ubuntu" }
}
```

On native Linux, omit `distribution`. The selected environment needs `/usr/bin/python3`, `/usr/bin/bwrap`, a merged `/usr` layout, and working unprivileged user, PID and network namespaces. Bubblewrap must support `--disable-userns` and `--assert-userns-disabled`. FORJA probes the actual sandbox before model calls, including on resume. An unavailable backend blocks the run; it never falls back to host execution. `core doctor` validates configuration but does not certify namespace support.

The controller copies Git-tracked and untracked nonignored regular files into a temporary snapshot. Git and `.forja` metadata are excluded; symlinks, junctions, special files and unsupported paths are refused. Hardlinks are copied as bytes. The source snapshot is mounted read-only at `/workspace`; only `/tmp` is writable scratch. Host home directories, Windows mounts, Git state, scheduler state, ignored dependencies and inherited environment secrets are not exposed. The Linux system runtime under `/usr` is readable. Do not store credentials there; this is a trusted system prerequisite, not a downloaded image.

Checks run with a separate network and PID namespace, no capabilities, no nested user namespaces and a new session. Detached descendants terminate when the command ends. A Linux supervisor enforces the wall deadline and output cap; disconnecting the Windows WSL client also tears down execution. Limits: 10,000 snapshot files / 64 MiB total, 64 MiB temporary filesystem, 16 MiB per scratch file, 8 MiB combined output, 64 processes per real UID and 256 descriptors per process. The process limit also accounts for other processes of that Linux UID; a busy environment may refuse a fork. CPU time is bounded per process, not for the whole process tree. There is no aggregate RAM guarantee or protection against kernel vulnerabilities or a concurrently malicious host process.

Commands must be Linux-compatible and support read-only source. Windows executables, checks needing `.git`, dependency installation, network services outside the sandbox, ignored `node_modules`, and builds that write into the source tree are not supported by this backend. Missing executables fail the check; FORJA does not install packages. Adapt checks to write artifacts under `/tmp` or leave isolation disabled for a trusted project. Check results record the source manifest hash and effective backend; normal acceptance and stale final checks use the same isolation path.

The optional [combined Claude example](../config/core-isolated-checks.json) also selects restricted worker file tools. Worker permissions and controller process isolation are different boundaries. No npm dependency is added. This sandbox follows [bubblewrap's documented model](https://github.com/containers/bubblewrap/blob/main/README.md); protection depends on the supplied mounts and namespace options.

Delivery gates govern controller operations. They do not sandbox workers with explicit full access or arbitrary custom executors: such a process may execute Git outside the controller. For stronger containment, combine restricted worker tools with isolated checks. Existing provider access settings are not silently changed by opting into delivery.

## Automatic commits without another agent

Save a reusable configuration for each project and pass it with `--config`:

```json
{
  "delivery": { "mode": "commit" }
}
```

Automatic delivery requires a clean initial worktree and index. `--allow-dirty` cannot opt unrelated existing edits into a commit. Core records the run's changes as an explicit manifest, builds a separate Git index, performs the privacy scan, and gives the final reviewer a compact delivery reference alongside its existing code-review context. The reviewer checks release suitability and supplies an approval bound to the exact Git tree plus a public-safe commit message. There is no `delivery` model route and no second review invocation.

Since 0.21.1 the review patch carries text changes only. It is review evidence (the commit is built from the candidate index, never by applying the patch) and is built without `--binary` and with `--no-renames`, so each binary file appears as one `Binary files ... differ` line. The 4 MiB review limit applies to that text patch: text over 4 MiB still blocks with `Delivery diff exceeds the 4 MiB review limit.` Binary files are the ones Git itself diffs as binary (`-` in `git diff --numstat`, so `.gitattributes` applies). The manifest and the receipt list every binary of the candidate in `binaries`: `path`, `change` (`added`, `modified` or `deleted`), `bytes` and `sha256` of the new blob (of the old blob for a deletion), never the bytes themselves. The reviewer inspects them through the working-tree files. The approval is bound to the exact tree, which includes every blob id, and to the manifest hash, so changing a binary after review voids the approval (`Delivery inputs changed during review`). Binaries are still committed and still pass the privacy scan like every other file; a binary under a refused path blocks.

A separate cap bounds binary assets: `delivery.maxBinaryBytes` (a positive integer of bytes, 32 MiB by default) limits the total size of added and modified binaries in one delivery candidate (one per run, or one per task with task granularity); deletions do not count. Going over blocks before review with `Delivery binary files total X MiB, over the Y MiB limit (delivery.maxBinaryBytes); largest: path (size), ...`, naming up to three files. Shrink or remove the largest assets, or raise the limit in the run configuration of a new run. Each delivery Git read is limited to 32 MiB, so a single file above 32 MiB cannot be delivered either way.

```json
{
  "delivery": { "mode": "commit", "maxBinaryBytes": 67108864 }
}
```

After all checks and task approvals pass, the controller verifies the source, candidate index, real index, branch, Git configuration, manifest and approval. It creates one commit with the run base as its only parent, updates that branch with a compare-and-swap operation, and installs the matching index. Rejection preserves working files and the original index. A crash between updating the branch and installing the index can require manual recovery; the receipt and any owned lock are retained, and no second commit is created automatically.

The real index is compared by staged content, not by its raw bytes: the receipt records a hash of `git ls-files --stage` (mode, blob, stage number, so unmerged entries count) plus the intent-to-add entries. Since 0.20.13 a read-only `git status` or `git diff` that only refreshes the stat cache and rewrites `.git/index` during the review no longer voids the approval; a real staged change (`git add` of a modified file, `git add -N`) still blocks with "Delivery inputs changed during review". This applies to both granularities and to the check just before a task commit is installed. Worker sessions and the controller's own Git calls run with `GIT_OPTIONAL_LOCKS=0`, so their reads never rewrite the index. While a run is active, check progress with `core status`, or prefix your own Git commands with `GIT_OPTIONAL_LOCKS=0` (PowerShell: `$env:GIT_OPTIONAL_LOCKS='0'` in that terminal).

The built-in privacy scanner is the implementation used by FORJA's release guard. It detects known private paths, credential patterns, home paths and conversation exports; it is not a complete privacy detector. Home paths are detected only as filesystem paths, never as URL or route segments: the Windows drive form (drive letter, `Users`, user name) is case-insensitive and includes JSON-escaped backslashes; the macOS form (capital `Users`) is case-sensitive, and it and the Linux `home` form must begin at a path boundary (start of text, whitespace, a quote, backtick, `=`, `(`, `:` or `file://`) with a user name followed by a separator. The reviewer remains responsible for semantic review, binary assets and the project's required release evidence. All required checks must be in task checks or caller `finalChecks`. Project Git configuration and filters are trusted; Git hooks are not used to grant authorization or replace these checks. The controller uses `commit-tree` / `update-ref`, and disables client push hooks. Server branch protections remain authoritative. Configure signing-required repositories through the normal project process; this path does not add signed commits automatically.

Since 0.20.15 the scan rules are stated up front: with `delivery` configured, `planning_contract.delivery_scan_rules` and the develop instructions list the refused paths, the home-path and credential content rules and the `.env.example` / `.env.sample` / `.env.template` allowance (only `KEY=` lines with empty or placeholder values; see [the release guard](RELEASE.md)). `start` pre-scans every tracked file of the run base before any model session, prints `FORJA warning: The run base already has N privacy-scan finding(s): path:line reason ...` and records the report in run state (`base_scan` in `core status`); `core doctor` runs the same report on HEAD. The pre-scan only reports: a pre-existing finding is never approved. A delivery that stages a file with a finding still blocks before review, and the message names each finding as `path:line reason`, adding `(already in the run base; reported at start)` when the base had it. Fix such findings in a separate commit before the run, or expect that inspection and `core retry --task ID --validate-only`.

`core status` reports code completion and delivery status separately. A delivery failure gives the CLI a nonzero exit even if code work is `done`. Receipts, manifests and logs stay under `.forja/runs/<run-id>/`; they are private evidence, not release files. A normal resume does not repeat a blocked delivery. After inspection, use `core deliver --retry`; it cannot invent reviewer approval or adopt changed source/history. Runs without `delivery` never commit or push.

## One reviewed commit per task

By default a run produces at most one commit, after every task is approved. To keep one explanatory commit per logical change, opt into task granularity:

```json
{
  "delivery": { "mode": "commit", "granularity": "task" }
}
```

`granularity` is `run` (the default) or `task`, with `mode` `commit` or `push`. With `task`, each task that changes source produces one local commit after its checks and independent review pass. The task's existing reviewer also approves its exact delivery snapshot and supplies a public-safe commit message in the same session; there is no extra reviewer, route or model session for Git.

- The controller builds each task commit in a separate index from the last approved task commit (the run base for the first) and stages every non-ignored working-tree difference from it: paths changed since the run began plus paths that earlier task commits touched. Each commit therefore holds exactly that task's delta, including later edits to shared files, a later revert of an earlier task's change to its run-start content, and the deletion of a file an earlier task created (before 0.20.14 such reverts and deletions were left out of later commits). Ignored files and `.forja/` are never staged. The 500-path and portable-path limits and the privacy scan apply to the staged set. The clean-start rule means no unrelated edit can be included. A task whose working tree equals the last task commit records `no_changes` and creates no empty commit.
- The run base stays immutable. Only commits the controller recorded in `taskCommits` advance the expected HEAD; a manual commit, a branch switch or an occupied index blocks the run and is never adopted.
- A snapshot that cannot be delivered (privacy scan, pipeline contract, moved HEAD) blocks before its review is paid for. A rejected or stale delivery approval blocks the task after review. Earlier commits and working files are preserved either way; after inspection, `core retry --task ID --validate-only --why "..."` runs fresh checks and a fresh review of the current snapshot.
- Each task keeps its own receipt under `.forja/runs/<run-id>/delivery/`. The commit object is recorded before the branch moves; if installation is interrupted, `core resume` installs that same commit (or recognizes it as already installed) without another review and without a duplicate commit. Ambiguous HEAD or index state blocks for inspection.
- `mode: "commit"` leaves the reviewed commits local. `mode: "push"` performs no push between tasks: after all tasks and final checks pass, the controller checks that local history is exactly the recorded chain on the run base, scans every outgoing commit's changes and message (a secret removed by a later commit still exists in history), and pushes the chain tip once to the authorized branch. Each task review sees the earlier commits in its manifest, so the last reviewer approves the whole outgoing chain. Remote, ancestry and production rules are the same as below.

`core status` reports `delivery_granularity`, `task_commits`, any pending task delivery, and the delivery outcome of each task. The planner contract reports `commits_during_run: true`, so later tasks may rely on earlier approved work in HEAD.

## Push and deployment are separate permissions

For automatic GitHub delivery, choose a working branch whose pipeline effects have been verified by the project administrator. Store the contract in a regular project-relative file, for example `forja.delivery.json`:

```json
{
  "version": 1,
  "destination": {
    "url": "https://github.com/example/project.git",
    "branch": "work/feature",
    "baseBranch": "main"
  },
  "pipeline": {
    "effect": "preview",
    "description": "The hosting integration creates a preview for this branch. Production is deployed only after merging into main."
  },
  "pipelineFiles": [".github/workflows/checks.yml"]
}
```

The files in `pipelineFiles` must exist. Include project-specific deployment scripts/configuration, not only the common files FORJA recognizes. An empty list is allowed when there are no pipeline files; it does **not** imply there is no external hosting integration. The declared effects are `none`, `preview`, `production` or `unknown`. Branch names, effects and URLs in examples are illustrative; they are not a template authorization for a real repository. Credential-bearing URLs and Git URL rewrites are refused. SSH URLs must use URL form, such as `ssh://git@example.com/team/project.git`.

Then explicitly authorize that contract in the run configuration:

```json
{
  "delivery": { "mode": "push", "policyFile": "forja.delivery.json" }
}
```

The contract is captured at startup and automatically protected from worker edits. Changes to declared pipeline files or additions/removals/changes in common pipeline configuration invalidate automatic delivery. A reviewer cannot change the contract or turn code approval into production permission. A private ignored policy file is also supported; do not put credentials in it. There is no automatic discovery or certification of external hosting settings: an administrator must verify and maintain the contract when those settings change. An absent or unknown effect never means safe.

Before publication, the full candidate snapshot is scanned and the run base must exactly match `baseBranch` on the authorized remote. The destination branch must be absent or at that same base. Only one reviewed commit may be outgoing. This deliberately refuses a checkout with unpublished local ancestry, even if the latest diff looks harmless. Use a clean checkout from the authorized remote for such projects. FORJA pushes the exact commit to the exact branch, without force, tags, merge, rebase or changes to branch protection. It stops if the remote has advanced incompatibly.

For `production`, the default is a local commit with push blocked. Review that concrete commit and authorize it explicitly:

```powershell
node $forja core deliver --approve-production <reviewed-commit-sha>
```

The grant is bound to this run and exact commit; it does not change project defaults and costs no additional model session. A project administrator may instead set `"production": true` in the run's `delivery` config when production publication is already explicitly authorized. `unknown` requires correcting the contract and obtaining a fresh review, not pretending it is production approval. A commit-only run cannot be upgraded to publish by `--retry`.

For website projects, the recommended operating policy is a working branch, preview and CI checks, followed by a reviewed PR and an explicitly authorized production merge. This version automates commit/push only: it does not create or merge PRs, monitor hosted CI, certify preview health, deploy directly or roll back production. Do not claim a site is deployed merely because Git accepted the push.
