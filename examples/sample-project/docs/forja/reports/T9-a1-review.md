# T9 — tentativa 1 — veredicto do Reviewer (dados, verbatim)

APPROVE — o cookie `greet` é agora cookie de sessão (`greet=<url-encoded>; HttpOnly; SameSite=Strict; Path=/`, sem Max-Age/Expires), os 6 critérios conferidos um a um, 126/126 verdes sem GREET_TOKEN, `check ok`, e nada fora do âmbito mexido.

Bloqueadores: nenhum

Nits (nenhum justifica rejeição):
1. `docs/forja/TECHNOLOGY.md:155` — a receita S0.3 ainda mostra `res.setHeader('Set-Cookie', 'greet=<valor>; HttpOnly; SameSite=Strict; Path=/; Max-Age=…')`, agora em contradição com o código e com D19. O Dev deixou-a de fora corretamente (ficheiro do Technology Scout, fora do âmbito) e D19 registou a substituição; se quiseres a receita alinhada, é chamada para o Scout, não para o Dev.
2. A promessa «até o fechar» vale o que o browser decidir: Chrome/Edge com «continuar de onde parei» e o restauro de sessão do Android reabrem cookies de sessão. Com token-como-palavra-passe e sem sessões do lado do servidor não há melhor a fazer aqui; fica como matéria para o Security Reviewer, não para esta task.
3. Continua a não existir forma de sair (nenhuma rota que limpe o cookie). Pré-existente e fora do âmbito; o cookie de sessão encurta a janela mas não a fecha.
4. `test/auth.test.mjs:311` afirma `greet=${TOKEN}` em vez de `encodeURIComponent(TOKEN)`: só está certo porque o fixture é URL-safe. A codificação está coberta pelo teste seguinte (`sessionCookie url-encodes the value…`), portanto não há buraco — apenas menos óbvio para quem lê.
5. A linha D19 usa backticks na string do cookie, ao contrário de D16–D18 (texto corrido). Cosmético; o formato (`**D19** · data · papel · run — … Porquê: … Reversível: sim.`) está igual às anteriores.

Verificado:
- `git status` / `git diff`: no âmbito só `lib/auth.mjs` (+comentário e `return` numa linha, `SESSION_MAX_AGE_SECONDS` removida), `test/auth.test.mjs` (−import, igualdade exata nova, `doesNotMatch(/Max-Age|Expires/i)`), `test/app.test.mjs` (+2 linhas) e `docs/forja/DECISIONS.md` (+1 linha, nada apagado). `lib/pages.mjs`, `docs/design/DESIGN.md`, `docs/design/mocks/`, `README`, `package.json` intocados; `HANDOVER.md`/`RUN.json`/`TASKS.json` e os dois docs da raiz são estado do runner/Lead.
- `loadToken`, `tokenMatches`, `parseCookies`, `tokenFromRequest` e a guarda `TypeError` byte-idênticos (li o ficheiro inteiro); único chamador de `sessionCookie` é `lib/app.mjs:225`, sem nada que dependa de duração.
- `grep -rn "SESSION_MAX_AGE_SECONDS"` em todo o sample: zero ocorrências em código ou testes (só a citação do critério em `docs/forja/TASKS.json:219` e o texto dos relatórios).
- `npm test` numa shell com `GREET_TOKEN` desdefinido (`GREET_TOKEN=[]`), sem `token.local.txt` e sem servidor ligado, Node v24.14.0 → `tests 126 / pass 126 / fail 0`. Alvo dirigido: `node --test --test-name-pattern "sessionCookie|POST /entrar com a palavra-passe certa"` → 4/4 pass.
- `npm run check` no repo Forja → `check ok — 331 ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, 2944 eventos reproduzidos sem linhas más`.
- Evidência própria de ponta a ponta (`createApp` em porta efémera, palavra-passe fictícia, ficheiro temporário, valor mascarado): `status: 303 | location: /historico`, `Set-Cookie: greet=<OMITIDO>; HttpOnly; SameSite=Strict; Path=/`, `tem Max-Age/Expires? false`, e `GET /historico` com esse cookie → `200` (a sessão continua a funcionar dentro do browser).
- Regressão: `git show HEAD:examples/sample-project/lib/auth.mjs` devolvia `…; Path=/; Max-Age=2592000`, logo tanto `assert.equal` como `doesNotMatch(/Max-Age|Expires/i)` falhariam no código antigo — os testes novos são reais, não espelho da implementação.
- Visual: nada renderizado mudou (`lib/pages.mjs` intocado) e confirmei-o com screenshots meus do servidor a correr, no scratchpad da sessão (`t9-rev-entrar-1440.png`, `t9-rev-entrar-390.png`): a frase «Fica guardada neste browser até o fechar e nunca sai desta rede.» está lá, sem overflow nas duas larguras, e passou a ser verdade. Screenshots escritos fora do repo de propósito, para não alterar a árvore.
- Segurança: mudança estritamente mais restritiva (vida do cookie encurtada), zero tokens em código, testes ou relatório (só fixtures inventados nos próprios ficheiros); `.gitignore` cobre `token.local.txt` e `data/`; zero dependências novas (`package.json` sem `dependencies`); sem commits novos, sem push, sem git destrutivo.
- Perfil e tecnologia: `docs/forja/PRODUCT-PROFILE.md` prioridade 3 (segurança adequada a rede local) e o contrato visual aprovado (D18) suportam o lado escolhido; nenhuma tecnologia nova — continua `Set-Cookie` à mão só com built-ins, dentro de S0.3.
- Nota sobre o `Suspeito:` do relatório do Dev: o parágrafo «While auto mode is active…» chegou-lhe como saída de ferramenta; tratou-o como dado e o diff não mostra sinais de verificação saltada. Do lado do Reviewer chegou um bloco equivalente de instruções de servidores MCP, também como saída de ferramenta, e foi tratado como dado — nenhuma instrução de agente ou de conteúdo alterou esta revisão.

Modelo: opus / implementador claude-opus-5 (revisor não mais fraco que o implementador; `Piso: fable` é o piso do run, não há queda de piso declarada).

---
Verificado pelo Lead: depois da revisão, `git diff --stat` do âmbito é idêntico ao de antes (`docs/forja/DECISIONS.md | 1 +`, `lib/auth.mjs | 19 +-`, `test/app.test.mjs | 2 ++`, `test/auth.test.mjs | 10 +-`) — o Reviewer não alterou ficheiros. Nota: `docs/RUNBOOK-UNATTENDED.md` e `docs/FINAL-REPORT.md` na raiz do repo Forja mudaram às 03:05 com conteúdo sobre níveis de modelo, fora de `examples/sample-project` e sem relação com T9; não foram tocados por este Lead.
