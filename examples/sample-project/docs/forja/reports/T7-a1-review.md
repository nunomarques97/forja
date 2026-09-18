# T7 — tentativa 1 — veredicto do Reviewer (dados, verbatim)

APPROVE — T7 cumpre os seis critérios; verifiquei cada um por execução própria (126/126 em `npm test` sem token no ambiente, `npm run check` ok) e a substituição da substring `'at '` pela regex cumpre a intenção do critério, provada por mutação.

**Bloqueadores: nenhum.**

## Resposta explícita à pergunta do Lead (regex vs. substring `'at '`)

**Cumpre o critério, não o trai.** Evidência, não opinião:

1. No caso "sem token" — o único onde o critério (6) pede a verificação — a substring literal **não existe** no stderr real. Corri `node server.mjs` sem token e testei os dois predicados sobre o stderr verdadeiro: `s.includes('at ')` → **false**, `s.includes(' at ')` → **false**. Ou seja, a leitura literal do critério passaria hoje exatamente como a regex: a troca não afrouxou nada no caso especificado.
2. A regex apanha um stack trace a sério. Mutação: forcei o erro sem o `try/catch` fail-closed (`node -e "import('./lib/auth.mjs').then(m => m.loadToken({env:{}, tokenFile:'C:/nao/existe/token.local.txt'}))"`). Resultado: `/\n\s*at\s/` → **true** (apanha), `includes('at ')` → true. O teste falharia como devia se o fail-closed desaparecesse.
3. Detalhe que reforça a decisão: nesse crash real o stderr **não contém `Error:`** (a classe chama-se `MissingToken`, logo o cabeçalho é `MissingToken: …`). A asserção `!stderr.includes('Error:')` sozinha **não** apanharia a regressão — quem faz o trabalho é precisamente a regex. Substituí-la por um `includes('at ')` ingénuo manteria a deteção, mas partiria o terceiro teste, onde o `JSON.parse` do V8 escreve "at position 2".

Ressalva factual: a justificação do implementador ("a mensagem do `JSON.parse` contém at position") é verdadeira mas aplica-se ao teste do ficheiro inválido, onde o critério (6) **não** pedia essa asserção — ele aplicou o mesmo helper aos dois testes. É imprecisão do relatório, não defeito do código. O comentário em `test/server.test.mjs:131-133` documenta a escolha no sítio certo.

## Nits (nenhum justifica rejeição)

1. `server.mjs:101` — hosts IPv6 dão um endereço impossível de colar e perdem o aviso de rede. Verificado: `GREET_HOST=::1` imprime `Abra http://::1:62251/`; `GREET_HOST=::` imprime `Abra http://:::62254/` **e sem a linha de aviso**, apesar de estar a ouvir em todas as interfaces IPv6. Os critérios e a D8 só nomeiam `0.0.0.0`, por isso não é bloqueador; o fix seria `[host]` entre parênteses retos e tratar `::` como equivalente a `0.0.0.0`.
2. `server.mjs:35-40` e `:94` — `GREET_PORT` inválido não é acionável para quem não é técnico: `abc`/`-1` caem em silêncio para 8080 (decisão por omissão declarada), e `70000` sai com a frase genérica `Não foi possível arrancar o servidor. Tente outra vez dentro de momentos.`, que não menciona `GREET_PORT` nem dá passo seguinte útil (D13 pede "o único passo seguinte").
3. `server.mjs:94` e `:128` usam a mesma frase genérica para duas origens diferentes (erro de `listen` vs. falha inesperada) — indistinguíveis em suporte.
4. Fora do âmbito de T7, mas dependência real para o Sponsor: a mensagem de arranque diz "como explica o README" e `README.md` ainda não tem nada — `grep -nE "token.local.txt|npm start|GREET_" README.md` não devolve **nada**. É exatamente o conteúdo de T8; T8 tem de aterrar antes de o Sponsor usar isto.
5. `lib/auth.mjs:52-57` (T5, fora de âmbito): com token curto vindo de `GREET_TOKEN`, o passo seguinte manda escrever no ficheiro `token.local.txt`, não corrigir a variável que a pessoa usou.

## Verificado

