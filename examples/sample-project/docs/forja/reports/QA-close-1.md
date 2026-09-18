QA FAIL — 2 findings

**Correu** (tudo a partir de `C:\dev\forja\examples\sample-project`)
- `npm test` sem `GREET_TOKEN` no ambiente → `tests 126 / pass 126 / fail 0` (corrido no início e no fim, idêntico).
- `npm run check` no repo Forja → `check ok — 295 ficheiros versionados, elenco do sample idêntico, política de modelos numa fonte só, 2498 eventos reproduzidos`.
- `node bin/forja.mjs bootstrap examples/sample-project --dry-run` → `created [] updated [] removed [] unchanged 28` (papel de fixture do D16 intacto).
- Arranque fail-closed: sem token → frase PT + `exit 1`; ficheiro de dados inválido → frase PT + `exit 1` e bytes iguais; porta ocupada → frase PT sugerindo `GREET_PORT` (apanhado ao vivo com a 8099 ocupada).
- E2E com o servidor real (`npm start`, porta 8123): `GET /` 303 → `/historico` 401 → `/entrar` 200 → palavra-passe errada 401 → `POST /entrar` sem Origin 403 → login correto 303 + `Set-Cookie … HttpOnly; SameSite=Strict; Path=/` → histórico vazio → guardar saudação 303 → item no topo da lista e registo no JSON.
- Caminhos de erro: nome vazio/só espaços/81 caracteres → 400 com a mensagem no formulário; corpo de 5000 bytes → 413; rota desconhecida → 404; cookie sem Origin → 403; `?token=` no URL não autentica (401); API JSON com `X-Greet-Token` → 201.
- Dados estranhos: `<script>alert("oi")</script>`, `Joaquim Gonçalves d'Ávila`, `Zoé 🙂 مرحبا`, nome de 80 caracteres, `\n` no meio do nome — todos escapados e legíveis, nenhuma página contém `<script` nem `http(s)://`.
- Persistência: 9 registos → restart do servidor → 9 registos, md5 do ficheiro igual; nova saudação depois do restart; 5 POST simultâneos → 5 registos, 5006 ids únicos, zero `.tmp` deixados para trás; ficheiro ilegível → 500 PT com bytes idênticos antes e depois.
- Números do gráfico conferidos contra um agrupamento independente em `Europe/Lisbon`: `1,0,4,3,1,1,6,1,1,2,2,4,3,3` na tabela = esperado; 14 `<rect>` de `width=24`, passo 39, base `y=190`, barra a zero com 2 px em `var(--line)`, só os 5 tokens da paleta, sem `<animate>`/gradientes/`foreignObject`/larguras em px — bate a contrato com `DESIGN.md` §3.
- Estados: vazio (`viewBox 0 0 546 100`, 14 barras a zero, tabela toda a 0), >100 registos (100 itens + «A mostrar as 100 mais recentes»), singular («1 saudação no total»).
- Visual a 1440×1000 e 390×844 de todos os ecrãs tocados (entrar, entrar-erro, histórico, histórico-vazio, erro-de-campo, 401, 403, 404, 413, 500) — sem scroll horizontal e todos os alvos ≥44 px em ambas as larguras, verificado por asserção no browser.
- Acessibilidade: `lang="pt"`, um `<h1>`, `<main>`, `<title>` e `<label for>` em todas as páginas; foco por tecla real → `outline solid 2px rgb(111,179,242) offset 2px` no campo, no botão e no link; percurso completo só com teclado (Tab → escrever → Enter no login, Tab → escrever → Enter no nome) terminou com «Olá, Teclado!» no topo da lista.
- Performance (mediana): 1000 → 105 ms, 5000 → 383 ms, 10 000 → 766 ms, 20 000 → 1785 ms. O orçamento do perfil («alguns milhares … menos de 1 s») cumpre-se com folga.
- Custo: zero dependências, `node_modules` inexistente, nenhum `import` fora de `node:`/`./`, nenhum `http(s)://` nas páginas servidas, nenhuma chamada de rede externa.
- Segredos: `.gitignore` com `node_modules/`, `data/`, `token.local.txt`; `git ls-files` sem dados nem tokens; stdout/stderr do servidor sem uma única ocorrência do token depois de todo o percurso.
- Screenshots do repo verificados de forma independente: `docs/screenshots/entrar-1440.png`, `entrar-390.png`, `t6-entrar-erro-1440.png`, `t6-401-1440.png`, `t6-401-390.png` são **byte a byte iguais** aos que tirei agora do servidor a correr (md5 coincidente) — a prova visual no repo é genuína e reproduz-se.

**Findings**

1. **grave — a página de entrada promete que a palavra-passe morre ao fechar o browser; na verdade fica 30 dias.**
   Reproduzir: abrir `/entrar`, entrar com a palavra-passe certa, inspecionar o cookie.
   Esperado: o texto `Fica guardada neste browser até o fechar` (DESIGN.md §4 ponto 4) descreve o que acontece — ou seja, cookie de sessão, sem `Max-Age`.
   Observado: `Set-Cookie: greet=…; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` e, no browser, `session: false | expira em 2026-10-17 | dias até expirar: 30.0`. Numa mesma máquina de escritório, quem fechar o browser a pensar que saiu continua com sessão aberta durante um mês.
   Nota: já tinha sido levantado na evidência de T5 («alinhar cookie ou frase») e ficou por fechar. Corrigir num dos dois lados — o texto ou o `Max-Age` em `lib/auth.mjs` — e alinhar `DESIGN.md` §4 com `docs/forja/TASKS.json` T2 critério 5, que hoje se contradizem.
   Evidência: `...\scratchpad\shots\entrar-1440.png` (1440) e `...\shots\entrar-390.png` (390); saída de `Network.getAllCookies`.

