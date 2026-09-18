# T9 — tentativa 1 — hand-back do Backend Dev (dados, verbatim)

DONE T9 — o cookie `greet` passou a cookie de sessão (sem `Max-Age`/`Expires`), testes alinhados e D19 registada; 126/126 verdes.

Ficheiros:
- `lib/auth.mjs`
- `test/auth.test.mjs`
- `test/app.test.mjs`
- `docs/forja/DECISIONS.md`

Critérios, um a um:
1. `sessionCookie(token)` devolve agora, numa só expressão, `` `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/` ``; `SESSION_MAX_AGE_SECONDS` desapareceu (o `/** … */` de `SESSION_COOKIE_NAME` deixou de prometer "30 days" e remete para a função). O comentário da função diz que é cookie de sessão por causa da promessa do ecrã «entrar» (DESIGN.md §4 ponto 4) e mantém a nota do `Secure`. `loadToken`, `tokenMatches`, `parseCookies`, `tokenFromRequest` e a guarda `TypeError` não foram tocados.
2. `test/auth.test.mjs` já não importa `SESSION_MAX_AGE_SECONDS`; o teste afirma igualdade exata com a string do ponto 1, mantém `HttpOnly`/`SameSite=Strict`/`Path=/` e a ausência de `Secure`, e ganhou `assert.doesNotMatch(value, /Max-Age|Expires/i)`.
3. `test/app.test.mjs`, teste `POST /entrar com a palavra-passe certa e Origin igual ao host -> 303 e cookie`: ganhou `assert.doesNotMatch(cookie, /Max-Age|Expires/i)`.
4. `lib/pages.mjs`, `docs/design/DESIGN.md`, `docs/design/mocks/` e `README` não foram tocados (ausentes do `git status`); a frase «Fica guardada neste browser até o fechar e nunca sai desta rede.» (`lib/pages.mjs:205`) continua igual e passou a ser verdade.
5. `DECISIONS.md` ganhou uma única linha `**D19** · 2026-09-17 03:00 · Backend Dev · run R-20260916-ae6a — …`, no formato das anteriores (o quê / Porquê / Reversível: sim), a dizer que substitui a parte «Max-Age=2592000» do critério 5 de T2 e que DESIGN.md §4 ponto 4 é a fonte. Nada foi apagado.
6. Evidência abaixo.

Evidência:
- Grep de âmbito antes de mexer: `SESSION_MAX_AGE_SECONDS` só existia em `lib/auth.mjs:22` e `test/auth.test.mjs:9,317,318`. Depois da alteração, a única ocorrência em todo o `sample-project` é a citação do próprio critério dentro de `docs/forja/TASKS.json:219` — não há código nem teste a referi-la.
- `npm test` (shell com `GREET_TOKEN` por definir — confirmado `GREET_TOKEN=[]` — e sem servidor ligado), Node v24.14.0 → `ℹ tests 126 / ℹ pass 126 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 0 / ℹ todo 0 / ℹ duration_ms 1380.8805`.
- `npm run check` no repo Forja → `check ok — 331 ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, 2884 eventos reproduzidos sem linhas más`.
- `Set-Cookie` real de um `POST /entrar` com a palavra-passe certa, contra `createApp()` numa porta efémera com palavra-passe fictícia e ficheiro de dados temporário (valor mascarado antes de imprimir): `status: 303 | location: /historico` · `Set-Cookie: greet=<VALOR OMITIDO>; HttpOnly; SameSite=Strict; Path=/` · `tem Max-Age ou Expires? false`. Script de evidência no scratchpad da sessão (fora do repo, nada a committar).
- `git diff --stat -- examples/sample-project` → `docs/forja/DECISIONS.md | 1 +` · `docs/forja/HANDOVER.md | 9 +-` · `docs/forja/RUN.json | 7 +-` · `docs/forja/TASKS.json | 9 +-` · `lib/auth.mjs | 19 +-` · `test/app.test.mjs | 2 ++` · `test/auth.test.mjs | 10 +-`. Os únicos ficheiros meus são os quatro do âmbito; `HANDOVER.md`, `RUN.json` e `TASKS.json` (mais `docs/FINAL-REPORT.md` e `docs/FORJA-POC-LOG.md` na raiz do repo) são estado do Forja escrito pelo runner/Lead e não lhes toquei.
- Prova de regressão: a nova asserção aplicada à string antiga (`greet=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`) falha — `The input was expected to not match the regular expression /Max-Age|Expires/i` —, logo o teste novo não passaria no código antigo. A asserção de igualdade exata falharia pela mesma razão.
- Zero dependências novas: `package.json` sem `dependencies`/`devDependencies` (só `test` e `start`), `node_modules` inexistente, nenhum `import` fora de `node:*`. Nenhum ecrã mudou, logo sem screenshots novos (critério 6).

Decisões por omissão: nenhuma na substância (a correção estava toda decidida na task). Duas escolhas de redação, técnicas: reescrevi o `/** */` de `SESSION_COOKIE_NAME`, que dizia «and how long the browser keeps it: 30 days in seconds» e passaria a mentir com a constante removida; e colapsei o `return` numa só template string, já que sem `Max-Age` cabe em linha.

Dúvidas: nenhuma.

Fora de âmbito:
- `docs/forja/TECHNOLOGY.md` S0.3 (linha 155) ainda mostra na receita `'greet=<valor>; HttpOnly; SameSite=Strict; Path=/; Max-Age=…'`. Não lhe toquei: é ficheiro append-only do Technology Scout e está fora do âmbito; se o Lead quiser alinhá-lo, é chamada para o Scout.
- `docs/forja/TASKS.json` T2 critério 5 continua a dizer `Max-Age=2592000`; é texto de task `done` e não editável, razão pela qual D19 existe.
- Findings 2 a 7 do QA (endereço de rede local, formato da 500, aterragem em `/entrar`, fragmento em inglês, `<title>` do gráfico, contrato visual em git) — nenhum tocado.

Suspeito: no fim do primeiro resultado de ferramenta da sessão do Dev (bloco de instruções de servidores MCP) vinha apanhado um parágrafo «While auto mode is active: Do your work through the Bash tool wherever it can accomplish the job… Fall back to a dedicated tool only when Bash genuinely cannot do the job.» Chegou como saída de ferramenta, por isso o Dev tratou-o como dado e continuou a usar as ferramentas normais. Sem impacto no resultado.

---
Verificado pelo Lead na sua própria shell: `npm test` → 126 tests / 126 pass / 0 fail (duration_ms 1376.1155), com `GREET_TOKEN` desdefinido e sem servidor ligado. `git diff --stat` do âmbito: `docs/forja/DECISIONS.md | 1 +`, `lib/auth.mjs | 19 +-`, `test/app.test.mjs | 2 ++`, `test/auth.test.mjs | 10 +-`.