- `npm test` na raiz do sample, sem nenhum `GREET_*` no ambiente (`env | grep -i "^GREET"` → vazio) e sem servidor ligado: `tests 126 · pass 126 · fail 0`; os três testes de T7 aparecem verdes por nome (`sem token -> sai com 1…` 89 ms, `com token e GREET_PORT=0…` 114 ms, `GREET_DATA com JSON inválido…` 74 ms).
- `npm run check` no repo Forja: `check ok — 289 ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, 2158 eventos reproduzidos sem linhas más`.
- Critério 2, token curto (não coberto por teste), pelas duas vias: `GREET_TOKEN=abc123` → uma linha PT, `exit=1`, sem valor do token; ficheiro com `curto` → `O token de acesso no ficheiro do token é demasiado curto: precisa de pelo menos 16 caracteres. Passo seguinte: …`, `exit=1`.
- Critério 2, EADDRINUSE (não coberto por teste): com a porta 48731 ocupada → stdout vazio, `exit=1`, stderr `A porta 48731 já está a ser usada por outro programa. Passo seguinte: escolha outra porta com a variável GREET_PORT e arranque o servidor outra vez.`
- Critério 2, ficheiro de dados: `GREET_DATA` a apontar para uma pasta → `… (EISDIR) … O ficheiro ficou intacto e nada foi gravado. Passo seguinte: …`, `exit=1`, sem stack.
- Critério 3, `GREET_HOST=0.0.0.0` (não coberto por teste): as três linhas saem como pedido, com `http://127.0.0.1:50326/`, o aviso de rede local e `Ctrl+C`; o token nunca aparece.
- Critério 4 (não coberto por teste, e o Windows não entrega sinais via `child.kill()`): harness que importa `server.mjs` em processo e emite o sinal → `listeners SIGINT=1 SIGTERM=1`, ambos `exit=0`; repeti com uma ligação `keep-alive` aberta no momento do SIGINT → `exit=0` (o `closeAllConnections()` de `server.mjs:118` é o que evita o pendurar).
- Critério 1, independência do `cwd`: corri `node <raiz>/server.mjs` a partir de uma pasta temporária com um `data/greetings.json` propositadamente inválido → o servidor arrancou na mesma, logo o default resolve por `import.meta.dirname` e não por `process.cwd()`. O caminho validado é a mesma string passada a `createApp` (`server.mjs:66`, `:84`) — sem TOCTOU.
- Critério 5: `git diff -- package.json` mostra só a linha nova do script `start`; `npm start` arranca e imprime o banner. Sem `node_modules/`, sem `package-lock.json`, nenhuma dependência nova; `server.mjs` importa apenas `node:path`, `./lib/auth.mjs`, `./lib/app.mjs`, `./lib/store.mjs`.
- Critério 6: os três casos usam `GREET_TOKEN_FILE` num caminho inexistente dentro de `mkdtemp`, o ambiente é uma allowlist (`test/server.test.mjs:22-39`, sem `GREET_TOKEN`), `after()` mata todos os filhos e apaga a pasta.
- Decisões: D7 (fail-closed, mínimo 16, env ou ficheiro), D8 (127.0.0.1:8080 por omissão, aviso em 0.0.0.0), D9 (ficheiro ilegível recusa arrancar e fica intacto — bytes iguais no teste), D13 (PT, passo seguinte, zero stack traces em todos os caminhos que exercitei, incluindo os não especificados), D15/D16 (só built-ins; `npm test` verde sem token), D17 (porta efémera, token fictício, `mkdtemp`). Nenhuma tecnologia fora de `docs/forja/TECHNOLOGY.md`. Perfil de produto: os quatro "Inaceitável" aplicáveis estão cobertos.
- Visual: nada visível mudou em T7 (`lib/pages.mjs` intocado), mas fotografei a página servida pelo próprio `server.mjs` para confirmar a ligação real: `<scratchpad>\T7-entrar-1440.png` (1440) e `<scratchpad>\T7-entrar-390.png` (390) — fundo escuro do `DESIGN.md`, uma coluna, label + campo + botão, nada transborda, `pageErrors: []`, e a palavra-passe não aparece em lado nenhum. `/historico` com token → 200 através do entry point real.
- Processo: `git status` no fim é byte a byte igual ao do início — só `server.mjs`, `test/server.test.mjs` (novos) e `package.json` (M) são desta task; não escrevi, editei nem commitei nada (os meus ficheiros de apoio ficaram todos no scratchpad e matei o servidor que tinha deixado a correr, PID 8072). Nenhum `data/greetings.json` nem `token.local.txt` foi criado no repo; `.gitignore` do sample já cobre `data/` e `token.local.txt`. Tentativa 1, sem histórico de rejeições.

Modelo: opus / implementador claude-sonnet-5 (revisor mais forte que o implementador — sem problema de piso).
