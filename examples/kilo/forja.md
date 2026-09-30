---
description: Hand a development goal to FORJA (plan, develop, checks, independent review)
---
The user wants FORJA to carry out this request in the current project:

$ARGUMENTS

Do not implement the request yourself. Prepare it for FORJA and launch it. Below, `<project>` is the absolute path of the project's Git root without a trailing backslash, and `<name>` is its last folder name.

1. Read enough of the project to understand the request: relevant folders and files, build and test commands, conventions. Do not change any project file.
2. Write the goal to `%USERPROFILE%\forja-goals\<name>.md` (create the folder if needed; it is outside the project), in the user's language, at most 16,000 characters, with these sections:
   - Objective: what must be done, in one or two sentences.
   - Context: relevant files and folders and how the code works today.
   - Rules: what must not change, patterns to follow, anything out of scope.
   - Acceptance: observable criteria and the exact commands that must pass (build, tests, lint).
3. Show the user a short summary of the goal and ask for confirmation. Stop until the user confirms; apply requested corrections to the file first.
4. Run `git status --porcelain` in the project. If it lists any change other than `.forja/`, stop and tell the user to commit or stash first: FORJA starts only from a clean working tree.
5. Launch FORJA in its own visible window with exactly this PowerShell command, once:
   `Start-Process powershell.exe -ArgumentList '-NoExit', '-Command', '& "$env:USERPROFILE\forja-kilo.cmd" "<project>"'`
   It returns within seconds. Do not wait for FORJA, do not run it inside this conversation and never launch it a second time for the same goal: FORJA refuses a second run in the same project while one is alive.
6. Confirm the start: wait about 20 seconds (for example `Start-Sleep 20`), then run the status command below. If it does not report a running run for this goal, tell the user FORJA did not start, show the status output and give them the command from step 5 to run in their own VS Code terminal. Do not launch again yourself.
7. Tell the user FORJA is running in the window titled `FORJA <name>`. The title changes to `DONE` or `STOPPED` with a short sound when it ends. FORJA never commits or pushes; changes stay uncommitted for review with `git diff`. You are not notified when it ends; the user can ask you for its status.

Related requests in the same project:
- Status ("how is FORJA doing?"): run `node "$env:USERPROFILE\Desktop\Repositorios\forja\bin\forja.mjs" core status` in `<project>` and summarize it. This is read-only.
- Resume after a stop or crash ("resume FORJA"): launch `Start-Process powershell.exe -ArgumentList '-NoExit', '-Command', '& "$env:USERPROFILE\forja-kilo.cmd" "<project>" resume'` once. The run keeps its frozen goal and configuration and continues from its saved state.