2. **grave — a app é «para uma equipa de 5 pessoas numa rede local» mas nunca diz aos outros 4 que endereço abrir.**
   Reproduzir: seguir o README, secção «Abrir à equipa toda, na mesma rede local» → `set GREET_HOST=0.0.0.0 && npm start`.
   Esperado: quem arranca o servidor (não técnico, por definição do perfil) fica a saber que endereço dar aos colegas.
   Observado: o terminal imprime sempre `Abra http://127.0.0.1:8131/ no browser.` mais o aviso genérico; `server.mjs:101` força `displayHost = '127.0.0.1'` quando o host é `0.0.0.0` e o IP da máquina nunca aparece. O README também não o diz nem ensina a descobri-lo. Confirmei que o servidor fica mesmo acessível em `http://172.23.96.1:8131/entrar` → 200, endereço que ninguém na equipa tem forma de adivinhar.
   Contexto: Q3 («pode ouvir na rede local?») foi respondida **«Sim»** pelo Sponsor em `docs/forja/SPONSOR-QUEUE.md` e nada mudou por causa dessa resposta. Esperado: quando `GREET_HOST=0.0.0.0`, imprimir também a(s) morada(s) de rede local a partilhar (ou, no mínimo, o README dizer como as obter) — e reavaliar se o default continua a fazer sentido depois do «Sim».
   Nota lateral do mesmo sítio: o aviso de arranque usa a palavra «token», que `DESIGN.md` §7 proíbe nos textos para a equipa e que o README chama sempre «palavra-passe».

3. **menor — a página 500 não segue o formato de `DESIGN.md` §5 para o caminho do ficheiro.**
   Esperado: `<p>` com o passo seguinte **numa frase** e, a seguir, uma linha própria `<p class="codigo">Ficheiro: <code>…</code></p>` antes de «Código 500.».
   Observado: `lib/app.mjs:307-312` mete o caminho dentro da própria frase, em corpo de texto; a 1440 o passo seguinte ocupa 4 linhas quase todas preenchidas por um caminho Windows. Também já estava apontado na evidência de T5 (ponto 2).

4. **menor — a primeira coisa que um membro da equipa vê é uma página de erro.**
   Reproduzir: browser limpo → abrir `http://127.0.0.1:8080/`.
   Esperado (fasquia do perfil: «nos primeiros 10 segundos … sem ler documentação»): quem ainda não entrou aterra na página «Entrar».
   Observado: `GET /` → 303 `/historico` → 401 «Precisa de entrar» com «Código 401.». Há um link claro e o passo seguinte está escrito, por isso não bloqueia — mas são dois ecrãs e um código de erro antes do formulário. Redirecionar para `/entrar` quando não há sessão válida resolvia.

5. **menor — fragmento em inglês na mensagem de arranque com ficheiro de dados ilegível.**
   Reproduzir: `GREET_DATA` a apontar para JSON inválido → `npm start`.
   Observado: `… Motivo: o conteúdo não é JSON válido (Unexpected end of JSON input). …`. O perfil proíbe texto em inglês para este público e o README cita esta mensagem tal e qual. Esperado: motivo só em português.

6. **menor — `<title>` do gráfico contradiz a linha de total quando há registos fora dos 14 dias.**
   Observado com 33 registos: a página diz «33 saudações no total» e o `<title>` do SVG — o que o leitor de ecrã ouve — diz «Total: 32 saudações». São os 32 da janela de 14 dias. Esperado: dizer «Total nestes 14 dias: 32 saudações» (ou equivalente).

7. **menor — o contrato visual deste run ainda não está em git.**
   `git status --short`: `M docs/design/DESIGN.md` e `?? docs/design/mocks/`. A secção «Ecrãs servidos pela aplicação» do `DESIGN.md` e os mocks + PNG que fundamentaram D18 são a fonte contra a qual T4/T5/T6 foram aprovadas e vivem só na árvore de trabalho. Esperado: entrarem no checkpoint final antes de `forja run finish`.

**Já registado**
- Nenhuma task `failed` ou `blocked`: T1..T8 todas `done` em `docs/forja/TASKS.json`.
- **Q2** continua aberta na fila do Sponsor (direção visual de `public/index.html`), com o default aplicado — fora do âmbito deste run por D6.

**Fora de âmbito**
- `public/index.html`, `lib/greet.mjs` e `lib/slug.mjs` não mudaram neste run (D6/D16) — confirmado por `git log` e não re-testados a fundo.
- Ficou um servidor desta app de uma sessão anterior a ouvir em `127.0.0.1:8099` (PID diferente dos meus, token e ficheiro de dados desconhecidos). Não lhe toquei; convém alguém fechá-lo.
- Toda a execução usou um ficheiro de dados em pasta temporária e um token fictício passado por `GREET_TOKEN` só no processo. Não criou, leu nem escreveu `token.local.txt`, e o `data/` do projeto está como estava.
- **Não verificado**: comportamento na mudança de hora de verão e na passagem da meia-noite com o servidor a correr (só coberto por testes unitários de `lib/stats.mjs`); leitor de ecrã real; browsers que não o Chrome.
