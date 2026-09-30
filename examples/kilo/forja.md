---
description: Hand a development goal to FORJA (plan, develop, checks, independent review)
---
The user wants FORJA to carry out this request in the current project:

$ARGUMENTS

Do not implement the request yourself. Prepare it for FORJA and launch it:

1. Read enough of the project to understand the request: relevant folders and files, build and test commands, conventions. Do not change any project file.
2. Write the goal to `%USERPROFILE%\forja-goal.md` (outside the project), in the user's language, at most 16,000 characters, with these sections:
   - Objective: what must be done, in one or two sentences.
   - Context: relevant files and folders and how the code works today.
   - Rules: what must not change, patterns to follow, anything out of scope.
   - Acceptance: observable criteria and the exact commands that must pass (build, tests, lint).
3. Show the user a short summary of the goal and ask for confirmation. Stop until the user confirms; apply requested corrections to the file first.
4. Run `git status --porcelain` in the project. If it lists any change, stop and tell the user to commit or stash first: FORJA starts only from a clean working tree.
5. Launch FORJA in a separate window so it keeps running after this conversation, by running exactly one of these, depending on your shell:
   - PowerShell: `Start-Process "$env:USERPROFILE\forja-kilo.cmd" -ArgumentList "<absolute project path>"`
   - cmd: `start "" "%USERPROFILE%\forja-kilo.cmd" "<absolute project path>"`
   Do not wait for it and do not run FORJA inside this conversation.
6. Tell the user FORJA is running in its own window. It never commits or pushes; when it finishes, the changes are left uncommitted for the user to review with `git diff`.
