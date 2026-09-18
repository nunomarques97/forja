# T10 — tentativa 1 — veredicto do Reviewer (dados, verbatim)

Modelo: opus. Implementador correu em: sonnet. Piso do run: fable. Data: 2026-09-17.

---

APPROVE — T10 cumpre os 6 critérios: `lanAddresses` filtra/dedup/ordena, `server.mjs` imprime as linhas dos colegas na ordem certa sem a palavra «token», README explica, 134/134 testes verdes e `npm run check` ok; o truque do `arguments.length` cumpre a letra do critério 1 mas enfraquece um dos testes do critério 3 — nit, não bloqueador.

**Bloqueadores:** nenhum.

**Nits:**

1. `lib/lan.mjs:23` — a guarda `if (arguments.length > 0 && arguments[0] === undefined) return [];` **cumpre** o critério 1, não o trai: o critério é internamente contraditório em JS (um parâmetro por omissão é aplicado exatamente quando o argumento é `undefined`, logo `lanAddresses(undefined)` não pode ao mesmo tempo usar `os.networkInterfaces()` e devolver `[]`). Nesta máquina confirmei a contradição na prática: `lanAddresses()` -> `["192.168.1.189","172.23.96.1"]`, `lanAddresses(undefined)` -> `[]`. Sem a guarda, o teste pedido pelo critério 3 falharia aqui. O defeito de raiz está no critério, não no código — corrigir o critério (pedir `{}` -> `[]` e deixar `undefined` cair no default), não o código.
2. Mas o teste do critério 3 **deixou de provar o que devia**: `test/lan.test.mjs:59` (`lanAddresses(undefined)`) sai em `lib/lan.mjs:23` antes do ciclo de filtragem, portanto só prova que a guarda existe — é um teste que espelha a implementação. A robustez real a um `interfaces` nulo vive em `lib/lan.mjs:27` (`if (interfaces == null || typeof interfaces !== 'object')`) e nenhum teste lá chega. Um `lanAddresses(null)` cobriria essa linha a sério.
3. `test/lan.test.mjs:58` — o nome do teste, «undefined -> [] (usa os.networkInterfaces() por omissão, sem rebentar)», afirma o contrário do que esse caminho faz: é precisamente o caminho que **não** toca em `os.networkInterfaces()`.
4. Armadilha latente (impacto zero hoje): a assinatura documentada `lanAddresses(interfaces = os.networkInterfaces())` promete um fallback que a guarda anula, logo um futuro `lanAddresses(config.interfaces)` com valor indefinido devolve `[]` em vez das interfaces reais. Confirmei que só há um chamador em produção — `server.mjs:107`, sem argumentos — pelo que nada disto afeta a funcionalidade entregue. A degradação seria honesta (a frase do `ipconfig`), não output silenciosamente errado. O implementador declarou a decisão em `Decisões por omissão`, que é o processo correto; devia ter ido também a `Dúvidas`, que ficou «nenhuma».
5. A palavra «token» continua a chegar ao terminal por stderr, via a mensagem de `lib/auth.mjs` reenviada em `server.mjs:61` («Não há token de acesso… crie o ficheiro token.local.txt…»). Está explicitamente fora de âmbito por decisão do critério, mas o finding 2 do QA só fica meio fechado — assunto para o Lead encaminhar.
6. O novo teste de `server.test.mjs` compara a lista de endereços calculada no processo-pai com a do processo-filho; se uma interface aparecer entre os dois momentos (VPN a ligar) o teste falha. Probabilidade desprezável e foi o que o critério pediu; fica registado.

**Verificado:**
- `npm test` numa shell sem `GREET_TOKEN`/`GREET_HOST`/`GREET_PORT`/`GREET_DATA`/`GREET_TOKEN_FILE` -> `tests 134 / pass 134 / fail 0`, bate certo com o relatório; confirmei pelos nomes que os 7 testes de `lan.test.mjs` e o novo de `server.test.mjs` correram mesmo.
- `npm run check` na raiz do Forja -> `check ok — 334 ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, 3194 eventos reproduzidos sem linhas más`.
- Evidência do implementador reproduzida por mim ao vivo (`GREET_HOST=0.0.0.0 GREET_PORT=0`, token fictício, dados no scratchpad) — ordem e texto idênticos ao relatado, só o porto efémero difere: `O servidor está a ouvir. Abra http://127.0.0.1:62699/ no browser.` / `Para os colegas na mesma rede: http://192.168.1.189:62699/` / `Para os colegas na mesma rede: http://172.23.96.1:62699/` / `Aviso: … qualquer pessoa na mesma rede que tenha a palavra-passe consegue entrar.` / `Para parar o servidor, prima Ctrl+C.` Sem «token», sem o token impresso, e o porto anunciado é o real (`server.address().port`), não o pedido.
- Critério 2 «com qualquer outro host nada muda»: corri sem `GREET_HOST` e com `GREET_HOST=localhost` -> só as duas linhas de sempre, nenhuma linha nova.
- Frases verbatim: comparei por igualdade de string a linha de fallback e a linha de aviso construídas por `server.mjs` contra o texto do critério -> `true` nas duas (as concatenações não perdem nem duplicam espaços).
- `server.mjs`: nenhum literal impresso contém «token» (grep linha a linha; as ocorrências são identificadores e o nome do ficheiro `token.local.txt` usado como caminho por omissão).
- Âmbito: `git status` na raiz do Forja lista só `README.md`, `server.mjs`, `test/server.test.mjs` modificados mais `lib/lan.mjs` e `test/lan.test.mjs` novos; `lib/greet.mjs`, `lib/slug.mjs`, `lib/auth.mjs`, `public/index.html` e `package.json` intocados. `TASKS.json`/`RUN.json`/`HANDOVER.md` só mexem em `status`/`attempts`/`current_task`/timestamps/id de sessão — estado do CLI, como o Lead indicou.
- Dependências: `package.json` sem `dependencies`, sem lockfile e sem `node_modules`. `node:os` é built-in, coberto pelo veredicto S0 de `docs/forja/TECHNOLOGY.md` — sem Scout necessário.
- Produto/design: `docs/forja/PRODUCT-PROFILE.md` §Fasquia proíbe token em URL, log ou relatório — cumprido. `docs/design/DESIGN.md` §7 proíbe «token» em texto para a equipa e §4 fixa «palavra-passe» — o aviso passa a cumprir. O default `127.0.0.1` da prioridade 3 do perfil ficou intocado.
- Visual: nenhum ficheiro HTML/CSS mudou, logo não há ecrã novo para fotografar; nenhum screenshot é devido.
- Ficheiros novos sem BOM, sem CRLF e sem caracteres invisíveis.
- Não escrevi, editei nem corri comandos que mudassem a árvore: `git status --untracked-files=all` no fim é idêntico ao do início.

**Modelo:** opus (pedido) / implementador sonnet — revisor mais forte que o implementador, sem queda de piso declarada nem necessária. Tentativa 1.

**Ficheiros revistos:** `lib/lan.mjs`, `server.mjs`, `test/lan.test.mjs`, `test/server.test.mjs`, `README.md`, `docs/forja/reports/T10-a1-dev.md`.
