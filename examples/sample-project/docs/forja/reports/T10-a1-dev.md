# T10 — tentativa 1 — hand-back do Backend Dev (dados, verbatim)

Modelo pedido: sonnet. Data: 2026-09-17.

---

DONE T10 — server.mjs (bloco `listening`) e novo `lib/lan.mjs` imprimem, com `GREET_HOST=0.0.0.0`, a linha `127.0.0.1` mais uma linha «Para os colegas na mesma rede: http://<ip>:<porta>/» por endereço (ou a frase de ipconfig se a lista vier vazia), aviso agora diz «palavra-passe» e nunca «token»; README e testes atualizados.

Ficheiros:
- `lib/lan.mjs` (novo) — `lanAddresses(interfaces = os.networkInterfaces())`
- `server.mjs` (só o bloco `server.once('listening', …)` e o novo `import`)
- `test/lan.test.mjs` (novo, 7 casos)
- `test/server.test.mjs` (um teste novo acrescentado ao fim, `import { lanAddresses }` acrescentado ao topo)
- `README.md` (só a secção «Abrir à equipa toda, na mesma rede local»)

Critérios um a um:
1. `lib/lan.mjs`: só `import os from 'node:os'`; filtra `family` `'IPv4'`/`4`, `internal === false`, sem duplicados, ordem de aparição; ignora IPv6, internos, entradas malformadas (`null`, `undefined`, tipos primitivos, arrays não-array). `{}` -> `[]`. `lanAddresses(undefined)` explícito -> `[]` de forma determinística (via `arguments.length`, ver nota em Decisões por omissão); `lanAddresses()` sem argumentos usa `os.networkInterfaces()` real, como server.mjs precisa.
2. `server.mjs`: linha `127.0.0.1` inalterada; com `0.0.0.0` imprime as linhas de colegas (ou a frase de fallback), depois o aviso com «palavra-passe» (não «token»), depois Ctrl+C — ordem verificada ao vivo (evidência abaixo). Com qualquer outro host nada mudou (só o `if (host === '0.0.0.0')` foi tocado).
3. `test/lan.test.mjs`: mistura IPv4 interno/externo repetido/IPv6 -> só o externo uma vez; família numérica `4`; ordem de aparição entre interfaces; entradas malformadas; `{}` -> `[]`; `undefined` -> `[]`; chamada sem argumento devolve sempre array de strings (não afirma vazio/não-vazio, para não depender da máquina).
4. `test/server.test.mjs`: novo teste arranca com `GREET_TOKEN` fictício, `GREET_TOKEN_FILE` inexistente, `GREET_PORT=0`, `GREET_DATA` em `mkdtemp`, `GREET_HOST=0.0.0.0`; afirma `http://127.0.0.1:<porta>/`, cada `http://<ip>:<porta>/` de `lanAddresses()` (ou a frase de fallback se vazio), `palavra-passe`, ausência de `/token/i`, ausência do token fictício; mata o processo e limpa a pasta no `after()` existente; não faz fetch pelo IP de rede.
5. `README.md`: só a secção pedida — explica a linha nova por endereço, que é esse (não o `127.0.0.1`) que se dá aos colegas, que pode mudar de rede, e o que fazer com a frase de fallback (`ipconfig` / «Endereço IPv4»). Sem token de exemplo nem em URL.
6. Evidência de âmbito e testes abaixo.

Evidência:
- `npm test` (shell sem `GREET_TOKEN`/`GREET_HOST`/etc.) -> `tests 134 / pass 134 / fail 0` (inclui os 7 novos de `lan.test.mjs` e o novo de `server.test.mjs`).
- `npm start` manual com `GREET_HOST=0.0.0.0 GREET_PORT=0` (token fictício, dados em pasta temporária) -> stdout real:

      O servidor está a ouvir. Abra http://127.0.0.1:57185/ no browser.
      Para os colegas na mesma rede: http://192.168.1.189:57185/
      Para os colegas na mesma rede: http://172.23.96.1:57185/
      Aviso: o servidor está a ouvir em toda a rede local — qualquer pessoa na mesma rede que tenha a palavra-passe consegue entrar.
      Para parar o servidor, prima Ctrl+C.

- `git diff --stat -- README.md server.mjs test/server.test.mjs` + `git status --short -- lib/lan.mjs test/lan.test.mjs` -> só esses cinco ficheiros mudaram/foram criados.
- `git diff --stat -- lib/greet.mjs lib/slug.mjs lib/auth.mjs public/index.html package.json` -> vazio (intocados; nenhuma dependência nova).
- `docs/forja/TASKS.json`, `HANDOVER.md`, `RUN.json` aparecem modificados no `git status`, mas são estado do Forja que eu não toquei (confirmado com `git diff docs/forja/TASKS.json`: só `status`/`attempts`/`updated_at`/`started_at`, escrito pelo Lead antes de eu começar).

Decisões por omissão: `lanAddresses` distingue "chamada sem argumento" (produção, dados reais) de "chamada explícita com `undefined`" (usado só nos testes, devolve `[]` sempre, para o teste não depender de esta máquina ter ou não endereço de rede) através de `arguments.length` — a única forma de cumprir ao mesmo tempo a assinatura pedida `lanAddresses(interfaces = os.networkInterfaces())` e o requisito «`undefined` -> `[]`» de forma determinística em qualquer máquina.

Dúvidas: nenhuma.

Fora de âmbito: não toquei no default `127.0.0.1` (D8/Q3, decisão de produto do Lead); não toquei em `lib/auth.mjs` nem nas suas mensagens; não corri screenshots (nenhum ecrã HTML mudou).
