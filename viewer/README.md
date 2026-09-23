# Viewer — API contract (server ↔ pages)

`viewer/server.mjs` serves the pages and streams **state**, never raw events. The responsive workspace is `viewer/core.html` at `/`, `/core` and `/m`. Compatibility pages are `viewer/index.html` at `/legacy` and `viewer/mobile.html` at `/legacy/m`. Assets live under `viewer/assets/`. Everything below is what a page may rely on.

## Auth

The Core workspace and sign-in page use English. Project goals, task titles and decision content retain their original language. The compatibility pages at `/legacy` and `/legacy/m` retain their Portuguese interface.

Every route except `/health` needs the token. A visitor without the cookie gets the **entry page** on `/` and `/m` (a form; `POST /login` sets the cookie) and 401 everywhere else; pasting `/?k=<token>` still works. Either way the server sets the `forja_k` HttpOnly cookie (`SameSite=Lax`, 30 days, `Secure` outside loopback) and redirects to the clean path. Pages never see or store the token; they just use `fetch`/`EventSource` with same-origin cookies. Nothing prints the token — not the startup banner, not `forja token` (its output is captured into `data/events.jsonl`); it is read from `data/viewer-token.txt` and rotated with `forja token rotate`.

## Routes

| Route | Returns |
|---|---|
| `GET /` · `GET /core` · `GET /m` | responsive Core workspace |
| `GET /legacy` · `GET /legacy/m` | previous event/roster pages, desktop and phone |
| `GET /assets/<file>` | static files from `viewer/assets/` |
| `GET /state` | the snapshot (below) |
| `GET /events` | SSE: `event: state` with the snapshot on connect and on every change (debounced 250 ms); `event: ping` every 15 s |
| `GET /feed` | the key-events feed (`viewer/lib/feed.mjs` → `feedSnapshot()`): `{ generatedAt, janelaHoras, agora: [ { projeto, estado: 'parou'\|'precisa'\|'pausa'\|'ativo'\|'terminou'\|'sem-run', ultimo, terminou, pendentes[] } ], itens: [ volta \| marco ] }`, newest first. Projects = `data/projects.json`; "next in the plan" reads each live project's `docs/forja/TASKS.json`. There is no raw-record route: the raw log is `data/events.jsonl` |
| `POST /answers` `{ project, id: "Q3", answer }` | stores the Sponsor's answer for the lead (`forja answers`) and emits `answer.pending`; `{ ok: true }` · 400 bad input · 404 no such open question in a known run · 413 body over 64 KB |
| `GET /health` | `{ ok: true }` (no auth; nothing else) |

## Snapshot (`viewer/lib/state.mjs` → `snapshot()`)

```
{ generatedAt, thresholds: THRESHOLDS (QUIET_MS, UNRESPONSIVE_MS, MAIN_UNRESPONSIVE_MS, DEAD_MS, HANDBACK_SETTLE_MS, PAIR_WINDOW_MS, PERMISSION_NOTIFY_MS, WATCHDOG_IGNORE_AFTER_MS — the single source, exported by viewer/lib/state.mjs),
  lines, badLines, current: <run id or null>,
  runs: [ {
    id, runId, sessions[], project, cwd, synthetic,
    startedAt, lastEventAt, endedAt, endReason, source, permissionMode,
    goal, goalSource ('forja' | 'prompt' | null),
    status, statusDetail, openQuestions,            // run-level state (see STATES)
    modelFloor, forja: { status, runId, modelFloor, forjalvl (+ modelLevel, alias), autonomy, checkpoints, lastCheckpointAt },
    roster: [ card × 10 ],                          // ALWAYS 10, fixed order: Lead, Architect, Frontend Dev, Backend Dev, Reviewer, Product Manager, Product Designer, Technology Scout, QA, Security Reviewer (core: true on the first five); each card also carries activeMs, sessions, models{}
    native: [ instance ],                           // Explore, claude-code-guide, … (never in the roster)
    tasks: [ { id, title, owner, status, attempts, criteria, after, createdAt, updatedAt, why, verdicts[], evidence } ],
    decisions: [ { ts, id, text, why, reversible, by, superseded } ],
    queue: [ { ts, id, question, default, why, status: 'open'|'pending'|'answered', answer, answeredAt } ],
    reviews: [ { ts, taskId, verdict: 'APPROVE'|'REJECT', text, by, final?, agentId? } ],
    fallbacks: [ { ts, role, from, to, why, signal? } ], modelSwitches: [],
    timeline: [ { ts, kind, text, agentId?, role?, status? } ],   // last 120, oldest first
    counts: { events, errors, denied, refused, instances, compactions },
    main: { lastEventAt, turnEndedAt, permission, stopFailure, quotaWait, effort, refused }
  } ] }

card     = { key, name, role, state, since, detail, quiet, instances: [ instance ] }   // Ferreiro's card has instances: [] (it is the session itself)
instance = { key, agentId, type, role, state, since, detail, quiet, inferred, task, taskId, startedAt, lastEventAt, endedAt, endReason,
             requestedModel, resolvedModel, background, calls, lastAction, progress: {ts,text}|null, handback: {ts,status,text}|null,
             verdict, permission: {since,tool,message}|null, denied, refused, error, reannounced }
```

