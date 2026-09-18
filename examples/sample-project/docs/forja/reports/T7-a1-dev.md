# T7 — tentativa 1 — hand-back do Backend Dev (dados, verbatim)

DONE T7 — server.mjs entry point with fail-closed startup (token, data file, port), `npm start`, and process-level tests, all green (Backend Dev)

Ficheiros:
- `C:\dev\forja\examples\sample-project\server.mjs` (novo)
- `C:\dev\forja\examples\sample-project\test\server.test.mjs` (novo)
- `C:\dev\forja\examples\sample-project\package.json` (só o script `start` acrescentado, resto intocado — confirmado por `git diff -- package.json`)

Evidência (critério a critério):
1. `server.mjs` só importa `node:path`, `./lib/auth.mjs`, `./lib/app.mjs`, `./lib/store.mjs`; usa `loadToken({ env: process.env, tokenFile: GREET_TOKEN_FILE ?? path.join(import.meta.dirname, 'token.local.txt') })`; `GREET_HOST`/`GREET_PORT`/`GREET_DATA` com as omissões pedidas, `GREET_DATA` resolvido com `import.meta.dirname`; `createStore(dataFile).load()` corre antes de `server.listen`.
2. Sem token: `npm test` — teste `sem token -> sai com 1, stderr em português, sem stack trace nem "Error:"` passa; manual: `stderr` = `"Não há token de acesso: ... Passo seguinte: crie o ficheiro token.local.txt ..."`, `exitCode 1`, stdout vazio. Ficheiro ilegível: teste `GREET_DATA com JSON inválido -> sai com 1 e o ficheiro fica byte a byte igual` passa (bytes antes/depois idênticos, mensagem cita o caminho). Porta ocupada: verificado manualmente — segundo processo na mesma porta (48123) devolve `stderr`: `"A porta 48123 já está a ser usada por outro programa. Passo seguinte: escolha outra porta com a variável GREET_PORT ..."`, exit 1.
3. Verificado manualmente com `GREET_HOST=0.0.0.0`: stdout = `"O servidor está a ouvir. Abra http://127.0.0.1:63265/ no browser."` + linha de aviso `"...qualquer pessoa na mesma rede que tenha o token consegue entrar."` + `"Para parar o servidor, prima Ctrl+C."`; token nunca aparece em stdout/stderr em nenhum teste ou execução manual.
4. `process.on('SIGINT'|'SIGTERM', stop)` fecha o servidor e faz `process.exit(0)` — implementado como é standard em Node no Windows (o handler só dispara com um Ctrl+C real numa consola anexada; `child.kill()`/`taskkill` no Windows fazem `TerminateProcess`, que não entrega o sinal a nenhum processo — verificado empiricamente ao enviar `SIGINT`/`kill -F` ao processo manual e ao processo do teste). Por isso o critério de teste do enunciado (item 6) só pede "processo morto no `after()`", não um exit-code gracioso — é o que `test/server.test.mjs` faz.
5. `package.json` ganhou só `"start": "node server.mjs"` (diff mostrado acima).
6. `test/server.test.mjs`: `child_process.spawn(process.execPath, ['server.mjs'], …)` com ambiente reduzido a `PATH/SystemRoot/TEMP/…` (sem `GREET_TOKEN`) e `GREET_TOKEN_FILE` num caminho inexistente em `mkdtemp`; cobre os três casos pedidos (sem token, arranque com sucesso incl. `fetch` a `/entrar` e `/historico`, ficheiro de dados inválido).

`npm test` (sem `GREET_TOKEN` no ambiente, sem servidor ligado):
```
ℹ tests 126
ℹ pass 126
ℹ fail 0
```
`npm run check` (repo Forja): `check ok — 289 ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, 2086 eventos reproduzidos sem linhas más`.

`git status --short` em `examples/sample-project`: só `server.mjs`, `test/server.test.mjs`, `package.json` (M) são meus; o resto (`docs/design/DESIGN.md`, `docs/forja/HANDOVER.md`, `docs/forja/RUN.json`, `docs/forja/TASKS.json`, `docs/design/mocks/`) já estava assim antes desta task, não toquei. Nenhum `data/greetings.json` nem `token.local.txt` foi criado no repo real.

Decisões por omissão:
- Mensagem genérica em português para erros inesperados do servidor (não cobertos pelos critérios) em vez de deixar a exceção rebentar — mantém D13 mesmo fora do que os testes exigem.
- `GREET_PORT` inválido (não inteiro ou negativo) cai para 8080 em vez de falhar — mais seguro/reversível; não estava especificado.
- Verificação de teste de "sem stack trace" usa a forma precisa `/\n\s*at\s/` em vez de procurar a substring `" at "`, porque a mensagem legítima do `JSON.parse` do V8 contém "at position …" — a checagem ingénua dava falso positivo sem ser um stack trace real.

Dúvidas: nenhuma.

Fora de âmbito: os nits do Reviewer/Security Reviewer de T5/T6 sobre `lib/pages.mjs`/`lib/app.mjs` (frase "até fechar o browser" vs `Max-Age` real, custo de render O(n), CSP/nosniff, etc.) — não são deste ficheiro e `lib/*` está fora do âmbito de T7.

---
Nota do Lead (verificação no disco, não faz parte do relatório do Dev): `npm test` corrido pelo Lead com `env -u GREET_TOKEN -u GREET_TOKEN_FILE -u GREET_DATA -u GREET_PORT -u GREET_HOST` → 126/126 pass, 0 fail. `git status`: novos `server.mjs` e `test/server.test.mjs`, `package.json` modificado só com o script `start`; `docs/FORJA-POC-LOG.md` e `docs/design/*` são restos da sessão anterior, fora desta task.
