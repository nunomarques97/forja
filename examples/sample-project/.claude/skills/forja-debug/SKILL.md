---
name: forja-debug
description: Bug investigation method for Forja's Devs and Reviewer — reproduce first, isolate, diagnose with evidence, fix the cause not the symptom, verify with the original reproduction plus a regression test, report honestly. Loaded by backend-dev, frontend-dev and reviewer.
---

# Forja debug — reproduce → isolate → diagnose → fix → verify

1. **Reproduce** before touching code: the exact command/steps, the observed vs expected output, verbatim error text. If you cannot reproduce, say so in the report — never fix by guess.
2. **Isolate**: shrink the failing case (one input, one file, one function); binary-search recent changes (`git log`, `git diff` of the area); check the environment (Node version, OS paths, CRLF, timezone, locale).
3. **Diagnose** with evidence: a log line, a failing assertion, a traced value — write the one-sentence cause in the report. A fix without a stated cause is a symptom fix.
4. **Fix the cause**, minimally; no "while I was here" changes. If the cause is a product decision, report `BLOCKED` with the evidence and let the Lead route it to the Product Manager.
5. **Verify**: the original reproduction now passes, the whole suite is green, and a regression test that fails on the old code exists (show it failing if you can — `git stash` is not allowed in reviews, so keep the old behaviour's output in the report instead).
6. **Report**: cause, fix, evidence, what else could be affected.
