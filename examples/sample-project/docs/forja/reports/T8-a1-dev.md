# T8 — tentativa 1 — hand-back do Backend Dev (dados, verbatim)

DONE T8 — README.md rewritten: opening line fixed and states both purposes, `## Como usar` (Portuguese, Windows-copyable steps) added right after it, and the top file list updated with all new modules/tests/screenshots; technical sections stayed in English.

Ficheiros: `C:\dev\forja\examples\sample-project\README.md` (only file changed).

Evidência:
- `npm test` (shell without `GREET_TOKEN`, no server running) → `tests 126 / pass 126 / fail 0`.
- `node bin/forja.mjs bootstrap examples/sample-project --dry-run` (run from `C:/dev/forja`) → `"created": [], "updated": []`.
- `git status --short` (in `examples/sample-project`) → only `README.md` shows as changed by me; no `data/` or `token.local.txt` listed.
- `git diff --stat -- lib/greet.mjs lib/slug.mjs public/index.html` → empty (untouched).
- `sed -n '1,20p' CLAUDE.md` → the `<!-- forja:begin -->`…`<!-- forja:end -->` block is byte-identical to before.
- Every error message quoted in "Se aparecer esta mensagem" was copied verbatim from `lib/auth.mjs` (`MissingToken` messages), `lib/store.mjs` (`UnreadableDataFile`), `server.mjs` (`EADDRINUSE` message), `lib/app.mjs` (`MSG.forbidden`, the constructed 500 browser text), and `lib/pages.mjs` (`ERROR_INFO[401]`, `ERROR_INFO[413]`, the `loginPage` and `historyPage` field-error strings).

Decisões por omissão:
- Kept the opening sentence in English (D13: existing/technical wording, only the outdated claim gets corrected) and put "Como usar" right after it, before the (English) file list — matches criterion order literally ("logo a seguir").
- Used "palavra-passe" instead of "token" throughout my own Portuguese prose (DESIGN.md §7 bans "token" in team-facing text); kept "token" only where it is a literal filename/env var (`token.local.txt`, `GREET_TOKEN`, `GREET_TOKEN_FILE`) or inside a verbatim quoted error message.
- Env-var examples use Command Prompt (`set VAR=value && npm start`) as the one concrete path, per the global rule of giving non-technical users a single path with no alternatives (skipped a PowerShell variant).
- Added `lib/app.mjs` to the file list even though the criterion's explicit list didn't name it, since it is the actual new HTTP-routing module and omitting it would be a real gap; this is additive, not a substitution for any required item.
- Quoted two MissingToken variants (file missing / file too short) under one "sem token/curto" bullet rather than all four internal variants, since the category in the criteria is singular and these two are the ones a Sponsor will actually hit from `npm start`.

Dúvidas: nenhuma.

Fora de âmbito (visto mas não tocado): `docs/FORJA-POC-LOG.md`, `docs/design/DESIGN.md`, `docs/forja/HANDOVER.md`, `docs/forja/RUN.json`, `docs/forja/TASKS.json`, `docs/design/mocks/` — pre-existing modifications/untracked files from other tasks, left untouched as instructed.
