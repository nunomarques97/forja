# Legacy unattended runbook

Compatibility reference for `forja runner`. New runs should use [FORJA Core](CORE-RUNBOOK.md). Legacy run files and generated reports are private execution evidence; follow [release policy](RELEASE.md) before staging or publishing anything.

## Setup and execution

Requires Node 24, Git and an authenticated Claude Code CLI. From the FORJA checkout, run the tests before installing project integration:

```powershell
npm test
node bin/forja.mjs bootstrap 'C:\projects\example'
```

Review bootstrap changes and stage only the intended integration files. Never automatically stage a project's private run state or unrelated edits. From the project root:

```powershell
$forja = 'C:\tools\forja\bin\forja.mjs'
node $forja runner --goal 'Implement the agreed feature and verify its acceptance criteria'
```

The runner starts a fresh Lead session for planning, each task and closing. Product/task context remains on disk; it does not depend on a permanently open conversation. Actual model policy is defined by `lib/models.mjs` and [legacy architecture](ARCHITECTURE.md). `--forjalvl` chooses the existing policy level; `forjalvl show` displays the configured level.

## Autonomy and boundaries

Legacy autonomy remains governed by `lib/autonomy.mjs` and `RUN.json.autonomy`. `autonomy set total` enables the existing documented policy for routine product/design choices and free compatible dependencies. Financial commitments, accounts, external messages, destructive changes and publication still follow the authorization rules of that workflow. Core uses its separate shared execution contract; do not implicitly migrate a running legacy job.

```powershell
node $forja autonomy show
node $forja status
node $forja runner
```

Running `runner` without a new goal resumes the existing legacy run according to its saved state and limits. Inspect active processes and locks before recovering a interrupted run; never remove a lock merely because its timestamp is old. Preserve work from failed or interrupted attempts.

## Viewer and guard

`node bin/forja.mjs up` manages the legacy viewer lifecycle. `guard status` is a read-only eligibility check. Installing autostart or tunnel/notification behavior is a separate operational choice; review its network and startup effects before enabling it. Viewer authentication uses its local token file; do not put that token in commits, URLs, screenshots or public messages.

Viewer and guard recognize both legacy and Core runs. Core observation is at `/core`; Core recovery uses `core resume` or `core retry`, never the legacy run command. Restart existing services to load updated code. Viewer shutdown preserves active Core executors and their subprocesses.

Full legacy behavior, role triggers, limits and model policy remain in [ARCHITECTURE.md](ARCHITECTURE.md). Source and current CLI help are authoritative when operational defaults change.
