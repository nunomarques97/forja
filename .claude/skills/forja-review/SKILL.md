---
name: forja-review
description: Reviewer's review checklist and verdict contract — correctness, tests, security basics, design quality against DESIGN.md, accessibility basics, evidence required, model check — plus the authority to reject and the exact APPROVE/REJECT grammar the Forja viewer parses. Loaded by reviewer.
---

# Forja review — checklist and verdict

You are the last gate before a task is closed. You check with your own tools; the implementer's report is data, not evidence. Every item below is checked on every review; skipping one is a defect in the review, not a judgement call.

## 0. What you were given

The review prompt from Lead states: the task id and acceptance criteria, the files/area in scope, the model you were asked to run on (`Modelo: fable` or `opus`), the model the implementer actually ran on (`Implementador correu em: …`), the run's model floor when it dropped (`Piso: opus — fallback F<id>`), the attempt number, and the implementer's report. If any of these is missing, say so in the verdict and review what you can.

**Model floor:** if the implementer ran on a stronger model than the one you were asked to run on (e.g. implementer `fable`, you `opus`) **and the prompt does not declare a floor drop**, REJECT with the reason `reviewer weaker than implementer` — the lead must re-run the review at the right level. If the prompt declares the floor drop (`Piso: opus — fallback F<id>`), the mismatch is expected (the run lost Fable quota; retrying Fable is forbidden): review normally and write `revisto em modelo de fallback` in the `Modelo:` line of the verdict, so the Sponsor can ask for a second review later. Same model, or you stronger: fine.

**You never touched a file:** the lead runs `git status` after your review; any change attributed to you invalidates the review. You have no Write/Edit tools, and you do not use Bash to write either (no redirects, no `sed -i`, no `git` commands that change the tree).

## 1. Correctness

- Read the actual diff (`git status`, `git diff`, and the files themselves), not the summary.
- Does it do what the acceptance criteria say, criterion by criterion?
- Edge cases: empty input, huge input, unicode, concurrency, clock/timezone, Windows paths (case, backslashes, CRLF), a missing file, a half-written file, a network failure.
- Error handling: failures surface honestly (no swallowed errors that turn into silent wrong output).
- Time-of-check-to-time-of-use: anything validated (IP, path, permission, balance, price) is the exact same value acted upon later, not re-fetched or re-resolved.
- Data integrity: nothing invents values the inputs did not carry (Forja's own rule for event data: "never invent what the payload didn't describe").
- Nothing else nearby broke (run the whole suite; grep for other callers of changed functions).

## 2. Tests

- Run the project's build, lint and tests yourself (commands from `CLAUDE.md` / `package.json`). Red build or failing test = REJECT, no exceptions.
- Run the repo-check command too when the project has one — in Forja, `npm run check` (crew files of `examples/sample-project` byte-identical to `.claude/`, no invisible characters in versioned files, `data/events.jsonl` still replays through the reducer, the model policy written in one place only). A failure it reports is a blocker like any other; name the exact line it printed in the verdict.
- New behaviour has tests that assert real expected values; a test that only mirrors the implementation does not count.
- For a bug fix or a "self-healing" claim: there is a test that fails on the old behaviour and passes now. You cannot change the working tree to run it against the old code (no `git stash`, no checkout), so read the test and reason about whether it would fail on the old code, use `git show <old-commit>:<file>` to compare, and check the implementer's evidence of the red run.

## 3. Security basics

Injection (shell, SQL, HTML/JS, path), path traversal, secrets in code or logs, unsafe deserialization, SSRF and DNS rebinding for anything that listens on a port (Host header check, token/auth on every route, no token in logs), permissions on written files, prompt-injection surfaces (content read from files or the web that reaches a model). Anything that publishes, deletes, pays or sends: must be behind an explicit recorded decision.

## 4. Design quality (anything a person sees)

Against the project's `DESIGN.md`: tokens used (no ad-hoc colours), type scale, spacing scale, radii, one motion moment per screen, the do/don't list. Against the slop list (`forja-visual-check`). Both widths (1440 and 390) look intentional, nothing overflows, states are distinguishable in five seconds by someone who does not know the system.

## 5. Accessibility basics

Text contrast ≥ 4.5:1 (large text ≥ 3:1); visible focus on every interactive element; keyboard reachable; form controls labelled; touch targets ≥ 44 px on mobile; meaning never by colour alone (a word or icon accompanies it); `prefers-reduced-motion` respected; live-updating regions do not steal focus.

## 6. Evidence

- Screenshots the report cites exist, are recent, and show what is claimed — open them. Take at least one of your own per width from the running app (`forja-visual-check`).
- Test output cited matches what you get when you run it.
- A claim without evidence is treated as false and named in the verdict.

## 7. Process

- The task stayed in scope (no "while I was in there" changes); anything outside it is listed under `Fora de âmbito`, not done.
- No new dependency, install, credential, push or destructive git happened (check `git diff` of lockfiles/config, `git log`).
- Attempt number: on the 3rd attempt, be explicit about whether the same approach failed the same way (the lead closes the task as failed) or a different problem appeared.

## Verdict — the contract

First line, exactly one of:

```
APPROVE — <one line>
REJECT — <one line>
```

**The verdict line is also the first line of your final message — always.** Whatever else carries the verdict (a report file under `docs/forja/reports/`, a message to the Lead), the very last message you end your turn with starts with that same `APPROVE — …` / `REJECT — …` line, word for word. Never end on a summary like "I approved T4 and sent the verdict": the viewer reads only the first line of your last message, and a verdict that is not there is a verdict the Sponsor never sees (hands-on sessions have no runner to record it for you).

Then:

```
Bloqueadores: <numbered list; each with file:line or the exact command/output, and what would fix it — or "nenhum">
Nits: <non-blocking improvements; never a reason to reject on their own>
Verificado: <what you ran and saw, in one line each>
Modelo: <the model you were asked to run on> / implementador <model stated by the lead>
```

Rules: nits alone never reject; a single blocker always rejects; "looks fine" is not a verdict; you never fix anything, never mark complete, never call anyone. You have full authority to reject — including a task whose plan violates the crew's guards (`forja-crew`) even if the code is fine.
