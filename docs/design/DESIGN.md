# Viewer design contract

The viewer makes the current project, work in progress, blockers and completion evidence readable at a glance. Show real state from the server; distinguish observed, inferred, stale and unknown values.

## Core

Use English for workspace controls, status, accessibility labels, errors and sign-in. Preserve project-authored text in its original language. Use English number/time formatting; the legacy compatibility views retain their original Portuguese UI.

`/`, `/core` and `/m` serve one responsive Core workspace. Lead with the project overview, attention needed, current goal and task progress. Search and status filters operate on the current run per registered project; do not imply a complete run history. Unreadable, blocked, failed and interrupted projects belong in attention. A persisted running status without a live process is interrupted, not evidence of active work. Completed projects remain visible. Tasks/checks/review and actual sessions are expandable details; the entry screen has no legacy tabs or fictional roster.

Its sole mutation is an explicit Sponsor technology choice for a paused run: show alternatives, costs/uncertainty, tradeoffs and recommendation without preselecting an answer. Confirming records that choice and attempts bounded continuation after all decisions are answered; it never makes a payment. Project and task names lead the hierarchy. Planning, implementation, checks and independent review remain distinguishable. Show only sessions that actually exist.

Provider, model, effort, attempts, token/cache usage and available cost estimates belong in expandable details. Mark incomplete measurement coverage explicitly. An estimate is not an invoice. General execution/recovery remain CLI operations; the technology decision is the narrow exception above. Preserve an unsubmitted choice and keyboard focus across polling, handle stale/double submissions, and never treat a transport error as confirmation.

Use the tokens in `viewer/assets/core.css`: dark background `#101210`, panel `#191c18`, text `#e4e7dc`. Keep tables inside a horizontally scrollable region on narrow screens, without making the whole page overflow. Preserve expanded details across refresh where the underlying session still exists.

## Legacy feed and models

Legacy views remain available at `/legacy` and `/legacy/m`, behind a secondary compatibility link. They are not tabs in the Core workspace. The legacy entry view presents key events grouped by project and run. Its models view provides the legacy roster, individual native instances, written status, elapsed time and available evidence. A completed or idle project remains visible; details must not imply that an absent agent is working.

Legacy roster identities and topology are compatibility UI, not a requirement that every Core run instantiate the full crew. Do not aggregate independent sessions into one fictional participant.

The existing palette lives in `viewer/assets/viewer.css`: background `#0E0C0B`, surface `#17130F`, line `#3A2F27`, ember `#FF7A2F` and patina `#63C9A9`. Use Barlow Condensed for display headings, Barlow for prose and IBM Plex Mono for compact technical details. Reuse the spacing scale of 4, 8, 12, 16, 24, 32 and 48 px.

## Interaction and accessibility

- Describe status with text as well as color; reserve alarm styling for actionable failures.
- Keep text contrast at least 4.5:1, visible keyboard focus and labeled controls. Aim for touch targets of at least 44 px.
- Refresh must preserve keyboard focus and reading position. Use polite live announcements for relevant state transitions, without announcing every metric update.
- Keep motion tied to current evidence and honor `prefers-reduced-motion`. Avoid decorative activity that suggests work is happening.
- Escape server-provided content. Keep authentication tokens and raw private events out of rendered pages.
- Show loading, empty, error, disconnected and stale states explicitly. An error must not leave an indefinite loading indicator.

## Verification

Viewer changes require desktop and narrow mobile inspection, keyboard navigation, loading/error/empty state checks and a check for page overflow. Store screenshots and real run evidence locally in ignored storage. Publish concise technical findings only; conversation history and raw screenshots do not belong in the release.

Provide viewport-height captures of the changed sections and relevant interaction states at each tested width. Keep a full-page image for composition when useful, but do not use its downscaled text as proof of legibility. Name each capture with width and section/state; recapture affected views after repairs. Restricted workers delegate capture to a controller-executable browser helper and receive the image paths for review. Missing readable evidence must be reported explicitly.

The existing `tools/shot.mjs` defaults to a viewport capture. For a local fixture, a section can be brought into view before capture; use a concrete selector for the changed section:

```sh
node tools/shot.mjs http://127.0.0.1:4173 data/visual/validation-390.png --width 390 --height 844 --eval "document.querySelector('.validation-evidence').scrollIntoView({block:'start',behavior:'instant'})"
```

The URL and selector must match the running fixture. This helper captures images; it does not replace interaction assertions or visual inspection. Use fictional data without authentication tokens in captures.

Curated documentation screenshots may be published under `docs/assets/` when explicitly requested, captured with fictional projects, and reviewed for private data, credentials and local paths. Label them as illustrative examples. Keep raw QA captures and browser profiles in ignored storage.

The API contract is in [viewer/README.md](../../viewer/README.md). Core operation is described in [CORE-RUNBOOK.md](../CORE-RUNBOOK.md).
