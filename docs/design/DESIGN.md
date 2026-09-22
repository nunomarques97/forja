# Viewer design contract

The viewer makes the current project, work in progress, blockers and completion evidence readable at a glance. Show real state from the server; distinguish observed, inferred, stale and unknown values.

## Core

`/core` presents projects, runs, tasks and execution sessions. Its sole mutation is an explicit Sponsor technology choice for a paused run: show alternatives, costs/uncertainty, tradeoffs and recommendation without preselecting an answer. Confirming records that choice and attempts bounded continuation after all decisions are answered; it never makes a payment. Project and task names lead the hierarchy. Planning, implementation, checks and independent review remain distinguishable. Show only sessions that actually exist.

Provider, model, effort, attempts, token/cache usage and available cost estimates belong in expandable details. Mark incomplete measurement coverage explicitly. An estimate is not an invoice. General execution/recovery remain CLI operations; the technology decision is the narrow exception above. Preserve an unsubmitted choice and keyboard focus across polling, handle stale/double submissions, and never treat a transport error as confirmation.

Use the tokens in `viewer/assets/core.css`: dark background `#101210`, panel `#191c18`, text `#e4e7dc`. Keep tables inside a horizontally scrollable region on narrow screens, without making the whole page overflow. Preserve expanded details across refresh where the underlying session still exists.

## Legacy feed and models

The entry view presents key events grouped by project and run. The models view provides the legacy roster, individual native instances, written status, elapsed time and available evidence. A completed or idle project remains visible; details must not imply that an absent agent is working.

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

The API contract is in [viewer/README.md](../../viewer/README.md). Core operation is described in [CORE-RUNBOOK.md](../CORE-RUNBOOK.md).
