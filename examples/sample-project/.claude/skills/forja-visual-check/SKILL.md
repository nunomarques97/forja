---
name: forja-visual-check
description: How Forja verifies anything a person will see, for real, while it is being built — run the app, take actual screenshots at 1440 and 390 wide (mobile: emulator), critique them against DESIGN.md and the slop list, fix, re-shoot, and put the final paths in the report. Used by Frontend Dev and Backend Dev when they build, and by Reviewer when it judges. Exists because a project was once built end to end without looking at it and came out "horrenda".
disable-model-invocation: true
---

# Forja visual check

"Tests pass" proves the code runs. It proves nothing about what a person will see. Every change to something visible is verified by rendering it and looking at it, **during** the build (after each meaningful change), not after.

## Web pages (including static mocks and the Forja viewer)

1. Serve the page (dev server or a static server) in the background so you can keep working.
2. Screenshot it with the Forja helper, which drives the local Chrome headless over CDP, waits for the page to settle, and writes a PNG:
   ```
   node "<forja>/tools/shot.mjs" <url> <out.png> --width 1440 --height 1000
   node "<forja>/tools/shot.mjs" <url> <out.png> --width 390 --height 844 --mobile
   ```
   Options: `--wait <ms>` (settle time), `--full` (full page), `--eval "<js>"` (run before shooting, e.g. to open a tab or set a state), `--no-reduced-motion` (Chrome headless reports `prefers-reduced-motion: reduce` by default; use this when the thing under test is motion).
   If the helper is missing (older bootstrap), fall back to the raw command:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --disable-gpu --hide-scrollbars --window-size=1440,1000 --screenshot=<out.png> <url>
   ```
3. Save screenshots where the project keeps them (`docs/screenshots/` unless `CLAUDE.md` says otherwise), named `<task>-<what>-<width>.png`.
4. **Look at the PNG** (Read it) and critique it against the project's `DESIGN.md` (tokens, type scale, spacing, radii, motion rules, do/don't) and this slop list: purple-to-blue gradient heroes, glassmorphism, emoji as icons, cards inside cards, generic sans + cream + terracotta, text overflowing its container, unreadable contrast, states you cannot tell apart, anything that only works at one width. Also check the states that matter for the task: empty, loading, error, long text, many items.
5. Fix what you found, re-shoot, repeat until there is nothing left to fix at both widths.
6. Put the final paths in the report under `Evidência`, one per width. A report without them is not done.

## Mobile apps (Expo, Android)

Run the emulator, take a real screenshot (`mobile-mcp` when registered, else the platform's screenshot command), same critique loop, same evidence rule.

## CLI output, generated files, documents

Run the command / open the generated file and paste the relevant excerpt (not the whole thing) in the report as evidence.

## For Reviewer

Do not trust the implementer's screenshots alone: open them, and take at least one of your own at each width from the running app to confirm they match the code as committed. A visual claim without a screenshot is treated as false.
