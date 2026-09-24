---
name: forja-release
description: Release and devops method for Forja's Devs — the pre-release checklist (tests, build, lint, changelog, version, tag, reproducible run instructions), what a release commit contains, and the hard line that publishing, deploying, pushing or anything external is a Sponsor-queue matter, never done by a Dev. Loaded by backend-dev and frontend-dev.
disable-model-invocation: true
---

# Forja release — ready to ship, never shipped by us

A "release" task means: the product is in a state the Sponsor could publish with one action. It never means publishing.

## Checklist (all, with evidence in the report)

1. Whole suite, lint, typecheck and production build green with the exact commands from `CLAUDE.md`.
2. Version bumped where the project keeps it (`package.json`, `app.json`, …) following its existing convention; a `CHANGELOG.md` entry (or the project's equivalent) written from the git log of the run, user-facing wording.
3. Reproducible run instructions verified from a clean state (fresh clone or `git stash`-free fresh checkout in a temp dir: install with the lockfile, build, run) — recorded step by step.
4. No secrets, tokens, local paths or debug flags in the built artefact or config; `.env.example` up to date if the project uses one.
5. A git tag proposal (name + message) in the report — the Sponsor tags; a Dev never tags, pushes, publishes, deploys, submits to a store or changes DNS. Any of those is a `BLOCKED` with the exact command the Sponsor would run, and the Lead queues it (`forja ask`) with the default "não publicar".
6. Rollback note: how to revert this release in one command.
