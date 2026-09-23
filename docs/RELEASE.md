# Versioning and publication

Persisted knowledge is not automatically public. Keep three distinct kinds of material:

Notification destinations are local configuration: set `FORJA_NTFY_TOPIC` or put `{"topic":"your-topic"}` in ignored `data/notify-config.json`. New clones do not send notifications until configured. An explicitly empty environment value disables notifications even when a local configuration exists.

| Material | Location | Git policy |
|---|---|---|
| Source, tests, configuration examples, concise architecture/conventions/ADRs | Normal source directories and curated docs | Review and version |
| Run state, prompts, conversations, questions/answers, handovers, raw metrics, screenshots and research transcripts | `.forja/`, `data/`, explicitly ignored local research files | Private; never stage or publish |
| A reusable lesson from a run | A short curated technical note | Rewrite without personal details or conversation history; review before staging |

Obsidian can open either a private knowledge collection or project Markdown. It does not determine publication. Do not synchronize a whole personal vault into a repository. Fewer maintained technical notes are preferable to accumulated run reports.

## Delivery responsibility

The agent preparing a release owns the proposed file list, staged-diff review and public/private classification. This is a delivery step, not a new mandatory model session for every task. Core workers continue to implement and review without making commits; the delivery agent works after the run, within the user's authorization.

For Core runs with explicit `delivery` configuration, the **existing final reviewer** owns the release decision in its code-review session. There is no separate Git agent: the controller prepares an explicit candidate index/manifest, enforces the privacy and history gates, and executes only the snapshot-bound approved operations. The controller uses the same built-in scanner as this release guard. Deployment effects and production permission remain separate from code approval. See [the delivery contract](CONTROLLER-DELIVERY.md) for exact configuration, prerequisites and recovery. Without this opt-in, delivery remains the caller's responsibility.

1. Inspect existing changes and preserve unrelated user work. Select explicit paths; never use `git add .` or `git add -A` for a release containing private evidence.
2. Review staged **contents**, including generated docs, screenshots and fixtures. Exclude personal information, user questions/answers, credentials, native transcripts and local home paths. Rename/move private evidence if needed; do not delete it to make a check pass.
3. Run the appropriate tests, `npm run check`, `npm run release:check` and `git diff --cached --check`. The scanner reads Git's index, not the worktree, and prints finding categories without secret values.
4. Commit only the approved staged files. Use SemVer in package.json, a curated CHANGELOG entry and a matching annotated `vX.Y.Z` tag. Patch versions fix behavior; minor versions add compatible capability; breaking changes require an explicit migration decision.
5. Before an authorized push, run `npm run release:check -- --tree`, inspect the exact outgoing commits and destination, and perform a history-aware secret/privacy audit. A clean current snapshot does not clean old commits. Never infer permission to push from permission to commit or tag.

The check is a local deterministic guard, **not a complete detector of personal information or a semantic privacy review**. It does not install a Git hook, automatically commit/push, scan all history or certify publication. Existing legacy repositories can already contain private run files in their history. `.gitignore` does not untrack those files. Resolve such findings before public publication, preserving local evidence and avoiding an unrequested history rewrite.

```sh
npm run release:check
npm run release:check -- --tree
```

The first command checks this proposed commit. The second checks the full tracked index snapshot and can legitimately fail on legacy state that was not added by this release.

Two synthetic regression assets have explicit, SHA-256-bound reviews in the scanner. They exercise legacy handover formatting and malformed native protocol input; they contain no captured user conversation. The output lists these separately under `reviewed`. Any byte change invalidates that review, and credential findings cannot use it. Review the scanner itself as part of delivery; its heuristics and fixture approvals are not a security boundary.

If unpublished local history contains private material, prepare the release in an isolated worktree rooted at the existing remote branch, with an explicit source/documentation list. Publish only that reviewed snapshot commit and its tag. Preserve the original local history and user edits; never push all local branches or tags. This excludes unpublished private ancestors without rewriting history already on the server. Continue publication from that worktree until the development history is deliberately reconciled.
