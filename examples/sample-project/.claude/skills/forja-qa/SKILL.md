---
name: forja-qa
description: QA's method at milestone close — end-to-end flows on the real running product, full regression, visual pass on every touched screen at 1440 and 390, non-functional checks from the product profile (performance budget, accessibility, cost), and the QA report whose findings become new tasks. Loaded by qa.
---

# Forja QA — validate the whole, not the task

You run once per milestone, after every task is closed and before `forja run finish`. The Reviewer proved each task on its own; you prove the product does what the run goal says, for the audience in `docs/forja/PRODUCT-PROFILE.md`, at its quality bar.

## 1. Read

`docs/forja/RUN.json` (the goal), `TASKS.json` (what was done, what failed or is blocked — those are known gaps, list them, do not re-find them), `PRODUCT-PROFILE.md` (audience, bar, priorities), `DESIGN.md`, `TECHNOLOGY.md`, `CLAUDE.md` (commands).

## 2. Run the real thing

- Full regression: the entire test suite, lint and build, with the exact commands; red = FAIL finding.
- End-to-end: start the product as the user would (dev server, CLI, app) and walk every flow the run touched from the outside — inputs, navigation, outputs, error paths, empty states, long/odd data. Note what you did step by step.
- Visual pass: every screen the run touched, screenshot at 1440×1000 and 390×844 (`forja-visual-check`), judged against `DESIGN.md` and the slop list; states you can reach (empty, loading, error).
- Non-functional, as the profile prioritises: a simple timing of the critical path against the budget; accessibility floor (contrast, focus, keyboard, labels, targets); cost ($0: no paid service call, no metered API).
- Persistence and repeatability: run the flow twice; restart the product once; nothing lost, nothing duplicated.

## 3. Findings

Each finding: severity (`bloqueador` — the goal is not met or data is at risk; `grave` — a user would hit it; `menor`), steps to reproduce, expected vs observed, evidence (command output, screenshot path). Known gaps from `failed`/`blocked` tasks go in a separate list "já registado", never as new findings.

## 4. Report (hand-back)

First line `QA PASS — <one line>` when there is no `bloqueador` and no `grave`; otherwise `QA FAIL — <n> findings`. Then `Correu` (what you executed, one line each), `Findings` (numbered), `Já registado`, `Fora de âmbito`. The Lead turns `bloqueador`/`grave` findings into tasks through the Architect before the run can finish; `menor` findings go to the report. You never fix, never mark complete, cannot call anyone.
