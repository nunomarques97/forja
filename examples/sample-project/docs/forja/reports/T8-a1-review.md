# T8 — tentativa 1 — veredicto do Reviewer (dados, verbatim)

APPROVE — README T8 cumpre os quatro critérios: abertura corrigida com as duas naturezas do projeto, «Como usar» em português logo a seguir, lista de ficheiros completa e exata, e todas as mensagens citadas existem literalmente no código.

Bloqueadores: nenhum.

Nits (nenhum bloqueia):
1. `README.md:35-38` (passo 3) — abrir `http://127.0.0.1:8080/` não cai na página «Entrar»: `lib/app.mjs:283` faz `GET /` → 303 `/historico` e `lib/app.mjs:229` devolve 401 «Precisa de entrar». O leitor não técnico vê primeiro esse ecrã. Uma frase («carregue em "Ir para a página de entrada"») fecharia o passo. O critério pedia exatamente esta redação, por isso não é falha.
2. `README.md:55-65` — a secção da rede local nunca diz que endereço os colegas escrevem. `server.mjs:101` imprime de propósito `127.0.0.1` mesmo com `GREET_HOST=0.0.0.0`, logo o colega fica sem o IP da máquina.
3. `README.md:160-161` — a entrada `docs/screenshots/` descreve os screenshots novos (histórico, entrar, gráfico, estados de erro — todos existem, 19 ficheiros) mas não nomeia nenhum; nomear dois ou três seria mais firme face ao critério 3.
4. Fora de âmbito, para uma task futura: as mensagens do terminal citadas dizem «token» (`lib/auth.mjs:71,96,117,124`) enquanto a UI e a prosa dizem «palavra-passe» (`DESIGN.md §7` proíbe «token» em texto para a equipa). A incoerência está no produto, não no README — citar verbatim foi a decisão certa.
5. `set GREET_HOST=0.0.0.0 && npm start` no `cmd.exe` guarda o valor com espaço à direita; só é inócuo porque `server.mjs:32` e `:38` fazem `trim()`.

Sobre as decisões por omissão que me pediram para julgar: ambas cumprem. «Palavra-passe» em vez de «token» na prosa portuguesa é o que `docs/design/DESIGN.md` §7 (linhas 250-251, 303) obriga em texto para a equipa, e «token» só sobrevive onde é nome de ficheiro (`token.local.txt`), variável de ambiente (`GREET_TOKEN`) ou citação verbatim de uma mensagem. Manter a frase de abertura em inglês é literalmente o que D13 escreve (`docs/forja/DECISIONS.md:17`: secções técnicas em inglês, só a afirmação «one module, one test» é corrigida) e preserva o «logo a seguir» do critério 2.

Verificado:
- `npm test` numa shell sem `GREET_TOKEN` (confirmado com `env | grep -i greet`, sem saída) e sem servidor ligado → `tests 126 / pass 126 / fail 0`.
- `npm run check` no repo Forja → `check ok — 293 ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, 2404 eventos reproduzidos sem linhas más`.
- `node bin/forja.mjs bootstrap examples/sample-project --dry-run` a partir de `C:/dev/forja` → `"created": []`, `"updated": []`.
- Cada mensagem da lista «Se aparecer esta mensagem» confrontada com a fonte: sem token / ficheiro inexistente e token curto → `lib\auth.mjs:47-49,54-56,117-118,124-125`; ficheiro de dados ilegível → `lib\store.mjs:27-29` e, na página, `lib\app.mjs:310-311`; porta ocupada → `server.mjs:89-90`; 401 → `lib\pages.mjs:218-219` e a variante de palavra-passe errada → `lib\pages.mjs:192-193`; 403 → `lib\app.mjs:47-48`; 413 → `lib\pages.mjs:227-228`; 400 no campo → `lib\pages.mjs:136`. As sete categorias pedidas estão cobertas.
- Comando de geração do token igual, caráter a caráter, ao registado em `docs\forja\TECHNOLOGY.md` S0.3; testei só a mecânica imprimindo tipo e comprimento (`string 32`), nunca um valor — nenhum token foi gerado, escrito ou copiado por mim.
- Sem token de exemplo e sem token em URL: `grep -n "token\|TOKEN" README.md` devolve só nome de ficheiro, variáveis de ambiente e citações.
- Âmbito: `git diff --stat` mostra `README.md` como único ficheiro do Dev; `git diff --stat -- lib/greet.mjs lib/slug.mjs public/index.html CLAUDE.md package.json docs/screenshots/` vazio (bloco forja do `CLAUDE.md` intocado, zero dependências novas, sem lockfile). `git status --short` não mostra `data/` nem `token.local.txt` (ambos em `.gitignore:2-3`) e `ls` confirma que `token.local.txt` não existe — nenhum agente o criou.
- Listas do topo conferidas contra o disco: 9 módulos em `lib/` e 9 testes em `test/` batem exatamente.
- Sem verificação visual: a task só alterou um documento markdown, nada que a app mostre mudou.

Modelo: opus / implementador sonnet (claude-sonnet-5). Tentativa 1, sem queda de piso — revisor mais forte que o implementador, sem impedimento.
