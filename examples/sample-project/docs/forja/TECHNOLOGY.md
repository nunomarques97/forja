# Tecnologia — decisões vinculativas (sample-project)

Escrito pelo Technology Scout. Registo **append-only**: uma secção por capacidade, com data. Os Devs
usam o que está aqui e mais nada; o Reviewer verifica contra este ficheiro. Quem precisar de algo que
não esteja aqui para `BLOCKED T<id> — precisa de decisão de tecnologia: <capacidade>` e o Lead acorda
o Scout.

Esta chamada é **S0** — inventário da stack contra o objetivo do run `R-20260916-ae6a`. Cada capacidade
tem a sua secção `S0.n`; chamadas futuras neste projeto usam `S1`, `S2`, …

## Veredicto do run: stack suficiente para este run

Nenhuma capacidade do objetivo exige uma dependência nova. Tudo é coberto por built-ins do Node 24
(verificado em `node v24.14.0`, Windows 11) mais HTML/CSS/SVG escritos à mão. **Dependência nova: não**
— logo nada vai à fila do Sponsor por causa de tecnologia.

Isto **confirma a conclusão de D15** (só built-ins) e **contraria a sua última frase** ("não é preciso
criar `TECHNOLOGY.md`"). O ficheiro é preciso por duas razões: (a) sem decisão escrita, a regra do Forja
obriga um Dev a `BLOCKED` no primeiro `import`; (b) dentro dos built-ins há escolhas reais que têm de
ser feitas uma vez e não por cada Dev — JSON vs `node:sqlite`, agrupar dias em UTC vs no fuso local,
`fetch` vs `http.request` nos testes, e a receita exata de escrita atómica em Windows. Três dessas
escolhas, feitas à pressa, produzem bugs silenciosos; estão fechadas abaixo.

Contexto comum a todas as secções: perfil de produto prioriza, por esta ordem, robustez/durabilidade,
simplicidade para não técnicos, segurança de rede local, custo zero, acessibilidade, rapidez. `CLAUDE.md`
exige módulos em `lib/` sem dependências e testes só `node --test`. `DESIGN.md` proíbe JavaScript no
browser, CDNs e webfonts — o que elimina à partida qualquer biblioteca de cliente.

---

## Servidor HTTP — `node:http` (S0.1, 2026-09-16)

Contexto: D6 pede um servidor que crie e liste saudações; D8 fixa `127.0.0.1:8080` por omissão. O perfil
pede simplicidade e zero dependências; cinco pessoas e alguns milhares de registos é carga desprezável.

Opções comparadas:
- **`node:http` (built-in)** — fit: perfeito, zero instalação, ESM nativo; maturidade: API estável há mais
  de uma década; licença: MIT (Node); adoção: é a base de toda a gente; tamanho: 0; segurança: recebe os
  patches do runtime, sem cadeia de fornecimento; resultado: roteamento e cabeçalhos manuais, ~40 linhas
  para 4 rotas.
- **Express 5** — fit: exigiria `npm install` e partir "zero dependências" do `CLAUDE.md`; maturidade: alta;
  licença: MIT; tamanho: dezenas de pacotes transitivos; resultado: não entrega nada que 4 rotas precisem.
- **Fastify / Hono** — mesmo problema, mais superfície, ganho nulo nesta escala.
- **sem biblioteca (`node:net` à mão)** — teria de implementar HTTP/1.1; absurdo tendo `node:http`.

Decisão: **`node:http`**. O objetivo pede "servidor HTTP mínimo em Node, sem dependências" e o built-in é
exatamente isso; uma framework só acrescentaria uma instalação proibida e código que ninguém lê. Com 4 rotas
o roteamento cabe num `switch` sobre `req.method` e `new URL(req.url, 'http://' + host).pathname`.

Como adotar:
- `import http from 'node:http'` → `http.createServer(handler)`; `server.listen(port, host, cb)`.
- Corpo do pedido: iterar `for await (const chunk of req)` acumulando bytes e **abortar aos 4 KB** (D9) com
  `413` e frase em português; formulários com `new URLSearchParams(corpo)` (built-in, já descodifica `+` e
  percent-encoding — verificado: `nome=Ana+Sofia` → `Ana Sofia`).
- Defesas já ligadas por omissão e a manter: `server.headersTimeout` 60 s, `server.requestTimeout` 300 s,
  `http.maxHeaderSize` 16 KB.
- Respostas: `res.writeHead(status, { 'Content-Type': '…; charset=utf-8' })`. Sempre `charset=utf-8` — sem
  ele os acentos das saudações aparecem partidos no browser.
- NÃO usar: `node:http2`, `https` (sem certificados, fora de âmbito), `res.socket` directamente.

Limites: revisitar se aparecerem uploads, sessões por utilizador, WebSockets ou mais de ~20 rotas.

Dependência nova: **não**.

---

## Persistência num ficheiro JSON, durável — `node:fs/promises` com escrita atómica (S0.2, 2026-09-16)

Contexto: prioridade nº 1 do perfil e D9 — "nada do que foi gravado se perde". O objetivo do Sponsor diz,
literalmente, "guarda cada saudação gerada num ficheiro JSON local".

Opções comparadas:
- **`node:fs/promises`, escrita atómica (temp → `sync()` → `rename`)** — fit: built-in, ficheiro JSON legível
  por uma pessoa, é o que o Sponsor pediu; maturidade: `FileHandle.sync()` e `rename` estáveis; licença: MIT;
  tamanho: 0; segurança: nenhuma superfície nova; resultado: resiste a corte de energia e a processo morto a
  meio, desde que a receita abaixo seja seguida à letra.
- **`fs.writeFile` direto por cima do ficheiro final** — fit: trivial; resultado: **rejeitado** — trunca o
  ficheiro antes de escrever, por isso um crash a meio deixa um JSON partido e perde tudo. Viola D9.
- **`node:sqlite` (`DatabaseSync`, WAL)** — fit: existe no Node 24 sem flag e dá durabilidade e concorrência
  de graça; licença: MIT/domínio público; maturidade: **release candidate (stability 1.2), não estável**, e
  verificado nesta máquina ainda imprime `ExperimentalWarning: SQLite is an experimental feature` no terminal;
  resultado: **rejeitado** — contraria o objetivo literal (ficheiro JSON), troca um ficheiro que uma pessoa
  abre no Bloco de Notas por um binário, e um aviso amarelo no arranque é exatamente o que o perfil proíbe
  para público não técnico.
- **`write-file-atomic` / `steno` (npm)** — licença MIT, fariam o mesmo; dependência nova proibida sem
  necessidade, e `write-file-atomic` tem em aberto precisamente a falha de Windows que a receita abaixo
  resolve (npm/write-file-atomic#227, sem retry no `rename`).
- **sem persistência (só em memória)** — perde tudo ao reiniciar. Fora de causa.

Decisão: **`node:fs/promises` com escrita atómica em série**, ficheiro `data/greetings.json` (D10). É a única
opção que cumpre ao mesmo tempo o objetivo literal, o zero-dependências e a durabilidade; `node:sqlite` seria
tecnicamente superior mas está fora do que foi pedido e ainda não é estável.

Como adotar — receita exata, a não improvisar:
1. `const fh = await open(tmp, 'w')` onde `tmp` é **na mesma pasta** do ficheiro final e com sufixo único
   (`greetings.json.<pid>.<random>.tmp`); pastas diferentes fazem o `rename` deixar de ser atómico.
2. `await fh.writeFile(JSON.stringify(registos, null, 2))` → `await fh.sync()` → `await fh.close()`.
   O `sync()` é o que garante que os bytes estão no disco e não só na cache; sem ele a receita não vale nada.
3. `await rename(tmp, final)` — substitui o ficheiro existente numa operação só (verificado nesta máquina).
4. **Retry obrigatório em Windows.** Verificado aqui: se outro processo tiver o ficheiro de destino aberto,
   `rename` falha com **`EPERM`** (Defender, indexador do Windows, OneDrive, backup ou um editor aberto).
   Tratar `EPERM`/`EBUSY`/`EACCES` com até 3 tentativas e espera crescente (100 ms, 200 ms, 400 ms) antes de
   desistir; ao desistir, **não apagar nem truncar o ficheiro final** — devolver erro em português e manter o
   `.tmp`. É a mesma correção que `graceful-fs` e o `pnpm` aplicam ao mesmo problema.
5. `try/finally` a limpar o `.tmp` quando a escrita falha antes do `rename`.
6. **Nunca manter um handle aberto sobre `data/greetings.json`.** Ler sempre com `readFile` (abre e fecha);
   um handle aberto pelo próprio servidor é a causa mais provável do `EPERM` do ponto 4.
7. **Não** tentar `fsync` da pasta: verificado que em Windows falha com `EPERM` e rebentaria a gravação. É uma
   garantia POSIX que aqui não existe e não se pede.
8. Serialização (D9): uma cadeia de promessas por processo — `fila = fila.then(() => gravar())` — para duas
   gravações simultâneas nunca se anularem. Sem locks, sem biblioteca.
9. Arranque: ficheiro inexistente ou vazio → lista vazia, cria-se na primeira saudação. JSON inválido ou
   formato inesperado → **recusar arrancar e recusar gravar**, sem tocar no ficheiro (D9).
10. `mkdir(dirname(final), { recursive: true })` antes da primeira gravação.

Limites: revisitar acima de ~50 000 registos (reescrever o ficheiro todo a cada saudação passa a pesar) ou se
alguma vez houver mais do que um processo a escrever — aí a decisão muda para `node:sqlite` e volta ao Scout.
Nota fora do meu âmbito, mas visível: o `.gitignore` deste projeto só tem `node_modules/`; D10 exige lá
`data/` e `token.local.txt` antes de existir qualquer gravação.

Dependência nova: **não**.

---

## Token no cabeçalho: geração e comparação segura — `node:crypto` (S0.3, 2026-09-16)

Contexto: D7 (fail-closed, mínimo 16 caracteres, `GREET_TOKEN` ou `token.local.txt`) e D11 (cabeçalho
`X-Greet-Token` na API, cookie no browser). O perfil proíbe token em código, em URL, em log ou em relatório.

Opções comparadas:
- **`node:crypto` (built-in)** — fit: perfeito; maturidade: estável; licença: MIT; tamanho: 0; segurança:
  `timingSafeEqual` é a primitiva certa contra ataques de tempo; `randomBytes` é CSPRNG do sistema.
- **`===` sobre as strings** — **rejeitado**: comparação que termina no primeiro byte diferente dá o token
  a quem meça o tempo. Numa rede local com o browser da equipa é um risco real, não teórico.
- **`bcrypt` / `argon2` (npm)** — feitos para palavras-passe humanas guardadas em base de dados; aqui o segredo
  é aleatório e de alta entropia, não há nada a derivar; dependências nativas, compilação, instalação proibida.
- **JWT / sessões assinadas (`jose`, MIT)** — resolveria expiração e revogação; o objetivo pede "um token
  simples num cabeçalho" e cinco pessoas numa sala não têm contas. Complexidade sem cliente.

Decisão: **`node:crypto`**, com comparação em tempo constante sobre **hashes SHA-256 dos dois lados**.
`timingSafeEqual` rebenta com `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` quando os buffers têm comprimentos
diferentes (verificado) — e o próprio comprimento do token seria uma fuga; passar pelo hash torna os dois
lados sempre 32 bytes e resolve as duas coisas de uma vez.

Como adotar:
```js
import { createHash, timingSafeEqual } from 'node:crypto';
const h = (s) => createHash('sha256').update(String(s ?? ''), 'utf8').digest();
const valido = timingSafeEqual(h(recebido), h(esperado));   // sempre 32 bytes dos dois lados
```
- Token recebido: `req.headers['x-greet-token']` (cabeçalhos chegam sempre em minúsculas) **ou** o cookie
  (D11). **Nunca** de query string — `new URL(...).searchParams` não é fonte de token.
- Cookies: **não há built-in de cookies no Node** (verificado: `node:cookie` não existe). Fazer à mão —
  ler `req.headers.cookie` com `split('; ')` e um `split('=')` por par, escrever com
  `res.setHeader('Set-Cookie', 'greet=<valor>; HttpOnly; SameSite=Strict; Path=/; Max-Age=…')`. Não instalar
  o pacote `cookie` por três linhas. Sem `Secure` porque é HTTP local — dizê-lo no comentário, não esconder.
- Geração do token: é do **Sponsor**, no README, com o built-in
  `node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"` (32 caracteres, seguro
  em URL e em ficheiro). **Nenhum agente executa este comando nem escreve um token** em lado nenhum.
- `crypto.randomUUID()` para o `id` de cada registo (D10). NÃO usar `Math.random()` para nada disto.
- NÃO usar: `createCipheriv` e afins (não há nada para cifrar), `crypto.webcrypto` (a API síncrona chega).

Limites: revisitar se aparecerem utilizadores distintos, expiração, revogação, ou exposição fora da rede local
— aí é sessão assinada e não este esquema. A verificação de origem dos POST (D11) é gate do Security Reviewer,
não desta decisão.

Dependência nova: **não**.

---

## Gráfico de barras por dia — SVG gerado no servidor + `Intl.DateTimeFormat` (S0.4, 2026-09-16)

Contexto: D12 pede barras verticais dos últimos 14 dias mais tabela de texto com os mesmos números.
`DESIGN.md` proíbe JavaScript no browser, CDNs e cores fora da paleta.

Opções comparadas:
- **SVG inline escrito à mão no servidor** — fit: único candidato compatível com "sem JS no cliente";
  maturidade: SVG 1.1 é suportado por tudo há 15 anos; licença: n/a; tamanho: 0; acessibilidade: total
  controlo (`role="img"`, `<title>`, e a tabela de texto ao lado); resultado: 14 `<rect>` com `x`/`height`
  calculados são ~25 linhas de template e dá exatamente o gráfico que D12 descreve.
- **Chart.js 4 (MIT)** — precisa de `<canvas>` e de JS no browser, e de CDN ou ficheiro vendorizado: viola
  `DESIGN.md` em três pontos de uma vez. Rejeitado.
- **uPlot / Chartist (MIT, pequenos)** — mesmo problema: são bibliotecas de cliente.
- **Gráfico em caracteres (blocos `█`, barras em CSS puro)** — livre e acessível, mas a fasquia do perfil
  pede uma página apresentável; SVG custa o mesmo e fica melhor. É o fallback se o SVG der problemas.

Decisão: **SVG inline gerado no servidor**, sem biblioteca. É a mesma escolha que o próprio Forja já fez para
o viewer (S1 no `TECHNOLOGY.md` do repo Forja). Nenhuma biblioteca de gráficos funciona sem JavaScript no
cliente, e o gráfico pedido são 14 retângulos — a biblioteca custaria mais do que o que desenha.

Como adotar:
- `<svg viewBox="0 0 W H" role="img" width="100%" style="max-width:100%">` com `<title>` descritivo; sem
  `width`/`height` fixos em px (`DESIGN.md`: nada de larguras fixas a 390). Cores só de `--bg/--text/--muted/
  --accent/--line`; barras em `--accent`.
- **Agrupar por dia no fuso local, não em UTC.** Os registos gravam `criado_em` em ISO UTC (D10). Verificado:
  `2026-06-15T23:30:00Z` é **16 de junho** em Lisboa — agrupar por `toISOString().slice(0,10)` põe saudações
  da madrugada no dia anterior e o gráfico mente. Usar o built-in ICU, que o Node 24 traz completo
  (418 fusos disponíveis, verificado):
  ```js
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon' }).format(new Date(criado_em));
  // -> "2026-06-16"  (en-CA dá YYYY-MM-DD, ordenável como string)
  ```
- **Escapar sempre** o texto que entra no SVG e no HTML (`&`, `<`, `>`, `"`) — o nome vem de um formulário.
  Uma função de escape de 4 `replace` em `lib/`; não instalar nada para isto.
- A tabela de texto com os mesmos números não é opcional: é o que o leitor de ecrã lê e o que os testes
  afirmam (D12, D17).
- NÃO usar: `<foreignObject>`, `<animate>`, gradientes, filtros, tooltips, `style` com `@import`.

Limites: revisitar se pedirem mais do que 14 dias, eixos com escala, múltiplas séries ou interação — aí volta
ao Scout e a resposta provavelmente continua a ser SVG, mas com uma decisão nova.

Dependência nova: **não**.

---

## Servir HTML e CSS estáticos — `node:fs/promises` com lista fixa de ficheiros (S0.5, 2026-09-16)

Contexto: o servidor tem de devolver as páginas e o que elas precisem. O projeto já tem `public/index.html`,
que D6 não muda.

Opções comparadas:
- **Lista fixa (allow-list) de ficheiros servidos por `readFile`** — fit: built-in; segurança: **imune a path
  traversal por construção**, porque o caminho nunca vem do URL; tamanho: 0; resultado: chega para 2–3 ficheiros.
- **Handler estático genérico sobre uma pasta** — built-in também, mas obriga a defender `..`, links
  simbólicos, `%2e%2e`, maiúsculas em Windows e nomes reservados (`CON`, `NUL`). Mais código e mais risco do
  que o que se ganha com 3 ficheiros.
- **`serve-handler` / `sirv` / `express.static` (npm, MIT)** — resolvem o caso genérico que aqui não existe;
  dependência nova proibida.
- **CSS inline nas páginas, sem servir ficheiros nenhuns** — é o que `DESIGN.md` já manda para `index.html`
  e evita por completo o problema.

Decisão: **CSS inline nas páginas novas** (como já é a regra do `DESIGN.md`) e, para qualquer ficheiro que
tenha mesmo de ser servido, um **mapa fixo rota → caminho absoluto**, resolvido com `path.join(import.meta.
dirname, …)`. Sem handler genérico e sem pacote: o URL nunca toca no sistema de ficheiros, por isso não há
travessia de diretórios a defender.

Como adotar:
- `import { readFile } from 'node:fs/promises'`; `import path from 'node:path'`; `import.meta.dirname` para a
  raiz do projeto (não `process.cwd()`, que muda consoante a pasta de onde se arranca).
- Content-Type: **não há módulo de mime no Node** (verificado: `node:mime` não existe). Um objeto literal com
  as extensões que existem — `.html: 'text/html; charset=utf-8'`, `.css: 'text/css; charset=utf-8'`,
  `.svg: 'image/svg+xml'`, `.png: 'image/png'` — e 404 para o resto. Não instalar `mime-types`.
- Qualquer rota desconhecida → 404 com a mesma página de erro em português das outras falhas.
- NÃO usar: `fs.createReadStream` com caminho derivado do URL, `res.sendFile` (não existe), `express.static`.

Limites: revisitar se a app passar a ter dezenas de ficheiros estáticos ou imagens carregadas por utilizadores.

Dependência nova: **não**.

---

## Testes do servidor e do HTML — `node:test` + `node:assert/strict` + `fetch` (S0.6, 2026-09-16)

Contexto: `CLAUDE.md` exige "testes só `node --test`"; D17 fixa a fasquia (porta efémera, token fictício,
ficheiro temporário, asserções sobre o HTML sem browser).

Opções comparadas:
- **`node:test` + `node:assert/strict`** — fit: já é o que `test/greet.test.mjs` e `test/slug.test.mjs` usam,
  e `npm test` já é `node --test`; maturidade: estável desde o Node 20; licença: MIT; tamanho: 0; resultado:
  `test`, `describe/it`, `before/after`, `mock` e relatório TAP, tudo o que este run precisa.
- **Vitest / Jest (MIT)** — proibidos pelo `CLAUDE.md` e desnecessários.
- **Cliente HTTP nos testes: `fetch` global vs `http.request`** — `fetch` é global e estável no Node 24
  (verificado contra um servidor em porta efémera: `200 ok`), permite `headers: { 'X-Greet-Token': … }` numa
  linha e devolve promessas; `http.request` obriga a envolver tudo em callbacks. Nada de `supertest`, `undici`
  ou `node-fetch` como dependência.
- **HTML: `jsdom` (MIT, v30, 24 dependências transitivas)** — daria `querySelector` nos testes; custo enorme
  para o que se quer afirmar, e é dependência nova.
- **HTML: `node-html-parser` (MIT, v9, 2 dependências)** — a alternativa honesta e barata se um dia fizer falta
  um seletor CSS num teste; ainda assim é dependência nova e hoje não é precisa.
- **HTML: asserções de string/regex sobre o HTML gerado** — sem DOM, mas D12 já obriga a uma tabela de texto
  com os mesmos números do gráfico, que é precisamente o que se afirma; e as asserções negativas que o perfil
  exige (`<script`, `http://`, `https://`) são literalmente procura de substring.

Decisão: **`node:test` + `node:assert/strict` + `fetch` global**, e o HTML testado por **asserções de string
sobre o texto gerado pelo servidor**, sem biblioteca de DOM. Os factos a provar são contagens por dia, ordem
da lista, estado vazio e ausência de `<script`/`http(s)://` — todos verificáveis sem árvore DOM. `jsdom` é a
opção a reabrir só se alguma vez for preciso afirmar estrutura (ex.: "o `<label>` aponta para o `<input>`"),
e mesmo aí `node-html-parser` vem primeiro na escada.

Como adotar:
- `import { test, before, after } from 'node:test'` · `import assert from 'node:assert/strict'` (é o estilo já
  usado nos testes existentes — manter).
- Arrancar o servidor no teste com `server.listen(0, '127.0.0.1')` e ler `server.address().port` (verificado);
  nunca uma porta fixa, que dá testes instáveis.
- Isolamento: `GREET_DATA` para um ficheiro em `os.tmpdir()` criado com `mkdtemp`, e token fictício definido
  no próprio processo. **`npm test` tem de passar sem token no ambiente e sem servidor ligado** (D16) — logo
  nenhum teste pode depender de `token.local.txt`.
- `after()` fecha o servidor (`server.close()`) e apaga a pasta temporária, senão `node --test` fica pendurado.
- NÃO usar: `node:test` snapshots (`--test-update-snapshots`) para o HTML — a página tem datas e ficaria a
  falhar todos os dias; `--experimental-test-coverage` não é exigido por ninguém neste run.

Limites: revisitar se aparecer JavaScript no browser (aí passa a ser preciso um browser real, e a prova visual
do `forja-visual-check` deixa de chegar).

Dependência nova: **não**.

---

## O que fica proibido neste run, por omissão

Qualquer `npm install`, qualquer `import` de algo que não comece por `node:` ou `./`/`../`, qualquer `http://`
ou `https://` em `src`, `href`, `@import` ou `fetch` do lado do browser, qualquer webfont, CDN, analytics ou
base de dados. Um Dev que julgue precisar de algo disto para `BLOCKED T<id> — precisa de decisão de tecnologia:
<capacidade>` com a opção mais barata que conhece, e o Lead acorda o Scout.