`refused` = tool calls that never got a result before the actor's turn ended (a hard denial in headless mode leaves no other trace); `counts.refused` sums the run. `main.refused` is the lead's own count.

`STATES` (exact strings, Portuguese, shown as-is): `inativo`, `a trabalhar`, `à espera de review`, `bloqueado`, `precisa do Sponsor`, `sem resposta`, `morto`, `terminado`, `falhou`, `à espera de input`, `à espera de quota`. A card or instance in `a trabalhar` with `quiet` (ms of silence, > 90 s) shows the amber "silêncio há Xs" signal. `since` is the timestamp the state began (elapsed time = now − since; use `generatedAt` vs the browser clock to correct skew). `detail` is the plain-words "on what" (progress text, last action, verdict, reason).

Timeline `kind` values: `run.start`, `run.resume`, `checkpoint`, `run.finish`, `run.fail`, `run.block`, `task.add`, `task.start`, `task.review`, `task.done`, `task.fail`, `task.block`, `decision`, `ask`, `answer`, `fallback`, `notify`, `session`, `session.end`, `prompt`, `stop`, `stop.failure`, `compact`, `model.switch`, `permission`, `denied`, `quota`, `subagent.start`, `subagent.end`, `subagent.fail`, `handback`, `tool.error`, `tool.refused`, `bad-line`.

## Fixtures for building the UI

`node test/fixtures/build-fixtures.mjs` writes `test/fixtures/*.jsonl`; serve one with `EVENTS_FILE=test/fixtures/all-states.jsonl FORJA_DATA_DIR=<tmp> node viewer/server.mjs` to see every roster state at once (states are evaluated against the real clock, so the fixture's absolute times matter: `all-states.jsonl` is dated 2026-09-17 09:00Z — instances become `sem resposta`/`morto` as that date recedes; use `viewer/lib/state.mjs` `reduceLines(lines, now)` in a script, or regenerate fixtures with a base time near "now", for live-looking screenshots).


## Core

Open `/` (or `/core` or `/m`) for the Core workspace. It summarizes current runs, prioritizes projects needing attention, and supports search and status filters. Tasks, checks, review and session consumption are expandable. This is the current run per project, not a historical run browser. Legacy event/roster pages remain under the secondary compatibility link. `core init` and `start` register projects; native usage is shown with measurement coverage and optional USD estimates, never presented as a subscription invoice. Authentication and host checks are shared with the existing viewer. Paid or unknown-cost alternatives pause work until a choice is submitted; no radio option is preselected. Other recovery stays in `core resume` / `core retry`; the guard only resumes interrupted running jobs. Restart an already-running viewer/guard to load this implementation. See [Core runbook](../docs/CORE-RUNBOOK.md).

`GET /api/core` includes `legacy_only_projects`, a non-negative integer count of existing registered projects that have no Core state. It is aggregate discovery metadata only: names, paths and legacy state are not added. Malformed or unreadable Core state remains an error project in `projects` and is never included in this count. Clients talking to an older server may treat a missing field as zero.

Reads and decision submissions have a ten-second browser deadline, including response-body parsing. Manual refresh supersedes an older read; submitting a decision invalidates outstanding reads before writing. Obsolete completions cannot publish their snapshot. A timeout never confirms a choice. Network errors retain the last snapshot with a stale warning and permit retry. The client cleans up requests, timers and listeners on page exit and reconnects on browser history restoration. Polling preserves open details, keyboard focus and an unsubmitted choice for the same project/run/decision.

`POST /api/core/decision` accepts `{ project, run, decision, option }` for a registered project and current Core run. It shares authentication/Host checks, refuses cross-origin requests, limits the body to 4 KB and acquires the project lock before recording the choice. Repeating the same answer is idempotent; stale runs or changed answers return 409. After the final choice it tries to resume through the existing launcher, within persisted budgets. Response `{ ok, waiting, resumed }` distinguishes a recorded choice from a launched process. No purchase is performed. Pending choices and sanitized HTTP(S) evidence links are projected by `GET /api/core`; local evidence paths remain private.
